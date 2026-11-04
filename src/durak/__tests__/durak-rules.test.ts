import { describe, expect, it } from 'vitest';
import { cardCode, parseCard, parseCards, type Card, type Suit } from '../../game/cards';
import { createSeededRng } from '../../game/deck';
import { applyDurakAction, beats, cardCount, createDurak, durakDeck, getDurakLegal, resolveBout } from '../engine';
import { DurakRuleError, type DurakAction, type DurakState } from '../types';
import { getDurakView } from '../views';

/**
 * Durak rule fixtures (podkidnoy, 36 cards). Expected values are worked out by
 * hand from docs/durak-rules.md, not by re-running the engine.
 */

const c = parseCard;
const codes = (cards: readonly Card[]) => cards.map(cardCode).sort();
const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: 'bot' as const }));
const act = (s: DurakState, id: string, a: DurakAction) => applyDurakAction(s, id, a);
const attack = (s: DurakState, id: string, card: string) => act(s, id, { type: 'attack', card: c(card) });
const defend = (s: DurakState, id: string, index: number, card: string) => act(s, id, { type: 'defend', attackIndex: index, card: c(card) });
const pending = (s: DurakState) => ('playerId' in s.pending ? `${s.pending.kind}:${s.pending.playerId}` : s.pending.kind);
const hand = (s: DurakState, id: string) => s.players.find((p) => p.id === id)!.hand;

/** A mid-game state built directly (the state is plain JSON, as in the poker tests). */
function custom(o: { hands: string[]; trump: Suit; trumpCard?: string; talon?: string; attacker?: string; defender?: string; bout?: number }): DurakState {
  const players = o.hands.map((h, seat) => ({ id: `p${seat}`, name: `P${seat}`, kind: 'bot' as const, seat, hand: parseCards(h), out: false, place: null }));
  const attackerId = o.attacker ?? 'p0';
  const defenderId = o.defender ?? 'p1';
  const defender = players.find((p) => p.id === defenderId)!;
  const talon = parseCards(o.talon ?? '');
  const number = o.bout ?? 2;
  const trumpCard = o.trumpCard ? c(o.trumpCard) : (talon[talon.length - 1] ?? { rank: 14, suit: o.trump });
  return {
    schemaVersion: 1,
    game: 'durak',
    players,
    trump: o.trump,
    trumpCard,
    talon,
    discard: [],
    bout: { number, attackerId, defenderId, pairs: [], taking: false, passed: [], limit: Math.min(number === 1 ? 5 : 6, defender.hand.length) },
    pending: { kind: 'attack', playerId: attackerId },
    outcome: null,
    seq: 1,
    events: [],
  };
}

function expectRefused(s: DurakState, fn: (s: DurakState) => unknown): void {
  const before = structuredClone(s);
  expect(() => fn(s)).toThrow(DurakRuleError);
  expect(s).toEqual(before);
}

describe('what beats what', () => {
  it('higher card of the same suit, or any trump over a non-trump', () => {
    expect(beats(c('7h'), c('6h'), 's')).toBe(true);
    expect(beats(c('6h'), c('7h'), 's')).toBe(false);
    expect(beats(c('6s'), c('Ah'), 's')).toBe(true);
    expect(beats(c('Ah'), c('6s'), 's')).toBe(false);
    expect(beats(c('7s'), c('6s'), 's')).toBe(true);
    expect(beats(c('Ac'), c('6h'), 's')).toBe(false); // another plain suit never beats
  });
});

describe('setup', () => {
  it.each([2, 3, 4, 5, 6])('%i players: six cards each, the rest in the talon, trump card drawn last', (n) => {
    const s = createDurak(seats(n), { rng: createSeededRng(n) });
    for (const p of s.players) expect(p.hand).toHaveLength(6);
    expect(s.talon).toHaveLength(36 - 6 * n);
    expect(cardCount(s)).toBe(36);
    expect(s.trump).toBe(s.trumpCard.suit);
    if (n < 6) expect(cardCode(s.talon[s.talon.length - 1]!)).toBe(cardCode(s.trumpCard));
    else expect(s.players[5]!.hand.map(cardCode)).toContain(cardCode(s.trumpCard)); // dealt as the very last card
    expect(new Set([...s.players.flatMap((p) => p.hand), ...s.talon].map(cardCode)).size).toBe(36);
  });

  it('the lowest trump leads; the next player defends', () => {
    // Deal order is seat 0,1,2 per round. Trump: hearts (Ah at the bottom).
    const hands = [parseCards('6c 7c 8c 9c Tc Jc'), parseCards('9h 6d 7d 8d 9d Td'), parseCards('7h 6s 7s 8s 9s Ts')];
    const used = new Set([...hands.flat(), c('Ah')].map(cardCode));
    const rest = durakDeck().filter((x) => !used.has(cardCode(x)));
    const deck: Card[] = [];
    for (let r = 0; r < 6; r++) for (const h of hands) deck.push(h[r]!);
    deck.push(...rest, c('Ah'));
    const s = createDurak(seats(3), { deck });
    expect(s.trump).toBe('h');
    expect(pending(s)).toBe('attack:p2'); // 7h is lower than 9h
    expect(s.bout.defenderId).toBe('p0');
    expect(s.bout.limit).toBe(5); // first bout
  });

  it('rejects a deck that is not 36 distinct Durak cards', () => {
    expect(() => createDurak(seats(2), { deck: durakDeck().slice(0, 35) })).toThrow(DurakRuleError);
    const dup = durakDeck();
    dup[1] = dup[0]!;
    expect(() => createDurak(seats(2), { deck: dup })).toThrow(DurakRuleError);
    expect(() => createDurak(seats(1), { rng: createSeededRng(1) })).toThrow(DurakRuleError);
  });
});

describe('a bout', () => {
  it('throw-ins must match a rank on the table; the first bout stops at five attack cards', () => {
    let s = custom({ hands: ['6c 6d 7c 7d 8c 8d', '6s 7s 8s 9s Ts Js'], trump: 's', trumpCard: 'As', talon: '9c 9d As', bout: 1 });
    expect(s.bout.limit).toBe(5);
    s = attack(s, 'p0', '6c');
    expect(pending(s)).toBe('defend:p1');
    s = defend(s, 'p1', 0, '6s');
    expect(pending(s)).toBe('throw:p0');
    expect(codes(getDurakLegal(s, 'p0')!.attackCards)).toEqual(['6d']); // only rank 6 is on the table
    expectRefused(s, (x) => attack(x, 'p0', '7c'));
    s = attack(s, 'p0', '6d');
    s = defend(s, 'p1', 1, '7s');
    s = attack(s, 'p0', '7c');
    s = defend(s, 'p1', 2, '8s');
    s = attack(s, 'p0', '7d');
    s = defend(s, 'p1', 3, '9s');
    s = attack(s, 'p0', '8c');
    s = defend(s, 'p1', 4, 'Ts');
    // 8d matches the table, but five attack cards is the first-bout limit.
    expect(pending(s)).toBe('resolve');
    s = resolveBout(s);
    expect(s.discard).toHaveLength(10);
    // Attacker draws first (1 → 4, the talon only had 3), the defender gets nothing.
    expect(codes(hand(s, 'p0'))).toEqual(['8d', '9c', '9d', 'As'].sort());
    expect(codes(hand(s, 'p1'))).toEqual(['Js']);
    // Beaten: the defender attacks next. Limit = min(6, new defender's 4 cards).
    expect(pending(s)).toBe('attack:p1');
    expect(s.bout).toMatchObject({ number: 2, defenderId: 'p0', limit: 4 });
  });

  it('never more attack cards than the defender held at the start of the bout', () => {
    let s = custom({ hands: ['6c 6d 6h 9c 9d Kh', '7c 7d'], trump: 's', talon: 'Ks Qs As' });
    expect(s.bout.limit).toBe(2);
    s = attack(s, 'p0', '6c');
    s = defend(s, 'p1', 0, '7c');
    s = attack(s, 'p0', '6d');
    s = defend(s, 'p1', 1, '7d');
    expect(pending(s)).toBe('resolve'); // 6h matches, but the limit is two
  });

  it('take: attackers may still add matching cards, then the defender picks everything up and is skipped', () => {
    let s = custom({ hands: ['6c 6d 6h 9c 9d Kh', '7h 8h Jd Qd Kd Ad', 'Tc Jc 6s Qh Ac Td'], trump: 's', talon: 'Ks Qs As' });
    s = attack(s, 'p0', '6c');
    expect(getDurakLegal(s, 'p1')!.defend).toEqual([{ attackIndex: 0, cards: [] }]); // nothing beats it
    s = act(s, 'p1', { type: 'take' });
    expect(pending(s)).toBe('throw:p0');
    s = attack(s, 'p0', '6d');
    s = act(s, 'p0', { type: 'pass' });
    expect(pending(s)).toBe('throw:p2'); // the third player throws in too
    s = attack(s, 'p2', '6s');
    expect(pending(s)).toBe('throw:p0'); // the table changed: p0 may add again
    s = attack(s, 'p0', '6h');
    // Nobody holds another 6: the engine skips players with nothing to add.
    expect(pending(s)).toBe('resolve');
    s = resolveBout(s);
    expect(s.events).toContainEqual({ type: 'pickup', playerId: 'p1', count: 4 });
    expect(codes(hand(s, 'p1'))).toEqual(codes(parseCards('7h 8h Jd Qd Kd Ad 6c 6d 6s 6h')));
    // Refill order: p0 (attacker) first, then p2; the defender already holds ten.
    expect(hand(s, 'p0')).toHaveLength(6); // 3 left + all 3 talon cards
    expect(hand(s, 'p2')).toHaveLength(5); // the talon ran out before p2's turn
    // Taken: the player after the defender attacks; the defender is skipped.
    expect(pending(s)).toBe('attack:p2');
    expect(s.bout.defenderId).toBe('p0');
  });

  it('refuses illegal commands without changing anything', () => {
    let s = custom({ hands: ['6c 6d 7c 9c 9d Kh', '7h 8h Jd Qd Kd 8c'], trump: 's', talon: 'Ks Qs As' });
    expectRefused(s, (x) => attack(x, 'p1', '7h')); // not p1's turn
    expectRefused(s, (x) => attack(x, 'p0', 'Ah')); // not in hand
    expectRefused(s, (x) => act(x, 'p0', { type: 'pass' })); // the lead attacker must play
    expectRefused(s, (x) => act(x, 'p0', { type: 'take' }));
    expectRefused(s, (x) => applyDurakAction(x, 'p0', { type: 'attack', card: c('6c') }, x.seq - 1)); // stale
    expectRefused(s, (x) => act(x, 'p0', { type: 'dance' } as unknown as DurakAction));
    s = attack(s, 'p0', '6c');
    expectRefused(s, (x) => defend(x, 'p1', 0, '7h')); // a heart does not beat a club
    expectRefused(s, (x) => defend(x, 'p1', 3, '8c')); // no attack card there
    expectRefused(s, (x) => attack(x, 'p1', '8c')); // the defender cannot attack
    s = defend(s, 'p1', 0, '8c');
    expectRefused(s, (x) => attack(x, 'p0', '9c')); // 9 is not on the table
    expectRefused(s, resolveBout); // the bout is not over
  });
});

describe('the end of the game', () => {
  it('the last player holding cards is the durak', () => {
    let s = custom({ hands: ['6c', '7c 8c'], trump: 's', trumpCard: 'As' });
    s = attack(s, 'p0', '6c');
    s = defend(s, 'p1', 0, '7c');
    expect(pending(s)).toBe('resolve'); // p0 has nothing left to throw
    s = resolveBout(s);
    expect(s.outcome).toEqual({ kind: 'loser', loserId: 'p1' });
    expect(s.players[0]).toMatchObject({ out: true, place: 1 });
    expect(pending(s)).toBe('over');
    expectRefused(s, resolveBout);
    expectRefused(s, (x) => attack(x, 'p1', '8c'));
  });

  it('everyone out in the same bout is a draw', () => {
    let s = custom({ hands: ['6c', '7c'], trump: 's', trumpCard: 'As' });
    s = attack(s, 'p0', '6c');
    s = defend(s, 'p1', 0, '7c');
    s = resolveBout(s);
    expect(s.outcome).toEqual({ kind: 'draw' });
  });

  it('a player who runs out after the talon is empty is safe and skipped', () => {
    // p0 attacks p1 with its last card and is out; p1 beats it and attacks p2.
    let s = custom({ hands: ['6c', '7c 9h', 'Td Jd'], trump: 's', trumpCard: 'As' });
    s = attack(s, 'p0', '6c');
    s = defend(s, 'p1', 0, '7c');
    expect(pending(s)).toBe('resolve'); // p2 holds no 6 or 7
    s = resolveBout(s);
    expect(s.players[0]).toMatchObject({ out: true, place: 1 });
    expect(pending(s)).toBe('attack:p1');
    expect(s.bout.defenderId).toBe('p2');
  });
});

describe('views', () => {
  it('a viewer sees their own hand, counts for everyone else, and never the talon', () => {
    const s = createDurak(seats(3), { rng: createSeededRng(4) });
    const v = getDurakView(s, 'p1');
    expect(v.players.find((p) => p.id === 'p1')!.hand!.map(cardCode)).toEqual(s.players[1]!.hand.map(cardCode));
    for (const p of v.players) if (p.id !== 'p1') expect(p.hand).toBeNull();
    expect(v.talonCount).toBe(18);
    const json = JSON.stringify(v);
    expect(json).not.toContain('"talon"');
    for (const card of s.talon.slice(0, -1)) expect(json).not.toContain(`{"rank":${card.rank},"suit":"${card.suit}"}`);
    for (const p of s.players.filter((x) => x.id !== 'p1')) for (const card of p.hand) expect(json).not.toContain(`{"rank":${card.rank},"suit":"${card.suit}"}`);
  });
});
