import { BOT_PROFILES } from '../bots/profiles';
import { CATEGORY_NAMES, HandCategory } from '../game/evaluator';
import type { SessionStats, Settings } from '../storage/session';
import { parseCard } from '../game/cards';
import { cardElement } from './cards';
import { brand, gameTile, GAMES, iconButton, notice } from './components';
import { h, ICONS, svg } from './dom';
import { chips, ordinal } from './format';

export interface StartScreenOptions {
  canContinue: boolean;
  savedHand: number | null;
  notice: string | null;
  /** Online table this browser can return to. */
  rejoinCode: string | null;
  onRejoin(): void;
  onContinue(): void;
  onPlay(): void;
  /** Opens "Play with Friends", optionally with a table code already filled in. */
  onFriends(code?: string): void;
  onHowTo(): void;
  onSettings(): void;
}

const HERO_SPREAD = ['As', 'Kh', 'Qc', 'Jd', 'Ts'];

/** The card room's front door: featured game, library, private tables. */
export function startScreen(o: StartScreenOptions): HTMLElement {
  const screen = h('main', { class: 'screen screen--home' });
  const scrollTo = (id: string): void => {
    const target = screen.querySelector<HTMLElement>(`#${id}`);
    target?.scrollIntoView({ behavior: document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  };

  // Navigation -------------------------------------------------------------
  const navItems: Array<[string, () => void]> = [
    ['Games', () => scrollTo('games')],
    ['Private tables', () => scrollTo('private')],
    ['How to play', o.onHowTo],
    ['Settings', o.onSettings],
  ];
  const nav = h('nav', { class: 'sitebar__nav', attrs: { 'aria-label': 'Main' } });
  for (const [label, onClick] of navItems) nav.append(h('button', { class: 'navlink', text: label, attrs: { type: 'button' }, on: { click: onClick } }));
  const menuButton = iconButton(ICONS.menu, 'Open menu', () => {
    let dialog: HTMLDialogElement | null = null;
    const list = h('div', { class: 'menu' });
    for (const [label, onClick] of navItems) {
      list.append(
        h('button', {
          class: 'menu__item',
          text: label,
          attrs: { type: 'button' },
          on: {
            click: () => {
              dialog?.close();
              onClick();
            },
          },
        }),
      );
    }
    dialog = openSheet('cardify', list);
  }, 'sitebar__menu');
  const sitebar = h('header', { class: 'sitebar' }, brand('bar'), nav, menuButton);

  // Featured game ----------------------------------------------------------
  const actions = h('div', { class: 'hero__actions' });
  let primaryTaken = false;
  const primary = (): string => {
    const cls = primaryTaken ? 'btn btn--secondary' : 'btn btn--primary';
    primaryTaken = true;
    return cls;
  };
  if (o.rejoinCode) {
    actions.append(h('button', { class: primary(), text: `Return to table ${o.rejoinCode}`, attrs: { type: 'button' }, on: { click: o.onRejoin } }));
  }
  if (o.canContinue) {
    const label = h('button', { class: `${primary()} btn--stack`, attrs: { type: 'button' }, on: { click: o.onContinue } });
    label.append(h('span', { text: 'Continue game' }), o.savedHand ? h('span', { class: 'btn__sub', text: `Solo, hand ${o.savedHand}` }) : '');
    actions.append(label);
  }
  actions.append(
    h('button', { class: primary(), text: o.canContinue ? 'New game' : 'Play poker', attrs: { type: 'button' }, on: { click: o.onPlay } }),
    h('button', { class: 'btn btn--ghost', text: 'Play with friends', attrs: { type: 'button' }, on: { click: () => o.onFriends() } }),
  );

  const spread = h('div', { class: 'hero__spread', attrs: { 'aria-hidden': 'true' } });
  HERO_SPREAD.forEach((code, i) => {
    const card = cardElement(parseCard(code));
    card.style.setProperty('--i', String(i - 2));
    spread.append(card);
  });
  spread.append(
    h('span', { class: 'hero__chips hero__chips--a' }),
    h('span', { class: 'hero__chips hero__chips--b' }),
    h('span', { class: 'hero__dealer', text: 'D' }),
  );

  const hero = h(
    'section',
    { class: 'hero', attrs: { 'aria-labelledby': 'hero-title' } },
    h(
      'div',
      { class: 'hero__rail' },
      h(
        'div',
        { class: 'hero__felt' },
        h(
          'div',
          { class: 'hero__copy' },
          h('p', { class: 'hero__game', text: "No-Limit Texas Hold'em" }),
          h('h1', { class: 'hero__title', text: 'Pull up a chair.', attrs: { id: 'hero-title' } }),
          h('p', {
            class: 'hero__lead',
            text: 'Nova, Vex and Orion are already seated. Play a four-seat Sit & Go against them, or open a private table for your friends.',
          }),
          o.notice ? notice(o.notice) : null,
          actions,
          h('p', { class: 'hero__fine', text: 'Virtual chips only. No deposits, no prizes.' }),
        ),
        spread,
      ),
    ),
  );

  // Library ------------------------------------------------------------------
  const shelf = h('ul', { class: 'shelf__decks' });
  for (const game of GAMES) shelf.append(gameTile(game, game.status === 'open' ? { label: 'Play poker', onClick: o.onPlay } : undefined));
  const library = h(
    'section',
    { class: 'section shelf', attrs: { id: 'games', tabindex: '-1', 'aria-labelledby': 'games-title' } },
    h(
      'div',
      { class: 'section__head' },
      h('h2', { class: 'section__title', text: 'The card room', attrs: { id: 'games-title' } }),
      h('p', { class: 'section__lead', text: "Hold'em is open tonight. Two more tables are being built." }),
    ),
    shelf,
  );

  // Private tables ---------------------------------------------------------
  const codeInput = h('input', {
    class: 'field__input field__input--code',
    attrs: {
      id: 'home-code',
      type: 'text',
      maxlength: 5,
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'K7QPM',
      enterkeyhint: 'join',
      'aria-describedby': 'home-code-hint',
    },
  });
  codeInput.addEventListener('input', () => {
    const cleaned = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });
  const joinForm = h(
    'form',
    {
      class: 'reserved__join',
      on: {
        submit: (e) => {
          e.preventDefault();
          o.onFriends(codeInput.value.trim());
        },
      },
    },
    h('label', { class: 'field__label', text: 'Have a code?', attrs: { for: 'home-code' } }),
    h('div', { class: 'join__row' }, codeInput, h('button', { class: 'btn btn--secondary', text: 'Join', attrs: { type: 'submit' } })),
    h('span', { class: 'field__hint', text: 'You will pick a name on the next step.', attrs: { id: 'home-code-hint' } }),
  );
  const reserved = h(
    'section',
    { class: 'section reserved', attrs: { id: 'private', tabindex: '-1', 'aria-labelledby': 'private-title' } },
    h(
      'div',
      { class: 'reserved__card' },
      h(
        'div',
        { class: 'reserved__copy' },
        h('h2', { class: 'section__title', text: 'Private tables', attrs: { id: 'private-title' } }),
        h('p', {
          class: 'reserved__lead',
          text: 'Seat two to six people at a table only you can share. Every table gets a five-character code, and the host can give empty seats to Nova, Vex or Orion.',
        }),
        h('button', { class: 'btn btn--primary', text: 'Create a table', attrs: { type: 'button' }, on: { click: () => o.onFriends() } }),
      ),
      joinForm,
    ),
  );

  // Regulars -----------------------------------------------------------------
  const regulars = h('ul', { class: 'regulars__list' });
  for (const profile of Object.values(BOT_PROFILES)) {
    regulars.append(
      h(
        'li',
        { class: 'regular', dataset: { profile: profile.id } },
        h('span', { class: 'avatar', text: profile.name.charAt(0), attrs: { 'aria-hidden': 'true' } }),
        h(
          'div',
          { class: 'regular__text' },
          h('h3', { class: 'regular__name', text: profile.name }),
          h('p', { class: 'regular__role', text: profile.archetype }),
          h('p', { class: 'regular__line', text: profile.tagline }),
        ),
      ),
    );
  }
  const regularsSection = h(
    'section',
    { class: 'section regulars', attrs: { 'aria-labelledby': 'regulars-title' } },
    h('div', { class: 'section__head' }, h('h2', { class: 'section__title', text: 'The regulars', attrs: { id: 'regulars-title' } }), h('p', { class: 'section__lead', text: 'Three bots with their own habits. They sit in every solo game and fill empty seats at private tables.' })),
    regulars,
  );

  const footer = h(
    'footer',
    { class: 'sitefoot' },
    brand('small'),
    h('p', { text: 'A card room in your browser. Virtual chips only: nothing here can be bought, won or cashed out.' }),
  );

  screen.append(sitebar, h('div', { class: 'home' }, hero, library, reserved, regularsSection, footer));
  return screen;
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

  const standings = h('ol', { class: 'standings', attrs: { 'aria-label': 'Final standings' } });
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
    { class: `screen screen--room screen--end ${won ? 'is-victory' : 'is-defeat'}` },
    h('header', { class: 'roombar' }, brand('bar')),
    h(
      'div',
      { class: 'panel end' },
      h('h1', { class: 'end__title', text: won ? 'You won the tournament' : 'Tournament over' }),
      h('p', {
        class: 'end__place',
        text: place ? `You finished ${ordinal(place)} of ${total}.` : 'The tournament is over.',
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
        h('button', { class: 'btn btn--ghost btn--wide', text: o.secondary.label, attrs: { type: 'button' }, on: { click: o.secondary.onClick } }),
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
  const variant = body.dataset.sheet;
  const close = h('button', { class: 'sheet__close', attrs: { type: 'button', 'aria-label': 'Close' } });
  close.append(svg(ICONS.close));
  const heading = h('h2', { class: 'sheet__title', text: title, attrs: { id: `sheet-${Date.now()}` } });
  const dialog = h(
    'dialog',
    { class: `sheet${variant ? ` sheet--${variant}` : ''}`, attrs: { 'aria-labelledby': heading.id } },
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

const RANKING_EXAMPLES: Record<number, [string, string]> = {
  [HandCategory.StraightFlush]: ['Five in a row, same suit. A-K-Q-J-10 is a royal flush.', '9h 8h 7h 6h 5h'],
  [HandCategory.FourOfAKind]: ['Four cards of the same rank.', 'Qs Qh Qd Qc 4s'],
  [HandCategory.FullHouse]: ['Three of a kind plus a pair.', 'Js Jd Jc 7h 7s'],
  [HandCategory.Flush]: ['Five cards of the same suit.', 'Ad Jd 8d 5d 2d'],
  [HandCategory.Straight]: ['Five in a row. A-2-3-4-5 is the lowest.', '9c 8d 7s 6h 5c'],
  [HandCategory.ThreeOfAKind]: ['Three cards of the same rank.', '8s 8h 8c Kd 3s'],
  [HandCategory.TwoPair]: ['Two different pairs.', 'Ks Kd 5c 5h 9s'],
  [HandCategory.Pair]: ['Two cards of the same rank.', 'Ah Ac Qs 8d 4c'],
  [HandCategory.HighCard]: ['Nothing else: the highest cards play.', 'Ad Qc 9h 6s 3d'],
};

const SHORTCUTS: Array<[string, string]> = [
  ['F', 'Fold'],
  ['C', 'Check or call'],
  ['R', 'Bet or raise. Press again to confirm the amount.'],
  ['A', 'All-in. Press twice.'],
  ['N', 'Next hand'],
  ['Esc', 'Close bet sizing'],
];

export function howToPlayBody(): HTMLElement {
  const rankings = h('ol', { class: 'rankings' });
  for (let c = 8; c >= 0; c--) {
    const [desc, example] = RANKING_EXAMPLES[c] ?? ['', ''];
    const hand = h('div', { class: 'rankings__cards', attrs: { 'aria-hidden': 'true' } });
    for (const code of example.split(' ')) {
      const card = cardElement(parseCard(code));
      card.classList.add('card--mini');
      hand.append(card);
    }
    rankings.append(
      h(
        'li',
        { class: 'rankings__row' },
        h('div', { class: 'rankings__text' }, h('span', { class: 'rankings__name', text: CATEGORY_NAMES[c as HandCategory] }), h('span', { class: 'rankings__desc', text: desc })),
        hand,
      ),
    );
  }
  const keys = h('dl', { class: 'keys' });
  for (const [key, label] of SHORTCUTS) keys.append(h('div', { class: 'keys__row' }, h('dt', {}, h('kbd', { text: key })), h('dd', { text: label })));
  const p = (text: string): HTMLElement => h('p', { text });
  const body = h(
    'div',
    { class: 'howto' },
    h('h3', { class: 'howto__h', text: 'The basics' }),
    p("No-Limit Texas Hold'em. You get two private cards, and five community cards are dealt in the middle: the flop (three), the turn (one) and the river (one). Your hand is the best five cards out of those seven."),
    p('Blinds rotate with the dealer button (D). In each betting round you can fold, check when nothing is owed, call, bet or raise any amount up to your whole stack. The minimum raise matches the previous raise.'),
    p('Everyone starts with 2,000 chips. Blinds rise every 8 hands. The last player with chips wins the Sit & Go.'),
    h('h3', { class: 'howto__h', text: 'Hand rankings, strongest first' }),
    rankings,
    h('h3', { class: 'howto__h', text: 'Keyboard shortcuts' }),
    keys,
    h('p', { class: 'howto__fine', text: 'Ties split the pot; an odd chip goes to the first winner left of the button. Virtual chips only: no deposits, prizes or real money.' }),
  );
  body.dataset.sheet = 'wide';
  return body;
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
    item('How to play', o.onHowTo),
    o.confirmLeave ? armed(o.leaveLabel, o.confirmLeave, o.onLeave, '') : item(o.leaveLabel, o.onLeave),
    restart ? armed('Restart tournament', 'Tap again to abandon this game', restart) : null,
  );
}

// ---------------------------------------------------------------------------
// Hand history
// ---------------------------------------------------------------------------

/**
 * Groups the table log into hands (newest first). Works only on the lines the
 * table already produced; nothing is inferred beyond their wording.
 */
export function historyBody(lines: readonly string[]): HTMLElement {
  interface Group {
    title: string;
    detail: string;
    lines: string[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const line of lines) {
    const header = /^Hand #(\d+)(?: · (.*))?$/.exec(line);
    if (header) {
      current = { title: `Hand ${header[1]}`, detail: header[2] ? capitalize(header[2]) : '', lines: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { title: 'Earlier', detail: '', lines: [] };
      groups.push(current);
    }
    current.lines.push(line);
  }

  const body = h('div', { class: 'history' });
  if (groups.length === 0) {
    body.append(h('p', { class: 'empty', text: 'No hands yet. Every action is written here as the cards are dealt.' }));
    return body;
  }
  for (const [i, group] of [...groups].reverse().entries()) {
    const list = h('ol', { class: 'history__lines' });
    for (const line of group.lines) {
      let kind = 'is-action';
      if (/^(Flop|Turn|River) dealt$/.test(line)) kind = 'is-street';
      else if (/\bwins?\b/.test(line) && !/^Blinds up/.test(line)) kind = 'is-win';
      else if (/^Blinds up/.test(line) || /\bout in\b/.test(line)) kind = 'is-note';
      else if (/^Not allowed/.test(line)) kind = 'is-error';
      list.append(h('li', { class: `${kind}${line.startsWith('You ') ? ' is-you' : ''}`, text: line }));
    }
    body.append(
      h(
        'section',
        { class: `history__hand${i === 0 ? ' is-latest' : ''}` },
        h('h3', { class: 'history__title' }, h('span', { text: group.title }), group.detail ? h('span', { class: 'history__detail', text: group.detail }) : ''),
        list,
      ),
    );
  }
  return body;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
