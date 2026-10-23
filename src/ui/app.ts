import { processBotTurn } from '../bots';
import { cardName, type Card } from '../game/cards';
import { DEFAULT_CONFIG } from '../game/config';
import { createCryptoRng } from '../game/deck';
import { advance, applyPlayerAction, startNextHand } from '../game/engine';
import { createSoloTournament, HUMAN_ID } from '../game/tournament';
import { IllegalActionError, type GameEvent, type GameState, type PlayerAction } from '../game/types';
import { getPlayerView, type TableView } from '../game/views';
import {
  clearSession,
  emptyStats,
  loadSession,
  loadSettings,
  saveSession,
  saveSettings,
  type SessionStats,
  type Settings,
} from '../storage/session';
import { Controls } from './controls';
import { h, ICONS, setText, svg } from './dom';
import { applyMotion, flyChips, prefersReducedMotion, PULSE, SoundBoard } from './effects';
import { chips, describeEvent } from './format';
import { endScreen, howToPlayBody, menuBody, openSheet, settingsBody, startScreen } from './screens';
import { newEvents, TableRenderer, winnerInfo } from './table';

const HISTORY_LIMIT = 80;

/**
 * Application controller. It owns the current GameState and is the only
 * place that calls engine commands. Rendering, sounds and animations are
 * driven from engine state; timers only ever *request* the next engine step,
 * and every scheduled step is tied to the state version (`seq`) it was
 * planned for, so a stale timer or a double tap can never act twice.
 */
export class App {
  private settings: Settings = loadSettings();
  private readonly sound = new SoundBoard();
  private readonly rng = createCryptoRng();
  private motion = true;

  private state: GameState | null = null;
  private stats: SessionStats = emptyStats();
  private view: TableView | null = null;

  private table: TableRenderer | null = null;
  private controls: Controls | null = null;
  private gameScreen: HTMLElement | null = null;
  private feedText: HTMLElement | null = null;
  private live: HTMLElement | null = null;
  private handInfo: HTMLElement | null = null;
  private soundBtn: HTMLButtonElement | null = null;
  private speedBtn: HTMLButtonElement | null = null;
  private history: string[] = [];

  private timer: number | undefined;
  private ticker: number | undefined;
  private autoNextAt: number | null = null;
  /** Number of open sheets; the table pauses while any is open. */
  private openSheets = 0;

  constructor(private readonly root: HTMLElement) {
    this.motion = applyMotion(this.settings);
    this.sound.enabled = this.settings.sound;
    try {
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
        this.motion = applyMotion(this.settings);
      });
    } catch {
      /* older Safari: no change events, initial value still applies */
    }
    document.addEventListener('keydown', (e) => this.onKey(e));
    // iOS needs a user gesture before audio can play.
    const unlock = (): void => this.sound.unlock();
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  showStart(notice: string | null = null): void {
    this.stopTimers();
    this.unmountGame();
    const saved = loadSession();
    let message = notice;
    if (saved.status === 'corrupt') {
      clearSession();
      message ??= 'Your saved game could not be restored, so a fresh table is ready.';
    }
    const canContinue = saved.status === 'ok' && saved.session.state.status === 'running';
    this.root.replaceChildren(
      startScreen({
        canContinue,
        savedHand: saved.status === 'ok' ? saved.session.state.handNumber : null,
        notice: message,
        onContinue: () => {
          if (saved.status !== 'ok') return;
          this.state = saved.session.state;
          this.stats = saved.session.stats;
          this.history = [];
          this.mountGame();
        },
        onPlay: () => this.newTournament(),
        onHowTo: () => this.openHowTo(),
        onSettings: () => this.openSettings(),
      }),
    );
    (this.root.querySelector('.btn--primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private newTournament(): void {
    this.state = createSoloTournament(DEFAULT_CONFIG, { rng: this.rng });
    this.stats = emptyStats();
    this.history = [];
    this.mountGame();
  }

  private showEnd(): void {
    const state = this.state;
    if (!state) return;
    this.stopTimers();
    clearSession();
    const screen = endScreen({
      state,
      heroId: HUMAN_ID,
      stats: this.stats,
      onNewGame: () => this.newTournament(),
      onMenu: () => this.showStart(),
    });
    this.unmountGame();
    this.root.replaceChildren(screen);
    (screen.querySelector('.btn--primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Game screen
  // -------------------------------------------------------------------------

  private mountGame(): void {
    const state = this.state;
    if (!state) return;
    this.stopTimers();
    this.view = null;

    const initialView = getPlayerView(state, HUMAN_ID);
    this.table = new TableRenderer(HUMAN_ID, initialView.players);
    this.controls = new Controls({
      onAction: (action, seq) => this.onHumanAction(action, seq),
      onNextHand: () => this.nextHand(),
    });

    const menuBtn = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Menu' }, on: { click: () => this.openMenu() } });
    menuBtn.append(svg(ICONS.menu));
    this.soundBtn = h('button', { class: 'icon-btn', attrs: { type: 'button' }, on: { click: () => this.toggleSound() } });
    this.speedBtn = h('button', { class: 'icon-btn icon-btn--text', attrs: { type: 'button' }, on: { click: () => this.toggleSpeed() } });
    this.handInfo = h('div', { class: 'topbar__info' });
    const brand = h('div', { class: 'topbar__brand', attrs: { 'aria-hidden': 'true' } });
    brand.append(svg(ICONS.logo), h('span', { class: 'wordmark wordmark--small', text: 'cardify' }));

    this.feedText = h('span', { class: 'feed__text', text: 'Shuffling up and dealing…' });
    const feed = h(
      'button',
      { class: 'feed', attrs: { type: 'button', 'aria-label': 'Show hand history' }, on: { click: () => this.openHistory() } },
      this.feedText,
      h('span', { class: 'feed__more', text: 'Log', attrs: { 'aria-hidden': 'true' } }),
    );
    this.live = h('div', { class: 'sr-only', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.gameScreen = h(
      'div',
      { class: 'screen screen--game' },
      h('header', { class: 'topbar' }, menuBtn, brand, this.handInfo, h('div', { class: 'topbar__tools' }, this.speedBtn, this.soundBtn)),
      h('section', { class: 'stage', attrs: { 'aria-label': 'Poker table' } }, this.table.root),
      feed,
      this.controls.root,
      this.live,
    );
    this.root.replaceChildren(this.gameScreen);
    this.refreshToolButtons();

    // First render without replaying effects (fresh deal still animates).
    this.render(state, { effects: state.hand?.events.length ? false : true });
    this.schedule();
  }

  private unmountGame(): void {
    this.table = null;
    this.controls = null;
    this.gameScreen = null;
    this.view = null;
  }

  /** Replace the state after an engine command and update everything derived from it. */
  private commit(next: GameState): void {
    const previous = this.state;
    this.state = next;
    this.trackStats(previous, next);
    this.persist();
    this.render(next, { effects: true });
    this.schedule();
  }

  private persist(): void {
    const state = this.state;
    if (!state) return;
    const hero = state.players.find((p) => p.id === HUMAN_ID);
    if (state.status === 'finished' || hero?.status === 'out') clearSession();
    else saveSession({ state, stats: this.stats });
  }

  private trackStats(previous: GameState | null, next: GameState): void {
    const hand = next.hand;
    if (!hand?.result || previous?.hand?.result) return;
    if (previous?.hand?.number !== hand.number) return;
    if ((hand.startingStacks[HUMAN_ID] ?? 0) <= 0) return;
    this.stats.handsPlayed += 1;
    const won = hand.result.awards.flatMap((a) => a.winners).filter((w) => w.playerId === HUMAN_ID).reduce((s, w) => s + w.amount, 0);
    if (won > 0) {
      this.stats.handsWon += 1;
      this.stats.biggestPotWon = Math.max(this.stats.biggestPotWon, won);
    }
  }

  private render(state: GameState, opts: { effects: boolean }): void {
    if (!this.table || !this.controls) return;
    const previous = this.view;
    const view = getPlayerView(state, HUMAN_ID);
    this.view = view;
    const timings = PULSE[this.settings.speed];

    this.table.update(view, { animate: this.motion && opts.effects, dealStagger: timings.dealStagger });
    this.updateControls();
    this.updateTopbar(view);

    const events = newEvents(previous, view);
    this.handleEvents(events, view, previous, opts.effects);
  }

  private updateTopbar(view: TableView): void {
    if (!this.handInfo) return;
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

  private updateControls(): void {
    const view = this.view;
    const state = this.state;
    if (!this.controls || !view || !state) return;
    const hero = state.players.find((p) => p.id === HUMAN_ID);
    const heroOut = hero?.status === 'out';
    const final = state.status === 'finished' || heroOut;
    let autoNextIn: number | null = null;
    if (this.autoNextAt !== null) autoNextIn = Math.max(0, Math.ceil((this.autoNextAt - Date.now()) / 1000));
    this.controls.update(view, { status: this.statusText(view, state), autoNextIn, final });
  }

  private statusText(view: TableView, state: GameState): string {
    const hero = state.players.find((p) => p.id === HUMAN_ID);
    const pending = view.pending;
    if (state.status === 'finished') return state.winnerId === HUMAN_ID ? 'You won the tournament' : 'Tournament complete';
    if (hero?.status === 'out') return 'You are out — final standings next';
    if (!pending) return 'Shuffling…';
    const suffix = hero?.status === 'folded' ? ' · you folded' : hero?.status === 'allin' ? ' · you are all-in' : '';
    switch (pending.kind) {
      case 'action': {
        const actor = view.players.find((p) => p.id === pending.playerId);
        return `${actor?.name ?? 'Opponent'} is thinking…${suffix}`;
      }
      case 'deal':
        return `Dealing the ${pending.street}…${suffix}`;
      case 'showdown':
        return 'Showdown';
      case 'complete':
        return winnerInfo(view)?.title ?? 'Hand complete';
    }
  }

  /** Sounds, feed lines, screen reader announcements and chip flights for new events. */
  private handleEvents(events: GameEvent[], view: TableView, previous: TableView | null, effects: boolean): void {
    const nameOf = (id: string): string => (id === HUMAN_ID ? 'You' : view.players.find((p) => p.id === id)?.name ?? id);
    const announcements: string[] = [];

    for (const event of events) {
      const line = describeEvent(event, nameOf);
      if (line) this.pushHistory(line);
      if (!effects) continue;
      switch (event.type) {
        case 'hole-cards': {
          this.sound.play('deal');
          const mine = view.players.find((p) => p.id === HUMAN_ID)?.holeCards;
          if (mine) announcements.push(`Hand ${view.handNumber}. You hold ${spoken(mine)}.`);
          break;
        }
        case 'action':
          this.sound.play(event.action === 'fold' ? 'fold' : event.action === 'check' ? 'check' : 'chip');
          break;
        case 'street':
          this.sound.play('card');
          announcements.push(`${event.street[0]?.toUpperCase()}${event.street.slice(1)}: ${spoken(event.cards)}.`);
          break;
        case 'award': {
          this.sound.play(event.playerId === HUMAN_ID ? 'win' : 'chip');
          const plate = this.table?.seatPlate(event.playerId);
          if (this.motion && plate && this.table) flyChips(this.table.potEl, plate, this.table.fxLayer, event.potIndex * 140);
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
      this.sound.play('turn');
      const toCall = view.legal?.toCall ?? 0;
      announcements.push(toCall > 0 ? `Your turn. ${chips(toCall)} to call.` : 'Your turn.');
      this.controls?.focusPrimary();
    }

    const latest = this.history[this.history.length - 1];
    if (this.feedText && latest) setText(this.feedText, latest);
    if (this.live && announcements.length > 0) setText(this.live, announcements.join(' '));
  }

  private pushHistory(line: string): void {
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Scheduling (Table Pulse)
  // -------------------------------------------------------------------------

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.setAutoNext(null);
    const state = this.state;
    if (!state || !this.gameScreen || this.openSheets > 0) return;
    const timings = PULSE[this.settings.speed];
    const seq = state.seq;
    const later = (ms: number, step: (s: GameState) => GameState | void): void => {
      this.timer = window.setTimeout(() => {
        this.timer = undefined;
        // Only act on the exact state this step was planned for.
        if (!this.state || this.state.seq !== seq) return;
        const next = step(this.state);
        if (next) this.commit(next);
      }, ms);
    };

    const hero = state.players.find((p) => p.id === HUMAN_ID);
    const hand = state.hand;
    if (!hand) {
      later(250, (s) => startNextHand(s, { rng: this.rng }));
      return;
    }
    const heroInHand = hero?.status === 'active' || hero?.status === 'allin';
    const pace = heroInHand ? 1 : 0.55;

    switch (hand.pending.kind) {
      case 'action': {
        const actorId = hand.pending.playerId;
        const actor = state.players.find((p) => p.id === actorId);
        if (actor?.kind === 'bot') {
          const [min, max] = timings.botThink;
          const think = (min + this.rng.next() * (max - min)) * pace;
          later(think, (s) => processBotTurn(s, this.rng));
        }
        break;
      }
      case 'deal': {
        const canBet = state.players.filter((p) => p.status === 'active').length >= 2;
        later((canBet ? timings.street : timings.runout) * (heroInHand ? 1 : 0.7), (s) => advance(s));
        break;
      }
      case 'showdown':
        later(timings.showdown, (s) => advance(s));
        break;
      case 'complete': {
        if (state.status === 'finished' || hero?.status === 'out') {
          later(timings.endScreen, () => this.showEnd());
        } else if (this.settings.autoNextHand) {
          this.setAutoNext(Date.now() + timings.autoNext);
          later(timings.autoNext, (s) => startNextHand(s, { rng: this.rng }));
        }
        break;
      }
    }
  }

  private setAutoNext(at: number | null): void {
    this.autoNextAt = at;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    if (at !== null) this.ticker = window.setInterval(() => this.updateControls(), 250);
    this.updateControls();
  }

  private stopTimers(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.autoNextAt = null;
  }

  // -------------------------------------------------------------------------
  // Player input
  // -------------------------------------------------------------------------

  private onHumanAction(action: PlayerAction, seq: number): void {
    const state = this.state;
    if (!state || state.seq !== seq) return; // stale tap
    try {
      this.commit(applyPlayerAction(state, HUMAN_ID, action, seq));
    } catch (error) {
      if (error instanceof IllegalActionError) {
        this.pushHistory(`Not allowed: ${error.message}`);
        if (this.feedText) setText(this.feedText, `Not allowed: ${error.message}`);
        this.render(state, { effects: false });
      } else {
        throw error;
      }
    }
  }

  private nextHand(): void {
    const state = this.state;
    if (!state || state.hand?.pending.kind !== 'complete' || state.status !== 'running') return;
    this.commit(startNextHand(state, { rng: this.rng }));
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.controls || this.openSheets > 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const inSlider = target instanceof HTMLInputElement && target.type === 'range';
    if (inSlider && e.key.startsWith('Arrow')) return;
    if (inSlider && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.controls.handleKey('r');
      return;
    }
    if (target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
    if (this.controls.handleKey(e.key)) e.preventDefault();
  }

  // -------------------------------------------------------------------------
  // Sheets & settings
  // -------------------------------------------------------------------------

  private withSheet(title: string, body: HTMLElement): HTMLDialogElement {
    this.openSheets += 1;
    this.stopTimers();
    return openSheet(title, body, () => {
      this.openSheets = Math.max(0, this.openSheets - 1);
      if (this.openSheets === 0 && this.gameScreen) this.schedule();
    });
  }

  private openMenu(): void {
    let dialog: HTMLDialogElement | null = null;
    const then = (fn: () => void) => () => {
      dialog?.close();
      fn();
    };
    dialog = this.withSheet(
      'Table menu',
      menuBody({
        onResume: then(() => undefined),
        onSettings: then(() => this.openSettings()),
        onHowTo: then(() => this.openHowTo()),
        onLeave: then(() => {
          this.persist();
          this.showStart();
        }),
        onRestart: then(() => {
          clearSession();
          this.newTournament();
        }),
      }),
    );
  }

  private openSettings(): void {
    this.withSheet(
      'Settings',
      settingsBody(this.settings, (next) => this.applySettings(next), prefersReducedMotion()),
    );
  }

  private openHowTo(): void {
    this.withSheet('How to Play', howToPlayBody());
  }

  private openHistory(): void {
    const list = h('ol', { class: 'history' });
    for (const line of [...this.history].reverse()) list.append(h('li', { text: line }));
    this.withSheet('Table log', list);
  }

  private applySettings(next: Settings): void {
    this.settings = next;
    saveSettings(next);
    this.sound.enabled = next.sound;
    this.motion = applyMotion(next);
    this.refreshToolButtons();
  }

  private toggleSound(): void {
    this.sound.unlock();
    this.applySettings({ ...this.settings, sound: !this.settings.sound });
  }

  private toggleSpeed(): void {
    this.applySettings({ ...this.settings, speed: this.settings.speed === 'fast' ? 'normal' : 'fast' });
    if (this.openSheets === 0) this.schedule();
  }

  private refreshToolButtons(): void {
    if (this.soundBtn) {
      this.soundBtn.replaceChildren(svg(this.settings.sound ? ICONS.soundOn : ICONS.soundOff));
      this.soundBtn.setAttribute('aria-label', this.settings.sound ? 'Sound on — tap to mute' : 'Sound off — tap to unmute');
      this.soundBtn.setAttribute('aria-pressed', String(this.settings.sound));
    }
    if (this.speedBtn) {
      setText(this.speedBtn, this.settings.speed === 'fast' ? 'Fast' : 'Normal');
      this.speedBtn.setAttribute('aria-label', `Speed: ${this.settings.speed}. Tap to switch.`);
    }
  }
}

function spoken(cards: readonly Card[]): string {
  return cards.map(cardName).join(', ');
}
