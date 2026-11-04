import { sameCard, type Card, type Suit } from '../game/cards';
import type { Rng } from '../game/deck';
import type { DurakAction } from './types';
import type { DurakView } from './views';

/**
 * Durak bot (v1). Decides only from the bot's own view (its hand, the table,
 * counts) — never the talon or other hands. Heuristics:
 * - lead with the lowest non-trump (prefer ranks it holds twice), trumps last;
 * - throw in cheap non-trumps; dump anything matching while the defender is taking;
 * - defend only if every attack card can be beaten without burning a high trump early,
 *   otherwise take.
 */

const value = (c: Card, trump: Suit): number => c.rank + (c.suit === trump ? 20 : 0);

function cheapest(cards: readonly Card[], trump: Suit): Card | undefined {
  return [...cards].sort((a, b) => value(a, trump) - value(b, trump))[0];
}

export function chooseDurakAction(view: DurakView, rng: Rng): DurakAction {
  const legal = view.legal;
  const hand = view.players.find((p) => p.id === view.viewerId)?.hand ?? [];
  if (!legal) throw new Error('chooseDurakAction: not this bot’s turn');
  const trump = view.trump;
  const endgame = view.talonCount === 0;

  if (view.pending.kind === 'attack') {
    const counts = new Map<number, number>();
    for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    const sorted = [...legal.attackCards].sort(
      (a, b) => value(a, trump) - value(b, trump) - ((counts.get(a.rank) ?? 0) - (counts.get(b.rank) ?? 0)) * 1.5,
    );
    const card = sorted[0] as Card;
    return { type: 'attack', card };
  }

  if (view.pending.kind === 'throw') {
    const candidates = legal.attackCards.filter((c) => {
      if (view.taking) return c.suit !== trump || endgame; // load the taker with junk
      if (c.suit === trump) return endgame && c.rank <= 10;
      return c.rank <= 11 || endgame;
    });
    const card = cheapest(candidates, trump);
    // A little variety: sometimes hold a card back early in the game.
    if (card && (endgame || view.taking || rng.next() < 0.85)) return { type: 'attack', card };
    return { type: 'pass' };
  }

  // Defending: plan a full defence with distinct cards, hardest attack first.
  const options = legal.defend.map((d) => ({ index: d.attackIndex, attack: view.pairs[d.attackIndex]?.attack as Card, cards: d.cards }));
  options.sort((a, b) => a.cards.length - b.cards.length);
  const used: Card[] = [];
  let plan: { index: number; card: Card } | null = null;
  let cost = 0;
  for (const o of options) {
    const pick = cheapest(
      o.cards.filter((c) => !used.some((u) => sameCard(u, c))),
      trump,
    );
    if (!pick) return { type: 'take' };
    used.push(pick);
    cost += pick.suit === trump ? 10 + pick.rank : 0;
    plan ??= { index: o.index, card: pick };
  }
  // Early on, picking up two or three cards beats spending a high trump.
  const tableSize = view.pairs.length;
  if (!endgame && view.talonCount > 8 && cost >= 23 && tableSize <= 2 && rng.next() < 0.8) return { type: 'take' };
  if (!plan) return { type: 'take' };
  return { type: 'defend', attackIndex: plan.index, card: plan.card };
}
