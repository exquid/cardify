import { createDeck, type Rng } from '../game/deck';
import type { Card } from '../game/cards';
import { evaluate } from '../game/evaluator';

/**
 * Chen formula: a classic quick score for two hole cards.
 * Roughly -1 (72o) … 20 (AA).
 */
export function chenScore(hole: readonly Card[]): number {
  const [a, b] = hole;
  if (!a || !b) throw new Error('chenScore needs two cards');
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  const value = (r: number): number => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);

  if (high === low) return Math.max(5, value(high) * 2);

  let score = value(high);
  if (a.suit === b.suit) score += 2;
  const gap = high - low - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && high < 12) score += 1;
  return Math.ceil(score);
}

/**
 * Monte Carlo equity against `opponents` random hands: the share of the pot
 * the hand wins on average (ties split). Only uses the bot's own cards and the
 * public board — opponents' hole cards are sampled, never peeked at.
 */
export function estimateEquity(
  hole: readonly Card[],
  board: readonly Card[],
  opponents: number,
  iterations: number,
  rng: Rng,
): number {
  if (opponents <= 0) return 1;
  const known = new Set([...hole, ...board].map((c) => c.rank * 4 + 'cdhs'.indexOf(c.suit)));
  const pool = createDeck().filter((c) => !known.has(c.rank * 4 + 'cdhs'.indexOf(c.suit)));
  const boardNeeded = 5 - board.length;
  const draws = boardNeeded + opponents * 2;

  let equity = 0;
  for (let i = 0; i < iterations; i++) {
    // Partial Fisher–Yates: only the cards we need are shuffled to the front.
    for (let j = 0; j < draws; j++) {
      const k = j + rng.nextInt(pool.length - j);
      const tmp = pool[j] as Card;
      pool[j] = pool[k] as Card;
      pool[k] = tmp;
    }
    const fullBoard = [...board, ...pool.slice(0, boardNeeded)];
    const mine = evaluate([...hole, ...fullBoard]).score;
    let best = mine;
    let tiedWithBest = 1;
    let heroBest = true;
    for (let o = 0; o < opponents; o++) {
      const start = boardNeeded + o * 2;
      const theirs = evaluate([pool[start] as Card, pool[start + 1] as Card, ...fullBoard]).score;
      if (theirs > best) {
        best = theirs;
        heroBest = false;
        tiedWithBest = 1;
      } else if (theirs === best) {
        tiedWithBest += 1;
      }
    }
    if (heroBest) equity += 1 / tiedWithBest;
  }
  return equity / iterations;
}
