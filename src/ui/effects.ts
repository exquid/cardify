import type { Settings } from '../storage/session';

/**
 * Presentation-only effects: Table Pulse timings, motion preferences and
 * synthesized sounds. Nothing in here touches game state.
 */

export interface PulseTimings {
  /** Bot "thinking" time range in ms. */
  botThink: [number, number];
  /** Pause before dealing flop/turn/river. */
  street: number;
  /** Extra pause on all-in run-outs so each card can land. */
  runout: number;
  /** Pause before cards are turned over at showdown. */
  showdown: number;
  /** Delay before an automatic next hand. */
  autoNext: number;
  /** Delay before the end-of-tournament screen. */
  endScreen: number;
  /** Stagger between dealt cards. */
  dealStagger: number;
}

export const PULSE: Record<Settings['speed'], PulseTimings> = {
  normal: { botThink: [550, 1150], street: 520, runout: 650, showdown: 600, autoNext: 3200, endScreen: 2600, dealStagger: 90 },
  fast: { botThink: [140, 280], street: 180, runout: 260, showdown: 240, autoNext: 1400, endScreen: 1400, dealStagger: 40 },
};

export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Applies the effective motion setting to the document root (CSS reads it). */
export function applyMotion(settings: Settings): boolean {
  const on = settings.animations && !prefersReducedMotion();
  document.documentElement.dataset.motion = on ? 'on' : 'off';
  return on;
}

type SoundName = 'card' | 'chip' | 'check' | 'fold' | 'turn' | 'win' | 'deal';

/**
 * Tiny Web Audio synthesizer. The AudioContext is only created after a user
 * gesture (see `unlock`), as required by iOS Safari.
 */
export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      const length = Math.floor(this.ctx.sampleRate * 0.4);
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  play(name: SoundName): void {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case 'card':
      case 'deal':
        this.noiseBurst(t, 0.05, 2600, 1.1, name === 'deal' ? 0.45 : 0.6);
        break;
      case 'chip':
        // Clay chips: two low clacks rather than a bright click.
        this.tone(t, 1500, 0.045, 0.2, 'triangle');
        this.tone(t + 0.04, 1950, 0.05, 0.14, 'triangle');
        this.noiseBurst(t, 0.035, 3200, 1.6, 0.2);
        break;
      case 'check':
        // Knuckles on felt.
        this.tone(t, 140, 0.08, 0.5, 'sine');
        this.tone(t + 0.1, 125, 0.08, 0.4, 'sine');
        break;
      case 'fold':
        this.noiseBurst(t, 0.16, 700, 0.6, 0.3);
        break;
      case 'turn':
        // Soft two-note bell, like a hotel desk chime heard from the bar.
        this.tone(t, 784, 0.35, 0.08, 'sine');
        this.tone(t + 0.13, 659.25, 0.45, 0.07, 'sine');
        break;
      case 'win':
        // Vibraphone-style major seventh (C E G B).
        [523.25, 659.25, 783.99, 987.77].forEach((f, i) => this.vibe(t + i * 0.11, f, 1.3, 0.09));
        break;
    }
  }

  /** Sine note with a gentle tremolo, a nod to the lounge vibraphone. */
  private vibe(start: number, freq: number, duration: number, gain: number): void {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    lfo.frequency.setValueAtTime(5.5, start);
    depth.gain.setValueAtTime(gain * 0.35, start);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    lfo.connect(depth).connect(env.gain);
    osc.connect(env).connect(this.master as GainNode);
    osc.start(start);
    lfo.start(start);
    osc.stop(start + duration + 0.05);
    lfo.stop(start + duration + 0.05);
  }

  private tone(start: number, freq: number, duration: number, gain: number, type: OscillatorType): void {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env).connect(this.master as GainNode);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private noiseBurst(start: number, duration: number, freq: number, q: number, gain: number): void {
    const ctx = this.ctx as AudioContext;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter).connect(env).connect(this.master as GainNode);
    src.start(start);
    src.stop(start + duration + 0.02);
  }
}

/**
 * Flies a small chip stack from one element to another (pot → winner).
 * Purely decorative; skipped when motion is off.
 */
export function flyChips(from: Element, to: Element, layer: HTMLElement, delay = 0): void {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const origin = layer.getBoundingClientRect();
  const chip = document.createElement('div');
  chip.className = 'flying-chips';
  chip.setAttribute('aria-hidden', 'true');
  const x0 = a.left + a.width / 2 - origin.left;
  const y0 = a.top + a.height / 2 - origin.top;
  const dx = b.left + b.width / 2 - origin.left - x0;
  const dy = b.top + b.height / 2 - origin.top - y0;
  chip.style.left = `${x0}px`;
  chip.style.top = `${y0}px`;
  chip.style.setProperty('--dx', `${dx}px`);
  chip.style.setProperty('--dy', `${dy}px`);
  chip.style.animationDelay = `${delay}ms`;
  layer.append(chip);
  chip.addEventListener('animationend', () => chip.remove(), { once: true });
  // Safety net in case animationend never fires (tab hidden, etc.).
  window.setTimeout(() => chip.remove(), 2000 + delay);
}
