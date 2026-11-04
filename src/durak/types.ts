import type { Card, Suit } from '../game/cards';

/**
 * Durak (podkidnoy, 36 cards) — engine state. Plain JSON, like the poker
 * engine, so it can be saved, sent and replayed. Rules: docs/durak-rules.md.
 */

export const HAND_SIZE = 6;
export const FIRST_BOUT_LIMIT = 5;
export const BOUT_LIMIT = 6;

export interface DurakPlayer {
  id: string;
  name: string;
  kind: 'human' | 'bot';
  seat: number;
  hand: Card[];
  /** No cards left after the talon ran out: this player is safe. */
  out: boolean;
  /** Order of getting out (1 = first). */
  place: number | null;
}

export interface TablePair {
  attack: Card;
  defense: Card | null;
  /** Who played the attack card. */
  by: string;
}

export interface Bout {
  number: number;
  attackerId: string;
  defenderId: string;
  pairs: TablePair[];
  /** The defender declared "take": attackers may still add cards, then the defender picks everything up. */
  taking: boolean;
  /** Attackers who passed since the table last changed. */
  passed: string[];
  /** Maximum number of attack cards in this bout. */
  limit: number;
}

export type DurakPending =
  | { kind: 'attack'; playerId: string }
  | { kind: 'defend'; playerId: string }
  | { kind: 'throw'; playerId: string }
  | { kind: 'resolve' }
  | { kind: 'over' };

export type DurakAction =
  | { type: 'attack'; card: Card }
  | { type: 'defend'; attackIndex: number; card: Card }
  | { type: 'take' }
  | { type: 'pass' };

export type DurakOutcome = { kind: 'loser'; loserId: string } | { kind: 'draw' };

export type DurakEvent =
  | { type: 'deal'; trumpCard: Card }
  | { type: 'bout'; number: number; attackerId: string; defenderId: string }
  | { type: 'attack'; playerId: string; card: Card }
  | { type: 'defend'; playerId: string; attackIndex: number; card: Card }
  | { type: 'pass'; playerId: string }
  | { type: 'take'; playerId: string }
  | { type: 'pickup'; playerId: string; count: number }
  | { type: 'discard'; count: number }
  /** Card faces drawn from the talon are private: only the count is public. */
  | { type: 'draw'; playerId: string; count: number }
  | { type: 'out'; playerId: string; place: number }
  | { type: 'over'; outcome: DurakOutcome };

export interface DurakState {
  schemaVersion: 1;
  game: 'durak';
  players: DurakPlayer[];
  trump: Suit;
  /** The face-up card under the talon; it is drawn last. */
  trumpCard: Card;
  /** Undrawn cards, top first (the trump card is the last one). Secret. */
  talon: Card[];
  discard: Card[];
  bout: Bout;
  pending: DurakPending;
  outcome: DurakOutcome | null;
  seq: number;
  events: DurakEvent[];
}

export interface DurakLegal {
  playerId: string;
  /** Cards this player may lead or throw in now. */
  attackCards: Card[];
  canPass: boolean;
  canTake: boolean;
  /** For each undefended attack card, the cards that beat it. */
  defend: { attackIndex: number; cards: Card[] }[];
}

export class DurakRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurakRuleError';
  }
}
