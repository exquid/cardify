import { chooseBotAction } from '../bots';
import { DEFAULT_CONFIG } from '../game/config';
import type { Rng } from '../game/deck';
import { advance, applyPlayerAction, getLegalActions, startNextHand, startTournament } from '../game/engine';
import { IllegalActionError, type BotProfileId, type GameState, type PlayerAction, type TournamentConfig } from '../game/types';
import type { DecisionOptions } from '../bots/strategy';
import { getPlayerView, type TableView } from '../game/views';
import type { HubSeat, TableGame } from './tableGame';

/**
 * Texas Hold'em behind the hub contract. A thin adapter over the existing,
 * unchanged engine: it proves the contract fits poker without forcing poker
 * concepts into it.
 */

const PROFILES: BotProfileId[] = ['nova', 'vex', 'orion'];

function timeoutAction(s: GameState, playerId: string): PlayerAction {
  const legal = getLegalActions(s, playerId);
  return legal?.canCheck ? { type: 'check' } : { type: 'fold' };
}

const isProfile = (p: string | undefined): p is BotProfileId => p === 'nova' || p === 'vex' || p === 'orion';

/** `botOptions` lets tests trade bot strength for speed; production keeps the bots' defaults. */
export function createPokerGame(config: TournamentConfig = DEFAULT_CONFIG, botOptions: DecisionOptions = {}): TableGame<GameState, PlayerAction, TableView> {
  return {
    id: 'holdem',
    minPlayers: 2,
    maxPlayers: 6,
    create(seats: readonly HubSeat[], rng: Rng): GameState {
      let bot = 0;
      const tournament = startTournament(
        config,
        seats.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          ...(s.kind === 'bot' ? { botProfile: isProfile(s.profile) ? s.profile : (PROFILES[bot++ % PROFILES.length] as BotProfileId) } : {}),
        })),
        { rng },
      );
      return startNextHand(tournament, { rng });
    },
    actor: (s) => (s.hand?.pending.kind === 'action' ? s.hand.pending.playerId : null),
    act: (s, playerId, action, expectedSeq) => applyPlayerAction(s, playerId, action, expectedSeq),
    auto(s, rng) {
      const kind = s.hand?.pending.kind;
      if (kind === 'deal') return { pace: s.players.filter((p) => p.status === 'active').length >= 2 ? 'deal' : 'runout', run: advance };
      if (kind === 'showdown') return { pace: 'reveal', run: advance };
      if (kind === 'complete' && s.status === 'running') return { pace: 'round', run: (x) => startNextHand(x, { rng }) };
      return null;
    },
    view: (s, viewerId) => getPlayerView(s, viewerId),
    timeoutAction,
    botAction(s, playerId, rng) {
      const player = s.players.find((p) => p.id === playerId);
      const action = player?.kind === 'bot' ? chooseBotAction(s, rng, botOptions) : null;
      return action ?? timeoutAction(s, playerId);
    },
    seq: (s) => s.seq,
    isOver: (s) => s.status === 'finished',
    isRuleError: (e) => e instanceof IllegalActionError,
  };
}
