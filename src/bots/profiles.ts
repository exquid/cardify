import type { BotProfileId } from '../game/types';

/**
 * Personality knobs. Preflop thresholds are in Chen-formula points
 * (AA = 20, 72o ≈ -1). For reference, ≥5 covers ~43% of
 * starting hands, ≥6 ~26%, ≥7 ~18%, ≥8 ~11%, ≥10 ~4%; postflop thresholds are in estimated equity (0..1).
 */
export interface BotProfile {
  id: BotProfileId;
  name: string;
  archetype: string;
  tagline: string;
  preflop: {
    /** Open-raise an unopened pot. */
    open: number;
    /** Limp / complete the small blind. */
    limp: number;
    /** Call a single raise. */
    call: number;
    /** Re-raise (3-bet). */
    threeBet: number;
    /** Shove threshold when short (≤ 10 BB). */
    push: number;
  };
  postflop: {
    /** Equity needed to bet for value when checked to. */
    valueBet: number;
    /** Equity needed to raise a bet. */
    raise: number;
    /** Added to pot odds before calling (negative = calls lighter). */
    callMargin: number;
  };
  /** Probability of acting aggressively when the hand qualifies. */
  aggression: number;
  /** Base bluff frequency. */
  bluff: number;
  /** Bet size as a fraction of the pot. */
  sizing: number;
  /** Random jitter applied to hand strength so play is not robotic. */
  noise: number;
}

export const BOT_PROFILES: Record<BotProfileId, BotProfile> = {
  nova: {
    id: 'nova',
    name: 'Nova',
    archetype: 'The careful analyst',
    tagline: 'Picks her spots, rarely bluffs, protects her stack.',
    preflop: { open: 7, limp: 5.5, call: 8, threeBet: 11, push: 7 },
    postflop: { valueBet: 0.6, raise: 0.78, callMargin: 0.07 },
    aggression: 0.65,
    bluff: 0.03,
    sizing: 0.55,
    noise: 0.03,
  },
  vex: {
    id: 'vex',
    name: 'Vex',
    archetype: 'The aggressive opportunist',
    tagline: 'Bets often and raises light — but never at random.',
    preflop: { open: 5, limp: 4, call: 6, threeBet: 9, push: 5 },
    postflop: { valueBet: 0.5, raise: 0.66, callMargin: -0.01 },
    aggression: 0.9,
    bluff: 0.16,
    sizing: 0.7,
    noise: 0.05,
  },
  orion: {
    id: 'orion',
    name: 'Orion',
    archetype: 'The balanced strategist',
    tagline: 'Mixes value bets, calls and the occasional well-timed bluff.',
    preflop: { open: 6, limp: 5, call: 7, threeBet: 10, push: 6 },
    postflop: { valueBet: 0.55, raise: 0.72, callMargin: 0.03 },
    aggression: 0.78,
    bluff: 0.08,
    sizing: 0.62,
    noise: 0.04,
  },
};
