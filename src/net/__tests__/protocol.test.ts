import { describe, expect, it } from 'vitest';
import { cleanName, normalizeCode, parseClientMessage } from '../protocol';

describe('protocol validation', () => {
  it('accepts well-formed messages', () => {
    // Older clients send no game: the table is Texas Hold'em.
    expect(parseClientMessage('{"t":"create","name":"  Tim  "}')).toEqual({ t: 'create', name: 'Tim', game: 'holdem' });
    expect(parseClientMessage('{"t":"create","name":"Tim","game":"durak"}')).toEqual({ t: 'create', name: 'Tim', game: 'durak' });
    expect(parseClientMessage('{"t":"act","action":{"type":"defend","attackIndex":1,"card":{"rank":9,"suit":"h","x":1}},"seq":3}')).toEqual({
      t: 'act',
      action: { type: 'defend', attackIndex: 1, card: { rank: 9, suit: 'h' } },
      seq: 3,
    });
    expect(parseClientMessage('{"t":"act","action":{"type":"take"},"seq":2}')).toEqual({ t: 'act', action: { type: 'take' }, seq: 2 });
    expect(parseClientMessage('{"t":"join","code":"k7qpm","name":"Ann"}')).toEqual({ t: 'join', code: 'K7QPM', name: 'Ann' });
    expect(parseClientMessage('{"t":"act","action":{"type":"raise","amount":120},"seq":4}')).toEqual({
      t: 'act',
      action: { type: 'raise', amount: 120 },
      seq: 4,
    });
    expect(parseClientMessage('{"t":"act","action":{"type":"fold","amount":5},"seq":1}')).toEqual({
      t: 'act',
      action: { type: 'fold' },
      seq: 1,
    });
  });

  it('rejects anything malformed or out of range', () => {
    for (const raw of [
      'nope',
      '[]',
      '{"t":"hack"}',
      '{"t":"create","name":""}',
      '{"t":"create","name":"aaaaaaaaaaaaaaaaaaaaaaa"}',
      '{"t":"join","code":"ABC10","name":"x"}',
      '{"t":"resume","code":"ABCDE","token":"short"}',
      '{"t":"act","action":{"type":"raise","amount":-5},"seq":1}',
      '{"t":"act","action":{"type":"raise","amount":1.5},"seq":1}',
      '{"t":"act","action":{"type":"bet"},"seq":1}',
      '{"t":"act","action":{"type":"call"},"seq":"1"}',
      '{"t":"remove-seat","playerId":"<script>"}',
      '{"t":"create","name":"Tim","game":"blackjack"}',
      '{"t":"act","action":{"type":"attack","card":{"rank":1,"suit":"h"}},"seq":1}',
      '{"t":"act","action":{"type":"defend","attackIndex":9,"card":{"rank":9,"suit":"h"}},"seq":1}',
      '{"t":"act","action":{"type":"defend","card":{"rank":9,"suit":"z"}},"seq":1}',
    ]) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('cleans names and codes', () => {
    expect(cleanName('  Ann\u0000\n  Lee ')).toBe('Ann Lee');
    expect(cleanName(42)).toBeNull();
    expect(normalizeCode(' abcde ')).toBe('ABCDE');
    expect(normalizeCode('ABCD0')).toBeNull();
  });
});
