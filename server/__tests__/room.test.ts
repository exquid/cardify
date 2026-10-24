import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../../src/game/deck';
import { getLegalActions } from '../../src/game/engine';
import { totalChips } from '../../src/game/rules';
import type { ServerMessage } from '../../src/net/protocol';
import { Room, RoomError, type RoomTimings } from '../room';

const FAST: RoomTimings = {
  botThink: [10, 20],
  street: 10,
  runout: 10,
  showdown: 10,
  nextHand: 50,
  turn: 1000,
  awayTurn: 200,
  leftTurn: 20,
};

/** Deterministic clock + timer queue. */
class FakeTimers {
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
  pendingDelay(): number | null {
    if (this.timers.length === 0) return null;
    return Math.min(...this.timers.map((t) => t.at)) - this.now;
  }
}

function setup(seed = 1) {
  const timers = new FakeTimers();
  const inbox = new Map<string, ServerMessage[]>();
  const rng = createSeededRng(seed);
  let hex = 0;
  const room = new Room(
    'ABCDE',
    {
      now: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      rng,
      randomHex: (bytes) => (++hex).toString(16).padStart(bytes * 2, '0'),
      send: (id, msg) => {
        const list = inbox.get(id) ?? [];
        list.push(msg);
        inbox.set(id, list);
      },
    },
    FAST,
  );
  const last = (id: string, t: ServerMessage['t']) => [...(inbox.get(id) ?? [])].reverse().find((m) => m.t === t);
  return { room, timers, inbox, last };
}

function expectRoomError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    return;
  }
  throw new Error(`expected RoomError ${code}`);
}

describe('lobby', () => {
  it('seats players, makes the first one host and broadcasts the lobby', () => {
    const { room, last } = setup();
    const host = room.addHuman('Tim');
    room.connect(host.id);
    const guest = room.addHuman('Tim');
    room.connect(guest.id);
    expect(room.hostId).toBe(host.id);
    expect(guest.name).toBe('Tim 2');
    const lobby = last(host.id, 'lobby');
    expect(lobby?.t === 'lobby' && lobby.lobby.seats.map((s) => s.name)).toEqual(['Tim', 'Tim 2']);
  });

  it('only the host can add bots, remove seats and start', () => {
    const { room } = setup();
    const host = room.addHuman('Host');
    const guest = room.addHuman('Guest');
    expectRoomError(() => room.addBot(guest.id), 'not-host');
    expectRoomError(() => room.start(guest.id), 'not-host');
    expectRoomError(() => room.removeSeat(guest.id, host.id), 'not-host');
    const bot = room.addBot(host.id);
    expect(bot.kind).toBe('bot');
    room.removeSeat(host.id, bot.id);
    expect(room.members).toHaveLength(2);
  });

  it('caps the table at six seats and refuses joins after the start', () => {
    const { room } = setup();
    const host = room.addHuman('Host');
    for (let i = 0; i < 5; i++) room.addBot(host.id);
    expectRoomError(() => room.addHuman('Late'), 'room-full');
    expectRoomError(() => room.addBot(host.id), 'room-full');
    room.removeSeat(host.id, room.members[5]!.id);
    room.start(host.id);
    expectRoomError(() => room.addHuman('Late'), 'already-started');
  });

  it('needs at least two seats to start', () => {
    const { room } = setup();
    const host = room.addHuman('Solo');
    expectRoomError(() => room.start(host.id), 'bad-request');
  });
});

describe('table', () => {
  function startedTable() {
    const ctx = setup(7);
    const a = ctx.room.addHuman('Ann');
    const b = ctx.room.addHuman('Bob');
    ctx.room.connect(a.id);
    ctx.room.connect(b.id);
    ctx.room.addBot(a.id);
    ctx.room.start(a.id);
    return { ...ctx, a, b };
  }

  it('sends every player only their own hole cards and never the deck', () => {
    const { room, last, a, b } = startedTable();
    const state = room.state!;
    for (const viewer of [a, b]) {
      const msg = last(viewer.id, 'state');
      expect(msg?.t).toBe('state');
      const json = JSON.stringify(msg);
      expect(json).not.toContain('"deck"');
      if (msg?.t !== 'state') continue;
      for (const p of msg.view.players) {
        if (p.id === viewer.id) expect(p.holeCards).toHaveLength(2);
        else expect(p.holeCards).toBeNull();
      }
      for (const other of state.players.filter((p) => p.id !== viewer.id)) {
        for (const card of other.holeCards) expect(json).not.toContain(JSON.stringify(card));
      }
    }
  });

  it('validates turn order and rejects stale sequence numbers', () => {
    const { room, timers } = startedTable();
    // Let bots act until a human is due.
    while (room.state!.hand!.pending.kind !== 'action' || room.member((room.state!.hand!.pending as { playerId: string }).playerId)?.kind === 'bot') {
      timers.step();
    }
    const actorId = (room.state!.hand!.pending as { playerId: string }).playerId;
    const other = room.members.find((m) => m.kind === 'human' && m.id !== actorId)!;
    expectRoomError(() => room.act(other.id, { type: 'fold' }, room.state!.seq), 'illegal-action');
    expectRoomError(() => room.act(actorId, { type: 'fold' }, room.state!.seq - 1), 'stale');
    const seq = room.state!.seq;
    room.act(actorId, { type: 'fold' }, seq);
    expect(room.state!.seq).toBe(seq + 1);
  });

  it('auto-acts on timeout and treats repeat offenders as away', () => {
    const { room, timers, last } = startedTable();
    let timeouts = 0;
    for (let i = 0; i < 400 && timeouts < 3; i++) {
      const pending = room.state!.hand!.pending;
      if (pending.kind === 'action' && room.member(pending.playerId)?.kind === 'human') {
        const meta = last(pending.playerId, 'state');
        if (meta?.t === 'state') expect(meta.table.turnDeadline).not.toBeNull();
        const member = room.member(pending.playerId)!;
        const expected = member.away ? FAST.awayTurn : FAST.turn;
        expect(timers.pendingDelay()).toBe(expected);
        timeouts++;
      }
      timers.step();
    }
    expect(room.members.some((m) => m.away)).toBe(true);
  });

  it('gives a disconnected player the short clock and restores it on reconnect', () => {
    const { room, timers, inbox } = startedTable();
    while (true) {
      const pending = room.state!.hand!.pending;
      if (pending.kind === 'action' && room.member(pending.playerId)?.kind === 'human') break;
      timers.step();
    }
    const actorId = (room.state!.hand!.pending as { playerId: string }).playerId;
    room.disconnect(actorId);
    // The current timer was planned while connected; the next turn of this
    // player would use the away clock. Reconnecting reschedules a full turn.
    inbox.set(actorId, []);
    room.connect(actorId);
    expect(timers.pendingDelay()).toBe(FAST.turn);
    expect(inbox.get(actorId)?.some((m) => m.t === 'state')).toBe(true);
  });

  it('keeps a leaving player seated mid-game, folds them quickly and hands over host', () => {
    const { room, timers, a, b } = startedTable();
    room.leave(a.id);
    expect(room.hostId).toBe(b.id);
    expect(room.member(a.id)?.left).toBe(true);
    expect(room.findByToken('anything')).toBeUndefined();
    // Game continues and conserves chips.
    const total = totalChips(room.state!);
    for (let i = 0; i < 50; i++) timers.step();
    expect(totalChips(room.state!)).toBe(total);
  });

  it('plays a whole tournament to the end and allows a rematch', () => {
    const { room, timers, a } = startedTable();
    const total = totalChips(room.state!);
    let steps = 0;
    while (room.phase === 'playing') {
      expect(++steps).toBeLessThan(200_000);
      // Humans play aggressively so the test finishes quickly.
      const pending = room.state!.hand!.pending;
      if (pending.kind === 'action' && room.member(pending.playerId)?.kind === 'human') {
        room.act(pending.playerId, { type: 'allin' }, room.state!.seq);
        continue;
      }
      if (!timers.step()) break;
    }
    expect(room.phase).toBe('finished');
    expect(totalChips(room.state!)).toBe(total);
    expect(room.state!.winnerId).not.toBeNull();
    room.rematch(a.id);
    expect(room.phase).toBe('lobby');
    expect(room.state).toBeNull();
  });

  it('never reveals other hole cards before showdown across a whole game', () => {
    const { room, timers, inbox } = startedTable();
    let steps = 0;
    while (room.phase === 'playing' && steps++ < 3000) {
      const pending = room.state!.hand!.pending;
      if (pending.kind === 'action' && room.member(pending.playerId)?.kind === 'human') {
        const legal = getLegalActions(room.state!, pending.playerId)!;
        room.act(pending.playerId, legal.canCheck ? { type: 'check' } : { type: 'call' }, room.state!.seq);
      } else if (!timers.step()) break;
    }
    for (const [viewerId, messages] of inbox) {
      for (const msg of messages) {
        if (msg.t !== 'state') continue;
        const shown = new Set(msg.view.result?.shown.map((s) => s.playerId) ?? []);
        for (const p of msg.view.players) {
          if (p.holeCards && p.id !== viewerId) expect(shown.has(p.id)).toBe(true);
        }
      }
    }
  });
});
