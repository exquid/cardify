import { cardName, type Card } from '../game/cards';
import type { GameEvent, PlayerAction } from '../game/types';
import type { TableView } from '../game/views';
import type { Settings } from '../storage/session';
import { Controls } from './controls';
import { h, ICONS, setText, svg } from './dom';
import { flyChips, PULSE, type SoundBoard } from './effects';
import { chips, describeEvent, ordinal } from './format';
import { newEvents, TableRenderer, winnerInfo, type SeatExtras } from './table';

const HISTORY_LIMIT = 80;

export interface TableScreenHooks {
  onAction(action: PlayerAction, seq: number): void;
  onNextHand(): void;
  onMenu(): void;
  onToggleSound(): void;
  /** Omit to hide the speed toggle (online tables are paced by the server). */
  onToggleSpeed?: () => void;
  onHistory(lines: readonly string[]): void;
}

export interface TableScreenEnv {
  sound: SoundBoard;
  settings(): Settings;
  motion(): boolean;
}

export interface FrameContext {
  /** Play sounds/animations for new events (false when restoring a snapshot). */
  effects: boolean;
  status: string;
  /** No next hand for this player (tournament over or busted). */
  final: boolean;
  autoNextIn: number | null;
  /** Whether this player deals the next hand themselves (solo) or the server does. */
  canDealNext: boolean;
  /** Seconds left on the viewer's own turn clock, if any. */
  turnSeconds: number | null;
  seats?: Map<string, SeatExtras>;
}

/**
 * The in-game screen shared by solo and online play: top bar, table, event
 * feed and action dock. It only renders TableViews and forwards input; the
 * driver (local engine or server) decides what happens.
 */
export class TableScreen {
  readonly root: HTMLElement;
  readonly history: string[] = [];
  private readonly table: TableRenderer;
  private readonly controls: Controls;
  private readonly feedText: HTMLElement;
  private readonly live: HTMLElement;
  private readonly handInfo: HTMLElement;
  private readonly soundBtn: HTMLButtonElement;
  private readonly speedBtn: HTMLButtonElement | null;
  private view: TableView | null = null;
  private lastContext: FrameContext | null = null;

  constructor(
    private readonly heroId: string,
    initial: TableView,
    private readonly env: TableScreenEnv,
    hooks: TableScreenHooks,
  ) {
    this.table = new TableRenderer(heroId, initial.players);
    this.controls = new Controls({ onAction: hooks.onAction, onNextHand: hooks.onNextHand });

    const menuBtn = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Menu' }, on: { click: hooks.onMenu } });
    menuBtn.append(svg(ICONS.menu));
    this.soundBtn = h('button', { class: 'icon-btn', attrs: { type: 'button' }, on: { click: hooks.onToggleSound } });
    const onSpeed = hooks.onToggleSpeed;
    this.speedBtn = onSpeed
      ? h('button', { class: 'icon-btn icon-btn--text', attrs: { type: 'button' }, on: { click: () => onSpeed() } })
      : null;
    this.handInfo = h('div', { class: 'topbar__info' });
    const brand = h('div', { class: 'topbar__brand', attrs: { 'aria-hidden': 'true' } });
    brand.append(h('span', { class: 'brand__script', text: 'cardify' }));

    this.feedText = h('span', { class: 'feed__text', text: 'Shuffling up and dealing…' });
    const feed = h(
      'button',
      { class: 'feed', attrs: { type: 'button', 'aria-label': 'Show hand history' }, on: { click: () => hooks.onHistory(this.history) } },
      this.feedText,
      h('span', { class: 'feed__more', text: 'Log', attrs: { 'aria-hidden': 'true' } }),
    );
    this.live = h('div', { class: 'sr-only', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.root = h(
      'div',
      { class: 'screen screen--game' },
      h('header', { class: 'topbar' }, menuBtn, brand, this.handInfo, h('div', { class: 'topbar__tools' }, this.speedBtn, this.soundBtn)),
      h('section', { class: 'stage', attrs: { 'aria-label': 'Poker table' } }, this.table.root),
      feed,
      this.controls.root,
      this.live,
    );
    this.refreshTools();
  }

  /** Full render of a new view, including sounds, feed lines and announcements. */
  render(view: TableView, ctx: FrameContext): void {
    const previous = this.view;
    this.view = view;
    this.lastContext = ctx;
    const timings = PULSE[this.env.settings().speed];
    this.table.update(view, {
      animate: this.env.motion() && ctx.effects,
      dealStagger: timings.dealStagger,
      seats: ctx.seats ?? new Map(),
    });
    this.controls.update(view, ctx);
    this.updateTopbar(view);
    this.handleEvents(newEvents(previous, view), view, previous, ctx.effects);
  }

  /** Cheap refresh for countdowns: no events, no animations. */
  tick(ctx: FrameContext): void {
    const view = this.view;
    if (!view) return;
    this.lastContext = ctx;
    this.controls.update(view, ctx);
    this.table.update(view, { animate: false, dealStagger: 0, seats: ctx.seats ?? new Map() });
  }

  notify(line: string): void {
    this.pushHistory(line);
    setText(this.feedText, line);
  }

  refreshTools(): void {
    const settings = this.env.settings();
    this.soundBtn.replaceChildren(svg(settings.sound ? ICONS.soundOn : ICONS.soundOff));
    this.soundBtn.setAttribute('aria-label', settings.sound ? 'Sound on — tap to mute' : 'Sound off — tap to unmute');
    this.soundBtn.setAttribute('aria-pressed', String(settings.sound));
    if (this.speedBtn) {
      setText(this.speedBtn, settings.speed === 'fast' ? 'Fast' : 'Normal');
      this.speedBtn.setAttribute('aria-label', `Speed: ${settings.speed}. Tap to switch.`);
    }
  }

  handleKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const inSlider = target instanceof HTMLInputElement && target.type === 'range';
    if (target instanceof HTMLInputElement && !inSlider) return;
    if (inSlider && e.key.startsWith('Arrow')) return;
    if (inSlider && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.controls.handleKey('r');
      return;
    }
    if (target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
    if (this.controls.handleKey(e.key)) e.preventDefault();
  }

  /** Re-renders the last view without effects (e.g. after an action was refused). */
  rerender(): void {
    if (this.view && this.lastContext) this.render(this.view, { ...this.lastContext, effects: false });
  }

  private updateTopbar(view: TableView): void {
    const next = view.handsUntilNextLevel;
    this.handInfo.replaceChildren(
      h('span', {
        class: 'topbar__hand',
        text: `${view.handNumber > 0 ? `Hand ${view.handNumber}` : 'Sit & Go'} · Blinds ${chips(view.smallBlind)}/${chips(view.bigBlind)}`,
      }),
      h('span', {
        class: 'topbar__next',
        text: `Level ${view.level} · next ${chips(view.nextBlinds.smallBlind)}/${chips(view.nextBlinds.bigBlind)} in ${next} ${next === 1 ? 'hand' : 'hands'}`,
      }),
    );
  }

  /** Sounds, feed lines, screen reader announcements and chip flights for new events. */
  private handleEvents(events: GameEvent[], view: TableView, previous: TableView | null, effects: boolean): void {
    const heroId = this.heroId;
    const nameOf = (id: string): string => (id === heroId ? 'You' : view.players.find((p) => p.id === id)?.name ?? id);
    const sound = this.env.sound;
    const announcements: string[] = [];

    for (const event of events) {
      const line = describeEvent(event, nameOf);
      if (line) this.pushHistory(line);
      if (!effects) continue;
      switch (event.type) {
        case 'hole-cards': {
          sound.play('deal');
          const mine = view.players.find((p) => p.id === heroId)?.holeCards;
          if (mine) announcements.push(`Hand ${view.handNumber}. You hold ${spoken(mine)}.`);
          break;
        }
        case 'action':
          sound.play(event.action === 'fold' ? 'fold' : event.action === 'check' ? 'check' : 'chip');
          break;
        case 'street':
          sound.play('card');
          announcements.push(`${event.street[0]?.toUpperCase()}${event.street.slice(1)}: ${spoken(event.cards)}.`);
          break;
        case 'award': {
          sound.play(event.playerId === heroId ? 'win' : 'chip');
          const plate = this.table.seatPlate(event.playerId);
          if (this.env.motion() && plate) flyChips(this.table.potEl, plate, this.table.fxLayer, event.potIndex * 140);
          if (line) announcements.push(line);
          break;
        }
        case 'level-up':
        case 'eliminated':
        case 'tournament-won':
          if (line) announcements.push(line);
          break;
        default:
          break;
      }
    }

    // Our turn just started.
    const myTurnNow = !!view.legal;
    const myTurnBefore = !!previous?.legal && previous.seq === view.seq;
    if (effects && myTurnNow && !myTurnBefore) {
      sound.play('turn');
      const toCall = view.legal?.toCall ?? 0;
      announcements.push(toCall > 0 ? `Your turn. ${chips(toCall)} to call.` : 'Your turn.');
      this.controls.focusPrimary();
    }

    const latest = this.history[this.history.length - 1];
    if (latest) setText(this.feedText, latest);
    if (announcements.length > 0) setText(this.live, announcements.join(' '));
  }

  private pushHistory(line: string): void {
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }
}

/**
 * Status line under the table, derived only from the view.
 * `thinking` customises how the acting opponent is described.
 */
export function describeStatus(view: TableView, heroId: string, thinking?: (name: string, id: string) => string): string {
  const hero = view.players.find((p) => p.id === heroId);
  const pending = view.pending;
  if (view.status === 'finished') return view.winnerId === heroId ? 'You won the tournament' : 'Tournament complete';
  if (hero?.status === 'out') return `You finished ${hero.finishPlace ? ordinal(hero.finishPlace) : 'out'} — watching`;
  if (!pending) return 'Shuffling…';
  const suffix = hero?.status === 'folded' ? ' · you folded' : hero?.status === 'allin' ? ' · you are all-in' : '';
  switch (pending.kind) {
    case 'action': {
      const actor = view.players.find((p) => p.id === pending.playerId);
      const name = actor?.name ?? 'Opponent';
      return `${thinking ? thinking(name, pending.playerId) : `${name} is thinking…`}${suffix}`;
    }
    case 'deal':
      return `Dealing the ${pending.street}…${suffix}`;
    case 'showdown':
      return 'Showdown';
    case 'complete':
      return winnerInfo(view)?.title ?? 'Hand complete';
  }
}

function spoken(cards: readonly Card[]): string {
  return cards.map(cardName).join(', ');
}
