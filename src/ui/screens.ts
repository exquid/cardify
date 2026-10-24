import { BOT_PROFILES } from '../bots/profiles';
import { CATEGORY_NAMES, HandCategory } from '../game/evaluator';
import type { SessionStats, Settings } from '../storage/session';
import { h, ICONS, svg } from './dom';
import { chips, ordinal } from './format';

function logo(className = ''): HTMLElement {
  const wrap = h('div', { class: `brand ${className}`.trim() });
  wrap.append(svg(ICONS.logo), h('span', { class: 'wordmark', text: 'cardify' }));
  return wrap;
}

export interface StartScreenOptions {
  canContinue: boolean;
  savedHand: number | null;
  notice: string | null;
  /** Online table this browser can return to. */
  rejoinCode: string | null;
  onRejoin(): void;
  onContinue(): void;
  onPlay(): void;
  onFriends(): void;
  onHowTo(): void;
  onSettings(): void;
}

export function startScreen(o: StartScreenOptions): HTMLElement {
  const actions = h('div', { class: 'start__actions' });
  if (o.rejoinCode) {
    actions.append(
      h('button', {
        class: 'btn btn--primary btn--wide',
        text: `Return to table ${o.rejoinCode}`,
        attrs: { type: 'button' },
        on: { click: o.onRejoin },
      }),
    );
  }
  if (o.canContinue) {
    actions.append(
      h('button', {
        class: `btn ${o.rejoinCode ? 'btn--secondary' : 'btn--primary'} btn--wide`,
        text: o.savedHand ? `Continue solo · hand ${o.savedHand}` : 'Continue solo',
        attrs: { type: 'button' },
        on: { click: o.onContinue },
      }),
    );
  }
  actions.append(
    h('button', {
      class: `btn ${o.canContinue || o.rejoinCode ? 'btn--secondary' : 'btn--primary'} btn--wide`,
      text: o.canContinue ? 'New game · Play Solo' : 'Play Solo',
      attrs: { type: 'button' },
      on: { click: o.onPlay },
    }),
    h('button', {
      class: 'btn btn--secondary btn--wide',
      text: 'Play with Friends',
      attrs: { type: 'button' },
      on: { click: o.onFriends },
    }),
    h(
      'div',
      { class: 'start__links' },
      h('button', { class: 'link-btn', text: 'How to Play', attrs: { type: 'button' }, on: { click: o.onHowTo } }),
      h('span', { class: 'start__dot', text: '·', attrs: { 'aria-hidden': 'true' } }),
      h('button', { class: 'link-btn', text: 'Settings', attrs: { type: 'button' }, on: { click: o.onSettings } }),
    ),
  );

  const lineup = h('ul', { class: 'lineup', attrs: { 'aria-label': 'Your opponents tonight' } });
  for (const profile of Object.values(BOT_PROFILES)) {
    lineup.append(
      h(
        'li',
        { class: 'lineup__item', dataset: { profile: profile.id } },
        h('span', { class: 'lineup__avatar', text: profile.name.charAt(0), attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'lineup__name', text: profile.name }),
        h('span', { class: 'lineup__role', text: profile.archetype.replace(/^The /, '') }),
      ),
    );
  }

  return h(
    'main',
    { class: 'screen screen--start' },
    h(
      'div',
      { class: 'start' },
      logo('brand--hero'),
      h('p', { class: 'tagline', text: "Texas Hold'em, after dark." }),
      o.notice ? h('p', { class: 'notice', text: o.notice, attrs: { role: 'status' } }) : null,
      actions,
      lineup,
      h('p', { class: 'start__meta', text: 'Solo: four-seat Sit & Go · Friends: private tables for 2–6 · virtual chips only, no real money' }),
    ),
  );
}

export interface EndScreenOptions {
  players: ReadonlyArray<{ id: string; name: string; finishPlace: number | null }>;
  finished: boolean;
  heroId: string;
  stats: SessionStats;
  primary: { label: string; onClick(): void; disabled?: boolean };
  secondary: { label: string; onClick(): void };
}

export function endScreen(o: EndScreenOptions): HTMLElement {
  const hero = o.players.find((p) => p.id === o.heroId);
  const place = hero?.finishPlace ?? null;
  const won = place === 1;
  const total = o.players.length;

  const standings = h('ol', { class: 'standings' });
  const ranked = [...o.players].sort((a, b) => (a.finishPlace ?? 0) - (b.finishPlace ?? 0));
  for (const p of ranked) {
    if (p.finishPlace === null) continue;
    standings.append(
      h(
        'li',
        { class: `standings__row${p.id === o.heroId ? ' is-hero' : ''}` },
        h('span', { class: 'standings__place', text: ordinal(p.finishPlace) }),
        h('span', { class: 'standings__name', text: p.id === o.heroId ? 'You' : p.name }),
        h('span', { class: 'standings__note', text: p.finishPlace === 1 && o.finished ? 'Champion' : '' }),
      ),
    );
  }

  return h(
    'main',
    { class: `screen screen--end ${won ? 'is-victory' : 'is-defeat'}` },
    h(
      'div',
      { class: 'end' },
      logo('brand--small'),
      h('p', { class: 'eyebrow', text: 'Tournament complete' }),
      h('h1', { class: 'end__title', text: won ? 'Victory' : 'Defeat' }),
      h('p', {
        class: 'end__place',
        text: place ? `You finished ${ordinal(place)} of ${total}` : 'The tournament is over',
      }),
      h(
        'dl',
        { class: 'stats' },
        stat('Hands played', chips(o.stats.handsPlayed)),
        stat('Hands won', chips(o.stats.handsWon)),
        stat('Biggest pot', chips(o.stats.biggestPotWon)),
      ),
      standings,
      h(
        'div',
        { class: 'end__actions' },
        h('button', {
          class: 'btn btn--primary btn--wide',
          text: o.primary.label,
          attrs: { type: 'button', disabled: !!o.primary.disabled },
          on: { click: o.primary.onClick },
        }),
        h('button', { class: 'link-btn', text: o.secondary.label, attrs: { type: 'button' }, on: { click: o.secondary.onClick } }),
      ),
    ),
  );
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stats__item' }, h('dt', { text: label }), h('dd', { text: value }));
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

/** Opens a native <dialog> sheet. Resolves when it closes. */
export function openSheet(title: string, body: HTMLElement, onClose?: () => void): HTMLDialogElement {
  const close = h('button', { class: 'sheet__close', attrs: { type: 'button', 'aria-label': 'Close' } });
  close.append(svg(ICONS.close));
  const heading = h('h2', { class: 'sheet__title', text: title, attrs: { id: `sheet-${Date.now()}` } });
  const dialog = h(
    'dialog',
    { class: 'sheet', attrs: { 'aria-labelledby': heading.id } },
    h('div', { class: 'sheet__head' }, heading, close),
    h('div', { class: 'sheet__body' }, body),
  );
  const finish = (): void => {
    dialog.remove();
    onClose?.();
  };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', finish, { once: true });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // tap on backdrop
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  return dialog;
}

export function settingsBody(settings: Settings, onChange: (next: Settings) => void, reducedMotion: boolean): HTMLElement {
  let current = { ...settings };
  const update = (patch: Partial<Settings>): void => {
    current = { ...current, ...patch };
    onChange(current);
  };

  const speed = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Game speed' } });
  const speedButtons = (['normal', 'fast'] as const).map((value) => {
    const b = h('button', {
      class: 'segmented__opt',
      text: value === 'normal' ? 'Normal' : 'Fast',
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(current.speed === value) },
      on: {
        click: () => {
          update({ speed: value });
          speedButtons.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        },
      },
    });
    return b;
  });
  speed.append(...speedButtons);

  const toggle = (label: string, hint: string, key: 'sound' | 'animations' | 'autoNextHand'): HTMLElement => {
    const input = h('input', { class: 'switch__input', attrs: { type: 'checkbox', role: 'switch' } });
    input.checked = current[key];
    input.addEventListener('change', () => update({ [key]: input.checked }));
    return h(
      'label',
      { class: 'setting' },
      h('span', { class: 'setting__text' }, h('span', { class: 'setting__label', text: label }), h('span', { class: 'setting__hint', text: hint })),
      h('span', { class: 'switch' }, input, h('span', { class: 'switch__track', attrs: { 'aria-hidden': 'true' } })),
    );
  };

  return h(
    'div',
    { class: 'settings' },
    h(
      'div',
      { class: 'setting setting--stacked' },
      h('span', { class: 'setting__text' }, h('span', { class: 'setting__label', text: 'Table speed' }), h('span', { class: 'setting__hint', text: 'Fast shortens pauses and bot thinking time.' })),
      speed,
    ),
    toggle('Sound', 'Soft card and chip sounds, generated in the browser.', 'sound'),
    toggle(
      'Animations',
      reducedMotion ? 'Your system asks for reduced motion, so animations stay off.' : 'Dealing, chip and highlight animations.',
      'animations',
    ),
    toggle('Auto next hand', 'Deal the next hand automatically after a short pause.', 'autoNextHand'),
  );
}

export function howToPlayBody(): HTMLElement {
  const rankings = h('ol', { class: 'rankings' });
  const examples: Record<number, string> = {
    [HandCategory.StraightFlush]: 'Five in a row, same suit. A-K-Q-J-10 is a Royal Flush.',
    [HandCategory.FourOfAKind]: 'Four cards of the same rank.',
    [HandCategory.FullHouse]: 'Three of a kind plus a pair.',
    [HandCategory.Flush]: 'Five cards of the same suit.',
    [HandCategory.Straight]: 'Five in a row. A-2-3-4-5 is the lowest.',
    [HandCategory.ThreeOfAKind]: 'Three cards of the same rank.',
    [HandCategory.TwoPair]: 'Two different pairs.',
    [HandCategory.Pair]: 'Two cards of the same rank.',
    [HandCategory.HighCard]: 'Nothing else — highest cards play.',
  };
  for (let c = 8; c >= 0; c--) {
    rankings.append(
      h(
        'li',
        { class: 'rankings__row' },
        h('span', { class: 'rankings__name', text: CATEGORY_NAMES[c as HandCategory] }),
        h('span', { class: 'rankings__desc', text: examples[c] ?? '' }),
      ),
    );
  }
  const p = (text: string): HTMLElement => h('p', { text });
  return h(
    'div',
    { class: 'howto' },
    p('No-Limit Texas Hold\'em. You get two private cards; five community cards are dealt in the middle: the flop (3), the turn (1) and the river (1). Your hand is the best five cards out of those seven.'),
    p('Blinds rotate with the dealer button (D). Each betting round you can fold, check (when nothing is owed), call, bet or raise — any amount up to your whole stack. The minimum raise matches the previous raise.'),
    p('Everyone starts with 2,000 chips. Blinds rise every 8 hands. Last player with chips wins the Sit & Go.'),
    h('h3', { class: 'howto__h', text: 'Hand rankings — strongest first' }),
    rankings,
    h('h3', { class: 'howto__h', text: 'Shortcuts' }),
    p('F fold · C check/call · R bet/raise (press again to confirm) · A all-in (press twice) · N next hand · Esc close sizing.'),
    h('p', { class: 'howto__fine', text: 'Ties split the pot; an odd chip goes to the first winner left of the button. Virtual chips only — no deposits, prizes or real money.' }),
  );
}

export interface MenuOptions {
  onResume(): void;
  onSettings(): void;
  onHowTo(): void;
  onLeave(): void;
  leaveLabel: string;
  /** Asks for a second tap before leaving (online: leaving mid-game folds your hands). */
  confirmLeave?: string;
  onRestart?: () => void;
}

export function menuBody(o: MenuOptions): HTMLElement {
  const item = (label: string, onClick: () => void, extra = ''): HTMLButtonElement =>
    h('button', { class: `menu__item ${extra}`.trim(), text: label, attrs: { type: 'button' }, on: { click: onClick } });
  /** Danger items need a second tap within the same menu. */
  const armed = (label: string, confirm: string, action: () => void, extra = 'menu__item--danger'): HTMLButtonElement => {
    let ready = false;
    const button = item(label, () => {
      if (!ready) {
        ready = true;
        button.textContent = confirm;
        button.classList.add('is-armed');
        return;
      }
      action();
    }, extra);
    return button;
  };
  const restart = o.onRestart;
  return h(
    'div',
    { class: 'menu' },
    item('Resume', o.onResume, 'menu__item--primary'),
    item('Settings', o.onSettings),
    item('How to Play', o.onHowTo),
    o.confirmLeave ? armed(o.leaveLabel, o.confirmLeave, o.onLeave, '') : item(o.leaveLabel, o.onLeave),
    restart ? armed('Restart tournament', 'Tap again to abandon this game', restart) : null,
  );
}
