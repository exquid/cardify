import { isCard, sameCard, type Card, type Suit } from '../game/cards';
import { createDeck, shuffleInPlace, type Rng } from '../game/deck';
import {
  BOUT_LIMIT,
  DurakRuleError,
  FIRST_BOUT_LIMIT,
  HAND_SIZE,
  type Bout,
  type DurakAction,
  type DurakLegal,
  type DurakPlayer,
  type DurakState,
} from './types';

/**
 * Pure Durak engine (podkidnoy). Every command returns a new state; inputs are
 * never mutated. Life cycle of a bout (see `DurakState.pending`):
 *   attack (lead) → defend ⇄ throw … → resolve (auto: discard or pick up, draw)
 *   → next bout … → over
 * One card moves per command; the defender answers each attack card before
 * more are added (a documented simplification of simultaneous throw-ins).
 */

export interface DurakSeat {
  id: string;
  name: string;
  kind: 'human' | 'bot';
}

export interface CreateDurakOptions {
  rng?: Rng;
  /** Pre-arranged 36-card deck, top first; the last card becomes the trump card. Tests only. */
  deck?: Card[];
}

export function durakDeck(): Card[] {
  return createDeck().filter((c) => c.rank >= 6);
}

export function beats(defense: Card, attack: Card, trump: Suit): boolean {
  if (defense.suit === attack.suit) return defense.rank > attack.rank;
  return defense.suit === trump && attack.suit !== trump;
}

export function createDurak(seats: readonly DurakSeat[], options: CreateDurakOptions = {}): DurakState {
  if (seats.length < 2 || seats.length > 6) throw new DurakRuleError('Durak needs 2 to 6 players');
  if (new Set(seats.map((s) => s.id)).size !== seats.length) throw new DurakRuleError('Player ids must be unique');
  let deck: Card[];
  if (options.deck) {
    deck = [...options.deck];
    assertDeck(deck);
  } else {
    if (!options.rng) throw new DurakRuleError('createDurak needs an rng or a deck');
    deck = shuffleInPlace(durakDeck(), options.rng);
  }
  const trumpCard = deck[deck.length - 1] as Card;
  const players: DurakPlayer[] = seats.map((s, seat) => ({ id: s.id, name: s.name, kind: s.kind, seat, hand: [], out: false, place: null }));
  // Deal one card at a time, starting with seat 0.
  for (let round = 0; round < HAND_SIZE; round++) {
    for (const p of players) p.hand.push(deck.shift() as Card);
  }
  const trump = trumpCard.suit;
  const first = firstAttacker(players, trump);
  const defender = nextActive(players, first.seat) as DurakPlayer;
  const state: DurakState = {
    schemaVersion: 1,
    game: 'durak',
    players,
    trump,
    trumpCard,
    talon: deck,
    discard: [],
    bout: newBout(1, first, defender),
    pending: { kind: 'attack', playerId: first.id },
    outcome: null,
    seq: 1,
    events: [
      { type: 'deal', trumpCard },
      { type: 'bout', number: 1, attackerId: first.id, defenderId: defender.id },
    ],
  };
  return state;
}

/** The lowest trump leads; without any trump in play, seat 0 leads. */
function firstAttacker(players: readonly DurakPlayer[], trump: Suit): DurakPlayer {
  let best: { p: DurakPlayer; rank: number } | null = null;
  for (const p of players) {
    for (const c of p.hand) if (c.suit === trump && (!best || c.rank < best.rank)) best = { p, rank: c.rank };
  }
  return best?.p ?? (players[0] as DurakPlayer);
}

function newBout(number: number, attacker: DurakPlayer, defender: DurakPlayer): Bout {
  return {
    number,
    attackerId: attacker.id,
    defenderId: defender.id,
    pairs: [],
    taking: false,
    passed: [],
    limit: Math.min(number === 1 ? FIRST_BOUT_LIMIT : BOUT_LIMIT, defender.hand.length),
  };
}

function assertDeck(deck: readonly Card[]): void {
  if (deck.length !== 36) throw new DurakRuleError(`A Durak deck has 36 cards, got ${deck.length}`);
  const seen = new Set<string>();
  for (const c of deck) {
    if (!isCard(c) || c.rank < 6) throw new DurakRuleError(`Invalid Durak card ${JSON.stringify(c)}`);
    const key = `${c.rank}${c.suit}`;
    if (seen.has(key)) throw new DurakRuleError(`Duplicate card ${key}`);
    seen.add(key);
  }
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

const hasCards = (p: DurakPlayer): boolean => p.hand.length > 0;

/** Next player clockwise after `seat` who still holds cards. */
function nextActive(players: readonly DurakPlayer[], seat: number): DurakPlayer | undefined {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const p = players[(seat + i) % n] as DurakPlayer;
    if (hasCards(p)) return p;
  }
  return undefined;
}

/** Main attacker first, then the others clockwise — the defender never throws in. */
export function attackOrder(state: DurakState): DurakPlayer[] {
  const n = state.players.length;
  const attacker = state.players.find((p) => p.id === state.bout.attackerId) as DurakPlayer;
  const order: DurakPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const p = state.players[(attacker.seat + i) % n] as DurakPlayer;
    if (p.id !== state.bout.defenderId) order.push(p);
  }
  return order;
}

function player(state: DurakState, id: string): DurakPlayer {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new DurakRuleError(`No player ${id}`);
  return p;
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

function tableRanks(bout: Bout): Set<number> {
  const ranks = new Set<number>();
  for (const pair of bout.pairs) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

/** Cards `p` may throw in right now (ignores whose turn it is). */
function throwableCards(state: DurakState, p: DurakPlayer): Card[] {
  const bout = state.bout;
  if (p.id === bout.defenderId || bout.pairs.length === 0 || bout.pairs.length >= bout.limit) return [];
  const defender = player(state, bout.defenderId);
  const undefended = bout.pairs.filter((x) => !x.defense).length;
  // Without "take", every attack card must still be beatable from the defender's hand.
  if (!bout.taking && undefended >= defender.hand.length) return [];
  const ranks = tableRanks(bout);
  return p.hand.filter((c) => ranks.has(c.rank));
}

export function getDurakLegal(state: DurakState, playerId: string): DurakLegal | null {
  const pending = state.pending;
  if (!('playerId' in pending) || pending.playerId !== playerId) return null;
  const p = player(state, playerId);
  const legal: DurakLegal = { playerId, attackCards: [], canPass: false, canTake: false, defend: [] };
  if (pending.kind === 'attack') {
    legal.attackCards = [...p.hand];
  } else if (pending.kind === 'throw') {
    legal.attackCards = throwableCards(state, p);
    legal.canPass = true;
  } else {
    legal.canTake = true;
    state.bout.pairs.forEach((pair, attackIndex) => {
      if (pair.defense) return;
      legal.defend.push({ attackIndex, cards: p.hand.filter((c) => beats(c, pair.attack, state.trump)) });
    });
  }
  return legal;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function applyDurakAction(input: DurakState, playerId: string, action: DurakAction, expectedSeq?: number): DurakState {
  if (expectedSeq !== undefined && expectedSeq !== input.seq) {
    throw new DurakRuleError(`Stale command (seq ${expectedSeq}, state is at ${input.seq})`);
  }
  const legal = getDurakLegal(input, playerId);
  if (!legal) throw new DurakRuleError(`It is not ${playerId}'s turn`);
  const state = structuredClone(input);
  const bout = state.bout;
  const me = player(state, playerId);
  const takeFromHand = (card: unknown): Card => {
    if (!isCard(card)) throw new DurakRuleError('Not a card');
    const index = me.hand.findIndex((c) => sameCard(c, card));
    if (index < 0) throw new DurakRuleError('That card is not in your hand');
    return me.hand.splice(index, 1)[0] as Card;
  };

  switch (action.type) {
    case 'attack': {
      if (!legal.attackCards.some((c) => isCard(action.card) && sameCard(c, action.card))) {
        throw new DurakRuleError(state.pending.kind === 'defend' ? 'You are defending' : 'That card cannot be played now');
      }
      const card = takeFromHand(action.card);
      bout.pairs.push({ attack: card, defense: null, by: playerId });
      bout.passed = [];
      state.events.push({ type: 'attack', playerId, card });
      break;
    }
    case 'defend': {
      const option = legal.defend.find((d) => d.attackIndex === action.attackIndex);
      if (!option) throw new DurakRuleError('Nothing to beat there');
      if (!option.cards.some((c) => isCard(action.card) && sameCard(c, action.card))) throw new DurakRuleError('That card does not beat it');
      const card = takeFromHand(action.card);
      (bout.pairs[action.attackIndex] as { defense: Card | null }).defense = card;
      bout.passed = [];
      state.events.push({ type: 'defend', playerId, attackIndex: action.attackIndex, card });
      break;
    }
    case 'take': {
      if (!legal.canTake) throw new DurakRuleError('Only the defender can take');
      bout.taking = true;
      bout.passed = [];
      state.events.push({ type: 'take', playerId });
      break;
    }
    case 'pass': {
      if (!legal.canPass) throw new DurakRuleError('You cannot pass now');
      bout.passed.push(playerId);
      state.events.push({ type: 'pass', playerId });
      break;
    }
    default: {
      const unknown: never = action;
      throw new DurakRuleError(`Unknown action ${JSON.stringify(unknown)}`);
    }
  }
  settle(state);
  state.seq += 1;
  return state;
}

/** Decides who acts next inside the bout, or that the bout is over. */
function settle(state: DurakState): void {
  const bout = state.bout;
  if (bout.pairs.length === 0) {
    state.pending = { kind: 'attack', playerId: bout.attackerId };
    return;
  }
  const undefended = bout.pairs.some((x) => !x.defense);
  if (undefended && !bout.taking) {
    state.pending = { kind: 'defend', playerId: bout.defenderId };
    return;
  }
  for (const p of attackOrder(state)) {
    if (bout.passed.includes(p.id)) continue;
    if (throwableCards(state, p).length > 0) {
      state.pending = { kind: 'throw', playerId: p.id };
      return;
    }
  }
  state.pending = { kind: 'resolve' };
}

/** Ends the bout: discard or pick up, refill hands, then start the next bout or finish. */
export function resolveBout(input: DurakState): DurakState {
  if (input.pending.kind !== 'resolve') throw new DurakRuleError('The bout is not over');
  const state = structuredClone(input);
  const bout = state.bout;
  const defender = player(state, bout.defenderId);
  const cards = bout.pairs.flatMap((x) => (x.defense ? [x.attack, x.defense] : [x.attack]));
  const taken = bout.taking;
  if (taken) {
    defender.hand.push(...cards);
    state.events.push({ type: 'pickup', playerId: defender.id, count: cards.length });
  } else {
    state.discard.push(...cards);
    state.events.push({ type: 'discard', count: cards.length });
  }
  const drawOrder = [...attackOrder(state), defender];
  bout.pairs = [];

  // Refill to six: attackers in order, the defender last.
  for (const p of drawOrder) {
    const need = Math.max(0, HAND_SIZE - p.hand.length);
    const drawn = state.talon.splice(0, need);
    if (drawn.length) {
      p.hand.push(...drawn);
      state.events.push({ type: 'draw', playerId: p.id, count: drawn.length });
    }
  }

  // With the talon gone, anyone without cards is out (safe).
  if (state.talon.length === 0) {
    let place = state.players.filter((p) => p.out).length;
    for (const p of drawOrder) {
      if (!p.out && p.hand.length === 0) {
        p.out = true;
        p.place = ++place;
        state.events.push({ type: 'out', playerId: p.id, place: p.place });
      }
    }
  }

  const holding = state.players.filter(hasCards);
  if (holding.length <= 1) {
    const loser = holding[0];
    state.outcome = loser ? { kind: 'loser', loserId: loser.id } : { kind: 'draw' };
    state.pending = { kind: 'over' };
    state.events.push({ type: 'over', outcome: state.outcome });
    state.seq += 1;
    return state;
  }

  // Beaten: the defender attacks next. Taken: the defender is skipped.
  const nextAttacker = !taken && hasCards(defender) ? defender : (nextActive(state.players, defender.seat) as DurakPlayer);
  const nextDefender = nextActive(state.players, nextAttacker.seat) as DurakPlayer;
  state.bout = newBout(bout.number + 1, nextAttacker, nextDefender);
  state.pending = { kind: 'attack', playerId: nextAttacker.id };
  state.events.push({ type: 'bout', number: state.bout.number, attackerId: nextAttacker.id, defenderId: nextDefender.id });
  state.seq += 1;
  return state;
}

/** Total cards in play — always 36. */
export function cardCount(state: DurakState): number {
  return (
    state.players.reduce((n, p) => n + p.hand.length, 0) +
    state.talon.length +
    state.discard.length +
    state.bout.pairs.reduce((n, x) => n + (x.defense ? 2 : 1), 0)
  );
}
