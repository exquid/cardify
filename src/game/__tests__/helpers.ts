import { cardCode, parseCard, parseCards, type Card } from '../cards';
import { createDeck } from '../deck';
import { holeDealOrder, startNextHand, startTournament } from '../engine';
import { totalChips } from '../rules';
import type { GameState, TournamentConfig } from '../types';

export const TEST_CONFIG: TournamentConfig = {
  startingStack: 1000,
  handsPerLevel: 1000,
  blindLevels: [{ smallBlind: 10, bigBlind: 20 }],
  blindGrowthAfterTable: 1.5,
};

/**
 * Builds a deck so that the given players receive the given hole cards and
 * the board comes out as specified. Burn cards and the remainder come from the
 * unused cards in a fixed order.
 */
export function riggedDeck(dealOrder: readonly string[], holes: Record<string, string>, board = ''): Card[] {
  const holeCards = Object.fromEntries(dealOrder.map((id) => [id, parseCards(holes[id] ?? '')]));
  const boardCards = parseCards(board);
  const used = new Set([...Object.values(holeCards).flat(), ...boardCards].map(cardCode));
  const filler = createDeck().filter((c) => !used.has(cardCode(c)));
  const take = (): Card => {
    const c = filler.shift();
    if (!c) throw new Error('riggedDeck: out of filler cards');
    return c;
  };
  const deck: Card[] = [];
  for (let round = 0; round < 2; round++) {
    for (const id of dealOrder) deck.push(holeCards[id]?.[round] ?? take());
  }
  const b = [...boardCards];
  const next = (): Card => b.shift() ?? take();
  deck.push(take(), next(), next(), next()); // burn + flop
  deck.push(take(), next()); // burn + turn
  deck.push(take(), next()); // burn + river
  deck.push(...filler);
  return deck;
}

export interface TableSetup {
  stacks: number[];
  dealerSeat: number;
  holes?: Record<string, string>;
  board?: string;
  config?: Partial<TournamentConfig>;
}

/** Players are named p0..pN-1 by seat. Starts the first hand with a rigged deck. */
export function setupHand(setup: TableSetup): GameState {
  const config = { ...TEST_CONFIG, ...setup.config };
  let state = startTournament(
    config,
    setup.stacks.map((_, i) => ({ id: `p${i}`, name: `P${i}`, kind: 'bot' as const })),
    { firstDealerSeat: setup.dealerSeat },
  );
  state = structuredClone(state);
  setup.stacks.forEach((s, i) => {
    const p = state.players[i];
    if (p) {
      p.stack = s;
      if (s === 0) p.status = 'out';
    }
  });
  const order = holeDealOrder(
    state.players.filter((p) => p.stack > 0),
    setup.dealerSeat,
  ).map((p) => p.id);
  return startNextHand(state, { deck: riggedDeck(order, setup.holes ?? {}, setup.board ?? '') });
}

export function chips(state: GameState): number {
  return totalChips(state);
}

export function stackOf(state: GameState, id: string): number {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p.stack;
}

export function acting(state: GameState): string | null {
  const pending = state.hand?.pending;
  return pending?.kind === 'action' ? pending.playerId : null;
}

export { parseCard, parseCards };
