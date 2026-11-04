import type { Card } from '../game/cards';
import type { TableGame } from '../hub/tableGame';
import { chooseDurakAction } from './bots';
import { applyDurakAction, createDurak, getDurakLegal, resolveBout } from './engine';
import { DurakRuleError, type DurakAction, type DurakState } from './types';
import { getDurakView, type DurakView } from './views';

/** Durak behind the hub contract — the second game, with no poker concepts in sight. */

function lowest(cards: readonly Card[], trump: string): Card {
  return [...cards].sort((a, b) => a.rank + (a.suit === trump ? 20 : 0) - (b.rank + (b.suit === trump ? 20 : 0)))[0] as Card;
}

/** Always legal: lead the lowest card, pass a throw-in, take when defending. */
function timeoutAction(state: DurakState, playerId: string): DurakAction {
  const legal = getDurakLegal(state, playerId);
  if (!legal) throw new Error(`${playerId} is not to act`);
  if (state.pending.kind === 'attack') return { type: 'attack', card: lowest(legal.attackCards, state.trump) };
  if (state.pending.kind === 'throw') return { type: 'pass' };
  return { type: 'take' };
}

export const durakGame: TableGame<DurakState, DurakAction, DurakView> = {
  id: 'durak',
  minPlayers: 2,
  // The engine plays 2–6; tables are laid out for up to four seats.
  maxPlayers: 4,
  create: (seats, rng) => createDurak(seats, { rng }),
  actor: (s) => ('playerId' in s.pending ? s.pending.playerId : null),
  act: (s, playerId, action, expectedSeq) => applyDurakAction(s, playerId, action, expectedSeq),
  auto: (s) => (s.pending.kind === 'resolve' ? { pace: 'reveal', run: resolveBout } : null),
  view: (s, viewerId) => getDurakView(s, viewerId),
  timeoutAction,
  botAction: (s, playerId, rng) => chooseDurakAction(getDurakView(s, playerId), rng),
  seq: (s) => s.seq,
  isOver: (s) => s.pending.kind === 'over',
  isRuleError: (e) => e instanceof DurakRuleError,
};
