import { describe, expect, it } from 'vitest';
import { durakGame } from '../../durak/game';
import { createSeededRng } from '../../game/deck';
import { createPokerGame } from '../pokerGame';
import { runUntilHuman, type HubSeat, type TableGame } from '../tableGame';
import { GAMES } from '../catalog';

/**
 * Stage 3 exit gate: poker and Durak both run through the same hub contract,
 * with the same generic driver, without either one leaking hidden cards
 * through its view.
 */

const seats = (n: number, humans = 0): HubSeat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Seat ${i}`, kind: i < humans ? 'human' : 'bot' }));

function playToEnd<S, A, V>(game: TableGame<S, A, V>, n: number, seed: number): S {
  const rng = createSeededRng(seed);
  let state = game.create(seats(n), rng);
  for (let i = 0; i < 200 && !game.isOver(state); i++) state = runUntilHuman(game, state, rng, () => false, 20_000);
  return state;
}

describe('hub contract', () => {
  it("Texas Hold'em plays whole tournaments through the generic driver", () => {
    const poker = createPokerGame({ startingStack: 300, handsPerLevel: 2, blindLevels: [{ smallBlind: 10, bigBlind: 20 }], blindGrowthAfterTable: 2 });
    for (const n of [2, 4, 6]) expect(poker.isOver(playToEnd(poker, n, n))).toBe(true);
  });

  it('Durak plays whole games through the same driver', () => {
    for (const n of [2, 3, 4, 6]) expect(durakGame.isOver(playToEnd(durakGame, n, 40 + n))).toBe(true);
  });

  it('a driver stops for a human and resumes after their move', () => {
    const rng = createSeededRng(9);
    let s = durakGame.create(seats(3, 1), rng);
    s = runUntilHuman(durakGame, s, rng, (id) => id === 's0');
    if (!durakGame.isOver(s)) {
      expect(durakGame.actor(s)).toBe('s0');
      const seq = durakGame.seq(s);
      s = durakGame.act(s, 's0', durakGame.timeoutAction(s, 's0'), seq);
      expect(durakGame.seq(s)).toBe(seq + 1);
    }
  });

  it('views are private for both games', () => {
    const rng = createSeededRng(3);
    const poker = createPokerGame();
    const p = poker.create(seats(3), rng);
    const pv = JSON.stringify(poker.view(p, 's1'));
    expect(pv).not.toContain('"deck"');
    const d = durakGame.create(seats(3), rng);
    const dv = durakGame.view(d, 's1');
    expect(JSON.stringify(dv)).not.toContain('"talon"');
    expect(dv.players.filter((x) => x.hand !== null).map((x) => x.id)).toEqual(['s1']);
  });

  it('the catalogue lists every game the hub knows', () => {
    expect(GAMES.map((g) => g.id)).toEqual(['holdem', 'durak', 'blackjack']);
    expect([createPokerGame().id, durakGame.id].every((id) => GAMES.some((g) => g.id === id))).toBe(true);
  });
});
