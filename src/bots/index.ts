import { createCryptoRng, type Rng } from '../game/deck';
import { applyPlayerAction } from '../game/engine';
import type { GameState, PlayerAction } from '../game/types';
import { buildObservation } from './observation';
import { BOT_PROFILES } from './profiles';
import { decideAction, type DecisionOptions } from './strategy';

export { BOT_PROFILES } from './profiles';
export type { BotProfile } from './profiles';

/** The action the acting bot would take, or null if no bot is to act. */
export function chooseBotAction(state: GameState, rng: Rng, options: DecisionOptions = {}): PlayerAction | null {
  const pending = state.hand?.pending;
  if (pending?.kind !== 'action') return null;
  const player = state.players.find((p) => p.id === pending.playerId);
  if (!player || player.kind !== 'bot' || !player.botProfile) return null;
  const observation = buildObservation(state, player.id);
  if (!observation) return null;
  return decideAction(observation, BOT_PROFILES[player.botProfile], rng, options);
}

/**
 * Lets the acting bot play one action through the regular engine command
 * (so it is validated exactly like a human action). Returns the state
 * unchanged when it is not a bot's turn.
 */
export function processBotTurn(state: GameState, rng: Rng = createCryptoRng(), options: DecisionOptions = {}): GameState {
  const action = chooseBotAction(state, rng, options);
  const pending = state.hand?.pending;
  if (!action || pending?.kind !== 'action') return state;
  return applyPlayerAction(state, pending.playerId, action, state.seq);
}
