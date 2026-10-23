import type { Card } from '../game/cards';
import { seatsAfter } from '../game/rules';
import type { GameState, LegalActions, PlayerStatus, Street } from '../game/types';
import { getPlayerView, type TableView } from '../game/views';

/**
 * Everything a bot is allowed to know. Built exclusively from the bot's own
 * player view, so the deck and other players' hole cards are physically
 * absent — not merely ignored.
 */
export interface BotObservation {
  botId: string;
  holeCards: Card[];
  board: Card[];
  street: Street;
  stack: number;
  streetBet: number;
  /** All chips in the middle, including current street bets. */
  pot: number;
  currentBet: number;
  bigBlind: number;
  legal: LegalActions;
  opponents: { id: string; stack: number; streetBet: number; status: PlayerStatus }[];
  /** 0 = first to act postflop … 1 = on the button (acts last). */
  position: number;
  /** Players dealt into the hand (table size for this hand). */
  playersDealt: number;
  /** Bets and raises made on the current street so far. */
  raisesThisStreet: number;
  /** Whether this bot made the last bet/raise preflop. */
  wasPreflopAggressor: boolean;
}

export function buildObservation(state: GameState, botId: string): BotObservation | null {
  const view: TableView = getPlayerView(state, botId);
  const me = view.players.find((p) => p.id === botId);
  if (!me || !view.legal || !me.holeCards || !view.street) return null;

  const dealt = view.players.filter((p) => p.status !== 'out');
  const dealerSeat = dealt.find((p) => p.isDealer)?.seat ?? me.seat;
  const order = seatsAfter(dealt, dealerSeat);
  const index = order.findIndex((p) => p.id === botId);
  const position = order.length > 1 ? index / (order.length - 1) : 1;

  const actions = view.events.filter((e) => e.type === 'action');
  const raisesThisStreet = actions.filter(
    (e) => e.street === view.street && (e.action === 'bet' || e.action === 'raise'),
  ).length;
  const preflopAggression = actions.filter((e) => e.street === 'preflop' && e.action === 'raise');
  const lastPreflopRaiser = preflopAggression[preflopAggression.length - 1]?.playerId ?? null;

  return {
    botId,
    holeCards: me.holeCards,
    board: view.board,
    street: view.street,
    stack: me.stack,
    streetBet: me.streetBet,
    pot: view.totalPot,
    currentBet: view.currentBet,
    bigBlind: view.bigBlind,
    legal: view.legal,
    opponents: view.players
      .filter((p) => p.id !== botId && (p.status === 'active' || p.status === 'allin'))
      .map((p) => ({ id: p.id, stack: p.stack, streetBet: p.streetBet, status: p.status })),
    position,
    playersDealt: dealt.length,
    raisesThisStreet,
    wasPreflopAggressor: lastPreflopRaiser === botId,
  };
}
