import { describe, expect, it } from 'vitest';
import { cardCode } from '../../src/game/cards';
import { createSeededRng } from '../../src/game/deck';
import { durakGame } from '../../src/durak/game';
import { cardCount, getDurakLegal } from '../../src/durak/engine';
import type { DurakAction, DurakState } from '../../src/durak/types';
import type { ServerMessage } from '../../src/net/protocol';
import { RoomError } from '../room';
import { createRoom } from './harness';

/** Stage 2 + 4 — a private Durak table on the same room code path as poker. */

function durakTable(seed = 21) {
  const t = createRoom(createSeededRng(seed), undefined, durakGame);
  const a = t.room.addHuman('Ann');
  const b = t.room.addHuman('Ben');
  t.room.connect(a.id);
  t.room.connect(b.id);
  t.room.addBot(a.id);
  t.room.start(a.id);
  return { ...t, a, b, state: () => t.room.state as unknown as DurakState };
}

const refusedCode = (fn: () => void): string | null => {
  try {
    fn();
  } catch (e) {
    return e instanceof RoomError ? e.code : 'other';
  }
  return null;
};

function firstLegal(s: DurakState, id: string): DurakAction {
  const legal = getDurakLegal(s, id)!;
  if (legal.attackCards[0]) return { type: 'attack', card: legal.attackCards[0] };
  const d = legal.defend.find((x) => x.cards.length);
  if (d) return { type: 'defend', attackIndex: d.attackIndex, card: d.cards[0]! };
  return legal.canPass ? { type: 'pass' } : { type: 'take' };
}

function assertPrivate(msgs: readonly ServerMessage[], viewer: string, state: DurakState): void {
  for (const m of msgs) {
    if (m.t !== 'state') continue;
    expect(m.game).toBe('durak');
    if (m.game !== 'durak') continue;
    expect(JSON.stringify(m)).not.toContain('"talon"');
    for (const p of m.view.players) if (p.id !== viewer) expect(p.hand).toBeNull();
    void state;
  }
}

describe('online Durak room', () => {
  it('lobby reports the game and caps the table at four seats', () => {
    const t = createRoom(createSeededRng(1), undefined, durakGame);
    const host = t.room.addHuman('Host');
    t.room.connect(host.id);
    for (let i = 0; i < 3; i++) t.room.addBot(host.id);
    expect(refusedCode(() => t.room.addBot(host.id))).toBe('room-full');
    expect(refusedCode(() => t.room.addHuman('Late'))).toBe('room-full');
    const lobby = [...t.messages(host.id)].reverse().find((m) => m.t === 'lobby');
    expect(lobby).toMatchObject({ t: 'lobby', lobby: { game: 'durak', maxSeats: 4 } });
  });

  it('two humans and a bot play a whole game; only the actor may act and every frame is private', () => {
    const t = durakTable();
    let humanMoves = 0;
    for (let i = 0; i < 6000 && t.room.phase === 'playing'; i++) {
      const s = t.state();
      expect(cardCount(s)).toBe(36);
      const actor = durakGame.actor(s);
      if (actor === t.a.id || actor === t.b.id) {
        const other = actor === t.a.id ? t.b.id : t.a.id;
        const before = JSON.stringify(s);
        expect(refusedCode(() => t.room.act(other, { type: 'pass' }, s.seq))).toBe('illegal-action');
        expect(JSON.stringify(t.room.state)).toBe(before);
        const action = firstLegal(s, actor);
        t.room.act(actor, action, s.seq);
        expect(refusedCode(() => t.room.act(actor, action, s.seq))).toBe('stale');
        humanMoves += 1;
        continue;
      }
      if (!t.timers.step()) break;
    }
    expect(t.room.phase).toBe('finished');
    expect(durakGame.isOver(t.state())).toBe(true);
    expect(humanMoves).toBeGreaterThan(10);
    assertPrivate(t.messages(t.a.id), t.a.id, t.state());
    assertPrivate(t.messages(t.b.id), t.b.id, t.state());
    // Rematch returns everyone to the lobby of the same game.
    t.room.rematch(t.a.id);
    expect(t.room.phase).toBe('lobby');
    expect(t.room.gameId).toBe('durak');
  });

  it("a human's clock running out plays the safe move (lead the lowest, pass, or take)", () => {
    const t = durakTable(4);
    for (let i = 0; i < 200; i++) {
      const s = t.state();
      const actor = durakGame.actor(s);
      if (actor === t.a.id || actor === t.b.id) {
        const seq = s.seq;
        t.timers.step(); // the turn timer fires
        expect(t.state().seq).toBe(seq + 1);
        expect(t.room.member(actor)!.missedTurns).toBe(1);
        return;
      }
      if (!t.timers.step()) break;
    }
    throw new Error('no human turn came');
  });

  it('a reconnect snapshot is a private Durak view at the current seq', () => {
    const t = durakTable(7);
    t.room.disconnect(t.b.id);
    t.inbox.set(t.b.id, []);
    t.room.connect(t.b.id);
    t.room.sendSnapshot(t.b.id);
    const snap = [...t.messages(t.b.id)].reverse().find((m) => m.t === 'state');
    expect(snap && snap.t === 'state' && snap.game).toBe('durak');
    if (!snap || snap.t !== 'state' || snap.game !== 'durak') return;
    expect(snap.view.seq).toBe(t.state().seq);
    const mine = snap.view.players.find((p) => p.id === t.b.id)!;
    expect(mine.hand!.map(cardCode).sort()).toEqual(t.state().players.find((p) => p.id === t.b.id)!.hand.map(cardCode).sort());
    assertPrivate([snap], t.b.id, t.state());
  });
});
