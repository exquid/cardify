import { isCard } from '../game/cards';
import type { BotProfileId, PlayerAction, PlayerKind } from '../game/types';
import type { TableView } from '../game/views';
import type { DurakAction } from '../durak/types';
import type { DurakView } from '../durak/views';
import type { GameId } from '../hub/tableGame';

/**
 * Wire protocol between the browser and the authoritative table server.
 * Shared by both sides; everything is plain JSON.
 *
 * The server never sends the deck or anyone else's hole cards: table state
 * travels only as the recipient's own `TableView` (see game/views.ts).
 */

export const PROTOCOL_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_SEATS = 6;
export const NAME_MAX_LENGTH = 16;
export const ROOM_CODE_LENGTH = 5;
/** Unambiguous characters only (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Games a private table can host. */
export const TABLE_GAMES = ['holdem', 'durak'] as const;
export type TableGameId = (typeof TABLE_GAMES)[number] & GameId;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'create'; name: string; game: TableGameId }
  | { t: 'join'; code: string; name: string }
  | { t: 'resume'; code: string; token: string }
  | { t: 'add-bot' }
  | { t: 'remove-seat'; playerId: string }
  | { t: 'start' }
  | { t: 'act'; action: PlayerAction | DurakAction; seq: number }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping' };

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface SeatInfo {
  id: string;
  name: string;
  kind: PlayerKind;
  botProfile: BotProfileId | null;
  connected: boolean;
}

export interface LobbyView {
  code: string;
  game: TableGameId;
  hostId: string;
  you: string;
  seats: SeatInfo[];
  maxSeats: number;
  canStart: boolean;
}

export interface TableMeta {
  code: string;
  hostId: string;
  /** Live connection state of every human seat (bots are always true). */
  connected: Record<string, boolean>;
  /** Server time (ms) when the current player's turn auto-acts, or null. */
  turnDeadline: number | null;
  /** Server time (ms) when the next hand is dealt, or null. */
  nextHandAt: number | null;
  /** Server clock at send time, so clients can correct for clock skew. */
  serverNow: number;
}

export type ErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'room-full'
  | 'already-started'
  | 'not-host'
  | 'not-in-room'
  | 'illegal-action'
  | 'stale'
  | 'rate-limited'
  | 'server-full';

export type ServerMessage =
  | { t: 'welcome'; v: number; code: string; token: string; playerId: string }
  | { t: 'lobby'; lobby: LobbyView }
  | { t: 'state'; game: 'holdem'; view: TableView; table: TableMeta }
  | { t: 'state'; game: 'durak'; view: DurakView; table: TableMeta }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'left' }
  | { t: 'pong' };

// ---------------------------------------------------------------------------
// Validation (the server trusts nothing it receives)
// ---------------------------------------------------------------------------

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const TOKEN_RE = /^[a-f0-9]{32}$/;
const ID_RE = /^[a-z0-9-]{1,24}$/;

/** Trims and validates a display name; returns null if unusable. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Control characters become spaces, then whitespace is collapsed.
  const printable = [...value]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : ch;
    })
    .join('');
  const name = printable.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || [...name].length > NAME_MAX_LENGTH) return null;
  return name;
}

export function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAction(v: unknown): PlayerAction | DurakAction | null {
  if (!isObject(v)) return null;
  switch (v.type) {
    // Durak (the room's game rejects actions of another game as illegal).
    case 'attack':
      return isCard(v.card) ? { type: 'attack', card: { rank: v.card.rank, suit: v.card.suit } } : null;
    case 'defend':
      return isCard(v.card) && Number.isSafeInteger(v.attackIndex) && (v.attackIndex as number) >= 0 && (v.attackIndex as number) < 6
        ? { type: 'defend', attackIndex: v.attackIndex as number, card: { rank: v.card.rank, suit: v.card.suit } }
        : null;
    case 'take':
    case 'pass':
      return { type: v.type };
    // Texas Hold'em.
    case 'fold':
    case 'check':
    case 'call':
    case 'allin':
      return { type: v.type };
    case 'bet':
    case 'raise':
      return Number.isSafeInteger(v.amount) && (v.amount as number) > 0 ? { type: v.type, amount: v.amount as number } : null;
    default:
      return null;
  }
}

/** Parses an untrusted frame into a well-formed message, or returns null. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || typeof data.t !== 'string') return null;
  switch (data.t) {
    case 'create': {
      const name = cleanName(data.name);
      const game = data.game === undefined ? 'holdem' : (TABLE_GAMES as readonly unknown[]).includes(data.game) ? (data.game as TableGameId) : null;
      return name && game ? { t: 'create', name, game } : null;
    }
    case 'join': {
      const name = cleanName(data.name);
      const code = normalizeCode(data.code);
      return name && code ? { t: 'join', code, name } : null;
    }
    case 'resume': {
      const code = normalizeCode(data.code);
      const token = typeof data.token === 'string' && TOKEN_RE.test(data.token) ? data.token : null;
      return code && token ? { t: 'resume', code, token } : null;
    }
    case 'remove-seat':
      return typeof data.playerId === 'string' && ID_RE.test(data.playerId) ? { t: 'remove-seat', playerId: data.playerId } : null;
    case 'act': {
      const action = parseAction(data.action);
      return action && Number.isSafeInteger(data.seq) ? { t: 'act', action, seq: data.seq as number } : null;
    }
    case 'add-bot':
    case 'start':
    case 'rematch':
    case 'leave':
    case 'ping':
      return { t: data.t };
    default:
      return null;
  }
}
