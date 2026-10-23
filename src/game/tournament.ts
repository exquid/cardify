import { DEFAULT_CONFIG } from './config';
import { startTournament, type StartTournamentOptions } from './engine';
import type { BotProfileId, GameState, SeatSetup, TournamentConfig } from './types';

/** Seat 0 is always the human; bots fill the other seats clockwise. */
export const HUMAN_ID = 'you';

export const BOT_SEATS: ReadonlyArray<{ id: string; name: string; profile: BotProfileId }> = [
  { id: 'nova', name: 'Nova', profile: 'nova' },
  { id: 'vex', name: 'Vex', profile: 'vex' },
  { id: 'orion', name: 'Orion', profile: 'orion' },
];

export function defaultSeats(humanName = 'You'): SeatSetup[] {
  return [
    { id: HUMAN_ID, name: humanName, kind: 'human' },
    ...BOT_SEATS.map((b) => ({ id: b.id, name: b.name, kind: 'bot' as const, botProfile: b.profile })),
  ];
}

/** Four-seat Sit & Go: one human against Nova, Vex and Orion. */
export function createSoloTournament(
  config: TournamentConfig = DEFAULT_CONFIG,
  options: StartTournamentOptions = {},
): GameState {
  return startTournament(config, defaultSeats(), options);
}
