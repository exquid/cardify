import type { Card } from './cards';
import { blindsForLevel, levelIndexForHand } from './config';
import { getLegalActions } from './engine';
import { isInHand } from './rules';
import type {
  BotProfileId,
  GameEvent,
  GameState,
  HandResult,
  LegalActions,
  Pending,
  PlayerKind,
  PlayerStatus,
  Street,
} from './types';

/**
 * Read-only projections of the game state. Views never contain the deck and
 * only contain hole cards the viewer is allowed to see. This is the boundary
 * a future server would send over the network.
 */

export interface PlayerPublicView {
  id: string;
  name: string;
  kind: PlayerKind;
  botProfile: BotProfileId | null;
  seat: number;
  stack: number;
  status: PlayerStatus;
  streetBet: number;
  contribution: number;
  /** Hole cards if visible to the viewer, otherwise null. */
  holeCards: Card[] | null;
  hasCards: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isActing: boolean;
  finishPlace: number | null;
}

export interface TableView {
  viewerId: string | null;
  seq: number;
  status: GameState['status'];
  winnerId: string | null;
  handNumber: number;
  level: number;
  smallBlind: number;
  bigBlind: number;
  handsPerLevel: number;
  /** Blinds of the next level (for the "next level in N hands" hint). */
  nextBlinds: { smallBlind: number; bigBlind: number };
  handsUntilNextLevel: number;
  street: Street | null;
  board: Card[];
  /** All chips committed this hand (pots + current street bets). */
  totalPot: number;
  /** Chips already gathered in the middle from previous streets. */
  collectedPot: number;
  currentBet: number;
  pending: Pending | null;
  players: PlayerPublicView[];
  /** Legal actions for the viewer when it is their turn. */
  legal: LegalActions | null;
  result: HandResult | null;
  events: GameEvent[];
}

export function getPlayerView(state: GameState, viewerId: string | null): TableView {
  const hand = state.hand;
  const handNumber = state.handNumber;
  const levelIndex = levelIndexForHand(state.config, Math.max(1, handNumber));
  const blinds = hand ? { smallBlind: hand.smallBlind, bigBlind: hand.bigBlind } : blindsForLevel(state.config, levelIndex);
  const handsPerLevel = state.config.handsPerLevel;
  const handsUntilNextLevel = handsPerLevel - ((Math.max(1, handNumber) - 1) % handsPerLevel);
  const actingId = hand?.pending.kind === 'action' ? hand.pending.playerId : null;
  const revealed = new Set(hand?.revealed ?? []);

  const totalPot = state.players.reduce((s, p) => s + p.contribution, 0);
  const streetBets = state.players.reduce((s, p) => s + p.streetBet, 0);

  return {
    viewerId,
    seq: state.seq,
    status: state.status,
    winnerId: state.winnerId,
    handNumber,
    level: levelIndex + 1,
    ...blinds,
    handsPerLevel,
    nextBlinds: blindsForLevel(state.config, levelIndex + 1),
    handsUntilNextLevel,
    street: hand?.street ?? null,
    board: hand ? [...hand.board] : [],
    totalPot,
    collectedPot: totalPot - streetBets,
    currentBet: hand?.currentBet ?? 0,
    pending: hand ? { ...hand.pending } : null,
    players: state.players.map((p) => {
      const canSee = p.id === viewerId || revealed.has(p.id);
      const hasCards = p.holeCards.length > 0 && (isInHand(p) || (hand?.pending.kind === 'complete' && revealed.has(p.id)));
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        botProfile: p.botProfile,
        seat: p.seat,
        stack: p.stack,
        status: p.status,
        streetBet: p.streetBet,
        contribution: p.contribution,
        holeCards: canSee && p.holeCards.length > 0 ? [...p.holeCards] : null,
        hasCards,
        isDealer: hand ? hand.dealerSeat === p.seat : state.dealerSeat === p.seat,
        isSmallBlind: hand ? hand.smallBlindSeat === p.seat : false,
        isBigBlind: hand ? hand.bigBlindSeat === p.seat : false,
        isActing: p.id === actingId,
        finishPlace: p.finishPlace,
      };
    }),
    legal: viewerId ? getLegalActions(state, viewerId) : null,
    result: hand?.result ? structuredClone(hand.result) : null,
    events: hand ? redactEvents(hand.events) : [],
  };
}

/** Spectator view: no hole cards except those revealed at showdown. */
export function getPublicView(state: GameState): TableView {
  return getPlayerView(state, null);
}

function redactEvents(events: readonly GameEvent[]): GameEvent[] {
  // Events only ever contain public information (board cards and cards shown
  // at showdown), so a deep copy is enough.
  return structuredClone(events) as GameEvent[];
}
