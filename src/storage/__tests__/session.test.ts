import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../../game/deck';
import { startNextHand } from '../../game/engine';
import { createSoloTournament } from '../../game/tournament';
import { emptyStats, parseSession, SESSION_SCHEMA_VERSION } from '../session';

function savedJson(mutate?: (state: ReturnType<typeof createSoloTournament>) => void): string {
  const rng = createSeededRng(3);
  const state = startNextHand(createSoloTournament(undefined, { rng }), { rng });
  mutate?.(state);
  return JSON.stringify({ version: SESSION_SCHEMA_VERSION, savedAt: 1, state, stats: emptyStats() });
}

describe('session persistence', () => {
  it('round-trips a game in progress', () => {
    const result = parseSession(savedJson());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.state.hand?.pending.kind).toBe('action');
      expect(result.session.state.players).toHaveLength(4);
    }
  });

  it('flags broken JSON, wrong versions and tampered chips as corrupt', () => {
    expect(parseSession('{not json').status).toBe('corrupt');
    expect(parseSession(JSON.stringify({ version: 99 })).status).toBe('corrupt');
    expect(parseSession(savedJson((s) => (s.players[0]!.stack += 5000))).status).toBe('corrupt');
    expect(parseSession(savedJson((s) => s.hand!.deck.push(s.hand!.deck[0]!))).status).toBe('corrupt');
    expect(parseSession(savedJson((s) => ((s.players[1] as { stack: unknown }).stack = 'lots'))).status).toBe('corrupt');
  });
});
