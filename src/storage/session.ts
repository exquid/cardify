import { isCard, type Card } from '../game/cards';
import type { GameState, Player } from '../game/types';

/**
 * localStorage persistence with a schema version and defensive validation.
 * Any problem (old schema, manual edits, truncated JSON, broken invariants)
 * yields `corrupt` so the app can offer a clean New Game instead of crashing.
 *
 * Trust note: in v1 the whole game — including the shuffled deck — lives in
 * the browser, so a curious player could read upcoming cards from storage.
 * That is acceptable for single-player; multiplayer must keep secrets on a server.
 */

const SESSION_KEY = 'cardify.session.v1';
const SETTINGS_KEY = 'cardify.settings.v1';
export const SESSION_SCHEMA_VERSION = 1;

export interface SessionStats {
  handsPlayed: number;
  handsWon: number;
  biggestPotWon: number;
}

export interface SavedSession {
  version: typeof SESSION_SCHEMA_VERSION;
  savedAt: number;
  state: GameState;
  stats: SessionStats;
}

export type LoadResult =
  | { status: 'none' }
  | { status: 'ok'; session: SavedSession }
  | { status: 'corrupt'; reason: string };

export interface Settings {
  speed: 'normal' | 'fast';
  sound: boolean;
  animations: boolean;
  autoNextHand: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  speed: 'normal',
  sound: true,
  animations: true,
  autoNextHand: false,
};

export function emptyStats(): SessionStats {
  return { handsPlayed: 0, handsWon: 0, biggestPotWon: 0 };
}

/** Storage can throw (Safari private mode, quota, disabled cookies). */
function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function saveSession(session: Omit<SavedSession, 'version' | 'savedAt'>): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const payload: SavedSession = { version: SESSION_SCHEMA_VERSION, savedAt: Date.now(), ...session };
    s.setItem(SESSION_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadSession(): LoadResult {
  const s = storage();
  if (!s) return { status: 'none' };
  let raw: string | null;
  try {
    raw = s.getItem(SESSION_KEY);
  } catch {
    return { status: 'none' };
  }
  if (raw === null) return { status: 'none' };
  return parseSession(raw);
}

export function clearSession(): void {
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function parseSession(raw: string): LoadResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', reason: 'Saved game is not valid JSON' };
  }
  if (!isObject(data)) return { status: 'corrupt', reason: 'Saved game has an unexpected shape' };
  if (data.version !== SESSION_SCHEMA_VERSION) {
    return { status: 'corrupt', reason: `Unsupported save version ${String(data.version)}` };
  }
  const problem = validateState(data.state);
  if (problem) return { status: 'corrupt', reason: problem };
  const stats = isObject(data.stats) ? data.stats : {};
  return {
    status: 'ok',
    session: {
      version: SESSION_SCHEMA_VERSION,
      savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
      state: data.state as GameState,
      stats: {
        handsPlayed: safeCount(stats.handsPlayed),
        handsWon: safeCount(stats.handsWon),
        biggestPotWon: safeCount(stats.biggestPotWon),
      },
    },
  };
}

/** Returns a human-readable problem, or null when the state is usable. */
export function validateState(value: unknown): string | null {
  if (!isObject(value)) return 'Missing game state';
  const state = value as Partial<GameState>;
  if (state.schemaVersion !== 1) return 'Unknown game schema';
  const config = state.config;
  if (!isObject(config) || !isChipCount(config.startingStack) || !Array.isArray(config.blindLevels) || config.blindLevels.length === 0) {
    return 'Invalid tournament config';
  }
  if (!Array.isArray(state.players) || state.players.length < 2 || state.players.length > 10) return 'Invalid players';
  for (const p of state.players as unknown[]) {
    if (!isValidPlayer(p)) return 'Invalid player record';
  }
  const players = state.players as Player[];
  if (new Set(players.map((p) => p.id)).size !== players.length) return 'Duplicate player ids';
  if (!isChipCount(state.handNumber) || !isChipCount(state.seq) || !Number.isInteger(state.dealerSeat)) {
    return 'Invalid counters';
  }
  if (state.status !== 'running' && state.status !== 'finished') return 'Invalid status';

  const total = players.reduce((sum, p) => sum + p.stack + p.contribution, 0);
  if (total !== config.startingStack * players.length) return 'Chip totals do not add up';

  const hand = state.hand;
  if (hand !== null) {
    if (!isObject(hand) || !Array.isArray(hand.board) || !Array.isArray(hand.deck) || !isObject(hand.pending)) {
      return 'Invalid hand';
    }
    const cards: unknown[] = [...hand.board, ...hand.deck, ...players.flatMap((p) => p.holeCards)];
    if (!cards.every(isCard)) return 'Invalid cards';
    const codes = (cards as Card[]).map((c) => `${c.rank}${c.suit}`);
    if (new Set(codes).size !== codes.length) return 'Duplicate cards';
    const pending = hand.pending;
    if (pending.kind === 'action' && !players.some((p) => p.id === pending.playerId && p.status === 'active')) {
      return 'Pending action for an unknown player';
    }
    if (!['action', 'deal', 'showdown', 'complete'].includes(pending.kind)) return 'Invalid pending step';
    if (!Array.isArray(hand.events)) return 'Invalid hand events';
  }
  return null;
}

function isValidPlayer(value: unknown): boolean {
  if (!isObject(value)) return false;
  const p = value as Partial<Player>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    (p.kind === 'human' || p.kind === 'bot') &&
    Number.isInteger(p.seat) &&
    isChipCount(p.stack) &&
    isChipCount(p.streetBet) &&
    isChipCount(p.contribution) &&
    Array.isArray(p.holeCards) &&
    ['active', 'folded', 'allin', 'out'].includes(p.status as string) &&
    (p.actedAtLevel === null || isChipCount(p.actedAtLevel))
  );
}

export function loadSettings(): Settings {
  const s = storage();
  try {
    const raw = s?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const data: unknown = JSON.parse(raw);
    if (!isObject(data)) return { ...DEFAULT_SETTINGS };
    return {
      speed: data.speed === 'fast' ? 'fast' : 'normal',
      sound: typeof data.sound === 'boolean' ? data.sound : DEFAULT_SETTINGS.sound,
      animations: typeof data.animations === 'boolean' ? data.animations : DEFAULT_SETTINGS.animations,
      autoNextHand: typeof data.autoNextHand === 'boolean' ? data.autoNextHand : DEFAULT_SETTINGS.autoNextHand,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChipCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeCount(value: unknown): number {
  return isChipCount(value) ? value : 0;
}
