import { describe, expect, it } from 'vitest';
import { cardCode, type Card } from '../../game/cards';
import { createSeededRng, type Rng } from '../../game/deck';
import { applyDurakAction, cardCount, createDurak, getDurakLegal, resolveBout } from '../engine';
import { durakGame } from '../game';
import { DurakRuleError, type DurakAction, type DurakLegal, type DurakState } from '../types';

/**
 * Seeded Durak games with invariants after every command: 36 distinct cards,
 * exactly one actor with legal actions, every advertised action accepted,
 * illegal ones refused without side effects, the game always ends, and the
 * outcome agrees with who still holds cards.
 */

function invariants(s: DurakState, where: string): void {
  const fail = (m: string): never => {
    throw new Error(`${where}: ${m}`);
  };
  if (cardCount(s) !== 36) fail(`card count ${cardCount(s)}`);
  const all = [...s.players.flatMap((p) => p.hand), ...s.talon, ...s.discard, ...s.bout.pairs.flatMap((x) => (x.defense ? [x.attack, x.defense] : [x.attack]))];
  if (new Set(all.map(cardCode)).size !== 36) fail('duplicate card');
  const withLegal = s.players.filter((p) => getDurakLegal(s, p.id)).map((p) => p.id);
  const pending = s.pending;
  if ('playerId' in pending) {
    if (withLegal.length !== 1 || withLegal[0] !== pending.playerId) fail(`legal for ${withLegal.join(',')}`);
    const actor = s.players.find((p) => p.id === pending.playerId)!;
    if (actor.hand.length === 0 && pending.kind !== 'throw') fail('actor without cards');
  } else if (withLegal.length) fail('legal actions while nobody acts');
  if (s.bout.pairs.filter((x) => !x.defense).length > 0 && s.pending.kind === 'resolve' && !s.bout.taking) fail('unbeaten card discarded');
  if (s.bout.pairs.length > s.bout.limit) fail('over the attack limit');
  if (s.pending.kind === 'over') {
    const holding = s.players.filter((p) => p.hand.length > 0);
    if (s.outcome?.kind === 'loser' && (holding.length !== 1 || holding[0]!.id !== s.outcome.loserId)) fail('wrong loser');
    if (s.outcome?.kind === 'draw' && holding.length !== 0) fail('draw with cards left');
    if (s.talon.length !== 0) fail('game over with a talon');
  }
}

function options(legal: DurakLegal): DurakAction[] {
  const out: DurakAction[] = legal.attackCards.map((card) => ({ type: 'attack', card }));
  for (const d of legal.defend) for (const card of d.cards) out.push({ type: 'defend', attackIndex: d.attackIndex, card });
  if (legal.canPass) out.push({ type: 'pass' });
  if (legal.canTake) out.push({ type: 'take' });
  return out;
}

function refusedWithoutSideEffects(s: DurakState, id: string, legal: DurakLegal, where: string): number {
  const before = JSON.stringify(s);
  const tries: [string, DurakAction][] = [];
  const other = s.players.find((p) => p.id !== id && p.hand.length > 0);
  const notInHand: Card | undefined = s.talon[0] ?? s.discard[0];
  if (notInHand) tries.push([id, { type: 'attack', card: notInHand }]);
  if (!legal.canPass) tries.push([id, { type: 'pass' }]);
  if (!legal.canTake) tries.push([id, { type: 'take' }]);
  if (other) tries.push([other.id, { type: 'pass' }]);
  let n = 0;
  for (const [who, a] of tries) {
    let threw = false;
    try {
      applyDurakAction(s, who, a, s.seq);
    } catch (e) {
      if (!(e instanceof DurakRuleError)) throw e;
      threw = true;
    }
    if (!threw) throw new Error(`${where}: ${JSON.stringify(a)} by ${who} was accepted`);
    n += 1;
  }
  if (JSON.stringify(s) !== before) throw new Error(`${where}: a refused command changed the state`);
  return n;
}

function play(seed: number, bots: boolean, stats: { games: number; commands: number; refusals: number; draws: number; bouts: number }) {
  const rng: Rng = createSeededRng(seed);
  const n = 2 + (seed % 5);
  let s = createDurak(
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: 'bot' as const })),
    { rng },
  );
  stats.games += 1;
  for (let step = 0; s.pending.kind !== 'over'; step++) {
    const where = `seed ${seed} step ${step}`;
    if (step > 3000) throw new Error(`${where}: no end in sight`);
    invariants(s, where);
    const seq = s.seq;
    if (s.pending.kind === 'resolve') {
      s = resolveBout(s);
      stats.bouts += 1;
    } else {
      const id = (s.pending as { playerId: string }).playerId;
      const legal = getDurakLegal(s, id)!;
      const all = options(legal);
      if (all.length === 0) throw new Error(`${where}: ${id} has no legal action`);
      for (const a of all) applyDurakAction(s, id, a, s.seq); // every advertised option is accepted
      stats.refusals += refusedWithoutSideEffects(s, id, legal, where);
      const choice = bots ? durakGame.botAction(s, id, rng) : (all[rng.nextInt(all.length)] as DurakAction);
      s = applyDurakAction(s, id, choice, s.seq);
    }
    if (s.seq !== seq + 1) throw new Error(`${where}: seq ${seq} → ${s.seq}`);
    stats.commands += 1;
  }
  invariants(s, `seed ${seed} end`);
  if (s.outcome?.kind === 'draw') stats.draws += 1;
}

describe('Durak generated games (seeded)', () => {
  it('random legal play: 300 games, 2–6 players', () => {
    const stats = { games: 0, commands: 0, refusals: 0, draws: 0, bouts: 0 };
    for (let seed = 1; seed <= 300; seed++) play(seed, false, stats);
    console.warn(`[durak-stats] random: ${JSON.stringify(stats)}`);
    expect(stats.games).toBe(300);
    expect(stats.bouts).toBeGreaterThan(3000);
  }, 120_000);

  it('bot play: 200 games always finish', () => {
    const stats = { games: 0, commands: 0, refusals: 0, draws: 0, bouts: 0 };
    for (let seed = 5001; seed <= 5200; seed++) play(seed, true, stats);
    console.warn(`[durak-stats] bots: ${JSON.stringify(stats)}`);
    expect(stats.games).toBe(200);
  }, 120_000);
});
