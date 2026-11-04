import { describe, expect, it } from 'vitest';
import { loadProfile, parseProfile, PROFILE_KEY, recordDurakResult, recordHoldemResult, resetStats, setProfileName } from '../profile';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
}

describe('local profile', () => {
  it('records each finished game exactly once', () => {
    const s = new MemoryStorage();
    recordHoldemResult('holdem-1', 3, s);
    recordHoldemResult('holdem-1', 3, s); // the same tournament reported again
    recordHoldemResult('holdem-2', 1, s);
    recordDurakResult('durak-1', 'durak', s);
    recordDurakResult('durak-1', 'durak', s);
    recordDurakResult('durak-2', 'safe', s);
    recordDurakResult('durak-3', 'draw', s);
    const p = loadProfile(s);
    expect(p.holdem).toEqual({ tournaments: 2, won: 1, bestPlace: 1 });
    expect(p.durak).toEqual({ games: 3, durak: 1, safe: 1, draws: 1 });
  });

  it('cleans names and survives corrupt or tampered data', () => {
    const s = new MemoryStorage();
    expect(setProfileName('  Ann\u0007  the   Bold ', s).name).toBe('Ann the Bold');
    expect(setProfileName('x'.repeat(40), s).name).toBe('');
    s.setItem(PROFILE_KEY, '{oops');
    expect(loadProfile(s).holdem.tournaments).toBe(0);
    const tampered = parseProfile({ version: 1, name: 5, holdem: { tournaments: -3, won: 99, bestPlace: 0 }, durak: { games: 2.5 }, recorded: [1, 'a'] });
    expect(tampered.holdem).toEqual({ tournaments: 0, won: 0, bestPlace: null });
    expect(tampered.durak.games).toBe(0);
    expect(tampered.recorded).toEqual(['a']);
  });

  it('reset keeps the name and clears the numbers', () => {
    const s = new MemoryStorage();
    setProfileName('Ben', s);
    recordDurakResult('d', 'safe', s);
    const p = resetStats(s);
    expect(p.name).toBe('Ben');
    expect(p.durak.games).toBe(0);
  });
});
