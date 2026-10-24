import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createCryptoRng, type Rng } from '../src/game/deck';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '../src/net/protocol';
import { createOriginMatcher } from './origins';
import { DEFAULT_TIMINGS, generateRoomCode, Room, RoomError, type RoomTimings } from './room';

/**
 * WebSocket transport around `Room`. Responsibilities: room registry, binding
 * sockets to seats, input validation, rate limiting, origin checks,
 * heartbeats and cleanup of abandoned tables.
 */

export interface ServerOptions {
  port: number;
  host?: string;
  /** Allowed browser origins; empty means "any" (handy for local development). */
  allowedOrigins?: string[];
  maxRooms?: number;
  timings?: RoomTimings;
  /** Remove tables with no connected humans after this long. */
  idleRoomMs?: number;
  heartbeatMs?: number;
  rng?: Rng;
  log?: (message: string) => void;
}

interface Connection {
  socket: WebSocket;
  room: Room | null;
  playerId: string | null;
  alive: boolean;
  /** Token bucket for rate limiting. */
  tokens: number;
  lastRefill: number;
  strikes: number;
}

const BUCKET_SIZE = 20;
const REFILL_PER_SECOND = 8;
const MAX_STRIKES = 40;
const MAX_PAYLOAD = 2048;

export interface RunningServer {
  http: Server;
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  // eslint-disable-next-line no-console -- the server's operational log
  const log = options.log ?? ((m: string) => console.log(m));
  const rng = options.rng ?? createCryptoRng();
  const timings = options.timings ?? DEFAULT_TIMINGS;
  const maxRooms = options.maxRooms ?? 500;
  const idleRoomMs = options.idleRoomMs ?? 10 * 60_000;
  const originAllowed = createOriginMatcher(options.allowedOrigins ?? []);
  const reportedOrigins = new Set<string>();

  const rooms = new Map<string, Room>();
  const connections = new Map<WebSocket, Connection>();
  /** `${code}:${playerId}` → socket currently bound to that seat. */
  const seats = new Map<string, Connection>();

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      // Readable cross-origin so the web app can tell "asleep" from "blocked".
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('cardify table server');
  });

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ origin }: { origin: string; req: IncomingMessage }) => {
      if (originAllowed(origin)) return true;
      // Log each refused origin once so a misconfigured ALLOWED_ORIGINS is easy to spot.
      if (!reportedOrigins.has(origin) && reportedOrigins.size < 50) {
        reportedOrigins.add(origin);
        log(`refused WebSocket from origin "${origin}" — add it to ALLOWED_ORIGINS to allow it`);
      }
      return false;
    },
  });

  const send = (conn: Connection, message: ServerMessage): void => {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(message));
  };
  const fail = (conn: Connection, code: ErrorCode, message: string): void => send(conn, { t: 'error', code, message });

  const createRoom = (): Room => {
    if (rooms.size >= maxRooms) throw new RoomError('server-full', 'The server is busy, try again in a few minutes');
    let code = generateRoomCode(rng);
    while (rooms.has(code)) code = generateRoomCode(rng);
    const room = new Room(code, {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      rng,
      randomHex: (bytes) => randomBytes(bytes).toString('hex'),
      send: (playerId, message) => {
        const conn = seats.get(`${code}:${playerId}`);
        if (conn) send(conn, message);
        if (message.t === 'left' && conn) unbind(conn);
      },
    }, timings);
    rooms.set(code, room);
    log(`room ${code} created (${rooms.size} open)`);
    return room;
  };

  const bind = (conn: Connection, room: Room, playerId: string): void => {
    const key = `${room.code}:${playerId}`;
    const previous = seats.get(key);
    if (previous && previous !== conn) {
      // Same seat opened elsewhere (another tab/device): the newest wins.
      previous.room = null;
      previous.playerId = null;
      previous.socket.close(4000, 'Seat opened in another tab');
    }
    seats.set(key, conn);
    conn.room = room;
    conn.playerId = playerId;
  };

  function unbind(conn: Connection): void {
    if (conn.room && conn.playerId) {
      const key = `${conn.room.code}:${conn.playerId}`;
      if (seats.get(key) === conn) seats.delete(key);
    }
    conn.room = null;
    conn.playerId = null;
  }

  const welcome = (conn: Connection, room: Room, playerId: string, token: string): void => {
    send(conn, { t: 'welcome', v: PROTOCOL_VERSION, code: room.code, token, playerId });
  };

  const handle = (conn: Connection, msg: ClientMessage): void => {
    switch (msg.t) {
      case 'ping':
        send(conn, { t: 'pong' });
        return;
      case 'create': {
        if (conn.room) leaveCurrent(conn);
        const room = createRoom();
        const member = room.addHuman(msg.name);
        bind(conn, room, member.id);
        welcome(conn, room, member.id, member.token as string);
        room.connect(member.id);
        return;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) throw new RoomError('not-found', `No table with code ${msg.code}`);
        if (conn.room) leaveCurrent(conn);
        const member = room.addHuman(msg.name);
        bind(conn, room, member.id);
        welcome(conn, room, member.id, member.token as string);
        room.connect(member.id);
        return;
      }
      case 'resume': {
        const room = rooms.get(msg.code);
        const member = room?.findByToken(msg.token);
        if (!room || !member) throw new RoomError('not-found', 'That table is no longer available');
        bind(conn, room, member.id);
        welcome(conn, room, member.id, msg.token);
        room.connect(member.id);
        room.sendSnapshot(member.id);
        return;
      }
      default:
        break;
    }

    const room = conn.room;
    const playerId = conn.playerId;
    if (!room || !playerId) throw new RoomError('not-in-room', 'Join a table first');
    switch (msg.t) {
      case 'add-bot':
        room.addBot(playerId);
        return;
      case 'remove-seat':
        room.removeSeat(playerId, msg.playerId);
        return;
      case 'start':
        room.start(playerId);
        log(`room ${room.code} started with ${room.members.length} seats`);
        return;
      case 'act':
        room.act(playerId, msg.action, msg.seq);
        return;
      case 'rematch':
        room.rematch(playerId);
        return;
      case 'leave':
        leaveCurrent(conn);
        return;
    }
  };

  function leaveCurrent(conn: Connection): void {
    const room = conn.room;
    const playerId = conn.playerId;
    if (!room || !playerId) return;
    room.leave(playerId);
    unbind(conn);
    if (room.isAbandoned(Date.now(), idleRoomMs)) closeRoom(room);
  }

  function closeRoom(room: Room): void {
    room.dispose();
    rooms.delete(room.code);
    for (const [key, conn] of seats) {
      if (key.startsWith(`${room.code}:`)) {
        seats.delete(key);
        conn.room = null;
        conn.playerId = null;
      }
    }
    log(`room ${room.code} closed (${rooms.size} open)`);
  }

  const allowMessage = (conn: Connection): boolean => {
    const now = Date.now();
    conn.tokens = Math.min(BUCKET_SIZE, conn.tokens + ((now - conn.lastRefill) / 1000) * REFILL_PER_SECOND);
    conn.lastRefill = now;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    conn.strikes += 1;
    if (conn.strikes > MAX_STRIKES) conn.socket.close(1008, 'Too many messages');
    else fail(conn, 'rate-limited', 'Slow down a little');
    return false;
  };

  wss.on('connection', (socket) => {
    const conn: Connection = { socket, room: null, playerId: null, alive: true, tokens: BUCKET_SIZE, lastRefill: Date.now(), strikes: 0 };
    connections.set(socket, conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary || !allowMessage(conn)) return;
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        fail(conn, 'bad-request', 'Malformed message');
        return;
      }
      try {
        handle(conn, msg);
      } catch (error) {
        if (error instanceof RoomError) fail(conn, error.code, error.message);
        else {
          console.error('unexpected error', error);
          fail(conn, 'bad-request', 'Something went wrong');
        }
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      const room = conn.room;
      const playerId = conn.playerId;
      if (room && playerId && seats.get(`${room.code}:${playerId}`) === conn) {
        seats.delete(`${room.code}:${playerId}`);
        room.disconnect(playerId);
      }
      conn.room = null;
      conn.playerId = null;
    });
  });

  // Heartbeat: drop dead sockets so seats show as offline promptly.
  const heartbeat = setInterval(() => {
    for (const [socket, conn] of connections) {
      if (!conn.alive) {
        socket.terminate();
        continue;
      }
      conn.alive = false;
      socket.ping();
    }
  }, options.heartbeatMs ?? 25_000);

  // Cleanup of abandoned tables.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.isAbandoned(now, idleRoomMs)) closeRoom(room);
    }
  }, 30_000);

  return new Promise((resolve) => {
    http.listen(options.port, options.host ?? '0.0.0.0', () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      log(`cardify server listening on :${port}`);
      resolve({
        http,
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            clearInterval(sweeper);
            for (const room of rooms.values()) room.dispose();
            for (const socket of wss.clients) socket.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
