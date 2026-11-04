import { GAMES, type GameEntry, type GameStatus } from '../hub/catalog';
import { h, ICONS, svg } from './dom';

export { GAMES, type GameEntry, type GameStatus };

/**
 * Shared presentation pieces of the cardify design system (see docs/DESIGN.md).
 * Nothing in here knows about a particular game's rules or state.
 */

export function brand(variant: 'hero' | 'bar' | 'small' = 'bar'): HTMLElement {
  const wrap = h('div', { class: `brand brand--${variant}` });
  wrap.append(svg(ICONS.logo), h('span', { class: 'wordmark', text: 'cardify' }));
  return wrap;
}

export function statusBadge(status: GameStatus): HTMLElement {
  return h('span', { class: `status status--${status}`, text: status === 'open' ? 'Open now' : 'Coming soon' });
}

/**
 * A game shown as a tuck box on the shelf. Open games get a real action;
 * unfinished games are sealed and have no buttons at all.
 */
export function gameTile(game: GameEntry, action?: { label: string; onClick(): void }): HTMLElement {
  const box = h(
    'div',
    { class: 'deck__box', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'deck__peek deck__peek--a' }),
    h('span', { class: 'deck__peek deck__peek--b' }),
    h('span', { class: 'deck__face' }, h('span', { class: 'deck__name', text: game.name })),
    game.status === 'soon' ? h('span', { class: 'deck__seal' }) : null,
  );
  const titleId = `game-${game.id}`;
  return h(
    'li',
    { class: `deck deck--${game.id} is-${game.status}`, attrs: { 'aria-labelledby': titleId } },
    box,
    h(
      'div',
      { class: 'deck__info' },
      h('div', { class: 'deck__row' }, h('h3', { class: 'deck__title', text: game.name, attrs: { id: titleId } }), statusBadge(game.status)),
      h('p', { class: 'deck__blurb', text: game.blurb }),
      h('p', { class: 'deck__players', text: game.players }),
      action && game.status === 'open'
        ? h('button', { class: 'btn btn--primary btn--sm', text: action.label, attrs: { type: 'button' }, on: { click: action.onClick } })
        : null,
    ),
  );
}

export function notice(text: string, tone: 'info' | 'error' = 'info'): HTMLElement {
  return h('p', { class: `notice notice--${tone}`, text, attrs: { role: tone === 'error' ? 'alert' : 'status' } });
}

/** A quiet in-progress line with a small dealing-cards indicator. */
export function loadingLine(text: string): HTMLElement {
  return h(
    'p',
    { class: 'loading', attrs: { role: 'status' } },
    h('span', { class: 'loading__cards', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
    h('span', { text }),
  );
}

export function iconButton(icon: string, label: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${extra}`.trim(), attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } });
  b.append(svg(icon));
  return b;
}
