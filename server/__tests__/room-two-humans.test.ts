import { describe, expect, it } from 'vitest';
import { cardCode } from '../../src/game/cards';
import { createSeededRng } from '../../src/game/deck';
import { totalChips } from '../../src/game/rules';
import type { ServerMessage } from '../../src/net/protocol';
import { RoomError } from '../room';
import { createRoom, passive } from './harness';

/**
 * Stage 2 — two real players at one table (plus a bot). Covers the Stage 2
 * exit gate: independent clients converge, duplicate/stale/foreign actions are
 * refused without side effects, reconnects restore the right private view and
 * nobody ever receives another player's hidden cards or the deck.
 */

function table(seed = 11) {
  const t = createRoom(createSeededRng(seed));
  const a = t.room.addHuman('Ann');
  const b = t.room.addHuman('Ben');
  t.room.connect(a.id);
  t.room.connect(b.id);
  t.room.addBot(a.id);
  t.room.start(a.id);
  return { ...t, a, b };
}

const code = (e: unknown): string | null => (e instanceof RoomError ? e.code : null);
function refused(fn: () => void): string | null {
  try {
    fn();
  } catch (error) {
    return code(error);
  }
  return null;
}

/** Every hole card a recipient was told about before showdown must be their own. */
function assertPrivate(msgs: readonly ServerMessage[], viewerId: string): void {
  for (const m of msgs) {
    if (m.t !== 'state' || m.game !== 'holdem') continue;
    expect(JSON.stringify(m)).not.toContain('"deck"');
    for (const p of m.view.players) {
      if (p.id === viewerId || !p.holeCards) continue;
      // Someone else's cards may only appear once they were shown at showdown.
      const shown = m.view.events.some((e) => e.type === 'show' && e.playerId === p.id);
      expect(shown, `${viewerId} saw ${p.id}'s cards at seq ${m.view.seq}`).toBe(true);
    }
  }
}

describe('two humans at one table', () => {
  it('plays a whole game: only the actor may act, duplicates are stale, views converge and stay private', () => {
    const t = table();
    const total = totalChips(t.room.state!);
    let foreignRefusals = 0;
    let staleRefusals = 0;
    for (let i = 0; i < 5000 && t.room.phase === 'playing'; i++) {
      const s = t.room.state!;
      const p = s.hand?.pending;
      const humans = [t.a.id, t.b.id];
      if (p?.kind === 'action' && humans.includes(p.playerId)) {
        const other = humans.find((id) => id !== p.playerId)!;
        const before = JSON.stringify(s);
        // The other human taps at the same moment with the same seq: refused, nothing changes.
        expect(refused(() => t.room.act(other, { type: 'fold' }, s.seq))).toBe('illegal-action');
        foreignRefusals += 1;
        expect(JSON.stringify(t.room.state)).toBe(before);
        const action = passive(t.room, p.playerId);
        t.room.act(p.playerId, action, s.seq);
        // The same tap delivered twice: stale.
        expect(refused(() => t.room.act(p.playerId, action, s.seq))).toBe('stale');
        staleRefusals += 1;
        expect(totalChips(t.room.state!)).toBe(total);
        continue;
      }
      if (!t.timers.step()) break;
    }
    expect(t.room.phase).toBe('finished');
    expect(foreignRefusals).toBeGreaterThan(10);
    expect(staleRefusals).toBe(foreignRefusals);
    // Both clients end on the same final seq and both views agree on every public number.
    const va = t.lastState(t.a.id)!.view;
    const vb = t.lastState(t.b.id)!.view;
    expect(va.seq).toBe(t.room.state!.seq);
    expect(vb.seq).toBe(va.seq);
    const publicOf = (v: typeof va) => v.players.map((p) => [p.id, p.stack, p.status, p.finishPlace]);
    expect(publicOf(va)).toEqual(publicOf(vb));
    assertPrivate(t.messages(t.a.id), t.a.id);
    assertPrivate(t.messages(t.b.id), t.b.id);
  });

  it('a reconnecting player gets a snapshot with their own cards only, at the current seq', () => {
    const t = table(5);
    t.room.disconnect(t.b.id);
    // Let a few steps run while Ben is away (his turns auto-act on the short clock).
    for (let i = 0; i < 40; i++) {
      const p = t.room.state!.hand?.pending;
      if (p?.kind === 'action' && p.playerId === t.a.id) t.room.act(t.a.id, passive(t.room, t.a.id), t.room.state!.seq);
      else if (!t.timers.step()) break;
    }
    t.inbox.set(t.b.id, []);
    t.room.connect(t.b.id);
    t.room.sendSnapshot(t.b.id);
    const snap = t.lastState(t.b.id)!;
    expect(snap.view.seq).toBe(t.room.state!.seq);
    expect(snap.view.viewerId).toBe(t.b.id);
    const ben = t.room.state!.players.find((p) => p.id === t.b.id)!;
    const mine = snap.view.players.find((p) => p.id === t.b.id)!;
    if (ben.holeCards.length) expect(mine.holeCards!.map(cardCode)).toEqual(ben.holeCards.map(cardCode));
    assertPrivate([snap], t.b.id);
    expect(snap.table.connected[t.b.id]).toBe(true);
  });

  it('a player who leaves mid-hand keeps their chips on the table; the other finishes the game', () => {
    const t = table(8);
    const total = totalChips(t.room.state!);
    t.room.leave(t.a.id); // the host leaves
    expect(t.room.hostId).toBe(t.b.id);
    expect(refused(() => t.room.act(t.a.id, { type: 'fold' }, t.room.state!.seq))).toBe('not-in-room');
    for (let i = 0; i < 5000 && t.room.phase === 'playing'; i++) {
      const p = t.room.state!.hand?.pending;
      if (p?.kind === 'action' && p.playerId === t.b.id) t.room.act(t.b.id, passive(t.room, t.b.id), t.room.state!.seq);
      else if (!t.timers.step()) break;
      expect(totalChips(t.room.state!)).toBe(total);
    }
    expect(t.room.phase).toBe('finished');
    t.room.rematch(t.b.id);
    expect(t.room.members.map((m) => m.id)).not.toContain(t.a.id);
  });

  it('a seat can only be resumed with its own token', () => {
    const t = table();
    expect(t.room.findByToken(t.a.token!)?.id).toBe(t.a.id);
    expect(t.room.findByToken(t.b.token!)?.id).toBe(t.b.id);
    expect(t.room.findByToken('0'.repeat(32))).toBeUndefined();
  });
});
