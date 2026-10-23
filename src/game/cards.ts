/** Card primitives shared by the engine, the bots and the UI. */

export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Suit = (typeof SUITS)[number];

/** 2..10 are face values, 11 = Jack, 12 = Queen, 13 = King, 14 = Ace. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

const RANK_CHARS: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const RANK_NAMES: Record<Rank, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

const RANK_PLURALS: Record<Rank, string> = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
  9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
};

export const SUIT_SYMBOLS: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SUIT_NAMES: Record<Suit, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

export function isRank(value: unknown): value is Rank {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 14;
}

export function isSuit(value: unknown): value is Suit {
  return typeof value === 'string' && (SUITS as readonly string[]).includes(value);
}

export function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isRank(v.rank) && isSuit(v.suit);
}

/** Compact code such as "As", "Td", "7c". */
export function cardCode(card: Card): string {
  return `${RANK_CHARS[card.rank]}${card.suit}`;
}

export function parseCard(code: string): Card {
  const trimmed = code.trim();
  const rankPart = trimmed.slice(0, -1).toUpperCase();
  const suitPart = trimmed.slice(-1).toLowerCase();
  const normalizedRank = rankPart === '10' ? 'T' : rankPart;
  const entry = (Object.entries(RANK_CHARS) as [string, string][]).find(([, ch]) => ch === normalizedRank);
  if (!entry || !isSuit(suitPart)) throw new Error(`Invalid card code: "${code}"`);
  return { rank: Number(entry[0]) as Rank, suit: suitPart };
}

/** Parses a whitespace-separated list: "As Kd 7c". */
export function parseCards(codes: string): Card[] {
  return codes.split(/\s+/).filter(Boolean).map(parseCard);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

export function rankLabel(rank: Rank): string {
  return rank === 10 ? '10' : RANK_CHARS[rank];
}

export function rankName(rank: Rank): string {
  return RANK_NAMES[rank];
}

export function rankPlural(rank: Rank): string {
  return RANK_PLURALS[rank];
}

export function cardName(card: Card): string {
  return `${RANK_NAMES[card.rank]} of ${SUIT_NAMES[card.suit]}`;
}

export function isRedSuit(suit: Suit): boolean {
  return suit === 'h' || suit === 'd';
}
