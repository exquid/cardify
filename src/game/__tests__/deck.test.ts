import { describe, expect, it } from 'vitest';
import { cardCode, parseCard } from '../cards';
import { createCryptoRng, createDeck, createSeededRng, shuffledDeck } from '../deck';

describe('deck', () => {
  it('contains 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardCode)).size).toBe(52);
  });

  it('shuffling keeps exactly the same 52 unique cards', () => {
    for (const rng of [createSeededRng(42), createCryptoRng()]) {
      const deck = shuffledDeck(rng);
      expect(deck).toHaveLength(52);
      expect(new Set(deck.map(cardCode)).size).toBe(52);
    }
  });

  it('seeded RNG is reproducible, crypto RNG is not constant', () => {
    expect(shuffledDeck(createSeededRng(7)).map(cardCode)).toEqual(shuffledDeck(createSeededRng(7)).map(cardCode));
    const a = shuffledDeck(createCryptoRng()).map(cardCode).join();
    const b = shuffledDeck(createCryptoRng()).map(cardCode).join();
    expect(a).not.toBe(b);
  });

  it('crypto nextInt stays within bounds and covers the range', () => {
    const rng = createCryptoRng();
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = rng.nextInt(7);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
      seen.add(x);
    }
    expect(seen.size).toBe(7);
  });

  it('shuffle is roughly uniform (position of the ace of spades)', () => {
    const rng = createSeededRng(123);
    const counts = new Array<number>(52).fill(0);
    const trials = 26_000;
    for (let i = 0; i < trials; i++) {
      const idx = shuffledDeck(rng).findIndex((c) => c.rank === 14 && c.suit === 's');
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(trials / 52 * 0.7);
      expect(c).toBeLessThan(trials / 52 * 1.3);
    }
  });

  it('parses and prints card codes', () => {
    expect(cardCode(parseCard('As'))).toBe('As');
    expect(cardCode(parseCard('10h'))).toBe('Th');
    expect(() => parseCard('1x')).toThrow();
  });
});
