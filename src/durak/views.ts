import type { Card, Suit } from '../game/cards';
import { getDurakLegal } from './engine';
import type { DurakEvent, DurakLegal, DurakOutcome, DurakPending, DurakState, TablePair } from './types';

/**
 * Read-only projection for one viewer: their own hand, everybody else's card
 * counts, the table. Never the talon order or other players' cards.
 */

export interface DurakPlayerView {
  id: string;
  name: string;
  kind: 'human' | 'bot';
  seat: number;
  handCount: number;
  /** Only the viewer's own hand. */
  hand: Card[] | null;
  out: boolean;
  place: number | null;
  role: 'attacker' | 'defender' | null;
  isActing: boolean;
}

export interface DurakView {
  viewerId: string | null;
  seq: number;
  trump: Suit;
  trumpCard: Card;
  talonCount: number;
  discardCount: number;
  boutNumber: number;
  limit: number;
  pairs: TablePair[];
  taking: boolean;
  pending: DurakPending;
  outcome: DurakOutcome | null;
  players: DurakPlayerView[];
  legal: DurakLegal | null;
  events: DurakEvent[];
}

export function getDurakView(state: DurakState, viewerId: string | null): DurakView {
  const acting = 'playerId' in state.pending ? state.pending.playerId : null;
  return {
    viewerId,
    seq: state.seq,
    trump: state.trump,
    trumpCard: { ...state.trumpCard },
    talonCount: state.talon.length,
    discardCount: state.discard.length,
    boutNumber: state.bout.number,
    limit: state.bout.limit,
    pairs: structuredClone(state.bout.pairs),
    taking: state.bout.taking,
    pending: { ...state.pending },
    outcome: state.outcome ? { ...state.outcome } : null,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      seat: p.seat,
      handCount: p.hand.length,
      hand: p.id === viewerId ? p.hand.map((c) => ({ ...c })) : null,
      out: p.out,
      place: p.place,
      role: state.pending.kind === 'over' ? null : p.id === state.bout.attackerId ? 'attacker' : p.id === state.bout.defenderId ? 'defender' : null,
      isActing: p.id === acting,
    })),
    legal: viewerId ? getDurakLegal(state, viewerId) : null,
    // Events only carry public information (played cards, counts).
    events: structuredClone(state.events),
  };
}
