import { describe, expect, it } from 'vitest';
import { cardCode, parseCards, type Card } from '../../game/cards';
import { DEFAULT_CONFIG } from '../../game/config';
import { createSeededRng, shuffledDeck, type Rng } from '../../game/deck';
import { advance, applyPlayerAction, getLegalActions, startNextHand, startTournament } from '../../game/engine';
import { totalChips } from '../../game/rules';
import type { BotProfileId, GameState, PlayerActionType } from '../../game/types';
import { chooseBotAction, processBotTurn } from '../index';
import { chenScore, estimateEquity } from '../handStrength';
import { buildObservation } from '../observation';
import { BOT_PROFILES } from '../profiles';
import { decideAction } from '../strategy';

const FAST = { equityIterations: 40 };

function shuffledDeckWithout(used: Card[], rng: Rng): Card[] {
  const taken = new Set(used.map(cardCode));
  return shuffledDeck(rng).filter((c) => !taken.has(cardCode(c)));
}

function botTable(profiles: BotProfileId[], seed: number): GameState {
  return startTournament(
    DEFAULT_CONFIG,
    profiles.map((profile, i) => ({ id: `${profile}${i}`, name: profile, kind: 'bot' as const, botProfile: profile })),
    { rng: createSeededRng(seed) },
  );
}

describe('hand strength', () => {
  it('scores hole cards with the Chen formula', () => {
    expect(chenScore(parseCards('As Ad'))).toBe(20);
    expect(chenScore(parseCards('Ks Kd'))).toBe(16);
    expect(chenScore(parseCards('As Ks'))).toBe(12);
    expect(chenScore(parseCards('2s 2d'))).toBe(5);
    expect(chenScore(parseCards('7s 2d'))).toBe(-1);
    expect(chenScore(parseCards('Js Ts'))).toBe(9);
  });

  it('estimates equity sensibly', () => {
    const rng = createSeededRng(5);
    const aces = estimateEquity(parseCards('As Ad'), [], 1, 3000, rng);
    expect(aces).toBeGreaterThan(0.81);
    expect(aces).toBeLessThan(0.89);
    const nuts = estimateEquity(parseCards('As Ks'), parseCards('Qs Js Ts 2d 3c'), 3, 200, rng);
    expect(nuts).toBe(1);
    const drawingDead = estimateEquity(parseCards('2c 3d'), parseCards('As Ks Qs Js Ts'), 1, 200, rng);
    // Board plays a royal flush: everyone splits.
    expect(drawingDead).toBeCloseTo(0.5, 5);
  });
});

describe('bot information boundary', () => {
  it('observations never include the deck or other players\' hole cards', () => {
    const rng = createSeededRng(11);
    let s = botTable(['nova', 'vex', 'orion', 'vex'], 11);
    for (let hand = 0; hand < 30 && s.status === 'running'; hand++) {
      s = startNextHand(s, { rng });
      while (s.hand!.pending.kind !== 'complete') {
        const pending = s.hand!.pending;
        if (pending.kind === 'action') {
          const obs = buildObservation(s, pending.playerId)!;
          const json = JSON.stringify(obs);
          expect(json).not.toContain('deck');
          for (const other of s.players.filter((p) => p.id !== pending.playerId)) {
            for (const card of other.holeCards) {
              expect(json).not.toContain(JSON.stringify(card));
            }
          }
          s = processBotTurn(s, rng, FAST);
        } else {
          s = advance(s);
        }
      }
    }
  });
});

describe('bot play', () => {
  it('always picks a legal action and finishes whole tournaments without hanging', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = createSeededRng(seed * 31);
      let s = botTable(['nova', 'vex', 'orion', seed % 2 ? 'vex' : 'nova'], seed);
      const total = totalChips(s);
      let hands = 0;
      while (s.status === 'running') {
        s = startNextHand(s, { rng });
        expect(++hands).toBeLessThan(1500);
        let steps = 0;
        while (s.hand!.pending.kind !== 'complete') {
          expect(++steps).toBeLessThan(200);
          if (s.hand!.pending.kind === 'action') {
            const id = s.hand!.pending.playerId;
            const action = chooseBotAction(s, rng, FAST);
            expect(action).not.toBeNull();
            expect(getLegalActions(s, id)).not.toBeNull();
            // processBotTurn goes through the validating engine command.
            const next = processBotTurn(s, rng, FAST);
            expect(next.seq).toBe(s.seq + 1);
            s = next;
          } else {
            s = advance(s);
          }
          expect(totalChips(s)).toBe(total);
        }
      }
      expect(s.winnerId).not.toBeNull();
    }
  });

  it('calls a preflop shove with premium hands and folds trash', () => {
    const facingShove = (hole: string): PlayerActionType => {
      const rng = createSeededRng(9);
      let s = startTournament(
        DEFAULT_CONFIG,
        [
          { id: 'hero', name: 'Hero', kind: 'human' },
          { id: 'bot', name: 'Nova', kind: 'bot', botProfile: 'nova' },
        ],
        { firstDealerSeat: 0, rng },
      );
      // Heads-up the non-dealer (bot) is dealt first: bot, hero, bot, hero.
      const [b1, b2] = parseCards(hole) as [Card, Card];
      const [h1, h2] = parseCards('7c 2d') as [Card, Card];
      const rest = shuffledDeckWithout([b1, b2, h1, h2], rng);
      s = startNextHand(s, { deck: [b1, h1, b2, h2, ...rest] });
      s = applyPlayerAction(s, 'hero', { type: 'allin' });
      const type = chooseBotAction(s, rng, FAST)!.type;
      // Calling an all-in for the whole stack may come back as "allin".
      return type === 'allin' ? 'call' : type;
    };
    for (const premium of ['Ah Ac', 'Kh Ks', 'Qh Qd']) expect(facingShove(premium)).toBe('call');
    expect(facingShove('8h 3c')).toBe('fold');
  });

  it('personalities differ: Vex is more aggressive than Nova', () => {
    const aggressiveShare = (profile: BotProfileId): number => {
      const rng = createSeededRng(77);
      let aggressive = 0;
      let decisions = 0;
      for (let i = 0; i < 400; i++) {
        let s = botTable(['nova', 'vex', 'orion', 'nova'], 1000 + i);
        s = startNextHand(s, { rng });
        const pending = s.hand!.pending;
        if (pending.kind !== 'action') continue;
        const obs = buildObservation(s, pending.playerId)!;
        const action = decideAction(obs, BOT_PROFILES[profile], rng, FAST);
        decisions++;
        if (action.type === 'raise' || action.type === 'bet' || action.type === 'allin') aggressive++;
      }
      return aggressive / decisions;
    };
    const vex = aggressiveShare('vex');
    const nova = aggressiveShare('nova');
    expect(vex).toBeGreaterThan(nova + 0.1);
  });
});
