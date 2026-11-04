import { BOT_PROFILES } from '../src/bots/profiles';
import type { Rng } from '../src/game/deck';
import type { BotProfileId, GameState, PlayerAction, PlayerKind } from '../src/game/types';
import type { TableView } from '../src/game/views';
import { createPokerGame } from '../src/hub/pokerGame';
import type { TableGame } from '../src/hub/tableGame';
import {
  MAX_SEATS,
  MIN_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ErrorCode,
  type LobbyView,
  type ServerMessage,
  type TableGameId,
  type TableMeta,
} from '../src/net/protocol';

/**
 * One private table. The room owns the authoritative game state: it shuffles,
 * validates every action through the game and sends each player only their
 * own view. It is transport-agnostic — clocks, timers, randomness and message
 * delivery are injected, which keeps it deterministic under test — and
 * game-agnostic: the game comes in through the hub's TableGame contract
 * (Texas Hold'em by default).
 */

export interface RoomTimings {
  botThink: [number, number];
  street: number;
  runout: number;
  showdown: number;
  nextHand: number;
  /** Time a connected player gets to act. */
  turn: number;
  /** Time a disconnected or idle player gets before auto check/fold. */
  awayTurn: number;
  /** Time for a player who left the table for good. */
  leftTurn: number;
}

export const DEFAULT_TIMINGS: RoomTimings = {
  botThink: [700, 1400],
  street: 650,
  runout: 900,
  showdown: 800,
  nextHand: 5000,
  turn: 30_000,
  awayTurn: 8000,
  leftTurn: 1000,
};

/** Consecutive timeouts after which a player is treated as away. */
const AWAY_AFTER_TIMEOUTS = 2;
/** Consecutive failed scheduled steps tolerated before the table is closed. */
const MAX_STEP_FAILURES = 2;

export interface RoomDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  rng: Rng;
  /** Random lowercase hex string of the given byte length. */
  randomHex(bytes: number): string;
  send(playerId: string, message: ServerMessage): void;
}

export interface Member {
  id: string;
  name: string;
  kind: PlayerKind;
  botProfile: BotProfileId | null;
  /** Secret used to reconnect; null for bots. */
  token: string | null;
  connected: boolean;
  away: boolean;
  missedTurns: number;
  left: boolean;
}

export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export type RoomPhase = 'lobby' | 'playing' | 'finished';

const BOT_ORDER: BotProfileId[] = ['orion', 'vex', 'nova'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a room hosts any TableGame
type AnyGame = TableGame<any, any, any>;

export class Room<S = GameState, A = PlayerAction, V = TableView> {
  phase: RoomPhase = 'lobby';
  readonly members: Member[] = [];
  hostId = '';
  state: S | null = null;
  /** Last time a human did anything or was connected; used for cleanup. */
  lastActivity: number;

  private timer: unknown = null;
  private turnDeadline: number | null = null;
  private nextHandAt: number | null = null;
  /** Consecutive scheduled steps that threw (reset by any successful step). */
  private stepFailures = 0;
  /** Set when the table could not recover from a failing step; it is then closed. */
  private broken = false;

  private readonly game: TableGame<S, A, V>;

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
    private readonly timings: RoomTimings = DEFAULT_TIMINGS,
    game?: TableGame<S, A, V>,
  ) {
    this.game = game ?? (createPokerGame() as AnyGame as TableGame<S, A, V>);
    this.lastActivity = deps.now();
  }

  get gameId(): TableGameId {
    return this.game.id as TableGameId;
  }

  /** Seats this table's game allows. */
  get maxSeats(): number {
    return Math.min(MAX_SEATS, this.game.maxPlayers);
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  addHuman(name: string): Member {
    this.requirePhase('lobby', 'already-started', 'This game has already started');
    if (this.members.length >= this.maxSeats) throw new RoomError('room-full', 'This table is full');
    const member: Member = {
      id: `p-${this.deps.randomHex(4)}`,
      name: this.uniqueName(name),
      kind: 'human',
      botProfile: null,
      token: this.deps.randomHex(16),
      connected: false,
      away: false,
      missedTurns: 0,
      left: false,
    };
    if (!this.hostId) this.hostId = member.id;
    this.members.push(member);
    this.touch();
    this.broadcastLobby();
    return member;
  }

  addBot(byId: string): Member {
    this.requireHost(byId);
    this.requirePhase('lobby', 'already-started', 'Bots can only join before the game starts');
    if (this.members.length >= this.maxSeats) throw new RoomError('room-full', 'This table is full');
    const botCount = this.members.filter((m) => m.kind === 'bot').length;
    const profile = BOT_ORDER[botCount % BOT_ORDER.length] as BotProfileId;
    const member: Member = {
      id: `bot-${this.deps.randomHex(3)}`,
      name: this.uniqueName(BOT_PROFILES[profile].name),
      kind: 'bot',
      botProfile: profile,
      token: null,
      connected: true,
      away: false,
      missedTurns: 0,
      left: false,
    };
    this.members.push(member);
    this.touch();
    this.broadcastLobby();
    return member;
  }

  removeSeat(byId: string, targetId: string): void {
    this.requireHost(byId);
    this.requirePhase('lobby', 'already-started', 'Seats are locked once the game starts');
    if (targetId === byId) throw new RoomError('bad-request', 'Use Leave to give up your own seat');
    const index = this.members.findIndex((m) => m.id === targetId);
    if (index < 0) throw new RoomError('not-found', 'No such seat');
    const [removed] = this.members.splice(index, 1);
    if (removed?.kind === 'human') this.deps.send(removed.id, { t: 'left' });
    this.broadcastLobby();
  }

  findByToken(token: string): Member | undefined {
    if (this.broken) return undefined;
    return this.members.find((m) => m.token === token && !m.left);
  }

  member(id: string): Member | undefined {
    return this.members.find((m) => m.id === id);
  }

  connectedHumans(): number {
    return this.members.filter((m) => m.kind === 'human' && m.connected).length;
  }

  // -------------------------------------------------------------------------
  // Connection life cycle
  // -------------------------------------------------------------------------

  connect(playerId: string): void {
    const member = this.member(playerId);
    if (!member || member.kind !== 'human') return;
    member.connected = true;
    member.away = false;
    member.missedTurns = 0;
    this.touch();
    if (this.phase === 'lobby') {
      this.broadcastLobby();
      return;
    }
    // Coming back on your own turn restores the full turn clock.
    const actor = this.state ? this.game.actor(this.state) : null;
    if (this.phase === 'playing' && actor === playerId) {
      this.schedule();
    } else {
      this.broadcastState();
    }
  }

  disconnect(playerId: string): void {
    const member = this.member(playerId);
    if (!member || member.kind !== 'human') return;
    member.connected = false;
    this.touch();
    if (this.phase === 'lobby') this.broadcastLobby();
    else this.broadcastState();
  }

  leave(playerId: string): void {
    const member = this.member(playerId);
    if (!member || member.kind !== 'human') return;
    this.deps.send(playerId, { t: 'left' });
    if (this.phase === 'lobby') {
      this.members.splice(this.members.indexOf(member), 1);
    } else {
      // Mid-game the seat stays (chips cannot vanish) and auto-folds quickly.
      member.left = true;
      member.connected = false;
      member.away = true;
      member.token = null;
    }
    if (this.hostId === playerId) {
      this.hostId = this.members.find((m) => m.kind === 'human' && !m.left)?.id ?? '';
    }
    this.touch();
    if (this.phase === 'lobby') this.broadcastLobby();
    else this.schedule();
  }

  /** True when no human is connected and nothing happened for `idleMs`. */
  isAbandoned(now: number, idleMs: number): boolean {
    if (this.broken) return true;
    const humansLeft = this.members.some((m) => m.kind === 'human' && !m.left);
    if (!humansLeft) return true;
    return this.connectedHumans() === 0 && now - this.lastActivity > idleMs;
  }

  dispose(): void {
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Game
  // -------------------------------------------------------------------------

  start(byId: string): void {
    this.requireHost(byId);
    this.requirePhase('lobby', 'already-started', 'The game has already started');
    if (this.members.length < Math.max(MIN_PLAYERS, this.game.minPlayers)) throw new RoomError('bad-request', 'Seat at least one more player or bot first');
    const seats = this.members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, ...(m.botProfile ? { profile: m.botProfile } : {}) }));
    this.state = this.game.create(seats, this.deps.rng);
    this.phase = 'playing';
    this.touch();
    this.schedule();
  }

  act(playerId: string, action: A, seq: number): void {
    this.requirePhase('playing', 'bad-request', 'No hand in progress');
    const state = this.state as S;
    const member = this.member(playerId);
    if (!member || member.left) throw new RoomError('not-in-room', 'You are not seated here');
    if (seq !== this.game.seq(state)) throw new RoomError('stale', 'The table moved on before your action arrived');
    try {
      this.state = this.game.act(state, playerId, action, seq);
    } catch (error) {
      if (this.game.isRuleError(error)) throw new RoomError('illegal-action', (error as Error).message);
      throw error;
    }
    member.missedTurns = 0;
    member.away = false;
    this.touch();
    this.schedule();
  }

  rematch(byId: string): void {
    if (this.broken) throw new RoomError('not-found', 'This table was closed');
    this.requireHost(byId);
    this.requirePhase('finished', 'bad-request', 'The current game is not over yet');
    this.clearTimer();
    for (let i = this.members.length - 1; i >= 0; i--) {
      if (this.members[i]?.left) this.members.splice(i, 1);
    }
    for (const m of this.members) {
      m.away = false;
      m.missedTurns = 0;
    }
    this.state = null;
    this.phase = 'lobby';
    this.touch();
    this.broadcastLobby();
  }

  /**
   * Plans the next automatic step (bot move, street, showdown, next hand or
   * turn timeout) and broadcasts the new state. Every timer is tied to the
   * state version it was planned for, so a stale timer can never act.
   */
  private schedule(): void {
    this.clearTimer();
    this.turnDeadline = null;
    this.nextHandAt = null;
    const state = this.state;
    if (!state) return;
    const game = this.game;

    if (game.isOver(state)) {
      this.phase = 'finished';
      this.broadcastState();
      return;
    }

    const now = this.deps.now();
    const t = this.timings;
    const actorId = game.actor(state);
    if (actorId) {
      const actor = this.member(actorId);
      if (actor?.kind === 'bot') {
        const [min, max] = t.botThink;
        this.later(min + this.deps.rng.next() * (max - min), (s) => game.act(s, actorId, game.botAction(s, actorId, this.deps.rng), game.seq(s)));
      } else if (actor) {
        const ms = actor.left ? t.leftTurn : actor.away || !actor.connected ? t.awayTurn : t.turn;
        this.turnDeadline = now + ms;
        this.later(ms, (s) => this.autoAct(s, actor));
      }
    } else {
      const step = game.auto(state, this.deps.rng);
      if (step) {
        const ms = { quick: t.street, deal: t.street, runout: t.runout, reveal: t.showdown, round: t.nextHand }[step.pace];
        if (step.pace === 'round') this.nextHandAt = now + ms;
        this.later(ms, step.run);
      }
    }
    this.broadcastState();
  }

  private autoAct(state: S, member: Member): S {
    if (this.game.actor(state) !== member.id) return state;
    member.missedTurns += 1;
    if (member.missedTurns >= AWAY_AFTER_TIMEOUTS) member.away = true;
    return this.game.act(state, member.id, this.game.timeoutAction(state, member.id), this.game.seq(state));
  }

  private later(ms: number, step: (s: S) => S): void {
    const seq = this.state ? this.game.seq(this.state) : null;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (!this.state || this.game.seq(this.state) !== seq || this.broken) return;
      try {
        this.state = step(this.state);
        this.stepFailures = 0;
      } catch (error) {
        // Never let a bug in one room take the server down, and never leave the
        // table silently frozen either.
        console.error(`[room ${this.code}] scheduled step failed`, error);
        this.recover();
        return;
      }
      this.schedule();
    }, Math.max(0, Math.round(ms)));
  }

  /**
   * A scheduled step threw. A pending player decision is resolved with the
   * safe default (check, else fold — always legal); dealing, showdown and the
   * next hand are retried. If that keeps failing, the table is closed cleanly.
   */
  private recover(): void {
    this.stepFailures += 1;
    const state = this.state;
    if (state && this.stepFailures <= MAX_STEP_FAILURES) {
      const actorId = this.game.actor(state);
      if (actorId) {
        try {
          this.state = this.game.act(state, actorId, this.game.timeoutAction(state, actorId), this.game.seq(state));
          this.schedule();
          return;
        } catch (error) {
          console.error(`[room ${this.code}] safe fallback action failed`, error);
        }
      } else {
        this.schedule(); // plans the same step again for the same state
        return;
      }
    }
    this.closeBroken();
  }

  /** Gives up on this table: stops every timer and sends players back to the start screen. */
  private closeBroken(): void {
    this.broken = true;
    this.clearTimer();
    this.turnDeadline = null;
    this.nextHandAt = null;
    this.phase = 'finished';
    console.error(`[room ${this.code}] closed after repeated failures`);
    for (const m of this.members) {
      if (m.kind === 'human' && m.connected) {
        this.deps.send(m.id, { t: 'error', code: 'not-found', message: 'This table ran into a problem and was closed. Sorry about that.' });
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  lobbyView(forId: string): LobbyView {
    return {
      code: this.code,
      game: this.gameId,
      hostId: this.hostId,
      you: forId,
      seats: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        botProfile: m.botProfile,
        connected: m.connected,
      })),
      maxSeats: this.maxSeats,
      canStart: this.members.length >= MIN_PLAYERS,
    };
  }

  tableMeta(): TableMeta {
    return {
      code: this.code,
      hostId: this.hostId,
      connected: Object.fromEntries(this.members.map((m) => [m.id, m.kind === 'bot' || m.connected])),
      turnDeadline: this.turnDeadline,
      nextHandAt: this.nextHandAt,
      serverNow: this.deps.now(),
    };
  }

  /** Sends the current snapshot (lobby or table) to one player. */
  sendSnapshot(playerId: string): void {
    if (this.phase === 'lobby' || !this.state) {
      this.deps.send(playerId, { t: 'lobby', lobby: this.lobbyView(playerId) });
    } else {
      this.deps.send(playerId, this.stateMessage(this.state, playerId, this.tableMeta()));
    }
  }

  private broadcastLobby(): void {
    for (const m of this.members) {
      if (m.kind === 'human' && m.connected) this.deps.send(m.id, { t: 'lobby', lobby: this.lobbyView(m.id) });
    }
  }

  private stateMessage(state: S, viewerId: string, table: TableMeta): ServerMessage {
    return { t: 'state', game: this.gameId, view: this.game.view(state, viewerId), table } as ServerMessage;
  }

  private broadcastState(): void {
    const state = this.state;
    if (!state) return;
    const table = this.tableMeta();
    for (const m of this.members) {
      // Each player gets their own projection: only their cards, never the deck.
      if (m.kind === 'human' && m.connected) this.deps.send(m.id, this.stateMessage(state, m.id, table));
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireHost(byId: string): void {
    if (byId !== this.hostId) throw new RoomError('not-host', 'Only the host can do that');
  }

  private requirePhase(phase: RoomPhase, code: ErrorCode, message: string): void {
    if (this.phase !== phase) throw new RoomError(code, message);
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.members.map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private touch(): void {
    this.lastActivity = this.deps.now();
  }
}

export function generateRoomCode(rng: Rng): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[rng.nextInt(ROOM_CODE_ALPHABET.length)];
  return code;
}
