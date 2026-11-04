import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../../game/deck';
import { createDurak } from '../engine';
import { durakGame } from '../game';
import { DURAK_SAVE_KEY, loadDurak, saveDurak, validateDurakState } from '../persist';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

const seats = [
  { id: 'you', name: 'You', kind: 'human' as const },
  { id: 'nova', name: 'Nova', kind: 'bot' as const },
  { id: 'vex', name: 'Vex', kind: 'bot' as const },
];

describe('Durak saves', () => {
  it('round-trips a game in progress and drops it once the game is over', () => {
    const rng = createSeededRng(12);
    let s = createDurak(seats, { rng });
    s = durakGame.act(s, durakGame.actor(s)!, durakGame.botAction(s, durakGame.actor(s)!, rng), s.seq);
    const store = new MemoryStorage();
    saveDurak(s, store);
    expect(loadDurak(store)).toEqual(s);
    while (!durakGame.isOver(s)) {
      const actor = durakGame.actor(s);
      s = actor ? durakGame.act(s, actor, durakGame.botAction(s, actor, rng), s.seq) : durakGame.auto(s, rng)!.run(s);
    }
    saveDurak(s, store);
    expect(store.getItem(DURAK_SAVE_KEY)).toBeNull();
  });

  it('treats corrupt or tampered saves as missing', () => {
    const store = new MemoryStorage();
    const good = createDurak(seats, { rng: createSeededRng(1) });
    const put = (v: unknown) => store.setItem(DURAK_SAVE_KEY, typeof v === 'string' ? v : JSON.stringify(v));
    put('{not json');
    expect(loadDurak(store)).toBeNull();
    put({ version: 2, state: good });
    expect(loadDurak(store)).toBeNull();
    const extraCard = structuredClone(good);
    extraCard.players[0]!.hand.push({ ...extraCard.talon[0]! }); // a duplicated card
    expect(validateDurakState(extraCard)).toBe('Cards do not add up');
    const lostCard = structuredClone(good);
    lostCard.talon.pop();
    expect(validateDurakState(lostCard)).toBe('Cards do not add up');
    const badActor = structuredClone(good);
    badActor.pending = { kind: 'attack', playerId: 'ghost' };
    expect(validateDurakState(badActor)).toBe('Bad actor');
    expect(validateDurakState({ game: 'poker' })).toBe('Not a Durak save');
    expect(validateDurakState(good)).toBeNull();
  });
});
