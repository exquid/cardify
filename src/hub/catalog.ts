import type { GameId } from './tableGame';

/** The card room's catalogue (Stage 3). Presentation lives in ui/components.ts. */

export type GameStatus = 'open' | 'soon';

export interface GameEntry {
  id: GameId;
  name: string;
  blurb: string;
  players: string;
  status: GameStatus;
  /** Ways the game can be played today. */
  modes: { solo: boolean; online: boolean };
}

export const GAMES: readonly GameEntry[] = [
  {
    id: 'holdem',
    name: "Texas Hold'em",
    blurb: 'No-Limit. A four-seat Sit & Go against bots, or a private table for 2 to 6.',
    players: '2–6 players',
    status: 'open',
    modes: { solo: true, online: true },
  },
  {
    id: 'durak',
    name: 'Durak',
    blurb: 'The classic shedding game: beat every attack or pick up the cards.',
    players: '2–4 players',
    status: 'open',
    modes: { solo: true, online: false },
  },
  {
    id: 'blackjack',
    name: 'Blackjack',
    blurb: 'Twenty-one against the dealer, one shoe at a time.',
    players: '1–5 players',
    status: 'soon',
    modes: { solo: false, online: false },
  },
];

export function gameById(id: GameId): GameEntry {
  const game = GAMES.find((g) => g.id === id);
  if (!game) throw new Error(`Unknown game ${id}`);
  return game;
}
