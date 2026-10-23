import type { Pot } from './types';

export interface Contribution {
  playerId: string;
  amount: number;
  /** Folded players feed the pots but can never win them. */
  folded: boolean;
}

/**
 * Splits hand contributions into a main pot and side pots.
 *
 * Layered approach: repeatedly take the smallest remaining contribution among
 * players still contesting the hand; every player (folded or not) pays up to
 * that level into the current layer, and only the live players who reached it
 * are eligible. Layers with identical eligibility are merged.
 *
 * Chips are conserved exactly: the sum of all pot amounts always equals the
 * sum of the contributions.
 */
export function buildPots(contributions: readonly Contribution[]): Pot[] {
  for (const c of contributions) {
    if (!Number.isSafeInteger(c.amount) || c.amount < 0) {
      throw new Error(`Invalid contribution for ${c.playerId}: ${c.amount}`);
    }
  }
  const remaining = new Map(contributions.map((c) => [c.playerId, c.amount]));
  const pots: Pot[] = [];

  while ([...remaining.values()].some((v) => v > 0)) {
    const contenders = contributions.filter((c) => !c.folded && (remaining.get(c.playerId) ?? 0) > 0);
    if (contenders.length === 0) {
      // Only folded money left (cannot normally happen once uncalled bets are
      // refunded). Keep chips conserved by adding it to the last pot.
      const leftover = [...remaining.values()].reduce((a, b) => a + b, 0);
      const last = pots[pots.length - 1];
      if (last) last.amount += leftover;
      else pots.push({ amount: leftover, eligible: contributions.filter((c) => !c.folded).map((c) => c.playerId) });
      break;
    }
    const level = Math.min(...contenders.map((c) => remaining.get(c.playerId) ?? 0));
    let amount = 0;
    for (const c of contributions) {
      const r = remaining.get(c.playerId) ?? 0;
      const take = Math.min(r, level);
      amount += take;
      remaining.set(c.playerId, r - take);
    }
    const eligible = contenders.map((c) => c.playerId);
    const previous = pots[pots.length - 1];
    if (previous && sameMembers(previous.eligible, eligible)) previous.amount += amount;
    else pots.push({ amount, eligible });
  }
  return pots;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Splits `amount` between `winnerIdsInOrder` as evenly as possible. Odd chips
 * go one at a time to winners in the given order — the engine passes winners
 * sorted clockwise starting from the first seat left of the dealer button.
 */
export function splitPot(amount: number, winnerIdsInOrder: readonly string[]): { playerId: string; amount: number }[] {
  if (winnerIdsInOrder.length === 0) throw new Error('splitPot needs at least one winner');
  const share = Math.floor(amount / winnerIdsInOrder.length);
  let odd = amount - share * winnerIdsInOrder.length;
  return winnerIdsInOrder.map((playerId) => {
    const extra = odd > 0 ? 1 : 0;
    odd -= extra;
    return { playerId, amount: share + extra };
  });
}
