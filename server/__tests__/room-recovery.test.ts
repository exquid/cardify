import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng } from '../../src/game/deck';
import { totalChips } from '../../src/game/rules';
import { createRoom } from './harness';

/**
 * Stage 2 — a scheduled step (bot move, deal, showdown, next hand) that throws
 * must never freeze a table. Failures are injected through the room's RNG,
 * which the engine uses for shuffling and the bots use for their decisions.
 */

/** Seeded RNG that throws while `broken` is set (or for the next `failNext` calls). */
function flakyRng(seed: number) {
  const inner = createSeededRng(seed);
  const control = { broken: false, failNext: 0 };
  const guard = (): void => {
    if (control.broken) throw new Error('injected RNG failure');
    if (control.failNext > 0) {
      control.failNext -= 1;
      throw new Error('injected transient RNG failure');
    }
  };
  const rng: Rng = {
    nextInt: (n) => {
      guard();
      return inner.nextInt(n);
    },
    next: () => {
      guard();
      return inner.next();
    },
  };
  return { rng, control };
}

function setup(seed = 3) {
  const { rng, control } = flakyRng(seed);
  const t = createRoom(rng);
  const errors: unknown[] = [];
  const originalError = console.error;
  const quiet = <T>(fn: () => T): T => {
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      return fn();
    } finally {
      console.error = originalError;
    }
  };
  return { ...t, control, errors, quiet };
}

/** Host + one bot, game started, host connected. */
function startedTable(seed?: number) {
  const t = setup(seed);
  const host = t.room.addHuman('Host');
  t.room.connect(host.id);
  t.room.addBot(host.id);
  t.room.start(host.id);
  return { ...t, host };
}

/** Lets timers run (host checks/calls when it is their turn) until `until` holds or steps run out. */
function play(t: ReturnType<typeof startedTable>, until: () => boolean, maxSteps = 2000): void {
  for (let i = 0; i < maxSteps && !until(); i++) {
    const s = t.room.state!;
    const p = s.hand?.pending;
    if (p?.kind === 'action' && p.playerId === t.host.id) {
      t.room.act(t.host.id, { type: s.hand!.currentBet > s.players.find((x) => x.id === t.host.id)!.streetBet ? 'call' : 'check' }, s.seq);
      continue;
    }
    if (!t.timers.step()) break;
  }
}

describe('room recovery from a failing scheduled step', () => {
  it('a transient failure while dealing the next hand is retried and the table carries on', () => {
    const t = startedTable();
    const total = totalChips(t.room.state!);
    play(t, () => t.room.state!.hand!.pending.kind === 'complete');
    const hand = t.room.state!.handNumber;
    t.control.failNext = 1; // the shuffle for the next hand throws once
    t.quiet(() => play(t, () => t.room.state!.handNumber > hand));
    expect(t.room.state!.handNumber).toBe(hand + 1);
    expect(t.errors.length).toBeGreaterThan(0); // logged, not swallowed silently
    expect(totalChips(t.room.state!)).toBe(total);
  });

  it('a bot whose decision keeps failing is auto-checked/folded instead of freezing the table', () => {
    const t = startedTable();
    play(t, () => t.room.state!.hand!.pending.kind === 'action' && (t.room.state!.hand!.pending as { playerId: string }).playerId !== t.host.id);
    const seq = t.room.state!.seq;
    t.control.broken = true; // every bot decision throws from now on
    t.quiet(() => {
      for (let i = 0; i < 5 && t.room.state!.seq === seq; i++) t.timers.step();
    });
    expect(t.room.state!.seq).toBeGreaterThan(seq);
    const last = t.room.state!.hand!.events.filter((e) => e.type === 'action').pop()!;
    expect(last).toMatchObject({ playerId: expect.stringMatching(/^bot-/) });
    expect(['check', 'fold']).toContain((last as { action: string }).action);
    expect(t.timers.pending).toBeGreaterThan(0); // something is planned: not frozen
  });

  it('a permanently failing step closes the table cleanly and tells the players', () => {
    const t = startedTable();
    play(t, () => t.room.state!.hand!.pending.kind === 'complete');
    t.control.broken = true; // the next shuffle can never succeed
    t.quiet(() => {
      for (let i = 0; i < 20 && t.timers.step(); i++) {
        /* run every retry */
      }
    });
    expect(t.timers.pending).toBe(0);
    const notice = (t.inbox.get(t.host.id) ?? []).filter((m) => m.t === 'error').pop();
    expect(notice).toMatchObject({ t: 'error', code: 'not-found' });
    expect(t.room.isAbandoned(t.timers.now, 60_000)).toBe(true);
    expect(t.room.findByToken(t.host.token!)).toBeUndefined();
  });
});
