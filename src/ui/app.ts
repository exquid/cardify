import { processBotTurn } from '../bots';
import { DEFAULT_CONFIG } from '../game/config';
import { createCryptoRng } from '../game/deck';
import { advance, applyPlayerAction, startNextHand } from '../game/engine';
import { createSoloTournament, HUMAN_ID } from '../game/tournament';
import { IllegalActionError, type GameState, type PlayerAction } from '../game/types';
import { getPlayerView } from '../game/views';
import { resolveServerUrl } from '../net/client';
import { normalizeCode } from '../net/protocol';
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
import { h } from './dom';
import { applyMotion, prefersReducedMotion, PULSE, SoundBoard } from './effects';
import { OnlineController, savedTableCode, type Shell } from './online';
import { endScreen, howToPlayBody, menuBody, openSheet, settingsBody, startScreen } from './screens';
import { describeStatus, TableScreen, type FrameContext, type TableScreenEnv } from './tableScreen';

/**
 * Application shell and the solo-game driver. In solo play it owns the
 * GameState and is the only place that calls engine commands; timers only
 * ever *request* the next engine step, and every scheduled step is tied to
 * the state version (`seq`) it was planned for, so a stale timer or a double
 * tap can never act twice. Online play is delegated to OnlineController.
 */
export class App implements Shell {
  private settings: Settings = loadSettings();
  private readonly sound = new SoundBoard();
  private readonly rng = createCryptoRng();
  private motion = true;
  readonly env: TableScreenEnv = {
    sound: this.sound,
    settings: () => this.settings,
    motion: () => this.motion,
  };

  private state: GameState | null = null;
  private stats: SessionStats = emptyStats();
  /** The screen receiving keyboard shortcuts (solo or online table). */
  private active: TableScreen | null = null;
  private solo: TableScreen | null = null;
  private online: OnlineController | null = null;

  private timer: number | undefined;
  private ticker: number | undefined;
  private autoNextAt: number | null = null;
  /** Number of open sheets; the solo table pauses while any is open. */
  private openSheets = 0;

  constructor(readonly root: HTMLElement) {
    this.motion = applyMotion(this.settings);
    this.sound.enabled = this.settings.sound;
    try {
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
        this.motion = applyMotion(this.settings);
      });
    } catch {
      /* older Safari: no change events, initial value still applies */
    }
    document.addEventListener('keydown', (e) => {
      if (this.openSheets === 0) this.active?.handleKey(e);
    });
    // iOS needs a user gesture before audio can play.
    const unlock = (): void => this.sound.unlock();
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);
  }

  /** First screen: an invite link (?table=CODE) opens the join form directly. */
  boot(): void {
    const params = new URLSearchParams(location.search);
    const code = normalizeCode(params.get('table'));
    if (code) {
      history.replaceState(null, '', location.pathname);
      this.openOnline(code);
      return;
    }
    this.showStart();
  }

  // -------------------------------------------------------------------------
  // Shell (shared by solo and online)
  // -------------------------------------------------------------------------

  showStart(notice: string | null = null): void {
    this.stopTimers();
    this.leaveSolo();
    this.online?.dispose();
    this.online = null;
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
        rejoinCode: resolveServerUrl() ? savedTableCode() : null,
        onRejoin: () => {
          this.openOnline();
          this.online?.rejoin();
        },
        onContinue: () => {
          if (saved.status !== 'ok') return;
          this.state = saved.session.state;
          this.stats = saved.session.stats;
          this.mountSolo();
        },
        onPlay: () => this.newTournament(),
        onFriends: () => this.openOnline(),
        onHowTo: () => this.openHowTo(),
        onSettings: () => this.openSettings(),
      }),
    );
    (this.root.querySelector('.btn--primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  setActive(screen: TableScreen | null): void {
    this.active = screen;
  }

  sheet(title: string, body: HTMLElement): HTMLDialogElement {
    this.openSheets += 1;
    if (this.solo) this.stopTimers();
    return openSheet(title, body, () => {
      this.openSheets = Math.max(0, this.openSheets - 1);
      if (this.openSheets === 0 && this.solo) this.schedule();
    });
  }

  openSettings(): void {
    this.sheet('Settings', settingsBody(this.settings, (next) => this.applySettings(next), prefersReducedMotion()));
  }

  openHowTo(): void {
    this.sheet('How to Play', howToPlayBody());
  }

  openHistory(lines: readonly string[]): void {
    const list = h('ol', { class: 'history' });
    for (const line of [...lines].reverse()) list.append(h('li', { text: line }));
    this.sheet('Table log', list);
  }

  toggleSound(): void {
    this.sound.unlock();
    this.applySettings({ ...this.settings, sound: !this.settings.sound });
  }

  private applySettings(next: Settings): void {
    this.settings = next;
    saveSettings(next);
    this.sound.enabled = next.sound;
    this.motion = applyMotion(next);
    this.active?.refreshTools();
  }

  private openOnline(code = ''): void {
    this.stopTimers();
    this.leaveSolo();
    this.online?.dispose();
    this.online = new OnlineController(this, resolveServerUrl());
    this.online.open(code);
  }

  // -------------------------------------------------------------------------
  // Solo game
  // -------------------------------------------------------------------------

  private newTournament(): void {
    this.state = createSoloTournament(DEFAULT_CONFIG, { rng: this.rng });
    this.stats = emptyStats();
    this.mountSolo();
  }

  private mountSolo(): void {
    const state = this.state;
    if (!state) return;
    this.stopTimers();
    this.online?.dispose();
    this.online = null;
    this.solo = new TableScreen(HUMAN_ID, getPlayerView(state, HUMAN_ID), this.env, {
      onAction: (action, seq) => this.onHumanAction(action, seq),
      onNextHand: () => this.nextHand(),
      onMenu: () => this.openSoloMenu(),
      onToggleSound: () => this.toggleSound(),
      onToggleSpeed: () => this.toggleSpeed(),
      onHistory: (lines) => this.openHistory(lines),
    });
    this.active = this.solo;
    this.root.replaceChildren(this.solo.root);
    // First render without replaying effects (a fresh deal still animates).
    this.renderSolo({ effects: !state.hand?.events.length });
    this.schedule();
  }

  private leaveSolo(): void {
    this.solo = null;
    this.active = null;
  }

  private showSoloEnd(): void {
    const state = this.state;
    if (!state) return;
    this.stopTimers();
    clearSession();
    this.leaveSolo();
    const screen = endScreen({
      players: state.players,
      finished: state.status === 'finished',
      heroId: HUMAN_ID,
      stats: this.stats,
      primary: { label: 'New tournament', onClick: () => this.newTournament() },
      secondary: { label: 'Main menu', onClick: () => this.showStart() },
    });
    this.root.replaceChildren(screen);
    (screen.querySelector('.btn--primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Replace the state after an engine command and update everything derived from it. */
  private commit(next: GameState): void {
    const previous = this.state;
    this.state = next;
    this.trackStats(previous, next);
    this.persist();
    this.renderSolo({ effects: true });
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

  private frame(effects: boolean): FrameContext | null {
    const state = this.state;
    if (!state) return null;
    const view = getPlayerView(state, HUMAN_ID);
    const hero = state.players.find((p) => p.id === HUMAN_ID);
    const status = state.status === 'finished' || hero?.status === 'out' ? describeStatus(view, HUMAN_ID).replace('— watching', '— final standings next') : describeStatus(view, HUMAN_ID);
    return {
      effects,
      status,
      final: state.status === 'finished' || hero?.status === 'out',
      autoNextIn: this.autoNextAt === null ? null : Math.max(0, Math.ceil((this.autoNextAt - Date.now()) / 1000)),
      canDealNext: true,
      turnSeconds: null,
    };
  }

  private renderSolo(opts: { effects: boolean }): void {
    const ctx = this.frame(opts.effects);
    if (!this.solo || !this.state || !ctx) return;
    this.solo.render(getPlayerView(this.state, HUMAN_ID), ctx);
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.setAutoNext(null);
    const state = this.state;
    if (!state || !this.solo || this.openSheets > 0) return;
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
        const actor = state.players.find((p) => p.id === (hand.pending as { playerId: string }).playerId);
        if (actor?.kind === 'bot') {
          const [min, max] = timings.botThink;
          later((min + this.rng.next() * (max - min)) * pace, (s) => processBotTurn(s, this.rng));
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
          later(timings.endScreen, () => this.showSoloEnd());
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
    if (at !== null) {
      this.ticker = window.setInterval(() => {
        const ctx = this.frame(false);
        if (ctx) this.solo?.tick(ctx);
      }, 250);
    }
  }

  private stopTimers(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.autoNextAt = null;
  }

  private onHumanAction(action: PlayerAction, seq: number): void {
    const state = this.state;
    if (!state || state.seq !== seq) return; // stale tap
    try {
      this.commit(applyPlayerAction(state, HUMAN_ID, action, seq));
    } catch (error) {
      if (!(error instanceof IllegalActionError)) throw error;
      this.solo?.notify(`Not allowed: ${error.message}`);
      this.solo?.rerender();
    }
  }

  private nextHand(): void {
    const state = this.state;
    if (!state || state.hand?.pending.kind !== 'complete' || state.status !== 'running') return;
    this.commit(startNextHand(state, { rng: this.rng }));
  }

  private toggleSpeed(): void {
    this.applySettings({ ...this.settings, speed: this.settings.speed === 'fast' ? 'normal' : 'fast' });
    if (this.openSheets === 0) this.schedule();
  }

  private openSoloMenu(): void {
    let dialog: HTMLDialogElement | null = null;
    const then = (fn: () => void) => () => {
      dialog?.close();
      fn();
    };
    dialog = this.sheet(
      'Table menu',
      menuBody({
        onResume: then(() => undefined),
        onSettings: then(() => this.openSettings()),
        onHowTo: then(() => this.openHowTo()),
        onLeave: then(() => {
          this.persist();
          this.showStart();
        }),
        leaveLabel: 'Leave table — progress is saved',
        onRestart: then(() => {
          clearSession();
          this.newTournament();
        }),
      }),
    );
  }
}
