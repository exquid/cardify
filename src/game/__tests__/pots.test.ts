import { describe, expect, it } from 'vitest';
import { buildPots, splitPot } from '../pots';

const c = (playerId: string, amount: number, folded = false) => ({ playerId, amount, folded });
const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

describe('buildPots', () => {
  it('single pot when everyone contributed the same', () => {
    expect(buildPots([c('a', 100), c('b', 100), c('c', 100)])).toEqual([
      { amount: 300, eligible: ['a', 'b', 'c'] },
    ]);
  });

  it('builds main and side pots for several all-ins', () => {
    const pots = buildPots([c('a', 100), c('b', 300), c('c', 500), c('d', 500)]);
    expect(pots).toEqual([
      { amount: 400, eligible: ['a', 'b', 'c', 'd'] },
      { amount: 600, eligible: ['b', 'c', 'd'] },
      { amount: 400, eligible: ['c', 'd'] },
    ]);
  });

  it('folded contributions feed pots but are never eligible', () => {
    const pots = buildPots([c('a', 50), c('b', 200, true), c('c', 200), c('d', 120)]);
    expect(pots).toEqual([
      { amount: 200, eligible: ['a', 'c', 'd'] },
      { amount: 210, eligible: ['c', 'd'] },
      { amount: 160, eligible: ['c'] },
    ]);
    expect(sum(pots)).toBe(570);
  });

  it('merges layers with identical eligibility', () => {
    // b folded after putting in 60; layers 40 and 60 have the same eligible set.
    const pots = buildPots([c('a', 40), c('b', 60, true), c('c', 100)]);
    expect(sum(pots)).toBe(200);
    expect(pots[0]).toEqual({ amount: 120, eligible: ['a', 'c'] });
    expect(pots[1]).toEqual({ amount: 80, eligible: ['c'] });
  });

  it('never creates or loses chips (randomized)', () => {
    for (let i = 0; i < 500; i++) {
      const contributions = ['a', 'b', 'c', 'd'].map((id) =>
        c(id, Math.floor(Math.random() * 1000), Math.random() < 0.3),
      );
      if (contributions.every((x) => x.folded)) contributions[0] = { ...contributions[0]!, folded: false };
      expect(sum(buildPots(contributions))).toBe(sum(contributions));
    }
  });

  it('rejects negative or fractional contributions', () => {
    expect(() => buildPots([c('a', -1)])).toThrow();
    expect(() => buildPots([c('a', 1.5)])).toThrow();
  });
});

describe('splitPot', () => {
  it('splits evenly', () => {
    expect(splitPot(300, ['a', 'b'])).toEqual([
      { playerId: 'a', amount: 150 },
      { playerId: 'b', amount: 150 },
    ]);
  });

  it('gives odd chips to the first winners in order', () => {
    expect(splitPot(101, ['x', 'y'])).toEqual([
      { playerId: 'x', amount: 51 },
      { playerId: 'y', amount: 50 },
    ]);
    expect(splitPot(302, ['x', 'y', 'z']).map((w) => w.amount)).toEqual([101, 101, 100]);
  });
});
