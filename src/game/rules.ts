import type { GameState, HandState, LegalActions, Player } from './types';

/**
 * Seat geometry and betting-rule helpers. Seats are numbered clockwise; "left
 * of X" means the next seat clockwise from X.
 */

export function playerAtSeat(players: readonly Player[], seat: number): Player | undefined {
  return players.find((p) => p.seat === seat);
}

/** Seats in clockwise order starting right after `fromSeat` (excluded), wrapping around. */
export function seatsAfter<T extends { seat: number }>(players: readonly T[], fromSeat: number): T[] {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((p) => p.seat > fromSeat);
  const before = sorted.filter((p) => p.seat <= fromSeat);
  return [...after, ...before];
}

/** Next player clockwise after `fromSeat` matching `predicate`. */
export function nextPlayer(
  players: readonly Player[],
  fromSeat: number,
  predicate: (p: Player) => boolean,
): Player | undefined {
  return seatsAfter(players, fromSeat).find(predicate);
}

export function isInTournament(p: Player): boolean {
  return p.status !== 'out';
}

/** Still holding cards in the current hand. */
export function isInHand(p: Player): boolean {
  return p.status === 'active' || p.status === 'allin';
}

export interface BlindPositions {
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
}

/**
 * Moving-button rule: the button advances to the next seat that is still in
 * the tournament. With three or more players SB and BB follow the button;
 * heads-up the button posts the small blind and the other player the big blind.
 */
export function blindPositions(players: readonly Player[], dealerSeat: number): BlindPositions {
  const live = players.filter(isInTournament);
  if (live.length < 2) throw new Error('Need at least two players to deal a hand');
  if (live.length === 2) {
    const bb = nextPlayer(live, dealerSeat, () => true) as Player;
    return { dealerSeat, smallBlindSeat: dealerSeat, bigBlindSeat: bb.seat };
  }
  const sb = nextPlayer(live, dealerSeat, () => true) as Player;
  const bb = nextPlayer(live, sb.seat, () => true) as Player;
  return { dealerSeat, smallBlindSeat: sb.seat, bigBlindSeat: bb.seat };
}

/**
 * Whether `p` still owes an action on this street: they have not acted yet,
 * or someone raised past what they last matched.
 */
export function needsToAct(p: Player, hand: HandState): boolean {
  return p.status === 'active' && (p.actedAtLevel === null || p.streetBet < hand.currentBet);
}

/** Total chips committed in this hand by everyone (all pots + street bets). */
export function totalPot(players: readonly Player[]): number {
  return players.reduce((sum, p) => sum + p.contribution, 0);
}

/** Sum of stacks plus everything committed to the pot. Must never change during a tournament. */
export function totalChips(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.stack + p.contribution, 0);
}

/**
 * Computes the legal options for `player` given the hand state. This is the
 * single source of truth for what the UI shows and what the engine accepts.
 *
 * No-limit rules implemented here:
 * - check only when nothing is owed;
 * - a call is capped by the stack (partial all-in call);
 * - minimum bet is one big blind; minimum raise is the previous full raise
 *   increment on top of the current bet;
 * - a player who already acted may re-raise only if the bet has grown by at
 *   least one full raise since then (a short all-in alone does not re-open
 *   the action for them);
 * - raising is pointless (and disabled) when nobody else can still put chips in.
 */
export function computeLegalActions(player: Player, hand: HandState, players: readonly Player[]): LegalActions {
  const toCall = Math.max(0, hand.currentBet - player.streetBet);
  const callAmount = Math.min(toCall, player.stack);
  const allInTo = player.streetBet + player.stack;

  const othersWhoCanRespond = players.some((p) => p.id !== player.id && p.status === 'active');
  const reopened =
    player.actedAtLevel === null || hand.currentBet - player.actedAtLevel >= hand.minRaise;
  const hasRaiseRights = othersWhoCanRespond && reopened && player.stack > toCall;

  let raise: LegalActions['raise'] = null;
  if (hasRaiseRights) {
    const kind = hand.currentBet === 0 ? 'bet' : 'raise';
    const min = kind === 'bet' ? hand.bigBlind : hand.currentBet + hand.minRaise;
    if (allInTo >= min) raise = { kind, min, max: allInTo };
  }

  const allInIsRaise = allInTo > hand.currentBet;
  const canAllIn = player.stack > 0 && (allInIsRaise ? hasRaiseRights : toCall > 0);

  return {
    playerId: player.id,
    toCall,
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0 && player.stack > 0,
    callAmount,
    callIsAllIn: toCall > 0 && callAmount === player.stack,
    raise,
    canAllIn,
    allInTo,
    allInIsRaise,
  };
}
