import type { LegalActions, PlayerAction } from '../game/types';
import type { TableView } from '../game/views';
import { h, ICONS, setText, svg, toggleClass } from './dom';
import { chips } from './format';

export interface ControlsCallbacks {
  /** `seq` is the state version the button was rendered for. */
  onAction(action: PlayerAction, seq: number): void;
  onNextHand(): void;
}

export interface ControlsContext {
  /** Text describing what the table waits for when it is not our turn. */
  status: string;
  /** Seconds until the automatic next hand, if enabled. */
  autoNextIn: number | null;
  /** True when there is no next hand (tournament over for the hero). */
  final: boolean;
  /** Whether the player deals the next hand (solo) or the server does (online). */
  canDealNext: boolean;
  /** Seconds left on the player's own turn clock (online), or null. */
  turnSeconds: number | null;
}

interface Preset {
  label: string;
  fraction: number | 'min' | 'max';
}

const PRESETS: Preset[] = [
  { label: 'Min', fraction: 'min' },
  { label: '½ Pot', fraction: 0.5 },
  { label: '¾ Pot', fraction: 0.75 },
  { label: 'Pot', fraction: 1 },
  { label: 'Max', fraction: 'max' },
];

/**
 * The action dock. Every option and limit comes from the engine's
 * LegalActions; the dock only collects the player's choice.
 */
export class Controls {
  readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly foldBtn: HTMLButtonElement;
  private readonly callBtn: HTMLButtonElement;
  private readonly raiseBtn: HTMLButtonElement;
  private readonly allInBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly panelVerb: HTMLElement;
  private readonly panelAmount: HTMLElement;
  private readonly panelNote: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly presetButtons: HTMLButtonElement[] = [];

  private legal: LegalActions | null = null;
  private view: TableView | null = null;
  private seq = -1;
  /** Set right after a click so a second tap cannot fire before the next render. */
  private locked = false;
  private panelOpen = false;
  private amount = 0;
  private allInArmedUntil = 0;
  private allInTimer: number | undefined;

  constructor(private readonly callbacks: ControlsCallbacks) {
    this.status = h('div', { class: 'dock__status', attrs: { 'aria-live': 'off' } });

    this.foldBtn = button('btn btn--fold', 'Fold', () => this.send({ type: 'fold' }));
    this.callBtn = button('btn btn--call', 'Check', () => this.onCallClick());
    this.raiseBtn = button('btn btn--raise', 'Raise', () => this.onRaiseClick());
    this.allInBtn = button('btn btn--allin', 'All-in', () => this.onAllInClick());
    this.nextBtn = button('btn btn--next', 'Next hand', () => {
      if (this.locked) return;
      this.locked = true;
      this.callbacks.onNextHand();
    });
    this.foldBtn.setAttribute('aria-keyshortcuts', 'F');
    this.callBtn.setAttribute('aria-keyshortcuts', 'C');
    this.raiseBtn.setAttribute('aria-keyshortcuts', 'R');
    this.allInBtn.setAttribute('aria-keyshortcuts', 'A');
    this.nextBtn.setAttribute('aria-keyshortcuts', 'N');

    this.actions = h('div', { class: 'dock__actions' }, this.foldBtn, this.callBtn, this.raiseBtn, this.allInBtn, this.nextBtn);

    // Bet sizing panel.
    this.panelVerb = h('span', { class: 'sizer__verb' });
    this.panelAmount = h('strong', { class: 'sizer__amount' });
    this.panelNote = h('span', { class: 'sizer__note' });
    this.slider = h('input', {
      class: 'sizer__slider',
      attrs: { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Bet amount' },
    });
    this.slider.addEventListener('input', () => this.setAmount(Number(this.slider.value), true));
    const minus = iconButton('sizer__step', ICONS.minus, 'Decrease amount', () => this.nudge(-1));
    const plus = iconButton('sizer__step', ICONS.plus, 'Increase amount', () => this.nudge(1));
    const close = iconButton('sizer__close', ICONS.close, 'Close bet sizing', () => this.closePanel());
    const presets = h('div', { class: 'sizer__presets' });
    for (const preset of PRESETS) {
      const b = button('chip-btn', preset.label, () => this.applyPreset(preset));
      this.presetButtons.push(b);
      presets.append(b);
    }
    this.panel = h(
      'div',
      { class: 'sizer', attrs: { hidden: true, role: 'group', 'aria-label': 'Bet sizing' } },
      h('div', { class: 'sizer__head' }, h('div', { class: 'sizer__readout' }, this.panelVerb, this.panelAmount, this.panelNote), close),
      h('div', { class: 'sizer__row' }, minus, this.slider, plus),
      presets,
    );

    this.root = h('div', { class: 'dock' }, this.panel, this.status, this.actions);
  }

  update(view: TableView, ctx: ControlsContext): void {
    const seqChanged = view.seq !== this.seq;
    this.view = view;
    this.seq = view.seq;
    if (seqChanged) this.locked = false;
    const legal = view.legal;
    const sameDecision = !!legal && !!this.legal && !seqChanged;
    this.legal = legal;

    const complete = view.pending?.kind === 'complete';
    const myTurn = !!legal;
    this.root.dataset.mode = myTurn ? 'turn' : complete ? 'complete' : 'waiting';

    // Status line.
    if (myTurn && legal) {
      const clock = ctx.turnSeconds !== null ? ` · ${ctx.turnSeconds}s` : '';
      setText(this.status, `${legal.toCall > 0 ? `Your turn · ${chips(legal.toCall)} to call` : 'Your turn'}${clock}`);
      toggleClass(this.status, 'is-urgent', ctx.turnSeconds !== null && ctx.turnSeconds <= 5);
    } else if (complete) {
      toggleClass(this.status, 'is-urgent', false);
      setText(this.status, ctx.final ? ctx.status : ctx.autoNextIn !== null ? `Next hand in ${ctx.autoNextIn}s` : ctx.status);
    } else {
      toggleClass(this.status, 'is-urgent', false);
      setText(this.status, ctx.status);
    }

    // Buttons.
    const show = (el: HTMLElement, visible: boolean): void => toggleClass(el, 'is-hidden', !visible);
    show(this.nextBtn, complete && !ctx.final && ctx.canDealNext);
    show(this.foldBtn, myTurn);
    show(this.callBtn, myTurn);
    show(this.raiseBtn, myTurn && !!legal?.raise);
    show(this.allInBtn, myTurn && !!legal?.canAllIn && !legal.callIsAllIn);
    for (const b of [this.foldBtn, this.callBtn, this.raiseBtn, this.allInBtn]) b.disabled = !myTurn;
    this.nextBtn.disabled = !complete || ctx.final || !ctx.canDealNext;

    if (!myTurn || !legal) {
      this.closePanel();
      this.disarmAllIn();
      return;
    }

    toggleClass(this.foldBtn, 'is-quiet', legal.canCheck);
    this.foldBtn.setAttribute('aria-label', legal.canCheck ? 'Fold (checking is free)' : 'Fold');
    if (legal.canCheck) {
      setText(this.callBtn, 'Check');
      this.callBtn.setAttribute('aria-label', 'Check');
    } else {
      const label = legal.callIsAllIn ? `Call ${chips(legal.callAmount)} · All-in` : `Call ${chips(legal.callAmount)}`;
      setText(this.callBtn, label);
      this.callBtn.setAttribute('aria-label', label);
    }

    if (!sameDecision) {
      this.closePanel();
      this.disarmAllIn();
      if (legal.raise) this.amount = legal.raise.min;
    }
    this.refreshRaiseButton();
  }

  /** Keyboard shortcuts (wired by the app). Returns true if handled. */
  handleKey(key: string): boolean {
    const k = key.toLowerCase();
    if (k === 'n' && this.root.dataset.mode === 'complete' && !this.nextBtn.disabled) {
      this.nextBtn.click();
      return true;
    }
    if (!this.legal) return false;
    switch (k) {
      case 'f':
        this.foldBtn.click();
        return true;
      case 'c':
      case 'k':
        this.callBtn.click();
        return true;
      case 'r':
      case 'b':
        if (!this.raiseBtn.classList.contains('is-hidden')) this.raiseBtn.click();
        return true;
      case 'a':
        if (!this.allInBtn.classList.contains('is-hidden')) this.allInBtn.click();
        return true;
      case 'escape':
        if (this.panelOpen) {
          this.closePanel();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  focusPrimary(): void {
    const target = [this.callBtn, this.nextBtn].find((b) => !b.classList.contains('is-hidden') && !b.disabled);
    target?.focus({ preventScroll: true });
  }

  private send(action: PlayerAction): void {
    if (this.locked || !this.legal) return;
    this.locked = true;
    this.closePanel();
    this.disarmAllIn();
    this.callbacks.onAction(action, this.seq);
  }

  private onCallClick(): void {
    if (!this.legal) return;
    this.send(this.legal.canCheck ? { type: 'check' } : { type: 'call' });
  }

  private onRaiseClick(): void {
    const option = this.legal?.raise;
    if (!option) return;
    if (!this.panelOpen) {
      this.openPanel();
      return;
    }
    const amount = this.amount;
    if (amount === option.max && this.legal?.canAllIn) this.send({ type: 'allin' });
    else this.send({ type: option.kind, amount });
  }

  private onAllInClick(): void {
    if (!this.legal?.canAllIn) return;
    const now = Date.now();
    if (now < this.allInArmedUntil) {
      this.send({ type: 'allin' });
      return;
    }
    // First tap arms, second tap confirms — all-in is never a single mis-tap.
    this.allInArmedUntil = now + 3000;
    this.allInBtn.classList.add('is-armed');
    setText(this.allInBtn, `Confirm ${chips(this.legal.allInTo)}`);
    window.clearTimeout(this.allInTimer);
    this.allInTimer = window.setTimeout(() => this.disarmAllIn(), 3000);
  }

  private disarmAllIn(): void {
    this.allInArmedUntil = 0;
    window.clearTimeout(this.allInTimer);
    this.allInBtn.classList.remove('is-armed');
    setText(this.allInBtn, 'All-in');
  }

  private openPanel(): void {
    const option = this.legal?.raise;
    if (!option) return;
    this.panelOpen = true;
    this.panel.hidden = false;
    this.root.classList.add('is-sizing');
    this.slider.min = String(option.min);
    this.slider.max = String(option.max);
    this.setAmount(Math.min(option.max, Math.max(option.min, this.amount)), false);
    this.slider.focus({ preventScroll: true });
  }

  private closePanel(): void {
    this.panelOpen = false;
    this.panel.hidden = true;
    this.root.classList.remove('is-sizing');
    this.refreshRaiseButton();
  }

  private step(): number {
    return Math.max(1, (this.view?.bigBlind ?? 2) / 2);
  }

  private nudge(direction: 1 | -1): void {
    const option = this.legal?.raise;
    if (!option) return;
    const bb = this.view?.bigBlind ?? 1;
    this.setAmount(this.amount + direction * bb, false);
  }

  private potSizedTarget(fraction: number): number {
    const view = this.view;
    const legal = this.legal;
    if (!view || !legal) return 0;
    // Pot-sized raise: call first, then raise by the size of the pot.
    return view.currentBet + Math.round((view.totalPot + legal.toCall) * fraction);
  }

  private applyPreset(preset: Preset): void {
    const option = this.legal?.raise;
    if (!option) return;
    const target = preset.fraction === 'min' ? option.min : preset.fraction === 'max' ? option.max : this.potSizedTarget(preset.fraction);
    this.setAmount(target, false);
  }

  private setAmount(raw: number, snap: boolean): void {
    const option = this.legal?.raise;
    if (!option) return;
    let value = Math.round(raw);
    if (snap && value < option.max && value > option.min) {
      const step = this.step();
      value = Math.round(value / step) * step;
    }
    value = Math.min(option.max, Math.max(option.min, value));
    this.amount = value;
    if (Number(this.slider.value) !== value) this.slider.value = String(value);
    const pct = option.max === option.min ? 100 : ((value - option.min) / (option.max - option.min)) * 100;
    this.slider.style.setProperty('--fill', `${pct}%`);

    const legal = this.legal as LegalActions;
    const isAllIn = value === option.max;
    setText(this.panelVerb, isAllIn ? 'All-in' : option.kind === 'bet' ? 'Bet' : 'Raise to');
    setText(this.panelAmount, chips(value));
    const streetBet = this.view?.players.find((p) => p.id === legal.playerId)?.streetBet ?? 0;
    const added = value - streetBet;
    setText(this.panelNote, `adds ${chips(added)} from your stack`);
    this.slider.setAttribute('aria-valuetext', `${isAllIn ? 'All-in' : option.kind === 'bet' ? 'Bet' : 'Raise to'} ${chips(value)}`);

    for (const [i, preset] of PRESETS.entries()) {
      const b = this.presetButtons[i];
      if (!b) continue;
      const target = preset.fraction === 'min' ? option.min : preset.fraction === 'max' ? option.max : this.potSizedTarget(preset.fraction);
      const usable = target >= option.min && target <= option.max;
      b.disabled = !usable;
      toggleClass(b, 'is-active', usable && target === value);
    }
    this.refreshRaiseButton();
  }

  private refreshRaiseButton(): void {
    const option = this.legal?.raise;
    if (!option) return;
    const verb = option.kind === 'bet' ? 'Bet' : 'Raise';
    let label: string;
    if (!this.panelOpen) label = verb;
    else if (this.amount === option.max) label = `All-in ${chips(this.amount)}`;
    else label = option.kind === 'bet' ? `Bet ${chips(this.amount)}` : `Raise to ${chips(this.amount)}`;
    setText(this.raiseBtn, label);
    this.raiseBtn.setAttribute('aria-label', this.panelOpen ? `Confirm: ${label}` : `${verb} — choose amount`);
    toggleClass(this.raiseBtn, 'is-confirm', this.panelOpen);
  }
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: className, text: label, attrs: { type: 'button' }, on: { click: onClick } });
}

function iconButton(className: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: className, attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } });
  b.append(svg(icon));
  return b;
}
