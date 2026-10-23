import { rankName, rankPlural, type Card, type Rank, type Suit } from './cards';

/**
 * Hand categories, ordered from weakest to strongest. A royal flush is simply
 * the ace-high straight flush; it only gets a different display name.
 */
export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
} as const;
export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  0: 'High Card',
  1: 'Pair',
  2: 'Two Pair',
  3: 'Three of a Kind',
  4: 'Straight',
  5: 'Flush',
  6: 'Full House',
  7: 'Four of a Kind',
  8: 'Straight Flush',
};

export interface HandValue {
  category: HandCategory;
  /**
   * Ranks that break ties inside the category, most significant first
   * (e.g. Two Pair K-K-7-7-A → [13, 7, 14]). For straights only the top card.
   */
  tiebreak: Rank[];
  /** Single comparable number: higher is better, equal means a split. */
  score: number;
}

export interface EvaluatedHand extends HandValue {
  /** The five cards that make the hand, ordered for display. */
  bestFive: Card[];
  /** Human readable name, e.g. "Two Pair, Kings and Sevens". */
  name: string;
}

const BASE = 15;
const CATEGORY_WEIGHT = BASE ** 5;

function encodeScore(category: HandCategory, tiebreak: readonly number[]): number {
  let score = category * CATEGORY_WEIGHT;
  for (let i = 0; i < 5; i++) score += (tiebreak[i] ?? 0) * BASE ** (4 - i);
  return score;
}

/**
 * Returns the high card of the best straight contained in `mask`
 * (bit r set ⇔ rank r present, bit 1 mirrors the ace for the wheel), or 0.
 */
function straightHigh(mask: number): Rank | 0 {
  for (let high = 14; high >= 5; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high as Rank;
  }
  return 0;
}

function withWheelAce(mask: number): number {
  return mask & (1 << 14) ? mask | (1 << 1) : mask;
}

/**
 * Evaluates the best five-card poker hand out of 5–7 cards in a single pass
 * over rank/suit counts (no 21-combination brute force), so it is cheap enough
 * for the bots' Monte Carlo sampling.
 */
export function evaluate(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate expects 5–7 cards, got ${cards.length}`);
  }
  const rankCounts = new Array<number>(15).fill(0);
  const suitMasks: Record<Suit, number> = { c: 0, d: 0, h: 0, s: 0 };
  const suitCounts: Record<Suit, number> = { c: 0, d: 0, h: 0, s: 0 };
  let rankMask = 0;
  for (const card of cards) {
    rankCounts[card.rank] = (rankCounts[card.rank] ?? 0) + 1;
    suitMasks[card.suit] |= 1 << card.rank;
    suitCounts[card.suit] += 1;
    rankMask |= 1 << card.rank;
  }

  let flushSuit: Suit | null = null;
  for (const suit of ['c', 'd', 'h', 's'] as const) {
    if (suitCounts[suit] >= 5) flushSuit = suit;
  }

  // Straight flush (royal flush is the ace-high case).
  if (flushSuit) {
    const high = straightHigh(withWheelAce(suitMasks[flushSuit]));
    if (high) return make(HandCategory.StraightFlush, [high]);
  }

  // Group ranks by multiplicity, highest rank first.
  const quads: Rank[] = [];
  const trips: Rank[] = [];
  const pairs: Rank[] = [];
  const singles: Rank[] = [];
  for (let r = 14; r >= 2; r--) {
    const n = rankCounts[r] ?? 0;
    if (n === 4) quads.push(r as Rank);
    else if (n === 3) trips.push(r as Rank);
    else if (n === 2) pairs.push(r as Rank);
    else if (n === 1) singles.push(r as Rank);
  }

  const highestExcluding = (exclude: readonly Rank[], count: number): Rank[] => {
    const out: Rank[] = [];
    for (let r = 14; r >= 2 && out.length < count; r--) {
      if ((rankCounts[r] ?? 0) > 0 && !exclude.includes(r as Rank)) out.push(r as Rank);
    }
    return out;
  };

  if (quads.length > 0) {
    const q = quads[0] as Rank;
    return make(HandCategory.FourOfAKind, [q, ...highestExcluding([q], 1)]);
  }

  if (trips.length > 0) {
    const t = trips[0] as Rank;
    // The pair part of a full house may come from a second set of trips.
    const pairCandidates = [...trips.slice(1), ...pairs].sort((a, b) => b - a);
    if (pairCandidates.length > 0) {
      return make(HandCategory.FullHouse, [t, pairCandidates[0] as Rank]);
    }
  }

  if (flushSuit) {
    const flushRanks: Rank[] = [];
    for (let r = 14; r >= 2 && flushRanks.length < 5; r--) {
      if (suitMasks[flushSuit] & (1 << r)) flushRanks.push(r as Rank);
    }
    return make(HandCategory.Flush, flushRanks);
  }

  const straight = straightHigh(withWheelAce(rankMask));
  if (straight) return make(HandCategory.Straight, [straight]);

  if (trips.length > 0) {
    const t = trips[0] as Rank;
    return make(HandCategory.ThreeOfAKind, [t, ...highestExcluding([t], 2)]);
  }

  if (pairs.length >= 2) {
    const [p1, p2] = pairs as [Rank, Rank];
    return make(HandCategory.TwoPair, [p1, p2, ...highestExcluding([p1, p2], 1)]);
  }

  if (pairs.length === 1) {
    const p = pairs[0] as Rank;
    return make(HandCategory.Pair, [p, ...highestExcluding([p], 3)]);
  }

  return make(HandCategory.HighCard, singles.slice(0, 5));
}

function make(category: HandCategory, tiebreak: Rank[]): HandValue {
  return { category, tiebreak, score: encodeScore(category, tiebreak) };
}

/** Positive if `a` beats `b`, negative if `b` wins, 0 for a split. */
export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}

/**
 * Full evaluation for display purposes: also finds the exact five cards that
 * form the hand. Uses the 21-combination search, which is plenty fast for
 * a handful of calls per showdown and doubles as a cross-check in tests.
 */
export function evaluateDetailed(cards: readonly Card[]): EvaluatedHand {
  const value = evaluate(cards);
  let bestFive: Card[] = cards.slice(0, 5);
  for (const combo of combinations(cards, 5)) {
    if (evaluate(combo).score === value.score) {
      bestFive = combo;
      break;
    }
  }
  return { ...value, bestFive: orderForDisplay(bestFive, value), name: describeHand(value) };
}

/** Best hand found by brute force over all 5-card subsets (reference implementation). */
export function evaluateBruteForce(cards: readonly Card[]): HandValue {
  let best: HandValue | null = null;
  for (const combo of combinations(cards, 5)) {
    const v = evaluate(combo);
    if (!best || v.score > best.score) best = v;
  }
  if (!best) throw new Error('evaluateBruteForce expects at least 5 cards');
  return best;
}

export function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i] as T);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i] = (idx[i] as number) + 1;
    for (let j = i + 1; j < k; j++) idx[j] = (idx[j - 1] as number) + 1;
  }
}

function orderForDisplay(five: Card[], value: HandValue): Card[] {
  const isStraightLike = value.category === HandCategory.Straight || value.category === HandCategory.StraightFlush;
  const wheel = isStraightLike && value.tiebreak[0] === 5;
  const effectiveRank = (c: Card): number => (wheel && c.rank === 14 ? 1 : c.rank);
  const counts = new Map<number, number>();
  for (const c of five) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  return [...five].sort((a, b) => {
    const byCount = (counts.get(b.rank) ?? 0) - (counts.get(a.rank) ?? 0);
    if (byCount !== 0) return byCount;
    return effectiveRank(b) - effectiveRank(a);
  });
}

export function describeHand(value: HandValue): string {
  const [a, b] = value.tiebreak;
  switch (value.category) {
    case HandCategory.StraightFlush:
      return a === 14 ? 'Royal Flush' : `Straight Flush, ${rankName(a as Rank)} high`;
    case HandCategory.FourOfAKind:
      return `Four of a Kind, ${rankPlural(a as Rank)}`;
    case HandCategory.FullHouse:
      return `Full House, ${rankPlural(a as Rank)} full of ${rankPlural(b as Rank)}`;
    case HandCategory.Flush:
      return `Flush, ${rankName(a as Rank)} high`;
    case HandCategory.Straight:
      return `Straight, ${rankName(a as Rank)} high`;
    case HandCategory.ThreeOfAKind:
      return `Three of a Kind, ${rankPlural(a as Rank)}`;
    case HandCategory.TwoPair:
      return `Two Pair, ${rankPlural(a as Rank)} and ${rankPlural(b as Rank)}`;
    case HandCategory.Pair:
      return `Pair of ${rankPlural(a as Rank)}`;
    default:
      return `High Card, ${rankName(a as Rank)}`;
  }
}
