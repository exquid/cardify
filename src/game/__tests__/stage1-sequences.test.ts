import { describe, expect, it } from 'vitest';
import { processBotTurn } from '../../bots';
import { cardCode } from '../cards';
import { DEFAULT_BLIND_LEVELS } from '../config';
import { createSeededRng, type Rng } from '../deck';
import { advance, advanceStreet, applyPlayerAction, getLegalActions, resolveShowdown, startNextHand, startTournament } from '../engine';
import { evaluateBruteForce } from '../evaluator';
import { needsToAct, seatsAfter } from '../rules';
import { IllegalActionError, type BotProfileId, type GameState, type LegalActions, type PlayerAction } from '../types';

/**
 * Stage 1 generated sequences (P13 + supporting P04/P07/P08/P11/P12/P14).
 * Seeded and reproducible: a failure message names the seed and step.
 * After every command the state invariants are checked; before every action
 * the legal-action list is cross-checked against what the engine accepts, and
 * a refused command must leave its input untouched. Showdown payouts are
 * compared with an independent oracle (own pot layering + brute-force
 * evaluator + documented odd-chip rule).
 */

const SEEDS = 150;
const MAX_HANDS_PER_TOURNAMENT = 30;
const MAX_COMMANDS_PER_HAND = 400;
const PROFILES: BotProfileId[] = ['nova', 'vex', 'orion'];

interface Stats {
  tournaments: number;
  hands: number;
  showdowns: number;
  multiPotShowdowns: number;
  commands: number;
  refusalsChecked: number;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[rng.nextInt(items.length)] as T;
}

function randomStacks(rng: Rng, n: number): number[] {
  const pattern = rng.nextInt(4);
  return Array.from({ length: n }, () => {
    switch (pattern) {
      case 0:
        return 2000; // equal stacks
      case 1:
        return 50 + rng.nextInt(3000); // mixed
      case 2:
        return rng.next() < 0.4 ? 1 + rng.nextInt(40) : 200 + rng.nextInt(800); // some below the blinds
      default:
        return pick(rng, [15, 25, 100, 333, 1000, 2001]); // awkward sizes
    }
  });
}

function setupTournament(rng: Rng, botDriven: boolean): { state: GameState; total: number } {
  const n = 2 + rng.nextInt(5); // 2..6 seats
  const config = {
    startingStack: 1000,
    handsPerLevel: 2 + rng.nextInt(4),
    blindLevels: DEFAULT_BLIND_LEVELS,
    blindGrowthAfterTable: 1.5,
  };
  const seats = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    kind: 'bot' as const,
    ...(botDriven ? { botProfile: pick(rng, PROFILES) } : {}),
  }));
  const state = structuredClone(startTournament(config, seats, { rng }));
  const stacks = randomStacks(rng, n);
  state.players.forEach((p, i) => (p.stack = stacks[i] as number));
  return { state, total: stacks.reduce((a, b) => a + b, 0) };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function checkInvariants(s: GameState, total: number, where: string): void {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  let sum = 0;
  for (const p of s.players) {
    for (const [k, v] of [['stack', p.stack], ['contribution', p.contribution], ['streetBet', p.streetBet]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) fail(`${p.id}.${k} = ${v}`);
    }
    if (p.streetBet > p.contribution) fail(`${p.id} streetBet > contribution`);
    sum += p.stack + p.contribution;
  }
  if (sum !== total) fail(`chips ${sum} != ${total}`);

  const hand = s.hand;
  if (!hand) return;
  const burns = hand.events.filter((e) => e.type === 'street').length;
  const cards = [...s.players.flatMap((p) => p.holeCards), ...hand.board, ...hand.deck].map(cardCode);
  if (new Set(cards).size !== cards.length) fail('duplicate card');
  if (cards.length !== 52 - burns) fail(`card count ${cards.length} != ${52 - burns}`);
  if (hand.board.length !== [0, 3, 4, 5][burns]) fail(`board ${hand.board.length} after ${burns} streets`);

  const pending = hand.pending;
  const withLegal = s.players.filter((p) => getLegalActions(s, p.id) !== null).map((p) => p.id);
  if (pending.kind === 'action') {
    const actor = s.players.find((p) => p.id === pending.playerId);
    if (!actor) fail('unknown actor');
    if (actor!.status !== 'active' || !needsToAct(actor!, hand)) fail(`actor ${actor!.id} has no decision`);
    if (withLegal.length !== 1 || withLegal[0] !== actor!.id) fail(`legal actions for ${withLegal.join(',')}`);
  } else if (withLegal.length > 0) {
    fail(`legal actions while pending ${pending.kind}`);
  }
  if (pending.kind === 'complete') {
    if (!hand.result) fail('complete without result');
    if (s.players.some((p) => p.streetBet !== 0 || p.contribution !== 0)) fail('chips left in the middle');
    const net = Object.values(hand.result!.net).reduce((a, b) => a + b, 0);
    if (net !== 0) fail(`net sum ${net}`);
  } else if (hand.result) {
    fail('result before completion');
  }
}

/** Every advertised option must be accepted; options not advertised must be refused without side effects. */
function checkLegalAgreement(s: GameState, id: string, legal: LegalActions, rng: Rng, stats: Stats, where: string): void {
  const accepts = (a: PlayerAction): void => {
    try {
      applyPlayerAction(s, id, a, s.seq);
    } catch (error) {
      throw new Error(`${where}: advertised ${JSON.stringify(a)} refused: ${String(error)}`);
    }
  };
  accepts({ type: 'fold' });
  if (legal.canCheck) accepts({ type: 'check' });
  if (legal.canCall) accepts({ type: 'call' });
  if (legal.canAllIn) accepts({ type: 'allin' });
  if (legal.raise) {
    accepts({ type: legal.raise.kind, amount: legal.raise.min });
    accepts({ type: legal.raise.kind, amount: legal.raise.max });
    accepts({ type: legal.raise.kind, amount: legal.raise.min + rng.nextInt(legal.raise.max - legal.raise.min + 1) });
  }

  const refused: PlayerAction[] = [];
  if (!legal.canCheck) refused.push({ type: 'check' });
  if (!legal.canCall) refused.push({ type: 'call' });
  if (!legal.canAllIn) refused.push({ type: 'allin' });
  const kind = s.hand!.currentBet === 0 ? 'bet' : 'raise';
  if (legal.raise) {
    if (legal.raise.min - 1 !== legal.allInTo) refused.push({ type: kind, amount: legal.raise.min - 1 });
    refused.push({ type: kind, amount: legal.raise.max + 1 });
    refused.push({ type: kind, amount: legal.raise.min + 0.5 });
  } else {
    const target = s.hand!.currentBet + s.hand!.minRaise;
    if (target !== legal.allInTo) refused.push({ type: kind, amount: target });
  }
  const before = structuredClone(s);
  const expectRefused = (run: () => unknown, label: string): void => {
    let threw = false;
    try {
      run();
    } catch (error) {
      if (!(error instanceof IllegalActionError)) throw new Error(`${where}: ${label} threw a non-rules error: ${String(error)}`);
      threw = true;
    }
    if (!threw) throw new Error(`${where}: ${label} was accepted`);
    stats.refusalsChecked += 1;
  };
  for (const a of refused) expectRefused(() => applyPlayerAction(s, id, a, s.seq), JSON.stringify(a));
  const other = s.players.find((p) => p.id !== id);
  if (other) expectRefused(() => applyPlayerAction(s, other.id, { type: 'fold' }), `wrong seat ${other.id}`);
  expectRefused(() => applyPlayerAction(s, id, { type: 'fold' }, s.seq - 1), 'stale seq');
  expectRefused(() => advanceStreet(s), 'deal while waiting for a player');
  expectRefused(() => resolveShowdown(s), 'showdown while waiting for a player');
  expect(s).toEqual(before);
}

function randomAction(legal: LegalActions, rng: Rng): PlayerAction {
  const r = rng.next();
  if (legal.canAllIn && r < 0.07) return { type: 'allin' };
  if (legal.raise && r < 0.3) {
    const { kind, min, max } = legal.raise;
    // Bias towards small raises so hands do not end on the first street every time.
    const span = Math.max(0, Math.min(max, min * 3) - min);
    return { type: kind, amount: min + rng.nextInt(span + 1) };
  }
  if (!legal.canCheck && r < 0.45) return { type: 'fold' };
  if (legal.canCheck && r > 0.97) return { type: 'fold' }; // rare, but legal
  return legal.canCheck ? { type: 'check' } : { type: 'call' };
}

// ---------------------------------------------------------------------------
// Independent settlement oracle
// ---------------------------------------------------------------------------

function oraclePayouts(s: GameState): Map<string, number> {
  const hand = s.hand!;
  const live = s.players.filter((p) => p.status === 'active' || p.status === 'allin');
  const levels = [...new Set(live.map((p) => p.contribution).filter((c) => c > 0))].sort((a, b) => a - b);
  const layers: { amount: number; eligible: string[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of s.players) amount += Math.max(0, Math.min(p.contribution, level) - prev);
    const eligible = live.filter((p) => p.contribution >= level).map((p) => p.id);
    const last = layers[layers.length - 1];
    if (last && last.eligible.join() === eligible.join()) last.amount += amount;
    else layers.push({ amount, eligible });
    prev = level;
  }
  const dead = s.players.reduce((sum, p) => sum + Math.max(0, p.contribution - prev), 0);
  if (dead > 0) layers[layers.length - 1]!.amount += dead;

  const score = new Map(live.map((p) => [p.id, evaluateBruteForce([...p.holeCards, ...hand.board]).score]));
  const clockwise = seatsAfter(s.players, hand.dealerSeat).map((p) => p.id);
  const won = new Map<string, number>();
  for (const layer of layers) {
    const best = Math.max(...layer.eligible.map((id) => score.get(id) as number));
    const winners = clockwise.filter((id) => layer.eligible.includes(id) && score.get(id) === best);
    const share = Math.floor(layer.amount / winners.length);
    let odd = layer.amount - share * winners.length;
    for (const id of winners) {
      const extra = odd > 0 ? 1 : 0;
      odd -= extra;
      won.set(id, (won.get(id) ?? 0) + share + extra);
    }
  }
  return won;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function playTournament(seed: number, botDriven: boolean, stats: Stats): void {
  const rng = createSeededRng(seed);
  const setup = setupTournament(rng, botDriven);
  const total = setup.total;
  let s = setup.state;
  stats.tournaments += 1;
  const tag = `seed ${seed}${botDriven ? ' (bots)' : ''}`;

  for (let h = 0; h < MAX_HANDS_PER_TOURNAMENT && s.status === 'running'; h++) {
    s = startNextHand(s, { rng });
    stats.hands += 1;
    stats.commands += 1;
    checkInvariants(s, total, `${tag} hand ${s.handNumber} start`);
    let deckLen = s.hand!.deck.length;

    for (let step = 0; s.hand!.pending.kind !== 'complete'; step++) {
      if (step >= MAX_COMMANDS_PER_HAND) throw new Error(`${tag} hand ${s.handNumber}: no progress (deadlock?)`);
      const where = `${tag} hand ${s.handNumber} step ${step}`;
      const pending = s.hand!.pending;
      const prevSeq = s.seq;
      const prevEvents = s.hand!.events.length;
      let next: GameState;
      if (pending.kind === 'action') {
        const legal = getLegalActions(s, pending.playerId)!;
        checkLegalAgreement(s, pending.playerId, legal, rng, stats, where);
        next = botDriven
          ? processBotTurn(s, rng, { equityIterations: 25 })
          : applyPlayerAction(s, pending.playerId, randomAction(legal, rng), s.seq);
      } else if (pending.kind === 'showdown') {
        const expected = oraclePayouts(s);
        next = resolveShowdown(s);
        const got = new Map<string, number>();
        for (const a of next.hand!.result!.awards) for (const w of a.winners) got.set(w.playerId, (got.get(w.playerId) ?? 0) + w.amount);
        expect(Object.fromEntries(got), `${where}: payouts vs oracle`).toEqual(Object.fromEntries(expected));
        stats.showdowns += 1;
        if (next.hand!.result!.awards.length > 1) stats.multiPotShowdowns += 1;
      } else {
        next = advance(s);
      }
      if (next.seq !== prevSeq + 1) throw new Error(`${where}: seq ${prevSeq} → ${next.seq}`);
      if (next.hand!.events.length < prevEvents) throw new Error(`${where}: events shrank`);
      if (next.hand!.deck.length > deckLen) throw new Error(`${where}: deck grew`);
      deckLen = next.hand!.deck.length;
      s = next;
      stats.commands += 1;
      checkInvariants(s, total, where);
    }

    // A settled hand cannot be settled or played again.
    expect(advance(s)).toBe(s);
    expect(() => resolveShowdown(s)).toThrow(IllegalActionError);
    expect(() => advanceStreet(s)).toThrow(IllegalActionError);
    for (const p of s.players) expect(() => applyPlayerAction(s, p.id, { type: 'fold' })).toThrow(IllegalActionError);
  }

  if (s.status === 'finished') {
    const places = s.players.map((p) => p.finishPlace ?? 0).sort((a, b) => a - b);
    expect(places, `${tag}: finishing places`).toEqual(s.players.map((_, i) => i + 1));
    const champion = s.players.find((p) => p.id === s.winnerId)!;
    expect(champion.stack, `${tag}: champion holds every chip`).toBe(total);
  }
}

describe('Stage 1 generated sequences (seeded)', () => {
  it(`random legal play: ${SEEDS} tournaments, 2–6 seats, mixed stacks`, () => {
    const stats: Stats = { tournaments: 0, hands: 0, showdowns: 0, multiPotShowdowns: 0, commands: 0, refusalsChecked: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) playTournament(seed, false, stats);
    console.warn(`[stage1-stats] random seeds 1..${SEEDS}: ${JSON.stringify(stats)}`);
    expect(stats.hands).toBeGreaterThanOrEqual(1000);
    expect(stats.showdowns).toBeGreaterThanOrEqual(100);
    expect(stats.multiPotShowdowns).toBeGreaterThanOrEqual(20);
  }, 120_000);

  it('bot-driven play: 40 tournaments through processBotTurn never throw or stall', () => {
    const stats: Stats = { tournaments: 0, hands: 0, showdowns: 0, multiPotShowdowns: 0, commands: 0, refusalsChecked: 0 };
    for (let seed = 10_001; seed <= 10_040; seed++) playTournament(seed, true, stats);
    console.warn(`[stage1-stats] bot seeds 10001..10040: ${JSON.stringify(stats)}`);
    expect(stats.hands).toBeGreaterThanOrEqual(300);
  }, 120_000);
});
