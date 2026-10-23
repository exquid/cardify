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
        this.noiseBurst(t, 0.045, 3200, 1.2, name === 'deal' ? 0.5 : 0.7);
        break;
      case 'chip':
        this.tone(t, 2600, 0.05, 0.22, 'triangle');
        this.tone(t + 0.035, 3300, 0.06, 0.16, 'triangle');
        this.noiseBurst(t, 0.03, 5000, 2, 0.25);
        break;
      case 'check':
        this.tone(t, 170, 0.07, 0.5, 'sine');
        this.tone(t + 0.09, 150, 0.07, 0.4, 'sine');
        break;
      case 'fold':
        this.noiseBurst(t, 0.14, 900, 0.7, 0.35);
        break;
      case 'turn':
        this.tone(t, 659, 0.16, 0.12, 'sine');
        this.tone(t + 0.1, 880, 0.22, 0.1, 'sine');
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.09, f, 0.5, 0.11, 'sine'));
        break;
    }
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
