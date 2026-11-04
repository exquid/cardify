import type { Rng } from '../game/deck';

/**
 * The card hub's game contract (Stage 3).
 *
 * Everything a shell (solo driver) or a table server needs from a turn-based
 * card game, and nothing more. Deliberately free of poker concepts: no chips,
 * blinds, streets or hands — a game only says who must decide, what may
 * happen automatically, and what each viewer is allowed to see.
 *
 * Implementations are pure: every function returns a new state and never
 * mutates its input, so states can be stored, sent and replayed.
 */

export type GameId = 'holdem' | 'durak' | 'blackjack';

export interface HubSeat {
  id: string;
  name: string;
  kind: 'human' | 'bot';
}

/** Automatic work a game wants done next (dealing, showdown, next round…). */
export interface AutoStep<State> {
  /** Pacing hint for drivers: how long a human would expect to wait. */
  pace: 'quick' | 'deal' | 'reveal' | 'round';
  run(state: State): State;
}

export interface TableGame<State, Action, View> {
  readonly id: GameId;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /** Creates a game for these seats and deals the first round. */
  create(seats: readonly HubSeat[], rng: Rng): State;

  /** The player who must decide now, or null (automatic work pending, or game over). */
  actor(state: State): string | null;

  /**
   * Validates and applies an action. Throws the game's rules error for
   * anything illegal, leaving the input untouched. `expectedSeq` rejects
   * stale or duplicated commands.
   */
  act(state: State, playerId: string, action: Action, expectedSeq?: number): State;

  /** Automatic work to run next, or null when waiting for a player or finished. */
  auto(state: State, rng: Rng): AutoStep<State> | null;

  /** The private projection for one viewer (null = spectator). Never contains hidden cards of others. */
  view(state: State, viewerId: string | null): View;

  /** What a server plays for a player whose clock ran out. Always legal. */
  timeoutAction(state: State, playerId: string): Action;

  /** A bot's choice for `playerId`. Always legal. */
  botAction(state: State, playerId: string, rng: Rng): Action;

  /** Monotonic command counter (stale-command protection). */
  seq(state: State): number;

  isOver(state: State): boolean;
}

/**
 * Plays automatic steps and bot/timeout decisions until a human must act or
 * the game is over. Used by tests and by simple drivers.
 * `decide` picks the action for an actor (defaults to the bot's choice).
 */
export function runUntilHuman<S, A, V>(
  game: TableGame<S, A, V>,
  start: S,
  rng: Rng,
  isHuman: (playerId: string) => boolean,
  maxSteps = 10_000,
): S {
  let state = start;
  for (let i = 0; i < maxSteps; i++) {
    if (game.isOver(state)) return state;
    const actor = game.actor(state);
    if (actor) {
      if (isHuman(actor)) return state;
      state = game.act(state, actor, game.botAction(state, actor, rng), game.seq(state));
      continue;
    }
    const step = game.auto(state, rng);
    if (!step) return state;
    state = step.run(state);
  }
  throw new Error(`${game.id}: no progress after ${maxSteps} steps`);
}
