import { cleanName } from '../net/protocol';

/**
 * Local player profile (Stage 5, no accounts): a display name and lifetime
 * statistics per game, derived from settled results. Each finished game is
 * recorded once, keyed by a game id, so a re-render or a reload can never
 * count it twice.
 */

export const PROFILE_KEY = 'cardify.profile.v1';
const RECENT_LIMIT = 50;

export interface HoldemStats {
  tournaments: number;
  won: number;
  /** Best finishing place (1 = won), or null before the first tournament. */
  bestPlace: number | null;
}

export interface DurakStats {
  games: number;
  /** Games where you were the durak. */
  durak: number;
  /** Games where you got out safely. */
  safe: number;
  draws: number;
}

export interface Profile {
  version: 1;
  name: string;
  holdem: HoldemStats;
  durak: DurakStats;
  /** Ids of recently recorded games (dedupe). */
  recorded: string[];
}

export function emptyProfile(): Profile {
  return { version: 1, name: '', holdem: { tournaments: 0, won: 0, bestPlace: null }, durak: { games: 0, durak: 0, safe: 0, draws: 0 }, recorded: [] };
}

const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rebuilds a profile from untrusted data, keeping every valid field. */
export function parseProfile(value: unknown): Profile {
  const p = emptyProfile();
  if (!isObject(value) || value.version !== 1) return p;
  p.name = cleanName(value.name) ?? '';
  const h = isObject(value.holdem) ? value.holdem : {};
  p.holdem = {
    tournaments: count(h.tournaments),
    won: Math.min(count(h.won), count(h.tournaments)),
    bestPlace: Number.isSafeInteger(h.bestPlace) && (h.bestPlace as number) >= 1 ? (h.bestPlace as number) : null,
  };
  const d = isObject(value.durak) ? value.durak : {};
  p.durak = { games: count(d.games), durak: count(d.durak), safe: count(d.safe), draws: count(d.draws) };
  p.recorded = Array.isArray(value.recorded) ? value.recorded.filter((x): x is string => typeof x === 'string').slice(-RECENT_LIMIT) : [];
  return p;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function loadProfile(storage: Store | undefined = local()): Profile {
  try {
    const raw = storage?.getItem(PROFILE_KEY);
    return raw ? parseProfile(JSON.parse(raw)) : emptyProfile();
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: Profile, storage: Store | undefined = local()): void {
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* private mode or quota: stats simply are not kept */
  }
}

/** Applies `update` once per `gameId`; returns the (possibly unchanged) profile. */
function recordOnce(gameId: string, update: (p: Profile) => void, storage: Store | undefined): Profile {
  const profile = loadProfile(storage);
  if (profile.recorded.includes(gameId)) return profile;
  update(profile);
  profile.recorded = [...profile.recorded, gameId].slice(-RECENT_LIMIT);
  saveProfile(profile, storage);
  return profile;
}

export function recordHoldemResult(gameId: string, place: number, storage: Store | undefined = local()): Profile {
  return recordOnce(
    gameId,
    (p) => {
      p.holdem.tournaments += 1;
      if (place === 1) p.holdem.won += 1;
      p.holdem.bestPlace = p.holdem.bestPlace === null ? place : Math.min(p.holdem.bestPlace, place);
    },
    storage,
  );
}

export function recordDurakResult(gameId: string, result: 'durak' | 'safe' | 'draw', storage: Store | undefined = local()): Profile {
  return recordOnce(
    gameId,
    (p) => {
      p.durak.games += 1;
      if (result === 'durak') p.durak.durak += 1;
      else if (result === 'safe') p.durak.safe += 1;
      else p.durak.draws += 1;
    },
    storage,
  );
}

export function setProfileName(name: string, storage: Store | undefined = local()): Profile {
  const profile = loadProfile(storage);
  profile.name = cleanName(name) ?? '';
  saveProfile(profile, storage);
  return profile;
}

export function resetStats(storage: Store | undefined = local()): Profile {
  const profile = { ...emptyProfile(), name: loadProfile(storage).name };
  saveProfile(profile, storage);
  return profile;
}
