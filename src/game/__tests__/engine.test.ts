import { describe, expect, it } from 'vitest';
import { cardCode } from '../cards';
import { createSeededRng, type Rng } from '../deck';
import {
  advance,
  applyPlayerAction,
  assertChipConservation,
  getLegalActions,
  startNextHand,
  startTournament,
} from '../engine';
import { totalChips } from '../rules';
import { getPublicView } from '../views';
import { IllegalActionError, type GameState, type PlayerAction } from '../types';
import { acting, chips, setupHand, stackOf, TEST_CONFIG } from './helpers';

const act = (s: GameState, id: string, action: PlayerAction) => applyPlayerAction(s, id, action);
const fold = (s: GameState, id: string) => act(s, id, { type: 'fold' });
const call = (s: GameState, id: string) => act(s, id, { type: 'call' });
const check = (s: GameState, id: string) => act(s, id, { type: 'check' });
const raise = (s: GameState, id: string, amount: number) => act(s, id, { type: 'raise', amount });
const allin = (s: GameState, id: string) => act(s, id, { type: 'allin' });

/** Deals/showdowns until a player must act or the hand is complete. */
function runOut(state: GameState): GameState {
  let s = state;
  for (let i = 0; i < 10; i++) {
    const kind = s.hand?.pending.kind;
    if (kind !== 'deal' && kind !== 'showdown') return s;
    s = advance(s);
  }
  throw new Error('runOut did not terminate');
}

/** Everyone checks/calls until the hand is over. */
function checkDown(state: GameState): GameState {
  let s = runOut(state);
  for (let i = 0; i < 50 && s.hand?.pending.kind === 'action'; i++) {
    const id = acting(s) as string;
    const legal = getLegalActions(s, id)!;
    s = runOut(legal.canCheck ? check(s, id) : call(s, id));
  }
  return s;
}

describe('positions and turn order', () => {
  it('4 players: SB/BB follow the button, UTG opens, SB first postflop', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    expect(s.hand!.smallBlindSeat).toBe(1);
    expect(s.hand!.bigBlindSeat).toBe(2);
    expect(stackOf(s, 'p1')).toBe(990);
    expect(stackOf(s, 'p2')).toBe(980);
    expect(acting(s)).toBe('p3');
    s = call(s, 'p3');
    expect(acting(s)).toBe('p0');
    s = call(s, 'p0');
    s = call(s, 'p1');
    // Big blind keeps the option even though nobody raised.
    expect(acting(s)).toBe('p2');
    const legal = getLegalActions(s, 'p2')!;
    expect(legal.canCheck).toBe(true);
    expect(legal.raise).toEqual({ kind: 'raise', min: 40, max: 1000 });
    s = check(s, 'p2');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
    s = advance(s);
    expect(s.hand!.board).toHaveLength(3);
    expect(acting(s)).toBe('p1');
    expect(getLegalActions(s, 'p1')!.raise).toEqual({ kind: 'bet', min: 20, max: 980 });
  });

  it('3 players: the button acts first preflop', () => {
    const s = setupHand({ stacks: [1000, 1000, 1000], dealerSeat: 0 });
    expect([s.hand!.smallBlindSeat, s.hand!.bigBlindSeat]).toEqual([1, 2]);
    expect(acting(s)).toBe('p0');
  });

  it('heads-up: button is SB and acts first preflop, BB acts first postflop', () => {
    let s = setupHand({ stacks: [1000, 1000], dealerSeat: 0 });
    expect(s.hand!.smallBlindSeat).toBe(0);
    expect(s.hand!.bigBlindSeat).toBe(1);
    expect(acting(s)).toBe('p0');
    s = call(s, 'p0');
    expect(acting(s)).toBe('p1');
    s = check(s, 'p1');
    s = advance(s);
    expect(acting(s)).toBe('p1');
    s = check(s, 'p1');
    expect(acting(s)).toBe('p0');
  });

  it('button rotates and skips eliminated seats', () => {
    let s = setupHand({ stacks: [1000, 0, 1000, 1000], dealerSeat: 0 });
    expect(s.players[1]!.status).toBe('out');
    expect(s.players[1]!.holeCards).toHaveLength(0);
    expect([s.hand!.smallBlindSeat, s.hand!.bigBlindSeat]).toEqual([2, 3]);
    expect(acting(s)).toBe('p0');
    s = fold(s, 'p0');
    s = fold(s, 'p2');
    expect(s.hand!.pending.kind).toBe('complete');
    s = startNextHand(s, { rng: createSeededRng(1) });
    expect(s.hand!.dealerSeat).toBe(2);
    expect([s.hand!.smallBlindSeat, s.hand!.bigBlindSeat]).toEqual([3, 0]);
    s = fold(s, acting(s)!);
    s = fold(s, acting(s)!);
    s = startNextHand(s, { rng: createSeededRng(2) });
    expect(s.hand!.dealerSeat).toBe(3);
    expect([s.hand!.smallBlindSeat, s.hand!.bigBlindSeat]).toEqual([0, 2]);
  });

  it('switches to heads-up rules after an elimination', () => {
    let s = setupHand({
      stacks: [1000, 20, 1000],
      dealerSeat: 2,
      holes: { p0: 'As Ad', p1: '2c 3d', p2: 'Ks Kd' },
      board: '7h 8s 9c Jd 4h',
    });
    // p1 is all-in just by posting the big blind.
    expect(s.players[1]!.status).toBe('allin');
    s = call(s, 'p2');
    s = call(s, 'p0');
    s = checkDown(s);
    expect(s.hand!.pending.kind).toBe('complete');
    expect(s.players[1]!.status).toBe('out');
    expect(s.players[1]!.finishPlace).toBe(3);
    s = startNextHand(s, { rng: createSeededRng(3) });
    expect(s.hand!.dealerSeat).toBe(0);
    expect(s.hand!.smallBlindSeat).toBe(0);
    expect(s.hand!.bigBlindSeat).toBe(2);
    expect(acting(s)).toBe('p0');
  });
});

describe('action validation', () => {
  it('rejects check facing a bet, out-of-turn play and wrong bet type', () => {
    const s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    expect(() => check(s, 'p3')).toThrow(IllegalActionError);
    expect(() => call(s, 'p0')).toThrow(IllegalActionError);
    expect(() => act(s, 'p3', { type: 'bet', amount: 60 })).toThrow(IllegalActionError);
  });

  it('enforces the minimum raise and the stack limit', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    expect(() => raise(s, 'p3', 30)).toThrow(/between 40 and 1000/);
    expect(() => raise(s, 'p3', 1001)).toThrow(IllegalActionError);
    expect(() => raise(s, 'p3', 40.5)).toThrow(IllegalActionError);
    s = raise(s, 'p3', 60); // raise of 40 on top of 20
    const legal = getLegalActions(s, 'p0')!;
    expect(legal.toCall).toBe(60);
    expect(legal.raise!.min).toBe(100);
    expect(() => raise(s, 'p0', 99)).toThrow(IllegalActionError);
    s = raise(s, 'p0', 100);
    expect(s.hand!.currentBet).toBe(100);
  });

  it('caps a call at the remaining stack (partial all-in call)', () => {
    let s = setupHand({ stacks: [100, 1000, 1000, 1000], dealerSeat: 0 });
    s = raise(s, 'p3', 500);
    const legal = getLegalActions(s, 'p0')!;
    expect(legal.callAmount).toBe(100);
    expect(legal.callIsAllIn).toBe(true);
    expect(legal.raise).toBeNull();
    s = call(s, 'p0');
    expect(stackOf(s, 'p0')).toBe(0);
    expect(s.players[0]!.status).toBe('allin');
    expect(s.players[0]!.streetBet).toBe(100);
  });

  it('rejects stale commands so one tap cannot act twice', () => {
    const s0 = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    const s1 = applyPlayerAction(s0, 'p3', { type: 'call' }, s0.seq);
    expect(() => applyPlayerAction(s1, 'p3', { type: 'call' }, s0.seq)).toThrow(/Stale/);
    expect(() => applyPlayerAction(s1, 'p3', { type: 'call' })).toThrow(IllegalActionError);
  });

  it('does not mutate the input state', () => {
    const s0 = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    const snapshot = JSON.stringify(s0);
    raise(s0, 'p3', 80);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('disables raising when nobody else can respond', () => {
    let s = setupHand({ stacks: [1000, 300], dealerSeat: 0 });
    s = call(s, 'p0');
    s = allin(s, 'p1');
    const legal = getLegalActions(s, 'p0')!;
    expect(legal.toCall).toBe(280);
    expect(legal.raise).toBeNull();
    expect(legal.canAllIn).toBe(false);
    expect(legal.canCall).toBe(true);
  });
});

describe('short all-in and re-opening the action', () => {
  it('a short all-in raise does not re-open raising for players who already acted', () => {
    let s = setupHand({ stacks: [150, 1000, 1000, 1000], dealerSeat: 0 });
    s = raise(s, 'p3', 100); // full raise of 80
    s = allin(s, 'p0'); // to 150: only +50, short
    expect(s.hand!.currentBet).toBe(150);
    expect(s.hand!.minRaise).toBe(80);
    s = fold(s, 'p1');
    // p2 has not acted yet, so it may raise (min = 150 + 80).
    expect(getLegalActions(s, 'p2')!.raise!.min).toBe(230);
    s = call(s, 'p2');
    const legal = getLegalActions(s, 'p3')!;
    expect(legal.toCall).toBe(50);
    expect(legal.raise).toBeNull();
    expect(legal.canAllIn).toBe(false);
    expect(() => raise(s, 'p3', 300)).toThrow(IllegalActionError);
    s = call(s, 'p3');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
  });

  it('several short all-ins adding up to a full raise do re-open the action', () => {
    let s = setupHand({ stacks: [150, 1000, 190, 1000], dealerSeat: 0 });
    s = raise(s, 'p3', 100);
    s = allin(s, 'p0'); // 150 (+50)
    s = call(s, 'p1'); // p1 stays in, so a re-raise can still be answered
    s = allin(s, 'p2'); // 190 (+40) → 90 above p3's 100, a full raise is 80
    const legal = getLegalActions(s, 'p3')!;
    expect(legal.raise).toEqual({ kind: 'raise', min: 270, max: 1000 });
  });
});

describe('pots, side pots and payouts', () => {
  it('main pot and side pot go to different winners; unmatched chips are returned', () => {
    let s = setupHand({
      stacks: [500, 100, 300],
      dealerSeat: 0,
      holes: { p0: 'Qs Qd', p1: 'As Ad', p2: 'Ks Kd' },
      board: '2c 7d 9h Js 3c',
    });
    s = allin(s, 'p0');
    s = call(s, 'p1');
    s = call(s, 'p2');
    expect(s.hand!.events).toContainEqual({ type: 'refund', playerId: 'p0', amount: 200 });
    s = runOut(s);
    const result = s.hand!.result!;
    expect(result.endedBy).toBe('showdown');
    expect(result.awards.map((a) => ({ amount: a.amount, winners: a.winners }))).toEqual([
      { amount: 300, winners: [{ playerId: 'p1', amount: 300 }] },
      { amount: 400, winners: [{ playerId: 'p2', amount: 400 }] },
    ]);
    expect([stackOf(s, 'p0'), stackOf(s, 'p1'), stackOf(s, 'p2')]).toEqual([200, 300, 400]);
    expect(chips(s)).toBe(900);
  });

  it('splits a pot when the board plays and gives the odd chip left of the button', () => {
    let s = setupHand({
      stacks: [1000, 1000, 1000],
      dealerSeat: 0,
      config: { blindLevels: [{ smallBlind: 5, bigBlind: 10 }] },
      holes: { p0: '2c 3d', p1: '4c 5d', p2: '6h 7h' },
      board: 'Ts Js Qs Ks As',
    });
    s = call(s, 'p0');
    s = fold(s, 'p1');
    s = check(s, 'p2');
    s = checkDown(s);
    const award = s.hand!.result!.awards[0]!;
    expect(award.amount).toBe(25);
    // Seats clockwise from the button: p1 (folded), p2, p0 → p2 gets the odd chip.
    expect(award.winners).toEqual([
      { playerId: 'p2', amount: 13 },
      { playerId: 'p0', amount: 12 },
    ]);
    expect(s.hand!.result!.net).toEqual({ p0: 2, p1: -5, p2: 3 });
  });

  it('pays several pots with a split in the side pot', () => {
    let s = setupHand({
      stacks: [100, 400, 400, 1000],
      dealerSeat: 3,
      holes: { p0: '3h 3d', p1: 'Kh Qh', p2: 'Kd Qd', p3: '2c 7s' },
      board: 'Kc Qc 3s 8h 9d',
    });
    // Seat 3 is the button: p0 SB, p1 BB, p2 first to act.
    s = allin(s, 'p2');
    s = fold(s, 'p3');
    s = allin(s, 'p0');
    s = call(s, 'p1');
    s = runOut(s);
    const awards = s.hand!.result!.awards;
    expect(awards[0]!.amount).toBe(300);
    expect(awards[0]!.winners).toEqual([{ playerId: 'p0', amount: 300 }]);
    expect(awards[1]!.amount).toBe(600);
    expect(awards[1]!.winners).toEqual([
      { playerId: 'p1', amount: 300 },
      { playerId: 'p2', amount: 300 },
    ]);
    expect(chips(s)).toBe(1900);
  });

  it('returns an uncalled bet when the caller is short', () => {
    let s = setupHand({ stacks: [1000, 300], dealerSeat: 0, board: '2c 7d 9h Js 3c' });
    s = call(s, 'p0');
    s = check(s, 'p1');
    s = advance(s);
    s = check(s, 'p1');
    s = act(s, 'p0', { type: 'bet', amount: 800 });
    s = call(s, 'p1');
    expect(s.hand!.events).toContainEqual({ type: 'refund', playerId: 'p0', amount: 520 });
    s = runOut(s);
    expect(s.hand!.pending.kind).toBe('complete');
    expect(chips(s)).toBe(1300);
  });

  it('awards the pot without showdown when everyone else folds', () => {
    let s = setupHand({ stacks: [1000, 1000, 1000, 1000], dealerSeat: 0 });
    s = fold(s, 'p3');
    s = fold(s, 'p0');
    s = fold(s, 'p1');
    const hand = s.hand!;
    expect(hand.pending.kind).toBe('complete');
    expect(hand.result!.endedBy).toBe('fold');
    expect(hand.result!.shown).toEqual([]);
    expect(hand.revealed).toEqual([]);
    expect(hand.events.some((e) => e.type === 'show')).toBe(false);
    expect(stackOf(s, 'p2')).toBe(1010);
    expect(stackOf(s, 'p1')).toBe(990);
    const view = getPublicView(s);
    expect(view.players.every((p) => p.holeCards === null)).toBe(true);
  });

  it('runs out the board automatically when everyone is all-in', () => {
    let s = setupHand({ stacks: [500, 500], dealerSeat: 0 });
    s = allin(s, 'p0');
    s = call(s, 'p1');
    expect(s.hand!.pending).toEqual({ kind: 'deal', street: 'flop' });
    s = runOut(s);
    expect(s.hand!.board).toHaveLength(5);
    expect(s.hand!.pending.kind).toBe('complete');
    expect(s.hand!.revealed.sort()).toEqual(['p0', 'p1']);
    expect(chips(s)).toBe(1000);
  });

  it('big blind all-in for less than a full blind: others still owe the full blind', () => {
    let s = setupHand({ stacks: [1000, 1000, 15], dealerSeat: 0 });
    expect(s.players[2]!.streetBet).toBe(15);
    expect(getLegalActions(s, 'p0')!.toCall).toBe(20);
    s = call(s, 'p0');
    s = fold(s, 'p1');
    expect(s.hand!.events).toContainEqual({ type: 'refund', playerId: 'p0', amount: 5 });
    s = runOut(s);
    expect(s.hand!.pending.kind).toBe('complete');
    expect(chips(s)).toBe(2015);
  });
});

describe('tournament invariants (randomized play)', () => {
  function randomAction(s: GameState, id: string, rng: Rng): PlayerAction {
    const legal = getLegalActions(s, id)!;
    const roll = rng.next();
    if (legal.canAllIn && roll < 0.08) return { type: 'allin' };
    if (legal.raise && roll < 0.3) {
      const { min, max, kind } = legal.raise;
      return { type: kind, amount: min + rng.nextInt(max - min + 1) };
    }
    if (roll < 0.45 && !legal.canCheck) return { type: 'fold' };
    return legal.canCheck ? { type: 'check' } : { type: 'call' };
  }

  it('conserves chips after every command and always ends with one winner', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = createSeededRng(seed);
      let s = startTournament(
        { ...TEST_CONFIG, handsPerLevel: 6, blindLevels: [{ smallBlind: 10, bigBlind: 20 }, { smallBlind: 25, bigBlind: 50 }] },
        ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, kind: 'bot' as const })),
        { rng },
      );
      const total = totalChips(s);
      let hands = 0;
      while (s.status === 'running') {
        s = startNextHand(s, { rng });
        hands++;
        expect(hands).toBeLessThan(3000);
        // Every card on the table is unique.
        const visible = [...s.players.flatMap((p) => p.holeCards), ...s.hand!.deck].map(cardCode);
        expect(new Set(visible).size).toBe(52);
        let guard = 0;
        while (s.hand!.pending.kind !== 'complete') {
          expect(guard++).toBeLessThan(200);
          const pending = s.hand!.pending;
          s = pending.kind === 'action' ? applyPlayerAction(s, pending.playerId, randomAction(s, pending.playerId, rng)) : advance(s);
          expect(totalChips(s)).toBe(total);
          assertChipConservation(s);
        }
      }
      const places = s.players.map((p) => p.finishPlace).sort();
      expect(places).toEqual([1, 2, 3, 4]);
      expect(s.players.find((p) => p.finishPlace === 1)!.stack).toBe(total);
      expect(s.winnerId).toBe(s.players.find((p) => p.finishPlace === 1)!.id);
      expect(() => startNextHand(s)).toThrow(IllegalActionError);
    }
  });
});
