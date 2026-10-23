/** Minimal DOM helpers — enough to keep the vanilla UI readable without a framework. */

type Child = Node | string | null | undefined | false;

export interface ElementProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(props.dataset ?? {})) el.dataset[key] = value;
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Inline SVG from trusted static markup (icons defined in this codebase). */
export function svg(markup: string): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as SVGSVGElement;
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggleClass(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Restarts a CSS animation by removing and re-adding a class. */
export function replayClass(el: HTMLElement, name: string): void {
  el.classList.remove(name);
  void el.offsetWidth;
  el.classList.add(name);
}

export const ICONS = {
  logo: `<svg viewBox="0 0 64 64" aria-hidden="true" class="logo-mark"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M32 11C25 20 15 26 15 35c0 6 5 9.5 10 8.5 3.2-.7 5.6-3 7-5.5-.4 6-2.6 10.5-6.5 14"/><path d="M32 11c7 9 17 15 17 24 0 6-5 9.5-10 8.5-3.2-.7-5.6-3-7-5.5.4 6 2.6 10.5 6.5 14"/></g></svg>`,
  menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  soundOn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l4 3.5v-11L7 10H4z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  soundOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l4 3.5v-11L7 10H4z" fill="currentColor"/><path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
} as const;
