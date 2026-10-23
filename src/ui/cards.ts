import { cardCode, cardName, isRedSuit, rankLabel, SUIT_SYMBOLS, type Card } from '../game/cards';
import { h } from './dom';

/** A face-up card, or a face-down back when `card` is null. */
export function cardElement(card: Card | null): HTMLDivElement {
  if (!card) {
    return h('div', { class: 'card card--back', attrs: { role: 'img', 'aria-label': 'Face-down card' } });
  }
  // U+FE0E forces text (not emoji) presentation of the suit glyph on iOS.
  const suit = `${SUIT_SYMBOLS[card.suit]}\uFE0E`;
  const el = h(
    'div',
    {
      class: `card ${isRedSuit(card.suit) ? 'card--red' : 'card--black'}`,
      attrs: { role: 'img', 'aria-label': cardName(card) },
      dataset: { code: cardCode(card) },
    },
    h('span', { class: 'card__rank', text: rankLabel(card.rank), attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'card__suit', text: suit, attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'card__pip', text: suit, attrs: { 'aria-hidden': 'true' } }),
  );
  return el;
}

function signature(cards: readonly (Card | null)[]): string {
  return cards.map((c) => (c ? cardCode(c) : '##')).join(' ');
}

export interface RenderCardsOptions {
  /** Animate cards that were not shown before. */
  animate: boolean;
  /** Stagger between entering cards, in ms. */
  stagger?: number;
  /** Initial delay before the first entering card, in ms. */
  delay?: number;
  /** Enter animation class. */
  enterClass?: string;
}

/**
 * Updates a container of cards with minimal DOM churn: unchanged cards stay
 * in place (so their CSS state persists), new ones get an enter animation and
 * a face-down card turning face-up is flipped.
 */
export function renderCards(container: HTMLElement, cards: readonly (Card | null)[], options: RenderCardsOptions): void {
  const sig = signature(cards);
  if (container.dataset.sig === sig) return;
  const previous = (container.dataset.sig ?? '').split(' ').filter(Boolean);
  container.dataset.sig = sig;

  const existing = Array.from(container.children) as HTMLElement[];
  let entering = 0;
  cards.forEach((card, i) => {
    const code = card ? cardCode(card) : '##';
    const old = existing[i];
    if (old && previous[i] === code) return;
    const el = cardElement(card);
    if (options.animate) {
      const wasBack = previous[i] === '##' && card !== null;
      el.classList.add(wasBack ? 'is-flipping' : (options.enterClass ?? 'is-entering'));
      el.style.animationDelay = `${(options.delay ?? 0) + entering * (options.stagger ?? 80)}ms`;
      entering += 1;
    }
    if (old) old.replaceWith(el);
    else container.append(el);
  });
  for (let i = existing.length - 1; i >= cards.length; i--) existing[i]?.remove();
}

/** Visual hint used when a card belongs to the winning five. */
export function markCards(container: HTMLElement, highlight: ReadonlySet<string> | null): void {
  for (const el of Array.from(container.children) as HTMLElement[]) {
    const code = el.dataset.code;
    el.classList.toggle('is-best', !!highlight && !!code && highlight.has(code));
    el.classList.toggle('is-dim', !!highlight && (!code || !highlight.has(code)));
  }
}
