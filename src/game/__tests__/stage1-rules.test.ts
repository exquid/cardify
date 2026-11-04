import { describe, expect, it } from 'vitest';
import { parseCards } from '../cards';
import { createDeck } from '../deck';
import { advance, advanceStreet, applyPlayerAction, getLegalActions, resolveShowdown, startNextHand } from '../engine';
import { evaluate, HandCategory } from '../evaluator';
import { buildPots, splitPot } from '../pots';
import { IllegalActionError, type GameState, type PlayerAction } from '../types';
import { acting, chips, setupHand, stackOf } from './helpers';

/**
 * Stage 1 (Poker Core QA) rule fixtures. Expected values are computed by hand
 * from the rules profile in docs/qa/cardify-stage-1-plan.md, not by re-running
 * the engine's own algorithms. Fixture numbers refer to the Stage 1 brief.
 */

const act = (s: GameState, id: string, action: PlayerAction, seq?: number) => applyPlayerAction(s, id, action, seq);
const fold = (s: GameState, id: string) => act(s, id, { type: 'fold' });
const check = (s: GameState, id: string) => act(s, id, { type: 'check' });
const call = (s: GameState, id: string) => act(s, id, { type: 'call' });
const bet = (s: GameState, id: string, amount: number) => act(s, id, { type: 'bet', amount });
const raise = (s: GameState, id: string, amount: number) => act(s, id, { type: 'raise', amount });
const allin = (s: GameState, id: string) => act(s, id, { type: 'allin' });
const player = (s: GameState, id: string) => s.players.find((p) => p.id === id)!;

/** Calls/checks everyone around preflop and deals the flop. Seats must all be funded. */
function limpToFlop(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 20 && s.hand!.pending.kind === 'action'; i++) {
    const id = acting(s)!;
    s = getLegalActions(s, id)!.canCheck ? check(s, id) : call(s, id);
  }
  expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
  return advance(s);
}

/** Plays the hand to the end: checks (or calls) for whoever must act, deals and resolves the rest. Bounded. */
function finish(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 200 && s.hand!.pending.kind !== 'complete'; i++) {
    const id = acting(s);
    s = id ? (getLegalActions(s, id)!.canCheck ? check(s, id) : call(s, id)) : advance(s);
  }
  expect(s.hand!.pending.kind).toBe('complete');
  return s;
}

/** Asserts a command is refused and leaves its input untouched. */
function expectRefused(s: GameState, run: (s: GameState) => unknown): void {
  const before = structuredClone(s);
  expect(() => run(s)).toThrow(IllegalActionError);
  expect(s).toEqual(before);
}

describe('P03/P07 action order and street closure', () => {
  it('fixture 1: the big blind gets its unraised preflop option before the flop', () => {
    // 3 players, blinds 5/10. Dealer p0, SB p1, BB p2; p0 acts first preflop.
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0, config: { blindLevels: [{ smallBlind: 5, bigBlind: 10 }] } });
    expect(acting(s)).toBe('p0');
    s = call(s, 'p0');
    s = call(s, 'p1'); // completes to 10: contributions are now equal
    expect(acting(s)).toBe('p2');
    const legal = getLegalActions(s, 'p2')!;
    expect(legal.canCheck).toBe(true);
    expect(legal.raise).toEqual({ kind: 'raise', min: 20, max: 1000 });
    s = check(s, 'p2');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
  });

  it('fixture 2: heads-up order on both streets and over consecutive hands', () => {
    let s = setupHand({ stacks: [1000, 1000], dealerSeat: 0 });
    expect(s.hand!.smallBlindSeat).toBe(0);
    expect(s.hand!.bigBlindSeat).toBe(1);
    expect(acting(s)).toBe('p0'); // button = SB acts first preflop
    s = call(s, 'p0');
    expect(acting(s)).toBe('p1');
    s = check(s, 'p1');
    s = advance(s);
    expect(acting(s)).toBe('p1'); // BB acts first postflop
    s = check(s, 'p1');
    expect(acting(s)).toBe('p0');
    s = bet(s, 'p0', 20);
    s = fold(s, 'p1');
    expect(s.hand!.pending.kind).toBe('complete');
    expect([stackOf(s, 'p0'), stackOf(s, 'p1')]).toEqual([1020, 980]);

    s = startNextHand(s, { deck: createDeck() });
    expect(s.hand!.dealerSeat).toBe(1);
    expect(s.hand!.smallBlindSeat).toBe(1);
    expect(s.hand!.bigBlindSeat).toBe(0);
    expect([stackOf(s, 'p0'), stackOf(s, 'p1')]).toEqual([1000, 970]);
    expect(acting(s)).toBe('p1');
  });

  it('multiway: folded and all-in players are skipped on later streets', () => {
    // 5 players, dealer p0: SB p1, BB p2, then p3, p4, p0 preflop.
    let s = setupHand({ stacks: [1000, 1000, 1000, 1000, 300], dealerSeat: 0 });
    expect(acting(s)).toBe('p3');
    s = fold(s, 'p3');
    s = allin(s, 'p4'); // 300
    s = call(s, 'p0');
    s = call(s, 'p1');
    s = call(s, 'p2');
    s = advance(s);
    // Postflop: p1, p2, p0 — p3 folded, p4 is all-in.
    expect(acting(s)).toBe('p1');
    s = check(s, 'p1');
    expect(acting(s)).toBe('p2');
    s = check(s, 'p2');
    expect(acting(s)).toBe('p0');
    s = check(s, 'p0');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'turn' });
  });

  it('every street closes exactly once: no command can re-deal a closed street', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0 });
    s = limpToFlop(s);
    expect(s.hand!.board).toHaveLength(3);
    expectRefused(s, advanceStreet); // waiting for a player, not for a deal
    for (const id of ['p1', 'p2', 'p0']) s = check(s, id);
    const deckBefore = s.hand!.deck.length;
    s = advance(s);
    expect(s.hand!.board).toHaveLength(4);
    expect(s.hand!.deck.length).toBe(deckBefore - 2); // burn + turn
  });
});

describe('P05/P06 amounts and re-opening', () => {
  it('fixture 3: raise-to arithmetic — BB 100, raise to 300, next full raise is to 500', () => {
    let s = setupHand({ stacks: [5000, 5000, 5000, 5000], dealerSeat: 0, config: { blindLevels: [{ smallBlind: 50, bigBlind: 100 }] } });
    s = raise(s, 'p3', 300);
    expect(s.hand!.minRaise).toBe(200);
    expect(player(s, 'p3').streetBet).toBe(300);
    expect(stackOf(s, 'p3')).toBe(4700);
    expect(getLegalActions(s, 'p0')!.raise).toEqual({ kind: 'raise', min: 500, max: 5000 });
    expectRefused(s, (x) => raise(x, 'p0', 499));
    s = raise(s, 'p0', 500); // "to 500", i.e. adds 500 — not 300 + 500
    expect(player(s, 'p0').streetBet).toBe(500);
    expect(stackOf(s, 'p0')).toBe(4500);
  });

  it('fixture 4: a short all-in does not re-open raising for players who already acted', () => {
    // Dealer p0 → postflop order p1 (A), p2 (B), p3 (C), p0 (D, yet to act).
    let s = setupHand({ stacks: [1000, 1000, 1000, 170], dealerSeat: 0 });
    s = limpToFlop(s); // everyone in for 20; C has 150 behind
    s = bet(s, 'p1', 100);
    s = call(s, 'p2');
    s = allin(s, 'p3'); // to 150: +50, short of a full raise (100)
    expect(s.hand!.currentBet).toBe(150);
    expect(s.hand!.minRaise).toBe(100);
    // D has not acted: may raise, minimum full raise-to is 150 + 100.
    expect(getLegalActions(s, 'p0')!.raise).toEqual({ kind: 'raise', min: 250, max: 980 });
    s = call(s, 'p0');
    for (const id of ['p1', 'p2']) {
      const legal = getLegalActions(s, id)!;
      expect(legal.toCall).toBe(50);
      expect(legal.raise).toBeNull();
      expect(legal.canAllIn).toBe(false);
      expectRefused(s, (x) => raise(x, id, 400));
      expectRefused(s, (x) => allin(x, id));
      s = call(s, id);
    }
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'turn' });
  });

  it('fixture 5: cumulative short all-ins re-open for A but not for D who just called', () => {
    // A=p1, B=p2 (150 behind), C=p3 (200 behind), D=p0.
    let s = setupHand({ stacks: [1000, 1000, 170, 220], dealerSeat: 0 });
    s = limpToFlop(s);
    s = bet(s, 'p1', 100);
    s = allin(s, 'p2'); // 150
    s = allin(s, 'p3'); // 200
    s = call(s, 'p0'); // D calls 200
    const a = getLegalActions(s, 'p1')!;
    expect(a.toCall).toBe(100);
    expect(a.raise).toEqual({ kind: 'raise', min: 300, max: 980 });

    // Branch 1: A just calls — the round closes, D is not asked again.
    const closed = call(s, 'p1');
    expect(closed.hand!.pending).toEqual({ kind: 'deal', street: 'turn' });

    // Branch 2: A makes a full raise — only then does D get raising rights back.
    const reraised = raise(s, 'p1', 300);
    expect(acting(reraised)).toBe('p0');
    // allInTo = street bet 200 + stack 780.
    expect(getLegalActions(reraised, 'p0')!.raise).toEqual({ kind: 'raise', min: 400, max: 980 });
  });

  it('fixture 6: a short all-in call adds only the remaining stack', () => {
    // Dealer p0 → postflop p1, p2, p0. p1 has 70 behind after the flop.
    let s = setupHand({ stacks: [1000, 90, 1000], dealerSeat: 0 });
    s = limpToFlop(s);
    s = bet(s, 'p1', 40); // 30 left
    s = raise(s, 'p2', 100);
    s = fold(s, 'p0');
    const legal = getLegalActions(s, 'p1')!;
    expect(legal).toMatchObject({ toCall: 60, callAmount: 30, callIsAllIn: true, raise: null });
    s = call(s, 'p1');
    expect(player(s, 'p1')).toMatchObject({ stack: 0, status: 'allin' });
    // p2's unmatched 30 comes back; nobody is left to bet against, so the board runs out.
    expect(s.hand!.events).toContainEqual({ type: 'refund', playerId: 'p2', amount: 30 });
    expect(player(s, 'p2').streetBet).toBe(70);
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'turn' });
  });

  it('rejects malformed, fractional, negative, out-of-range and wrong-type amounts', () => {
    const s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    // p3 faces 20; full raise range is [40, 1000].
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -40, 0, 39, 40.5, 1001, 1e20]) {
      expectRefused(s, (x) => raise(x, 'p3', amount));
    }
    expectRefused(s, (x) => act(x, 'p3', { type: 'raise', amount: '100' as unknown as number }));
    expectRefused(s, (x) => bet(x, 'p3', 100)); // a bet is already out: must be "raise"
    expect(player(raise(s, 'p3', 40), 'p3').streetBet).toBe(40); // exact minimum
    expect(player(raise(s, 'p3', 1000), 'p3').status).toBe('allin'); // exact maximum
  });

  it('documents the short all-in bet policy (D5): next minimum raise is all-in + 1 BB', () => {
    let s = setupHand({ stacks: [1000, 35, 1000], dealerSeat: 0 });
    s = limpToFlop(s); // p1 has 15 behind, BB is 20
    s = allin(s, 'p1'); // a 15-chip bet, below one big blind
    expect(s.hand!.currentBet).toBe(15);
    expect(s.hand!.minRaise).toBe(20);
    expect(getLegalActions(s, 'p2')!.raise).toEqual({ kind: 'raise', min: 35, max: 980 });
  });
});

describe('P08/P09 run-out and fold endings', () => {
  it('fixture 7: no run-out while one active player still faces a wager', () => {
    // 3 players, dealer p0 acts first preflop.
    let s = setupHand({ stacks: [500, 300, 1000], dealerSeat: 0 });
    s = allin(s, 'p0'); // 500
    s = allin(s, 'p1'); // 300, a short call
    expect(acting(s)).toBe('p2'); // the BB still owes a decision
    expect(s.hand!.board).toHaveLength(0);
    expectRefused(s, advanceStreet);
    s = call(s, 'p2');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
    const deck0 = s.hand!.deck.length;
    s = advance(s);
    expect([s.hand!.board.length, deck0 - s.hand!.deck.length]).toEqual([3, 4]);
    s = advance(s);
    expect([s.hand!.board.length, deck0 - s.hand!.deck.length]).toEqual([4, 6]);
    s = advance(s);
    expect([s.hand!.board.length, deck0 - s.hand!.deck.length]).toEqual([5, 8]);
    expect(s.hand!.pending).toEqual({ kind: 'showdown' });
    s = advance(s);
    expect(s.hand!.pending.kind).toBe('complete');
    // Nothing else can deal or pay.
    expect(advance(s)).toBe(s);
    expectRefused(s, advanceStreet);
    expectRefused(s, resolveShowdown);
  });

  it('fixture 8: uncalled excess returns 120 and only 160 is contested', () => {
    // Dealer p0 folds (0), SB p1 = A raises to 200, BB p2 = B all-in for 80.
    let s = setupHand({
      stacks: [1000, 1000, 80],
      dealerSeat: 0,
      holes: { p1: 'As Ad', p2: '7c 2d' },
      board: '3h 8s 9d Jc Kh',
    });
    s = fold(s, 'p0');
    s = raise(s, 'p1', 200);
    s = call(s, 'p2'); // all-in for 80 total
    expect(s.hand!.events).toContainEqual({ type: 'refund', playerId: 'p1', amount: 120 });
    expect([player(s, 'p1').contribution, player(s, 'p2').contribution]).toEqual([80, 80]);
    s = finish(s);
    const result = s.hand!.result!;
    expect(result.refunds).toEqual([{ playerId: 'p1', amount: 120 }]);
    expect(result.awards.reduce((sum, a) => sum + a.amount, 0)).toBe(160);
    expect(stackOf(s, 'p1')).toBe(1000 - 200 + 120 + 160);
    expect(chips(s)).toBe(2080);
  });

  it('fold ending: last player wins without showdown and the award is paid once', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0 });
    s = raise(s, 'p0', 60);
    s = fold(s, 'p1');
    s = fold(s, 'p2');
    const result = s.hand!.result!;
    expect(result.endedBy).toBe('fold');
    expect(result.shown).toEqual([]);
    expect(s.hand!.revealed).toEqual([]);
    expect(result.refunds).toEqual([{ playerId: 'p0', amount: 40 }]); // only the BB's 20 was matched
    expect(s.hand!.events.filter((e) => e.type === 'award')).toEqual([
      { type: 'award', playerId: 'p0', amount: 50, potIndex: 0, potCount: 1, handName: null },
    ]);
    expect([stackOf(s, 'p0'), stackOf(s, 'p1'), stackOf(s, 'p2')]).toEqual([1030, 990, 980]);
    expectRefused(s, resolveShowdown);
  });
});

describe('P04 rejected actions leave the state untouched (fixtures 9–11)', () => {
  it('fixture 9: wrong seat, check facing a bet, under-minimum raise, oversized commitment, unknown type', () => {
    const s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    expectRefused(s, (x) => call(x, 'p0')); // p3 is to act
    expectRefused(s, (x) => call(x, 'nobody'));
    expectRefused(s, (x) => check(x, 'p3'));
    expectRefused(s, (x) => raise(x, 'p3', 30));
    expectRefused(s, (x) => raise(x, 'p3', 5000));
    expectRefused(s, (x) => act(x, 'p3', { type: 'dance' } as unknown as PlayerAction));
  });

  it('fixture 9b: a command from a previous hand is stale', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0 });
    const oldSeq = s.seq;
    s = fold(s, 'p0');
    s = fold(s, 'p1');
    s = startNextHand(s, { deck: createDeck() });
    // p1 acts first in the new hand (dealer moved to p1 → p1 is first preflop with 3 players).
    const actor = acting(s)!;
    expectRefused(s, (x) => act(x, actor, { type: 'call' }, oldSeq));
  });

  it('fixture 10: a late replay of the same action context cannot become a new action', () => {
    // Heads-up: p0 (SB) calls, p1 raises, p0 is to act again.
    let s = setupHand({ stacks: [1000, 1000], dealerSeat: 0 });
    const seenByP0 = s.seq;
    s = act(s, 'p0', { type: 'call' }, seenByP0);
    s = raise(s, 'p1', 60);
    expect(acting(s)).toBe('p0');
    expectRefused(s, (x) => act(x, 'p0', { type: 'call' }, seenByP0));
  });

  it('fixture 11 (engine part): a step planned for one hand is inert in the next', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0 });
    const planned = { seq: s.seq, id: acting(s)! };
    s = fold(s, 'p0');
    s = fold(s, 'p1');
    s = startNextHand(s, { deck: createDeck() });
    expectRefused(s, (x) => act(x, planned.id, { type: 'fold' }, planned.seq));
  });
});

describe('P10 evaluator fixtures (best five of seven)', () => {
  const score = (codes: string) => evaluate(parseCards(codes)).score;
  const compare = (board: string, a: string, b: string) => Math.sign(score(`${a} ${board}`) - score(`${b} ${board}`));

  it('board-only royal flush is an exact tie', () => expect(compare('Ah Kh Qh Jh Th', '2c 3d', 'As Ad')).toBe(0));
  it('six-high straight beats the wheel', () => expect(compare('2c 3d 4h 9s Kc', 'Ah 5d', '5c 6d')).toBe(-1));
  it('selects aces full of kings from two sets of trips', () => {
    expect(evaluate(parseCards('Ah Ad Ac Kh Kd Kc 2s'))).toMatchObject({ category: HandCategory.FullHouse, tiebreak: [14, 13] });
  });
  it('three pairs: aces and kings with a queen kicker', () => {
    expect(evaluate(parseCards('Ah Ad Kh Kd Qh Qd 2s'))).toMatchObject({ category: HandCategory.TwoPair, tiebreak: [14, 13, 12] });
  });
  it('flushes compare down to the fifth card', () => expect(compare('Ah Jh 8h 7h 2d', '4h 3d', '5h 6c')).toBe(-1));
  it('quads on board: the kicker decides', () => expect(compare('9h 9d 9c 9s 2h', 'Ah 3d', 'Kh Qd')).toBe(1));
  it('unused hole cards never break a tie', () => expect(compare('Ah Ad Kc Qd Js', '2c 3c', '4c 5c')).toBe(0));

  it('no straight wraps around the ace (Q-K-A-2-3)', () => {
    expect(evaluate(parseCards('Qc Kd Ah 2s 3c 8d 9h')).category).toBe(HandCategory.HighCard);
  });
  it('duplicate ranks do not hide a straight', () => {
    expect(evaluate(parseCards('5c 5d 6h 7s 8c 9d 9h'))).toMatchObject({ category: HandCategory.Straight, tiebreak: [9] });
  });
  it('adjacent categories and kicker chains', () => {
    const order = [
      'As Kd Qc Jh 9s 3d 2c', // high card
      '2s 2d 5c 7h 9s Jd Kc', // pair
      '2s 2d 5c 5h 9s Jd Kc', // two pair
      '2s 2d 2c 7h 9s Jd Kc', // trips
      '5s 6d 7c 8h 9s Jd 2c', // straight
      '2h 5h 7h 9h Jh Ks 3c', // flush
      '2s 2d 2c 7h 7s Jd Kc', // full house
      '2s 2d 2c 2h 9s Jd Kc', // quads
      '5h 6h 7h 8h 9h Jd 2c', // straight flush
    ].map(score);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    expect(score('9s 9d Ac Kh 4s 3d 2c')).toBeGreaterThan(score('9c 9h Ad Ks 3s 2h')); // third kicker: 4 vs 3
    expect(score('As Kd 9c 7h 4s')).toBeGreaterThan(score('As Kd 9c 7h 3s')); // fifth high card
    expect(score('Ts Td Tc As 4s')).toBeGreaterThan(score('Th Tc Ts Ks Qs')); // trips kicker
  });
  it('card order does not change the result', () => {
    const cards = parseCards('Ah Jh 8h 7h 2d 5h 6c');
    const expected = evaluate(cards).score;
    for (let r = 0; r < 7; r++) {
      const rotated = [...cards.slice(r), ...cards.slice(0, r)];
      expect(evaluate(rotated).score).toBe(expected);
      expect(evaluate([...rotated].reverse()).score).toBe(expected);
    }
  });
});

describe('P11/P12 pot ledger fixtures', () => {
  const c = (playerId: string, amount: number, folded = false) => ({ playerId, amount, folded });

  it('two layers: main 150 (ABC), side 100 (BC)', () => {
    expect(buildPots([c('A', 50), c('B', 100), c('C', 100)])).toEqual([
      { amount: 150, eligible: ['A', 'B', 'C'] },
      { amount: 100, eligible: ['B', 'C'] },
    ]);
  });
  it('folded contributor feeds both pots but is eligible for neither', () => {
    expect(buildPots([c('A', 50), c('B', 100), c('C', 100, true)])).toEqual([
      { amount: 150, eligible: ['A', 'B'] },
      { amount: 100, eligible: ['B'] },
    ]);
  });
  it('three layers: 160 / 180 / 200 with eligibility ABCD, BCD, CD', () => {
    const pots = buildPots([c('A', 40), c('B', 100), c('C', 200), c('D', 200)]);
    expect(pots).toEqual([
      { amount: 160, eligible: ['A', 'B', 'C', 'D'] },
      { amount: 180, eligible: ['B', 'C', 'D'] },
      { amount: 200, eligible: ['C', 'D'] },
    ]);
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(540);
  });
  it('odd chip: 15 split between two tied winners is 8/7, no fractions', () => {
    const [pot] = buildPots([c('A', 5), c('B', 5), c('C', 5, true)]);
    expect(pot).toEqual({ amount: 15, eligible: ['A', 'B'] });
    expect(splitPot(15, ['A', 'B'])).toEqual([
      { playerId: 'A', amount: 8 },
      { playerId: 'B', amount: 7 },
    ]);
  });

  it('settles each pot independently: tied side pot, single-winner main pot', () => {
    // p1 is all-in short with the best hand; p0 and p2 tie for the side pot.
    let s = setupHand({
      stacks: [1000, 100, 1000],
      dealerSeat: 0,
      holes: { p0: 'Kc Qc', p1: 'As Ad', p2: 'Kd Qd' },
      board: '2h 7s 9c Jh 3d',
    });
    s = raise(s, 'p0', 300);
    s = allin(s, 'p1'); // 100
    s = call(s, 'p2');
    s = finish(s);
    const awards = s.hand!.result!.awards.map((a) => ({ amount: a.amount, winners: a.winners }));
    expect(awards).toEqual([
      { amount: 300, winners: [{ playerId: 'p1', amount: 300 }] },
      // Odd chip policy: clockwise from the first seat left of the button (p1 is not eligible, so p2 first).
      { amount: 400, winners: [{ playerId: 'p2', amount: 200 }, { playerId: 'p0', amount: 200 }] },
    ]);
    expect([stackOf(s, 'p0'), stackOf(s, 'p1'), stackOf(s, 'p2')]).toEqual([900, 300, 900]);
  });
});

describe('P01/P02/P14 dealing, blinds and the next hand', () => {
  it.each([2, 3, 4, 5, 6])('%i players: exact hole/board counts and 52 distinct cards', (n) => {
    let s = setupHand({ stacks: Array.from({ length: n }, () => 1000), dealerSeat: 0 });
    for (const p of s.players) expect(p.holeCards).toHaveLength(2);
    expect(s.hand!.deck).toHaveLength(52 - 2 * n);
    s = finish(s);
    expect(s.hand!.board).toHaveLength(5);
    expect(s.hand!.deck).toHaveLength(52 - 2 * n - 8);
    const seen = new Set([...s.players.flatMap((p) => p.holeCards), ...s.hand!.board, ...s.hand!.deck].map((c) => `${c.rank}${c.suit}`));
    expect(seen.size).toBe(52 - 3); // three burn cards left the deck
  });

  it('a short small blind posts what it has and is all-in', () => {
    const s = setupHand({ stacks: [1000, 5, 1000], dealerSeat: 0 });
    expect(player(s, 'p1')).toMatchObject({ stack: 0, streetBet: 5, status: 'allin' });
    expect(s.hand!.currentBet).toBe(20);
    expect(getLegalActions(s, 'p0')!.toCall).toBe(20);
  });

  it('a new hand clears every per-hand field and keeps settled stacks', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0, holes: { p0: 'As Ad' }, board: '2h 7s 9c Jh 3d' });
    s = raise(s, 'p0', 100);
    s = call(s, 'p1');
    s = call(s, 'p2');
    s = finish(s);
    const settled = s.players.map((p) => p.stack);
    s = startNextHand(s, { deck: createDeck() });
    const hand = s.hand!;
    expect(hand).toMatchObject({ number: 2, street: 'preflop', board: [], revealed: [], result: null, lastAggressorId: null, currentBet: 20, minRaise: 20 });
    // Dealer p1 → SB p2 posts 10, BB p0 posts 20.
    expect(s.players.map((p) => p.stack)).toEqual([settled[0]! - 20, settled[1]!, settled[2]! - 10]);
    for (const p of s.players) {
      expect(p.status).toBe(p.stack + p.contribution > 0 ? 'active' : 'out');
      expect(p.actedAtLevel).toBeNull();
      expect(p.holeCards).toHaveLength(2);
    }
    expect(s.players.map((p) => p.contribution)).toEqual([20, 0, 10]);
  });
});

describe('P01 malformed setup fails safely', () => {
  it('rejects a deck with duplicate cards before dealing', () => {
    const s = setupHand({ stacks: [1000, 1000], dealerSeat: 0 });
    const done = fold(s, 'p0');
    const deck = createDeck();
    deck[1] = deck[0]!;
    expect(() => startNextHand(done, { deck })).toThrow(/Duplicate/);
  });

  it.fails('BUG-S1-03: rejects a deck that is too short or contains invalid cards before dealing', () => {
    const s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    const done = fold(fold(fold(s, 'p3'), 'p0'), 'p1');
    // 10 cards: enough for hole cards, not for the board. Today the hand starts
    // and later dies mid-hand with a plain "Deck exhausted" error.
    expect(() => startNextHand(done, { deck: createDeck().slice(0, 10) })).toThrow();
    expect(() => startNextHand(done, { deck: [...createDeck().slice(0, 51), { rank: 1, suit: 'x' } as never] })).toThrow();
  });
});
