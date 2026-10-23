import type { GameEvent } from '../game/types';

const chipFormatter = new Intl.NumberFormat('en-US');

export function chips(amount: number): string {
  return chipFormatter.format(amount);
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const STREET_NAMES = { flop: 'Flop', turn: 'Turn', river: 'River' } as const;

/**
 * One-line, human readable description of an engine event for the feed.
 * Returns null for events that are not worth a line of their own.
 */
export function describeEvent(event: GameEvent, nameOf: (id: string) => string): string | null {
  // "You" takes the base verb form: "You call", "Vex calls".
  const v = (id: string, third: string, base: string): string => {
    const who = nameOf(id);
    return `${who} ${who === 'You' ? base : third}`;
  };
  switch (event.type) {
    case 'hand-start':
      return `Hand #${event.handNumber} · blinds ${chips(event.smallBlind)}/${chips(event.bigBlind)}`;
    case 'level-up':
      return `Blinds up — level ${event.level}: ${chips(event.smallBlind)}/${chips(event.bigBlind)}`;
    case 'blind':
      return `${v(event.playerId, 'posts', 'post')} ${event.blind} blind ${chips(event.amount)}${event.allIn ? ' (all-in)' : ''}`;
    case 'hole-cards':
      return null;
    case 'action': {
      const id = event.playerId;
      const allIn = event.allIn ? ' — all-in' : '';
      switch (event.action) {
        case 'fold':
          return v(id, 'folds', 'fold');
        case 'check':
          return v(id, 'checks', 'check');
        case 'call':
          return `${v(id, 'calls', 'call')} ${chips(event.amount)}${allIn}`;
        case 'bet':
          return `${v(id, 'bets', 'bet')} ${chips(event.to)}${allIn}`;
        case 'raise':
          return `${v(id, 'raises', 'raise')} to ${chips(event.to)}${allIn}`;
      }
      return null;
    }
    case 'street':
      return `${STREET_NAMES[event.street]} dealt`;
    case 'refund':
      return `${chips(event.amount)} returned to ${nameOf(event.playerId) === 'You' ? 'you' : nameOf(event.playerId)}`;
    case 'show':
      return `${v(event.playerId, 'shows', 'show')} ${event.handName}`;
    case 'award': {
      const pot = event.potCount > 1 ? (event.potIndex === 0 ? ' from the main pot' : ` from side pot ${event.potIndex}`) : '';
      const how = event.handName ? ` with ${event.handName}` : '';
      return `${v(event.playerId, 'wins', 'win')} ${chips(event.amount)}${pot}${how}`;
    }
    case 'eliminated':
      return `${v(event.playerId, 'is', 'are')} out in ${ordinal(event.place)} place`;
    case 'tournament-won':
      return `${v(event.playerId, 'wins', 'win')} the tournament`;
  }
}

/** Short label shown on a seat after the player's latest action. */
export function actionTag(event: Extract<GameEvent, { type: 'action' }>): string {
  if (event.allIn && event.action !== 'fold' && event.action !== 'check') return 'All-in';
  switch (event.action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Call ${chips(event.amount)}`;
    case 'bet':
      return `Bet ${chips(event.to)}`;
    case 'raise':
      return `Raise ${chips(event.to)}`;
  }
}
