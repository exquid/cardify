import type { Card } from './cards';

/**
 * Engine state types. Everything here is plain JSON-serializable data so the
 * whole game can be saved to localStorage today and moved to a
 * server-authoritative runtime later without changing its shape.
 */

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type BotProfileId = 'nova' | 'vex' | 'orion';
export type PlayerKind = 'human' | 'bot';

/**
 * - active: in the hand and still able to act
 * - folded: gave up this hand
 * - allin: in the hand, no chips left, takes no further actions
 * - out:    eliminated from the tournament (not dealt in)
 */
export type PlayerStatus = 'active' | 'folded' | 'allin' | 'out';

export interface Player {
  id: string;
  name: string;
  kind: PlayerKind;
  botProfile: BotProfileId | null;
  seat: number;
  stack: number;
  holeCards: Card[];
  status: PlayerStatus;
  /** Chips put in on the current street (blinds included preflop). */
  streetBet: number;
  /** Chips put in during the whole hand. Used to build main/side pots. */
  contribution: number;
  /**
   * Table bet level at the moment the player last acted voluntarily on this
   * street, or null if they have not acted yet. Drives both "who still needs
   * to act" and whether a short all-in re-opens raising for them.
   */
  actedAtLevel: number | null;
  /** Final tournament place once eliminated (or 1 for the winner). */
  finishPlace: number | null;
}

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
}

export interface TournamentConfig {
  startingStack: number;
  handsPerLevel: number;
  blindLevels: BlindLevel[];
  /** Multiplier applied per level once the table runs out. */
  blindGrowthAfterTable: number;
}

export type PlayerActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/**
 * A command coming from a player. For `bet` and `raise`, `amount` is the
 * total the player's street bet becomes ("raise to"), not the increment.
 */
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount: number }
  | { type: 'raise'; amount: number }
  | { type: 'allin' };

export interface RaiseOption {
  kind: 'bet' | 'raise';
  /** Minimum legal total street bet for a full bet/raise. */
  min: number;
  /** Maximum total street bet (= the player's all-in amount). */
  max: number;
}

export interface LegalActions {
  playerId: string;
  /** Chips needed to match the current bet (uncapped by stack). */
  toCall: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Chips actually moved by a call (capped by stack). */
  callAmount: number;
  callIsAllIn: boolean;
  /** Null when no full bet/raise is possible (short stack or action not re-opened). */
  raise: RaiseOption | null;
  canAllIn: boolean;
  /** Street bet total if the player moves all-in. */
  allInTo: number;
  /** Whether going all-in would be a (possibly short) bet/raise rather than a call. */
  allInIsRaise: boolean;
}

/** What the hand is waiting for next. */
export type Pending =
  | { kind: 'action'; playerId: string }
  | { kind: 'deal'; street: Exclude<Street, 'preflop'> }
  | { kind: 'showdown' }
  | { kind: 'complete' };

export type GameEvent =
  | { type: 'hand-start'; handNumber: number; dealerSeat: number; smallBlind: number; bigBlind: number }
  | { type: 'level-up'; level: number; smallBlind: number; bigBlind: number }
  | { type: 'blind'; playerId: string; blind: 'small' | 'big'; amount: number; allIn: boolean }
  | { type: 'hole-cards' }
  | {
      type: 'action';
      playerId: string;
      street: Street;
      action: Exclude<PlayerActionType, 'allin'>;
      /** Chips moved by this action. */
      amount: number;
      /** Player's street bet after the action. */
      to: number;
      allIn: boolean;
    }
  | { type: 'street'; street: Exclude<Street, 'preflop'>; cards: Card[] }
  | { type: 'refund'; playerId: string; amount: number }
  | { type: 'show'; playerId: string; cards: Card[]; handName: string }
  | {
      type: 'award';
      playerId: string;
      amount: number;
      potIndex: number;
      potCount: number;
      handName: string | null;
    }
  | { type: 'eliminated'; playerId: string; place: number }
  | { type: 'tournament-won'; playerId: string };

export interface Pot {
  amount: number;
  /** Players (not folded) who can win this pot. */
  eligible: string[];
}

export interface PotAward {
  potIndex: number;
  amount: number;
  eligible: string[];
  winners: { playerId: string; amount: number }[];
}

export interface ShownHand {
  playerId: string;
  cards: Card[];
  handName: string;
  category: number;
  score: number;
  bestFive: Card[];
}

export interface HandResult {
  endedBy: 'fold' | 'showdown';
  awards: PotAward[];
  refunds: { playerId: string; amount: number }[];
  /** Only for players whose cards were revealed at showdown. */
  shown: ShownHand[];
  /** Stack change over the whole hand, per player id. */
  net: Record<string, number>;
}

export interface HandState {
  number: number;
  street: Street;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  smallBlind: number;
  bigBlind: number;
  board: Card[];
  /** Remaining undealt cards. Secret: never exposed through views. */
  deck: Card[];
  /** Highest street bet the active players must match. */
  currentBet: number;
  /** Size of the last full bet/raise increment on this street. */
  minRaise: number;
  lastAggressorId: string | null;
  pending: Pending;
  /** Players whose hole cards are public (showdown). */
  revealed: string[];
  startingStacks: Record<string, number>;
  result: HandResult | null;
  events: GameEvent[];
}

export interface Elimination {
  playerId: string;
  handNumber: number;
  place: number;
}

export interface GameState {
  schemaVersion: 1;
  config: TournamentConfig;
  players: Player[];
  /** Dealer seat of the latest hand (or the seat the first hand will use). */
  dealerSeat: number;
  handNumber: number;
  hand: HandState | null;
  status: 'running' | 'finished';
  winnerId: string | null;
  eliminations: Elimination[];
  /**
   * Monotonic command counter. Every accepted command increments it; callers
   * can pass the value they saw to reject stale or duplicated commands.
   */
  seq: number;
}

export interface SeatSetup {
  id: string;
  name: string;
  kind: PlayerKind;
  botProfile?: BotProfileId;
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
