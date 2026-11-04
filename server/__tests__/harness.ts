import { createSeededRng, type Rng } from '../../src/game/deck';
import { getLegalActions } from '../../src/game/engine';
import type { ServerMessage } from '../../src/net/protocol';
import type { GameState, PlayerAction } from '../../src/game/types';
import type { TableView } from '../../src/game/views';
import type { TableGame } from '../../src/hub/tableGame';
import { Room, type RoomTimings } from '../room';

/** Shared fakes for room tests: deterministic clock, timer queue, message inbox. */

export const FAST: RoomTimings = { botThink: [10, 20], street: 10, runout: 10, showdown: 10, nextHand: 50, turn: 1000, awayTurn: 200, leftTurn: 20 };

export class FakeTimers {
  now = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };
  clear = (id: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  /** Runs the next due timer; returns false when none is left. */
  step(): boolean {
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = this.timers.shift();
    if (!next) return false;
    this.now = Math.max(this.now, next.at);
    next.fn();
    return true;
  }
  get pending(): number {
    return this.timers.length;
  }
}

/** A room on fake timers; Texas Hold'em unless another hub game is passed. */
export function createRoom<S = GameState, A = PlayerAction, V = TableView>(rng: Rng = createSeededRng(1), timings: RoomTimings = FAST, game?: TableGame<S, A, V>) {
  const timers = new FakeTimers();
  const inbox = new Map<string, ServerMessage[]>();
  let hex = 0;
  const room = new Room<S, A, V>(
    'ABCDE',
    {
      now: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      rng,
      randomHex: (bytes) => (++hex).toString(16).padStart(bytes * 2, '0'),
      send: (id, msg) => inbox.set(id, [...(inbox.get(id) ?? []), msg]),
    },
    timings,
    game,
  );
  const messages = (id: string): ServerMessage[] => inbox.get(id) ?? [];
  const lastState = (id: string) =>
    [...messages(id)].reverse().find((m): m is Extract<ServerMessage, { t: 'state'; game: 'holdem' }> => m.t === 'state' && m.game === 'holdem');
  return { room, timers, inbox, messages, lastState };
}

/** The passive legal action for a player: check if free, otherwise call. */
export function passive(room: Room, playerId: string) {
  const legal = getLegalActions(room.state!, playerId)!;
  return legal.canCheck ? ({ type: 'check' } as const) : ({ type: 'call' } as const);
}
