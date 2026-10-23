import type { Rng } from '../game/deck';
import type { LegalActions, PlayerAction } from '../game/types';
import { chenScore, estimateEquity } from './handStrength';
import type { BotObservation } from './observation';
import type { BotProfile } from './profiles';

/**
 * Heuristic decision making (v1):
 * - preflop: Chen score adjusted for position, table size and raises faced;
 *   push/fold mode when short-stacked;
 * - postflop: Monte Carlo equity vs. the opponents still in the hand,
 *   discounted when facing pressure, compared with pot odds;
 * - personality profiles shift every threshold and the bluff/aggression mix.
 *
 * The output is always mapped onto `legal`, so a bot can never produce an
 * illegal command whatever the heuristics suggest.
 */

export interface DecisionOptions {
  /** Monte Carlo samples for postflop equity. */
  equityIterations?: number;
}

/** What the heuristics want before it is mapped onto the legal options. */
type Intent =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'raise'; to: number }
  | { kind: 'allin' };

export function decideAction(
  obs: BotObservation,
  profile: BotProfile,
  rng: Rng,
  options: DecisionOptions = {},
): PlayerAction {
  const intent = obs.street === 'preflop' ? preflopIntent(obs, profile, rng) : postflopIntent(obs, profile, rng, options);
  return toLegalAction(intent, obs.legal);
}

function jitter(rng: Rng, amount: number): number {
  return (rng.next() * 2 - 1) * amount;
}

function preflopIntent(obs: BotObservation, profile: BotProfile, rng: Rng): Intent {
  const { legal, bigBlind } = obs;
  const chen = chenScore(obs.holeCards);
  const opponentsStacks = obs.opponents.map((o) => o.stack + o.streetBet);
  const effectiveStack = Math.min(obs.stack + obs.streetBet, Math.max(0, ...opponentsStacks));
  const stackBB = effectiveStack / bigBlind;

  // Later position and fewer players → wider ranges.
  let adjusted = chen + jitter(rng, profile.noise * 25);
  adjusted += (obs.position - 0.5) * 2;
  if (obs.playersDealt <= 3) adjusted += 1;
  if (obs.playersDealt === 2) adjusted += 1.5;

  // Short stack: push or fold.
  if (stackBB <= 10) {
    const threshold = profile.preflop.push - (10 - stackBB) * 0.35 + (obs.raisesThisStreet > 0 ? 1.5 : 0);
    if (adjusted >= threshold) return { kind: 'allin' };
    return legal.canCheck ? { kind: 'check' } : { kind: 'fold' };
  }

  const facingRaise = obs.currentBet > bigBlind;
  if (!facingRaise) {
    if (adjusted >= profile.preflop.open) {
      const limpers = obs.opponents.filter((o) => o.streetBet >= bigBlind).length - 1;
      return { kind: 'raise', to: Math.round(bigBlind * (2.5 + Math.max(0, limpers))) };
    }
    if (legal.canCheck) return { kind: 'check' };
    if (adjusted >= profile.preflop.limp && legal.toCall <= bigBlind) return { kind: 'call' };
    return { kind: 'fold' };
  }

  // Facing a raise: bigger raises and re-raises demand stronger hands.
  // Capped: a huge shove should tighten the range, not make even aces fold.
  const raiseSizeBB = obs.currentBet / bigBlind;
  const pressure = Math.min(3, Math.max(0, raiseSizeBB - 3) * 0.3) + (obs.raisesThisStreet > 1 ? 1.5 : 0);
  const commitsStack = legal.toCall > obs.stack * 0.4;

  if (adjusted >= profile.preflop.threeBet + pressure) {
    const to = obs.currentBet * 3;
    return to >= (obs.stack + obs.streetBet) * 0.6 ? { kind: 'allin' } : { kind: 'raise', to };
  }
  // Good pot odds (typically defending a blind against a small open) widen the calling range.
  const potOdds = legal.toCall / (obs.pot + legal.toCall);
  const oddsDiscount = potOdds <= 0.2 ? 2 : potOdds <= 0.3 ? 1 : 0;
  const blindDefense = obs.streetBet > 0 ? 0.5 : 0;
  const callBar = profile.preflop.call + pressure - oddsDiscount - blindDefense + (commitsStack ? 2 : 0);
  if (adjusted >= callBar) return { kind: 'call' };
  return { kind: 'fold' };
}

function postflopIntent(obs: BotObservation, profile: BotProfile, rng: Rng, options: DecisionOptions): Intent {
  const { legal } = obs;
  const opponents = obs.opponents.length;
  const iterations = options.equityIterations ?? 300;
  const rawEquity = estimateEquity(obs.holeCards, obs.board, opponents, iterations, rng);

  // Random-hand equity overrates us against someone who is betting: discount
  // it by the size of the bet we face and by how many raises happened.
  const potBeforeCall = Math.max(1, obs.pot - legal.toCall);
  const betPressure = Math.min(1.5, legal.toCall / potBeforeCall);
  const exponent = 1 + 0.6 * betPressure + 0.25 * Math.max(0, obs.raisesThisStreet - 1);
  const equity = Math.min(1, Math.max(0, rawEquity ** exponent + jitter(rng, profile.noise)));

  const pot = obs.pot;
  const betTo = (fraction: number): number => obs.currentBet + Math.round((pot + legal.toCall) * fraction);
  const roll = rng.next();

  if (legal.toCall === 0) {
    const valueBar = profile.postflop.valueBet - (obs.wasPreflopAggressor ? 0.05 : 0);
    if (equity >= valueBar) {
      if (roll < profile.aggression) return { kind: 'raise', to: betTo(equity > 0.8 ? profile.sizing + 0.15 : profile.sizing) };
      return { kind: 'check' }; // slow-play now and then
    }
    // Semi-bluff with real drawing equity before the river.
    if (obs.street !== 'river' && rawEquity >= 0.3 && roll < profile.aggression * 0.3) {
      return { kind: 'raise', to: betTo(0.5) };
    }
    const bluffChance = profile.bluff * (opponents === 1 ? 1.4 : 0.5) * (obs.wasPreflopAggressor ? 1.5 : 1);
    if (roll < bluffChance) return { kind: 'raise', to: betTo(0.5) };
    return { kind: 'check' };
  }

  const potOdds = legal.toCall / (pot + legal.toCall);
  if (equity >= profile.postflop.raise && roll < profile.aggression) {
    const to = betTo(0.8);
    return to >= (obs.stack + obs.streetBet) * 0.7 ? { kind: 'allin' } : { kind: 'raise', to };
  }
  if (equity >= potOdds + profile.postflop.callMargin) return { kind: 'call' };
  if (obs.street !== 'river' && legal.toCall <= pot * 0.35 && roll < profile.bluff * 0.5) {
    return { kind: 'raise', to: betTo(0.75) };
  }
  return { kind: 'fold' };
}

/**
 * Maps an intent onto the legal options with sensible fallbacks
 * (e.g. a raise that is not allowed becomes a call; never fold when checking
 * is free).
 */
export function toLegalAction(intent: Intent, legal: LegalActions): PlayerAction {
  const passive = (): PlayerAction => (legal.canCheck ? { type: 'check' } : legal.canCall ? { type: 'call' } : { type: 'fold' });

  switch (intent.kind) {
    case 'fold':
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    case 'check':
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    case 'call':
      return passive();
    case 'allin':
      if (legal.canAllIn) return { type: 'allin' };
      return passive();
    case 'raise': {
      const option = legal.raise;
      if (!option) {
        // Cannot make a full raise: shove only if the stack is short anyway.
        return legal.canAllIn && legal.allInIsRaise ? { type: 'allin' } : passive();
      }
      const to = Math.min(option.max, Math.max(option.min, Math.round(intent.to)));
      // Leaving a sliver behind makes no sense: just go all-in.
      if (to >= option.max * 0.9 && legal.canAllIn) return { type: 'allin' };
      return { type: option.kind, amount: to };
    }
  }
}
