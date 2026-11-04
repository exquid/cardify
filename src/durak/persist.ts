import { cardCode, isCard } from '../game/cards';
import { getDurakLegal } from './engine';
import type { DurakState } from './types';

/**
 * Saved Durak games: a versioned envelope and a defensive validator. A save
 * that fails any check is treated as missing — it never crashes the game.
 */

export const DURAK_SAVE_KEY = 'cardify.durak.v1';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cards = (v: unknown): boolean => Array.isArray(v) && v.every(isCard);

/** Returns a reason when `value` is not a usable DurakState, otherwise null. */
export function validateDurakState(value: unknown): string | null {
  if (!isObject(value) || value.game !== 'durak' || value.schemaVersion !== 1) return 'Not a Durak save';
  const s = value as unknown as DurakState;
  if (!Array.isArray(s.players) || s.players.length < 2 || s.players.length > 6) return 'Bad players';
  for (const p of s.players) {
    if (!isObject(p) || typeof p.id !== 'string' || typeof p.name !== 'string' || !cards(p.hand) || typeof p.out !== 'boolean') return 'Bad player';
  }
  if (!cards(s.talon) || !cards(s.discard) || !isCard(s.trumpCard)) return 'Bad piles';
  if (!isObject(s.bout) || !Array.isArray(s.bout.pairs)) return 'Bad bout';
  for (const pair of s.bout.pairs) if (!isObject(pair) || !isCard(pair.attack) || (pair.defense !== null && !isCard(pair.defense))) return 'Bad pair';
  const all = [
    ...s.players.flatMap((p) => p.hand),
    ...s.talon,
    ...s.discard,
    ...s.bout.pairs.flatMap((x) => (x.defense ? [x.attack, x.defense] : [x.attack])),
  ];
  if (all.length !== 36 || new Set(all.map(cardCode)).size !== 36) return 'Cards do not add up';
  if (!Number.isSafeInteger(s.seq) || !isObject(s.pending)) return 'Bad progress';
  const ids = new Set(s.players.map((p) => p.id));
  if (!ids.has(s.bout.attackerId) || !ids.has(s.bout.defenderId)) return 'Bad bout seats';
  if ('playerId' in s.pending) {
    if (!ids.has(s.pending.playerId)) return 'Bad actor';
    try {
      if (!getDurakLegal(s, s.pending.playerId)) return 'Bad actor';
    } catch {
      return 'Bad actor';
    }
  } else if (!['resolve', 'over'].includes(s.pending.kind)) return 'Bad pending step';
  return null;
}

export function loadDurak(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): DurakState | null {
  try {
    const raw = storage?.getItem(DURAK_SAVE_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!isObject(data) || data.version !== 1) return null;
    return validateDurakState(data.state) === null ? (data.state as DurakState) : null;
  } catch {
    return null;
  }
}

export function saveDurak(state: DurakState, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (state.pending.kind === 'over') storage?.removeItem(DURAK_SAVE_KEY);
    else storage?.setItem(DURAK_SAVE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), state }));
  } catch {
    /* private mode or quota: the game simply is not saved */
  }
}

export function clearDurak(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(DURAK_SAVE_KEY);
  } catch {
    /* ignore */
  }
}
