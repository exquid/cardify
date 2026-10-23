import { RANKS, SUITS, type Card } from './cards';

/**
 * Source of randomness. Abstracted so tests can use a deterministic generator
 * and production code can use the Web Crypto API.
 */
export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Uniform float in [0, 1). Used by bots for mixing decisions, never for dealing. */
  next(): number;
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

/** In-place Fisher–Yates shuffle. Returns the same array for convenience. */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

export function shuffledDeck(rng: Rng): Card[] {
  return shuffleInPlace(createDeck(), rng);
}

/**
 * Cryptographically strong RNG backed by `crypto.getRandomValues`.
 * Uses rejection sampling so that every integer in range is equally likely
 * (plain `x % n` would bias the low values).
 */
export function createCryptoRng(): Rng {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Web Crypto API (crypto.getRandomValues) is not available');
  }
  const buffer = new Uint32Array(1);
  const nextUint32 = (): number => {
    cryptoApi.getRandomValues(buffer);
    return buffer[0] as number;
  };
  return {
    nextInt(maxExclusive: number): number {
      assertRange(maxExclusive);
      const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
      let x = nextUint32();
      while (x >= limit) x = nextUint32();
      return x % maxExclusive;
    },
    next(): number {
      return nextUint32() / 0x1_0000_0000;
    },
  };
}

/**
 * Small deterministic PRNG (mulberry32) for tests and reproducible
 * simulations. Never used for real dealing.
 */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  return {
    nextInt(maxExclusive: number): number {
      assertRange(maxExclusive);
      return Math.floor(next() * maxExclusive);
    },
    next,
  };
}

function assertRange(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new RangeError(`nextInt: invalid bound ${maxExclusive}`);
  }
}
