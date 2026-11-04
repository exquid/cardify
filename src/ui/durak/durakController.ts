import { durakGame } from '../../durak/game';
import { clearDurak, loadDurak, saveDurak } from '../../durak/persist';
import { DurakRuleError, type DurakAction, type DurakState } from '../../durak/types';
import { createCryptoRng } from '../../game/deck';
import type { HubSeat } from '../../hub/tableGame';
import { h } from '../dom';
import { PULSE, type SoundBoard } from '../effects';
import { menuBody } from '../screens';
import { DurakScreen, durakRulesBody } from './durakScreen';

/**
 * Solo Durak driver: owns the DurakState, paces bots and bout endings with
 * timers, and is the only place that calls engine commands. Like the poker
 * driver, every timer is tied to the `seq` it was planned for, so a stale
 * timer or a double tap can never act twice.
 */

export interface DurakHost {
  readonly root: HTMLElement;
  readonly sound: SoundBoard;
  speed(): 'normal' | 'fast';
  soundOn(): boolean;
  sheet(title: string, body: HTMLElement): HTMLDialogElement;
  openSettings(): void;
  openHistory(lines: readonly string[]): void;
  toggleSound(): void;
  showStart(notice?: string | null): void;
  setKeyTarget(target: { handleKey(e: KeyboardEvent): void; refreshTools(): void } | null): void;
  /** True while any sheet is open: the table pauses. */
  paused(): boolean;
}

export const HERO = 'you';
const BOTS = [
  { id: 'nova', name: 'Nova' },
  { id: 'vex', name: 'Vex' },
  { id: 'orion', name: 'Orion' },
];

export class DurakController {
  private readonly rng = createCryptoRng();
  private state: DurakState | null = null;
  private screen: DurakScreen | null = null;
  private timer: number | undefined;
  private players = 3;

  constructor(private readonly host: DurakHost) {}

  /** Opens the seat picker, then starts a game. */
  open(): void {
    const body = h('div', { class: 'menu' });
    let dialog: HTMLDialogElement | null = null;
    const choose = (n: number) => () => {
      dialog?.close();
      this.players = n;
      this.newGame();
    };
    const saved = loadDurak();
    const resumable = saved && saved.players.some((p) => p.id === HERO) ? saved : null;
    body.append(
      h('p', { class: 'menu__lead', text: 'Podkidnoy Durak with a 36-card deck. Beat every attack, or pick the cards up. Don’t be the last one holding cards.' }),
      ...(resumable
        ? [h('button', {
            class: 'menu__item menu__item--primary',
            text: `Continue game · bout ${resumable.bout.number}`,
            attrs: { type: 'button' },
            on: {
              click: () => {
                dialog?.close();
                this.mount(resumable);
              },
            },
          })]
        : []),
      h('button', { class: `menu__item${resumable ? '' : ' menu__item--primary'}`, text: 'You vs Nova (2 players)', attrs: { type: 'button' }, on: { click: choose(2) } }),
      h('button', { class: 'menu__item', text: 'You, Nova and Vex (3 players)', attrs: { type: 'button' }, on: { click: choose(3) } }),
      h('button', { class: 'menu__item', text: 'Full table of four', attrs: { type: 'button' }, on: { click: choose(4) } }),
    );
    dialog = this.host.sheet('Play Durak', body);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.screen = null;
    this.host.setKeyTarget(null);
  }

  /** Called by the host when a sheet opens: nothing moves while it is open. */
  pause(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Called by the host when the last sheet closes. */
  resume(): void {
    if (this.screen) this.schedule();
  }

  refreshTools(): void {
    this.screen?.refreshTools();
  }

  private newGame(): void {
    clearDurak();
    const seats: HubSeat[] = [{ id: HERO, name: 'You', kind: 'human' }, ...BOTS.slice(0, this.players - 1).map((b) => ({ ...b, kind: 'bot' as const }))];
    this.mount(durakGame.create(seats, this.rng));
  }

  private mount(state: DurakState): void {
    window.clearTimeout(this.timer);
    this.state = state;
    saveDurak(state);
    this.screen = new DurakScreen(HERO, durakGame.view(this.state, HERO), this.host.sound, () => this.host.soundOn(), {
      onAction: (action, seq) => this.onHeroAction(action, seq),
      onMenu: () => this.openMenu(),
      onToggleSound: () => {
        this.host.toggleSound();
        this.screen?.refreshTools();
      },
      onHistory: (lines) => this.host.openHistory(lines),
      onPlayAgain: () => this.open(),
      onLeave: () => this.host.showStart(),
    });
    this.host.root.replaceChildren(this.screen.root);
    this.host.setKeyTarget(this.screen);
    this.render();
    this.schedule();
  }

  private render(): void {
    if (this.screen && this.state) this.screen.render(durakGame.view(this.state, HERO));
  }

  private commit(next: DurakState): void {
    this.state = next;
    saveDurak(next);
    this.render();
    this.schedule();
  }

  private onHeroAction(action: DurakAction, seq: number): void {
    const state = this.state;
    if (!state || durakGame.seq(state) !== seq) return;
    try {
      this.commit(durakGame.act(state, HERO, action, seq));
    } catch (error) {
      if (!(error instanceof DurakRuleError)) throw error;
      this.screen?.notify(`Not allowed: ${error.message}`);
      this.screen?.release();
    }
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const state = this.state;
    if (!state || !this.screen || this.host.paused() || durakGame.isOver(state)) return;
    const timings = PULSE[this.host.speed()];
    const seq = durakGame.seq(state);
    const later = (ms: number, step: (s: DurakState) => DurakState): void => {
      this.timer = window.setTimeout(() => {
        this.timer = undefined;
        if (!this.state || durakGame.seq(this.state) !== seq) return;
        try {
          this.commit(step(this.state));
        } catch (error) {
          // Never freeze silently: fall back to the always-legal timeout move.
          console.error('durak step failed', error);
          const actor = durakGame.actor(this.state);
          if (actor && actor !== HERO) this.commit(durakGame.act(this.state, actor, durakGame.timeoutAction(this.state, actor), seq));
        }
      }, ms);
    };
    const actor = durakGame.actor(state);
    if (actor && actor !== HERO) {
      const [min, max] = timings.botThink;
      later(min + this.rng.next() * (max - min), (s) => durakGame.act(s, actor, durakGame.botAction(s, actor, this.rng), seq));
      return;
    }
    const auto = durakGame.auto(state, this.rng);
    if (auto) later(timings.showdown + timings.street, auto.run);
  }

  private openMenu(): void {
    let dialog: HTMLDialogElement | null = null;
    const then = (fn: () => void) => () => {
      dialog?.close();
      fn();
    };
    window.clearTimeout(this.timer);
    dialog = this.host.sheet(
      'Durak',
      menuBody({
        onResume: then(() => undefined),
        onSettings: then(() => this.host.openSettings()),
        onHowTo: then(() => this.host.sheet('How to play Durak', durakRulesBody())),
        onLeave: then(() => this.host.showStart()),
        leaveLabel: 'Leave table',
        onRestart: then(() => this.open()),
        restartLabel: 'New game',
      }),
    );
  }
}
