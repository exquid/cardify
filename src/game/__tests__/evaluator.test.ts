import { describe, expect, it } from 'vitest';
import { parseCards } from '../cards';
import { createSeededRng, shuffledDeck } from '../deck';
import { evaluate, evaluateBruteForce, evaluateDetailed, HandCategory } from '../evaluator';

const ev = (codes: string) => evaluate(parseCards(codes));
const beats = (a: string, b: string) => expect(ev(a).score).toBeGreaterThan(ev(b).score);
const ties = (a: string, b: string) => expect(ev(a).score).toBe(ev(b).score);

describe('hand categories', () => {
  it.each([
    ['As Kd 9c 7h 4s 3d 2c', HandCategory.HighCard],
    ['As Ad 9c 7h 4s 3d 2c', HandCategory.Pair],
    ['As Ad 9c 9h 4s 3d 2c', HandCategory.TwoPair],
    ['As Ad Ac 9h 4s 3d 2c', HandCategory.ThreeOfAKind],
    ['9s Td Jc Qh Ks 3d 2c', HandCategory.Straight],
    ['As 2d 3c 4h 5s 9d Jc', HandCategory.Straight],
    ['As Ks 9s 7s 4s 3d 2c', HandCategory.Flush],
    ['As Ad Ac 9h 9s 3d 2c', HandCategory.FullHouse],
    ['As Ad Ac Ah 9s 3d 2c', HandCategory.FourOfAKind],
    ['5s 6s 7s 8s 9s 3d 2c', HandCategory.StraightFlush],
    ['Ts Js Qs Ks As 3d 2c', HandCategory.StraightFlush],
  ])('%s → category %i', (codes, category) => {
    expect(ev(codes).category).toBe(category);
  });

  it('names the royal flush and the wheel', () => {
    expect(evaluateDetailed(parseCards('Ts Js Qs Ks As 3d 2c')).name).toBe('Royal Flush');
    expect(evaluateDetailed(parseCards('As 2d 3c 4h 5s 9d Jc')).name).toBe('Straight, Five high');
    expect(evaluateDetailed(parseCards('Kh Kd 7c 7s Ah 2d 3c')).name).toBe('Two Pair, Kings and Sevens');
  });
});

describe('hand comparison', () => {
  it('pair beats high card', () => beats('2s 2d 9c 7h 4s', 'As Kd Qc Jh 9s'));
  it('two pair kicker decides', () => beats('Ks Kd 7c 7h As', 'Kc Kh 7d 7s Qs'));
  it('higher second pair wins two pair', () => beats('Ks Kd 8c 8h 2s', 'Kc Kh 7d 7s As'));
  it('pair kickers are compared down to the third kicker', () => beats('9s 9d Ac Kh 4s', '9c 9h Ad Ks 3s'));
  it('wheel is the lowest straight', () => beats('2s 3d 4c 5h 6s', 'As 2d 3c 4h 5s'));
  it('ace-high straight beats king-high', () => beats('Ts Jd Qc Kh As', '9s Td Jc Qh Ks'));
  it('flush beats straight', () => beats('2s 5s 7s 9s Js', '9d Tc Jh Qs Kd'));
  it('full house beats flush', () => beats('2s 2d 2c 3h 3s', 'As Ks Qs Js 9s'));
  it('quads beat full house', () => beats('2s 2d 2c 2h 3s', 'As Ad Ac Kh Ks'));
  it('straight flush beats quads', () => beats('5h 6h 7h 8h 9h', 'As Ad Ac Ah Ks'));
  it('royal flush beats king-high straight flush', () => beats('Th Jh Qh Kh Ah', '9s Ts Js Qs Ks'));
  it('full house compares trips first', () => beats('3s 3d 3c 2h 2s', '2c 2d 2s Ah As'));
  it('flush compares all five cards', () => beats('As Ks 9s 6s 3s', 'Ad Kd 9d 6d 2d'));
  it('identical ranks in different suits tie', () => ties('As Kd 9c 7h 4s', 'Ad Kc 9h 7s 4d'));
  it('kicker beyond the best five does not count', () =>
    ties('As Ad Kc Qh Js 3d 2c', 'Ah Ac Kd Qs Jh 5c 4d'));
  it('board plays: both players play the same straight', () =>
    ties('2c 3d 9s Th Jc Qd Ks', '4c 5d 9s Th Jc Qd Ks'));
  it('picks the best of two trips for a full house', () => {
    const v = ev('Ks Kd Kc 9h 9s 9d 2c');
    expect(v.category).toBe(HandCategory.FullHouse);
    expect(v.tiebreak).toEqual([13, 9]);
  });
  it('chooses the six-card straight top end', () => {
    expect(ev('4s 5d 6c 7h 8s 9d 2c').tiebreak).toEqual([9]);
  });
});

describe('cross-check against brute force', () => {
  it('matches the 21-combination reference on 3,000 random 7-card hands', () => {
    const rng = createSeededRng(2024);
    for (let i = 0; i < 3000; i++) {
      const cards = shuffledDeck(rng).slice(0, 7);
      expect(evaluate(cards).score).toBe(evaluateBruteForce(cards).score);
    }
  });

  it('best five cards really produce the evaluated hand', () => {
    const rng = createSeededRng(99);
    for (let i = 0; i < 500; i++) {
      const cards = shuffledDeck(rng).slice(0, 7);
      const detailed = evaluateDetailed(cards);
      expect(detailed.bestFive).toHaveLength(5);
      expect(evaluate(detailed.bestFive).score).toBe(detailed.score);
    }
  });
});
