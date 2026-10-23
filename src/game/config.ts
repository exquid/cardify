import type { BlindLevel, TournamentConfig } from './types';

export const DEFAULT_BLIND_LEVELS: BlindLevel[] = [
  { smallBlind: 10, bigBlind: 20 },
  { smallBlind: 15, bigBlind: 30 },
  { smallBlind: 25, bigBlind: 50 },
  { smallBlind: 50, bigBlind: 100 },
  { smallBlind: 75, bigBlind: 150 },
  { smallBlind: 100, bigBlind: 200 },
  { smallBlind: 150, bigBlind: 300 },
  { smallBlind: 200, bigBlind: 400 },
  { smallBlind: 300, bigBlind: 600 },
  { smallBlind: 400, bigBlind: 800 },
  { smallBlind: 500, bigBlind: 1000 },
];

export const DEFAULT_CONFIG: TournamentConfig = {
  startingStack: 2000,
  handsPerLevel: 8,
  blindLevels: DEFAULT_BLIND_LEVELS,
  blindGrowthAfterTable: 1.5,
};

/** Zero-based blind level for a 1-based hand number. */
export function levelIndexForHand(config: TournamentConfig, handNumber: number): number {
  return Math.max(0, Math.floor((handNumber - 1) / Math.max(1, config.handsPerLevel)));
}

/**
 * Blinds for a level. Past the end of the table, blinds keep growing by
 * `blindGrowthAfterTable`, rounded to tidy multiples of 5.
 */
export function blindsForLevel(config: TournamentConfig, levelIndex: number): BlindLevel {
  const table = config.blindLevels;
  if (table.length === 0) throw new Error('Tournament config needs at least one blind level');
  const direct = table[levelIndex];
  if (direct) return direct;
  const last = table[table.length - 1] as BlindLevel;
  const extra = levelIndex - (table.length - 1);
  const factor = config.blindGrowthAfterTable ** extra;
  const round5 = (n: number): number => Math.max(5, Math.round(n / 5) * 5);
  const smallBlind = round5(last.smallBlind * factor);
  return { smallBlind, bigBlind: Math.max(smallBlind * 2, round5(last.bigBlind * factor)) };
}
