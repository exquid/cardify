import { processBotTurn } from '../src/bots';
import { BOT_PROFILES } from '../src/bots/profiles';
import { DEFAULT_CONFIG } from '../src/game/config';
import type { Rng } from '../src/game/deck';
import { advance, applyPlayerAction, getLegalActions, startNextHand, startTournament } from '../src/game/engine';
import {
  IllegalActionError,
  type BotProfileId,
  type GameState,
  type PlayerAction,
  type PlayerKind,
  type TournamentConfig,
} from '../src/game/types';
import { getPlayerView } from '../src/game/views';
import {
  MAX_SEATS,
  MIN_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ErrorCode,
  type LobbyView,
  type ServerMessage,
  type TableMeta,
} from '../src/net/protocol';

/**
 * One private table. The room owns the authoritative GameState: it shuffles,
 * validates every action through the engine and sends each player only their
 * own view. It is transport-agnostic — clocks, timers, randomness and message
 * delivery are injected, which keeps it deterministic under test.
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

export class Room {
  phase: RoomPhase = 'lobby';
  readonly members: Member[] = [];
  hostId = '';
  state: GameState | null = null;
  /** Last time a human did anything or was connected; used for cleanup. */
  lastActivity: number;

  private timer: unknown = null;
  private turnDeadline: number | null = null;
  private nextHandAt: number | null = null;

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
    private readonly timings: RoomTimings = DEFAULT_TIMINGS,
    private readonly config: TournamentConfig = DEFAULT_CONFIG,
  ) {
    this.lastActivity = deps.now();
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  addHuman(name: string): Member {
    this.requirePhase('lobby', 'already-started', 'This game has already started');
    if (this.members.length >= MAX_SEATS) throw new RoomError('room-full', 'This table is full');
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
    if (this.members.length >= MAX_SEATS) throw new RoomError('room-full', 'This table is full');
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
    const pending = this.state?.hand?.pending;
    if (this.phase === 'playing' && pending?.kind === 'action' && pending.playerId === playerId) {
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
    if (this.members.length < MIN_PLAYERS) throw new RoomError('bad-request', 'Seat at least one more player or bot first');
    const seats = this.members.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      ...(m.botProfile ? { botProfile: m.botProfile } : {}),
    }));
    const tournament = startTournament(this.config, seats, { rng: this.deps.rng });
    this.state = startNextHand(tournament, { rng: this.deps.rng });
    this.phase = 'playing';
    this.touch();
    this.schedule();
  }

  act(playerId: string, action: PlayerAction, seq: number): void {
    this.requirePhase('playing', 'bad-request', 'No hand in progress');
    const state = this.state as GameState;
    const member = this.member(playerId);
    if (!member || member.left) throw new RoomError('not-in-room', 'You are not seated here');
    if (seq !== state.seq) throw new RoomError('stale', 'The table moved on before your action arrived');
    try {
      this.state = applyPlayerAction(state, playerId, action, seq);
    } catch (error) {
      if (error instanceof IllegalActionError) throw new RoomError('illegal-action', error.message);
      throw error;
    }
    member.missedTurns = 0;
    member.away = false;
    this.touch();
    this.schedule();
  }

  rematch(byId: string): void {
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
    if (!state?.hand) return;

    if (state.status === 'finished') {
      this.phase = 'finished';
      this.broadcastState();
      return;
    }

    const now = this.deps.now();
    const t = this.timings;
    const pending = state.hand.pending;
    switch (pending.kind) {
      case 'action': {
        const actor = this.member(pending.playerId);
        if (actor?.kind === 'bot') {
          const [min, max] = t.botThink;
          this.later(min + this.deps.rng.next() * (max - min), (s) => processBotTurn(s, this.deps.rng));
        } else if (actor) {
          const ms = actor.left ? t.leftTurn : actor.away || !actor.connected ? t.awayTurn : t.turn;
          this.turnDeadline = now + ms;
          this.later(ms, (s) => this.autoAct(s, actor));
        }
        break;
      }
      case 'deal': {
        const canBet = state.players.filter((p) => p.status === 'active').length >= 2;
        this.later(canBet ? t.street : t.runout, advance);
        break;
      }
      case 'showdown':
        this.later(t.showdown, advance);
        break;
      case 'complete':
        this.nextHandAt = now + t.nextHand;
        this.later(t.nextHand, (s) => startNextHand(s, { rng: this.deps.rng }));
        break;
    }
    this.broadcastState();
  }

  private autoAct(state: GameState, member: Member): GameState {
    const legal = getLegalActions(state, member.id);
    if (!legal) return state;
    member.missedTurns += 1;
    if (member.missedTurns >= AWAY_AFTER_TIMEOUTS) member.away = true;
    return applyPlayerAction(state, member.id, legal.canCheck ? { type: 'check' } : { type: 'fold' }, state.seq);
  }

  private later(ms: number, step: (s: GameState) => GameState): void {
    const seq = this.state?.seq;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (!this.state || this.state.seq !== seq) return;
      try {
        this.state = step(this.state);
      } catch (error) {
        // Never let a bug in one room take the server down; keep the table alive.
        console.error(`[room ${this.code}] scheduled step failed`, error);
        return;
      }
      this.schedule();
    }, Math.max(0, Math.round(ms)));
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
      hostId: this.hostId,
      you: forId,
      seats: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        botProfile: m.botProfile,
        connected: m.connected,
      })),
      maxSeats: MAX_SEATS,
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
      this.deps.send(playerId, { t: 'state', view: getPlayerView(this.state, playerId), table: this.tableMeta() });
    }
  }

  private broadcastLobby(): void {
    for (const m of this.members) {
      if (m.kind === 'human' && m.connected) this.deps.send(m.id, { t: 'lobby', lobby: this.lobbyView(m.id) });
    }
  }

  private broadcastState(): void {
    const state = this.state;
    if (!state) return;
    const table = this.tableMeta();
    for (const m of this.members) {
      // Each player gets their own projection: only their cards, never the deck.
      if (m.kind === 'human' && m.connected) this.deps.send(m.id, { t: 'state', view: getPlayerView(state, m.id), table });
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
