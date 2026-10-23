import type { Card } from './cards';
import { blindsForLevel, levelIndexForHand } from './config';
import { createCryptoRng, shuffledDeck, type Rng } from './deck';
import { evaluateDetailed } from './evaluator';
import { buildPots, splitPot } from './pots';
import {
  blindPositions,
  computeLegalActions,
  isInHand,
  isInTournament,
  needsToAct,
  nextPlayer,
  playerAtSeat,
  seatsAfter,
  totalChips,
} from './rules';
import {
  IllegalActionError,
  type GameEvent,
  type GameState,
  type HandResult,
  type HandState,
  type LegalActions,
  type Player,
  type PlayerAction,
  type PotAward,
  type SeatSetup,
  type ShownHand,
  type Street,
  type TournamentConfig,
} from './types';

/**
 * Pure poker engine. Every command takes a GameState and returns a new one;
 * the input is never mutated (each command works on a structured clone).
 *
 * Hand life cycle (see `HandState.pending`):
 *   startNextHand → action* → deal(flop) → action* → deal(turn) → action*
 *   → deal(river) → action* → showdown → complete
 * Betting rounds that cannot have any action (everyone all-in) are skipped,
 * so the remaining board is simply dealt street by street ("run-out").
 * Dealing and showdown are separate commands so the UI can pace them
 * (Table Pulse) without ever re-running game logic.
 */

export interface StartTournamentOptions {
  /** Seat of the first hand's dealer; random when omitted. */
  firstDealerSeat?: number;
  rng?: Rng;
}

export function startTournament(
  config: TournamentConfig,
  seats: readonly SeatSetup[],
  options: StartTournamentOptions = {},
): GameState {
  if (seats.length < 2) throw new Error('A tournament needs at least two players');
  if (new Set(seats.map((s) => s.id)).size !== seats.length) throw new Error('Player ids must be unique');
  if (!Number.isSafeInteger(config.startingStack) || config.startingStack <= 0) {
    throw new Error('Starting stack must be a positive integer');
  }
  const players: Player[] = seats.map((s, seat) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    botProfile: s.botProfile ?? null,
    seat,
    stack: config.startingStack,
    holeCards: [],
    status: 'active',
    streetBet: 0,
    contribution: 0,
    actedAtLevel: null,
    finishPlace: null,
  }));
  const rng = options.rng ?? createCryptoRng();
  const firstDealer = options.firstDealerSeat ?? rng.nextInt(players.length);
  if (!playerAtSeat(players, firstDealer)) throw new Error(`No seat ${firstDealer}`);
  return {
    schemaVersion: 1,
    config,
    players,
    dealerSeat: firstDealer,
    handNumber: 0,
    hand: null,
    status: 'running',
    winnerId: null,
    eliminations: [],
    seq: 0,
  };
}

export interface StartHandOptions {
  rng?: Rng;
  /**
   * Pre-arranged deck (top of deck first). Only meant for tests and replays;
   * normal play shuffles a fresh deck with the crypto RNG.
   */
  deck?: Card[];
}

export function startNextHand(input: GameState, options: StartHandOptions = {}): GameState {
  if (input.status !== 'running') throw new IllegalActionError('Tournament is over');
  if (input.hand && input.hand.pending.kind !== 'complete') {
    throw new IllegalActionError('Current hand is still in progress');
  }
  const state = clone(input);
  const live = state.players.filter((p) => p.stack > 0);
  if (live.length < 2) throw new IllegalActionError('Not enough players with chips');

  const handNumber = state.handNumber + 1;
  // First hand uses the configured seat; afterwards the button moves to the
  // next seat still in the tournament.
  const dealerSeat =
    state.handNumber === 0 && playerAtSeat(live, state.dealerSeat)
      ? state.dealerSeat
      : (nextPlayer(live, state.dealerSeat, () => true) as Player).seat;

  for (const p of state.players) {
    p.holeCards = [];
    p.streetBet = 0;
    p.contribution = 0;
    p.actedAtLevel = null;
    p.status = p.stack > 0 ? 'active' : 'out';
  }

  const positions = blindPositions(state.players, dealerSeat);
  const levelIndex = levelIndexForHand(state.config, handNumber);
  const blinds = blindsForLevel(state.config, levelIndex);

  const deck = options.deck ? [...options.deck] : shuffledDeck(options.rng ?? createCryptoRng());
  assertValidDeck(deck);

  const events: GameEvent[] = [];
  if (handNumber > 1 && levelIndex !== levelIndexForHand(state.config, handNumber - 1)) {
    events.push({ type: 'level-up', level: levelIndex + 1, ...blinds });
  }
  events.push({ type: 'hand-start', handNumber, dealerSeat, ...blinds });

  const hand: HandState = {
    number: handNumber,
    street: 'preflop',
    dealerSeat,
    smallBlindSeat: positions.smallBlindSeat,
    bigBlindSeat: positions.bigBlindSeat,
    smallBlind: blinds.smallBlind,
    bigBlind: blinds.bigBlind,
    board: [],
    deck,
    // The amount to call preflop is the full big blind even when the big
    // blind is all-in for less.
    currentBet: blinds.bigBlind,
    minRaise: blinds.bigBlind,
    lastAggressorId: null,
    pending: { kind: 'complete' },
    revealed: [],
    startingStacks: Object.fromEntries(state.players.map((p) => [p.id, p.stack])),
    result: null,
    events,
  };
  state.hand = hand;
  state.handNumber = handNumber;
  state.dealerSeat = dealerSeat;

  postBlind(state, hand, positions.smallBlindSeat, blinds.smallBlind, 'small');
  postBlind(state, hand, positions.bigBlindSeat, blinds.bigBlind, 'big');

  // Hole cards: one at a time, two rounds, starting left of the button.
  const order = holeDealOrder(state.players, dealerSeat);
  for (let round = 0; round < 2; round++) {
    for (const p of order) p.holeCards.push(draw(hand, 1)[0] as Card);
  }
  events.push({ type: 'hole-cards' });

  settle(state, hand.bigBlindSeat);
  state.seq += 1;
  return state;
}

/** Players receiving cards, in dealing order (clockwise from the seat left of the button). */
export function holeDealOrder(players: readonly Player[], dealerSeat: number): Player[] {
  return seatsAfter(players, dealerSeat).filter((p) => p.status !== 'out');
}

export function getLegalActions(state: GameState, playerId: string): LegalActions | null {
  const hand = state.hand;
  if (!hand || hand.pending.kind !== 'action' || hand.pending.playerId !== playerId) return null;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;
  return computeLegalActions(player, hand, state.players);
}

/**
 * Validates and applies a player's action. Throws IllegalActionError for
 * anything not allowed by `getLegalActions`. Pass `expectedSeq` to reject
 * stale commands (e.g. a double tap delivering the same click twice).
 */
export function applyPlayerAction(
  input: GameState,
  playerId: string,
  action: PlayerAction,
  expectedSeq?: number,
): GameState {
  if (expectedSeq !== undefined && expectedSeq !== input.seq) {
    throw new IllegalActionError(`Stale command (seq ${expectedSeq}, state is at ${input.seq})`);
  }
  const legal = getLegalActions(input, playerId);
  if (!legal) throw new IllegalActionError(`It is not ${playerId}'s turn`);

  const state = clone(input);
  const hand = state.hand as HandState;
  const player = state.players.find((p) => p.id === playerId) as Player;

  switch (action.type) {
    case 'fold': {
      player.status = 'folded';
      player.actedAtLevel = hand.currentBet;
      logAction(hand, player, 'fold', 0);
      break;
    }
    case 'check': {
      if (!legal.canCheck) throw new IllegalActionError('Cannot check facing a bet');
      player.actedAtLevel = hand.currentBet;
      logAction(hand, player, 'check', 0);
      break;
    }
    case 'call': {
      if (!legal.canCall) throw new IllegalActionError('Nothing to call');
      commitChips(player, legal.callAmount);
      player.actedAtLevel = hand.currentBet;
      logAction(hand, player, 'call', legal.callAmount);
      break;
    }
    case 'bet':
    case 'raise': {
      const option = legal.raise;
      const amount = action.amount;
      if (!Number.isSafeInteger(amount)) throw new IllegalActionError('Bet amount must be a whole number of chips');
      if (amount === legal.allInTo && legal.canAllIn && legal.allInIsRaise) {
        // Explicit amount equal to the whole stack: treat as all-in (may be short).
        raiseTo(hand, player, amount);
        break;
      }
      if (!option) throw new IllegalActionError('Raising is not allowed here');
      if (option.kind !== action.type) {
        throw new IllegalActionError(`Use "${option.kind}" here, not "${action.type}"`);
      }
      if (amount < option.min || amount > option.max) {
        throw new IllegalActionError(`${action.type} must be between ${option.min} and ${option.max}`);
      }
      raiseTo(hand, player, amount);
      break;
    }
    case 'allin': {
      if (!legal.canAllIn) throw new IllegalActionError('All-in is not available');
      if (legal.allInIsRaise) {
        raiseTo(hand, player, legal.allInTo);
      } else {
        commitChips(player, player.stack);
        player.actedAtLevel = hand.currentBet;
        logAction(hand, player, 'call', legal.callAmount);
      }
      break;
    }
    default: {
      const unknown: never = action;
      throw new IllegalActionError(`Unknown action ${JSON.stringify(unknown)}`);
    }
  }

  settle(state, player.seat);
  state.seq += 1;
  return state;
}

/** Deals the next street when the hand is waiting for it. */
export function advanceStreet(input: GameState): GameState {
  const pending = input.hand?.pending;
  if (!pending || pending.kind !== 'deal') throw new IllegalActionError('No street to deal');
  const state = clone(input);
  const hand = state.hand as HandState;
  const street = pending.street;

  draw(hand, 1); // burn
  const cards = draw(hand, street === 'flop' ? 3 : 1);
  hand.board.push(...cards);
  hand.street = street;
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  hand.lastAggressorId = null;
  for (const p of state.players) {
    p.streetBet = 0;
    p.actedAtLevel = null;
  }
  hand.events.push({ type: 'street', street, cards });
  settle(state, hand.dealerSeat);
  state.seq += 1;
  return state;
}

/** Evaluates hands and pays every pot when the hand is waiting for showdown. */
export function resolveShowdown(input: GameState): GameState {
  if (input.hand?.pending.kind !== 'showdown') throw new IllegalActionError('Not at showdown');
  const state = clone(input);
  const hand = state.hand as HandState;
  const contenders = state.players.filter(isInHand);

  const shown: ShownHand[] = contenders.map((p) => {
    const detailed = evaluateDetailed([...p.holeCards, ...hand.board]);
    return {
      playerId: p.id,
      cards: [...p.holeCards],
      handName: detailed.name,
      category: detailed.category,
      score: detailed.score,
      bestFive: detailed.bestFive,
    };
  });
  // Reveal clockwise from the left of the button.
  const order = seatsAfter(state.players, hand.dealerSeat);
  for (const p of order) {
    const s = shown.find((x) => x.playerId === p.id);
    if (!s) continue;
    hand.revealed.push(p.id);
    hand.events.push({ type: 'show', playerId: p.id, cards: s.cards, handName: s.handName });
  }

  const pots = buildPots(
    state.players.map((p) => ({ playerId: p.id, amount: p.contribution, folded: !isInHand(p) })),
  );
  const awards: PotAward[] = pots.map((pot, potIndex) => {
    const candidates = shown.filter((s) => pot.eligible.includes(s.playerId));
    const best = Math.max(...candidates.map((c) => c.score));
    const winnerIds = order.filter((p) => candidates.some((c) => c.playerId === p.id && c.score === best)).map((p) => p.id);
    const winners = splitPot(pot.amount, winnerIds);
    for (const w of winners) {
      const player = state.players.find((p) => p.id === w.playerId) as Player;
      player.stack += w.amount;
      hand.events.push({
        type: 'award',
        playerId: w.playerId,
        amount: w.amount,
        potIndex,
        potCount: pots.length,
        handName: shown.find((s) => s.playerId === w.playerId)?.handName ?? null,
      });
    }
    return { potIndex, amount: pot.amount, eligible: pot.eligible, winners };
  });

  finishHand(state, { endedBy: 'showdown', awards, shown });
  state.seq += 1;
  return state;
}

/**
 * Generic "advance" for anything that is not a player decision (deal the next
 * street or resolve the showdown). Returns the state unchanged when the hand
 * is waiting for a player or is complete.
 */
export function advance(state: GameState): GameState {
  const kind = state.hand?.pending.kind;
  if (kind === 'deal') return advanceStreet(state);
  if (kind === 'showdown') return resolveShowdown(state);
  return state;
}

// ---------------------------------------------------------------------------
// Internals (operate on the cloned state)
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertValidDeck(deck: readonly Card[]): void {
  const seen = new Set<string>();
  for (const c of deck) {
    const key = `${c.rank}${c.suit}`;
    if (seen.has(key)) throw new Error(`Duplicate card in deck: ${key}`);
    seen.add(key);
  }
}

function draw(hand: HandState, count: number): Card[] {
  if (hand.deck.length < count) throw new Error('Deck exhausted');
  return hand.deck.splice(0, count);
}

function commitChips(player: Player, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > player.stack) {
    throw new IllegalActionError(`Invalid chip movement of ${amount} for ${player.id}`);
  }
  player.stack -= amount;
  player.streetBet += amount;
  player.contribution += amount;
  if (player.stack === 0 && player.status === 'active') player.status = 'allin';
}

function postBlind(state: GameState, hand: HandState, seat: number, amount: number, blind: 'small' | 'big'): void {
  const player = playerAtSeat(state.players, seat) as Player;
  const posted = Math.min(amount, player.stack);
  commitChips(player, posted);
  hand.events.push({ type: 'blind', playerId: player.id, blind, amount: posted, allIn: player.stack === 0 });
}

function raiseTo(hand: HandState, player: Player, target: number): void {
  const previousBet = hand.currentBet;
  const moved = target - player.streetBet;
  commitChips(player, moved);
  const increment = target - previousBet;
  // Only a full bet/raise sets the new minimum raise size; a short all-in
  // raises the amount to call but leaves minRaise unchanged.
  if (increment >= hand.minRaise) hand.minRaise = increment;
  if (increment > 0) hand.lastAggressorId = player.id;
  hand.currentBet = Math.max(previousBet, target);
  player.actedAtLevel = hand.currentBet;
  const action = increment > 0 ? (previousBet === 0 ? 'bet' : 'raise') : 'call';
  logAction(hand, player, action, moved);
}

function logAction(
  hand: HandState,
  player: Player,
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise',
  amount: number,
): void {
  hand.events.push({
    type: 'action',
    playerId: player.id,
    street: hand.street,
    action,
    amount,
    to: player.streetBet,
    allIn: player.status === 'allin',
  });
}

/**
 * Decides what the hand waits for after any state change.
 * `fromSeat` is the seat to search clockwise from for the next actor.
 */
function settle(state: GameState, fromSeat: number): void {
  const hand = state.hand as HandState;
  const inHand = state.players.filter(isInHand);

  if (inHand.length === 1) {
    awardUncontested(state, inHand[0] as Player);
    return;
  }

  if (!bettingRoundComplete(state)) {
    const next = nextPlayer(state.players, fromSeat, (p) => needsToAct(p, hand));
    if (next) {
      hand.pending = { kind: 'action', playerId: next.id };
      return;
    }
  }

  refundUncalled(state);
  hand.pending = nextStreetPending(hand.street);
}

function bettingRoundComplete(state: GameState): boolean {
  const hand = state.hand as HandState;
  const active = state.players.filter((p) => p.status === 'active');
  if (active.length === 0) return true;
  if (active.length === 1) {
    // Nobody left to bet against: the last active player only has to match
    // the largest all-in, never to act otherwise.
    const sole = active[0] as Player;
    const maxOther = Math.max(0, ...state.players.filter((p) => p.status === 'allin').map((p) => p.streetBet));
    return sole.streetBet >= maxOther;
  }
  return !active.some((p) => needsToAct(p, hand));
}

function nextStreetPending(street: Street): HandState['pending'] {
  switch (street) {
    case 'preflop':
      return { kind: 'deal', street: 'flop' };
    case 'flop':
      return { kind: 'deal', street: 'turn' };
    case 'turn':
      return { kind: 'deal', street: 'river' };
    default:
      return { kind: 'showdown' };
  }
}

/**
 * Returns the part of the biggest street bet that nobody else matched.
 * Folded players' bets count as matched chips (they stay in the pot).
 */
function refundUncalled(state: GameState): void {
  const hand = state.hand as HandState;
  const sorted = [...state.players].sort((a, b) => b.streetBet - a.streetBet);
  const top = sorted[0];
  const second = sorted[1];
  if (!top || !second) return;
  const excess = top.streetBet - second.streetBet;
  if (excess <= 0) return;
  top.stack += excess;
  top.streetBet -= excess;
  top.contribution -= excess;
  if (top.status === 'allin' && top.stack > 0) top.status = 'active';
  hand.events.push({ type: 'refund', playerId: top.id, amount: excess });
  hand.currentBet = top.streetBet;
}

function awardUncontested(state: GameState, winner: Player): void {
  const hand = state.hand as HandState;
  refundUncalled(state);
  const amount = state.players.reduce((sum, p) => sum + p.contribution, 0);
  winner.stack += amount;
  hand.events.push({ type: 'award', playerId: winner.id, amount, potIndex: 0, potCount: 1, handName: null });
  finishHand(state, {
    endedBy: 'fold',
    awards: [
      {
        potIndex: 0,
        amount,
        eligible: [winner.id],
        winners: [{ playerId: winner.id, amount }],
      },
    ],
    shown: [],
  });
}

function finishHand(state: GameState, partial: Pick<HandResult, 'endedBy' | 'awards' | 'shown'>): void {
  const hand = state.hand as HandState;
  const refunds = hand.events
    .filter((e): e is Extract<GameEvent, { type: 'refund' }> => e.type === 'refund')
    .map((e) => ({ playerId: e.playerId, amount: e.amount }));

  for (const p of state.players) {
    p.streetBet = 0;
    p.contribution = 0;
  }
  const net: Record<string, number> = {};
  for (const p of state.players) net[p.id] = p.stack - (hand.startingStacks[p.id] ?? p.stack);

  hand.result = { ...partial, refunds, net };
  hand.pending = { kind: 'complete' };
  hand.currentBet = 0;

  recordEliminations(state);
}

/**
 * Busted players get their finishing place. When several bust in the same
 * hand, whoever started the hand with more chips finishes higher.
 */
function recordEliminations(state: GameState): void {
  const hand = state.hand as HandState;
  const busted = state.players
    .filter((p) => isInTournament(p) && p.stack === 0)
    .sort((a, b) => (hand.startingStacks[a.id] ?? 0) - (hand.startingStacks[b.id] ?? 0));
  const remainingBefore = state.players.filter(isInTournament).length;
  busted.forEach((p, i) => {
    const place = remainingBefore - i;
    p.status = 'out';
    p.finishPlace = place;
    state.eliminations.push({ playerId: p.id, handNumber: hand.number, place });
    hand.events.push({ type: 'eliminated', playerId: p.id, place });
  });

  const survivors = state.players.filter(isInTournament);
  if (survivors.length === 1) {
    const champion = survivors[0] as Player;
    champion.finishPlace = 1;
    state.status = 'finished';
    state.winnerId = champion.id;
    hand.events.push({ type: 'tournament-won', playerId: champion.id });
  }
}

/** Debug/test helper: throws if chips were created or destroyed. */
export function assertChipConservation(state: GameState): void {
  const expected = state.config.startingStack * state.players.length;
  const actual = totalChips(state);
  if (actual !== expected) throw new Error(`Chip conservation violated: ${actual} != ${expected}`);
  for (const p of state.players) {
    if (p.stack < 0 || p.contribution < 0 || p.streetBet < 0) {
      throw new Error(`Negative chips for ${p.id}`);
    }
  }
}
