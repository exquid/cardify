import { cardName, isRedSuit, sameCard, SUIT_NAMES, SUIT_SYMBOLS, type Card, type Suit } from '../../game/cards';
import type { DurakAction, DurakEvent } from '../../durak/types';
import type { DurakView } from '../../durak/views';
import { brand } from '../components';
import { cardElement } from '../cards';
import { h, ICONS, setText, svg, toggleClass } from '../dom';
import type { SoundBoard } from '../effects';

/**
 * Durak table screen (solo). Renders DurakViews and forwards the player's
 * choices; it never decides rules itself — every playable card comes from
 * `view.legal`. Built on the Walnut Club shell: topbar, felt, seat plates,
 * feed and dock.
 */

export interface DurakScreenHooks {
  onAction(action: DurakAction, seq: number): void;
  onMenu(): void;
  onToggleSound(): void;
  onHistory(lines: readonly string[]): void;
  onPlayAgain(): void;
  onLeave(): void;
}

type Position = 'top' | 'left' | 'right';
const LAYOUT: Record<number, Position[]> = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'], 4: ['left', 'top', 'top', 'right'], 5: ['left', 'left', 'top', 'right', 'right'] };

interface SeatEls {
  root: HTMLElement;
  cards: HTMLElement;
  count: HTMLElement;
  tag: HTMLElement;
}

const suitGlyph = (s: Suit) => `${SUIT_SYMBOLS[s]}︎`;

/** Sort a hand by suit (trumps last) and rank, the way players hold cards. */
export function sortHand(hand: readonly Card[], trump: Suit): Card[] {
  const order: Suit[] = (['c', 'd', 'h', 's'] as Suit[]).filter((s) => s !== trump).concat(trump);
  return [...hand].sort((a, b) => order.indexOf(a.suit) - order.indexOf(b.suit) || a.rank - b.rank);
}

export class DurakScreen {
  readonly root: HTMLElement;
  readonly history: string[] = [];
  private readonly felt: HTMLElement;
  private readonly pairsEl: HTMLElement;
  private readonly talonEl: HTMLElement;
  private readonly talonCount: HTMLElement;
  private readonly discardEl: HTMLElement;
  private readonly seats = new Map<string, SeatEls>();
  private readonly handEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly takeBtn: HTMLButtonElement;
  private readonly passBtn: HTMLButtonElement;
  private readonly feedText: HTMLElement;
  private readonly live: HTMLElement;
  private readonly info: HTMLElement;
  private readonly soundBtn: HTMLButtonElement;
  private readonly resultEl: HTMLElement;
  private view: DurakView | null = null;
  private seenEvents = 0;
  private locked = false;
  private target: number | null = null;
  /** Seconds left on the acting human's clock (online), or null. */
  private clock: number | null = null;

  constructor(
    private readonly heroId: string,
    initial: DurakView,
    private readonly sound: SoundBoard,
    private readonly soundOn: () => boolean,
    private readonly hooks: DurakScreenHooks,
  ) {
    const menuBtn = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Menu' }, on: { click: hooks.onMenu } });
    menuBtn.append(svg(ICONS.menu));
    this.soundBtn = h('button', { class: 'icon-btn', attrs: { type: 'button' }, on: { click: hooks.onToggleSound } });
    this.info = h('div', { class: 'topbar__info', attrs: { role: 'group' } });
    const mark = brand('bar');
    mark.classList.add('topbar__brand');
    mark.setAttribute('aria-hidden', 'true');

    // Felt: talon + trump on the left, the bout in the middle, the discard pile on the right.
    this.talonCount = h('span', { class: 'durak-talon__count' });
    this.talonEl = h('div', { class: 'durak-talon', attrs: { 'aria-label': 'Talon' } });
    this.discardEl = h('div', { class: 'durak-discard', attrs: { 'aria-label': 'Discard pile' } });
    this.pairsEl = h('div', { class: 'durak-pairs', attrs: { role: 'group', 'aria-label': 'Cards on the table' } });
    this.felt = h(
      'div',
      { class: 'table__felt' },
      h('span', { class: 'table__print', text: 'cardify', attrs: { 'aria-hidden': 'true' } }),
      this.talonEl,
      this.pairsEl,
      this.discardEl,
    );
    this.resultEl = h('div', { class: 'durak-result', attrs: { hidden: true, role: 'status' } });
    const table = h('div', { class: 'table durak-table' }, h('div', { class: 'table__rail' }, this.felt), this.resultEl);

    // Opponents around the felt.
    const opponents = initial.players.filter((p) => p.id !== heroId);
    const layout = LAYOUT[opponents.length] ?? LAYOUT[3]!;
    const heroSeat = initial.players.find((p) => p.id === heroId)?.seat ?? 0;
    const clockwise = [...opponents].sort((a, b) => ((a.seat - heroSeat + 6) % 6) - ((b.seat - heroSeat + 6) % 6));
    clockwise.forEach((p, i) => {
      const cards = h('div', { class: 'seat__cards durak-seat__cards' });
      const count = h('div', { class: 'seat__stack' });
      const tag = h('div', { class: 'seat__tag is-empty' });
      const root = h(
        'div',
        { class: 'seat durak-seat', dataset: { pos: layout[i] ?? 'top', slot: String(i) }, attrs: { role: 'group', 'aria-label': `${p.name}'s seat` } },
        cards,
        h(
          'div',
          { class: 'seat__plate' },
          h('div', { class: 'seat__avatar', attrs: { 'aria-hidden': 'true' } }, h('span', { text: p.name.charAt(0) })),
          h('div', { class: 'seat__meta' }, h('div', { class: 'seat__name', text: p.name }), count),
        ),
        tag,
      );
      this.seats.set(p.id, { root, cards, count, tag });
      table.append(root);
    });

    this.feedText = h('span', { class: 'feed__text', text: 'Shuffling the 36-card deck…' });
    const feed = h(
      'button',
      { class: 'feed', attrs: { type: 'button', 'aria-label': 'Show game history' }, on: { click: () => hooks.onHistory(this.history) } },
      this.feedText,
      h('span', { class: 'feed__more', text: 'History', attrs: { 'aria-hidden': 'true' } }),
    );

    // Dock: status, the hero's hand, Take / Done.
    this.statusEl = h('div', { class: 'dock__status', attrs: { 'aria-live': 'off' } });
    this.handEl = h('div', { class: 'durak-hand', attrs: { role: 'group', 'aria-label': 'Your hand' } });
    this.takeBtn = h('button', { class: 'btn btn--fold', text: 'Take', attrs: { type: 'button', 'aria-keyshortcuts': 'T' }, on: { click: () => this.send({ type: 'take' }) } });
    this.passBtn = h('button', { class: 'btn btn--call', text: 'Done', attrs: { type: 'button', 'aria-keyshortcuts': 'D' }, on: { click: () => this.send({ type: 'pass' }) } });
    const actions = h('div', { class: 'dock__actions durak-actions' }, this.takeBtn, this.passBtn);
    const dock = h('div', { class: 'dock durak-dock' }, this.statusEl, this.handEl, actions);
    this.live = h('div', { class: 'sr-only', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });

    this.root = h(
      'div',
      { class: 'screen screen--game screen--durak' },
      h('header', { class: 'topbar' }, menuBtn, mark, this.info, h('div', { class: 'topbar__tools' }, this.soundBtn)),
      h('section', { class: 'stage', attrs: { 'aria-label': 'Durak table' } }, table),
      feed,
      dock,
      this.live,
    );
    this.refreshTools();
  }

  refreshTools(): void {
    const on = this.soundOn();
    this.soundBtn.replaceChildren(svg(on ? ICONS.soundOn : ICONS.soundOff));
    this.soundBtn.setAttribute('aria-label', on ? 'Sound on — tap to mute' : 'Sound off — tap to unmute');
  }

  /** Accept input again for the same decision (after a refused action). */
  release(): void {
    this.locked = false;
    if (this.view) this.render(this.view);
  }

  /** Updates only the status line (online turn clock), so taps on the hand are never lost to a re-render. */
  setClock(seconds: number | null): void {
    this.clock = seconds;
    const view = this.view;
    if (view) setText(this.statusEl, this.status(view, (id) => (id === this.heroId ? 'You' : view.players.find((p) => p.id === id)?.name ?? id)));
  }

  notify(line: string): void {
    this.history.push(line);
    setText(this.feedText, line);
  }

  handleKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't' && !this.takeBtn.classList.contains('is-hidden')) this.takeBtn.click();
    else if ((k === 'd' || k === 'enter') && !this.passBtn.classList.contains('is-hidden')) this.passBtn.click();
    else return;
    e.preventDefault();
  }

  render(view: DurakView): void {
    const seqChanged = view.seq !== this.view?.seq;
    if (seqChanged) {
      this.locked = false;
      this.target = null;
    }
    const legal = view.legal;
    const nameOf = (id: string) => (id === this.heroId ? 'You' : view.players.find((p) => p.id === id)?.name ?? id);

    // Topbar.
    const stat = (k: string, v: string | HTMLElement) => h('span', { class: 'topbar__stat' }, h('span', { class: 'topbar__k', text: k }), h('span', { class: 'topbar__v' }, v));
    const trump = h('span', { class: `durak-suit ${isRedSuit(view.trump) ? 'is-red' : ''}`, text: `${suitGlyph(view.trump)} ${SUIT_NAMES[view.trump]}` });
    this.info.replaceChildren(stat('Durak', `Bout ${view.boutNumber}`), stat('Trump', trump), stat('Deck', String(view.talonCount)));
    this.info.setAttribute('aria-label', `Durak, bout ${view.boutNumber}, trump ${SUIT_NAMES[view.trump]}, ${view.talonCount} cards in the deck`);

    // Talon: a face-down stack with the trump card turned across it.
    this.talonEl.replaceChildren();
    if (view.talonCount > 0) {
      const trumpCard = cardElement(view.trumpCard);
      trumpCard.classList.add('durak-talon__trump');
      this.talonEl.append(trumpCard);
      if (view.talonCount > 1) this.talonEl.append(cardElement(null));
    } else {
      this.talonEl.append(h('span', { class: 'durak-talon__empty', text: suitGlyph(view.trump) }));
    }
    setText(this.talonCount, view.talonCount ? String(view.talonCount) : '');
    this.talonEl.append(this.talonCount);
    this.discardEl.replaceChildren(...(view.discardCount ? [cardElement(null), h('span', { class: 'durak-talon__count', text: String(view.discardCount) })] : []));
    toggleClass(this.discardEl, 'is-empty', view.discardCount === 0);

    // The bout.
    const defending = view.pending.kind === 'defend' && legal !== null;
    const undefended = view.pairs.map((p, i) => (p.defense ? -1 : i)).filter((i) => i >= 0);
    if (this.target !== null && !undefended.includes(this.target)) this.target = null;
    this.pairsEl.replaceChildren(
      ...view.pairs.map((pair, i) => {
        const attack = cardElement(pair.attack);
        const slot = h('div', { class: 'durak-pair', dataset: { index: String(i) } }, attack);
        if (pair.defense) {
          const d = cardElement(pair.defense);
          d.classList.add('durak-pair__defense');
          slot.append(d);
        } else if (defending) {
          slot.classList.add('is-open');
          toggleClass(slot, 'is-target', this.target === i);
          slot.setAttribute('role', 'button');
          slot.setAttribute('tabindex', '0');
          slot.setAttribute('aria-label', `Beat ${cardName(pair.attack)}`);
          slot.addEventListener('click', () => {
            this.target = this.target === i ? null : i;
            this.render(view);
          });
        }
        return slot;
      }),
    );
    toggleClass(this.pairsEl, 'is-taking', view.taking);

    // Opponents.
    for (const p of view.players) {
      const seat = this.seats.get(p.id);
      if (!seat) continue;
      const shown = Math.min(p.handCount, 6);
      seat.cards.replaceChildren(...Array.from({ length: shown }, () => cardElement(null)));
      seat.cards.style.setProperty('--n', String(shown));
      setText(seat.count, p.out ? 'Out' : `${p.handCount} ${p.handCount === 1 ? 'card' : 'cards'}`);
      toggleClass(seat.root, 'is-acting', p.isActing);
      toggleClass(seat.root, 'is-out', p.out);
      const role = p.out ? `Safe · ${ordinalShort(p.place ?? 0)}` : p.role === 'attacker' ? 'Attacking' : p.role === 'defender' ? (view.taking ? 'Taking' : 'Defending') : '';
      setText(seat.tag, role);
      toggleClass(seat.tag, 'is-empty', role === '');
    }

    // Hero hand.
    const me = view.players.find((p) => p.id === this.heroId);
    const hand = sortHand(me?.hand ?? [], view.trump);
    const playable = (c: Card): DurakAction | null => {
      if (!legal || this.locked) return null;
      if (legal.attackCards.some((x) => sameCard(x, c))) return { type: 'attack', card: c };
      const options = legal.defend.filter((d) => d.cards.some((x) => sameCard(x, c)));
      const pick = options.find((d) => d.attackIndex === this.target) ?? (this.target === null ? options[0] : undefined);
      return pick ? { type: 'defend', attackIndex: pick.attackIndex, card: c } : null;
    };
    this.handEl.replaceChildren(
      ...hand.map((c) => {
        const action = playable(c);
        const el = cardElement(c);
        if (c.suit === view.trump) el.classList.add('is-trump');
        const b = h('button', {
          class: `durak-hand__card${action ? ' is-playable' : ''}`,
          attrs: { type: 'button', 'aria-label': `${cardName(c)}${action ? '' : ', not playable now'}` },
          on: { click: () => action && this.send(action) },
        });
        if (!action) b.setAttribute('aria-disabled', 'true');
        b.append(el);
        return b;
      }),
    );
    this.handEl.style.setProperty('--n', String(hand.length));

    // Dock buttons and status.
    const myTurn = !!legal && view.pending.kind !== 'over';
    toggleClass(this.takeBtn, 'is-hidden', !(myTurn && legal?.canTake));
    toggleClass(this.passBtn, 'is-hidden', !(myTurn && legal?.canPass));
    this.takeBtn.disabled = this.locked;
    this.passBtn.disabled = this.locked;
    setText(this.passBtn, view.taking ? 'Done adding' : 'Done');
    this.root.querySelector('.durak-dock')?.setAttribute('data-mode', myTurn ? 'turn' : view.pending.kind === 'over' ? 'complete' : 'waiting');
    setText(this.statusEl, this.status(view, nameOf));

    // Result.
    this.resultEl.hidden = view.pending.kind !== 'over';
    if (view.pending.kind === 'over' && view.outcome) {
      const lost = view.outcome.kind === 'loser' && view.outcome.loserId === this.heroId;
      const title = view.outcome.kind === 'draw' ? 'A draw' : lost ? 'You are the durak' : 'You got out!';
      const detail = view.outcome.kind === 'draw' ? 'The last cards went out together.' : lost ? 'Last one holding cards. Shuffle up and try again.' : `${nameOf(view.outcome.loserId)} is the durak.`;
      this.resultEl.replaceChildren(
        h('p', { class: 'durak-result__title', text: title }),
        h('p', { class: 'durak-result__detail', text: detail }),
        h(
          'div',
          { class: 'durak-result__actions' },
          h('button', { class: 'btn btn--primary', text: 'Play again', attrs: { type: 'button' }, on: { click: () => this.hooks.onPlayAgain() } }),
          h('button', { class: 'btn btn--ghost', text: 'Main menu', attrs: { type: 'button' }, on: { click: () => this.hooks.onLeave() } }),
        ),
      );
      toggleClass(this.resultEl, 'is-win', !lost && view.outcome.kind !== 'draw');
    }

    this.handleEvents(view, nameOf, seqChanged);
    this.view = view;
  }

  private status(view: DurakView, nameOf: (id: string) => string): string {
    const p = view.pending;
    if (p.kind === 'over') return 'Game over';
    if (p.kind === 'resolve') return view.taking ? `${nameOf(view.players.find((x) => x.role === 'defender')?.id ?? '')} picks up` : 'Beaten — to the discard pile';
    const mine = 'playerId' in p && p.playerId === this.heroId;
    const clock = this.clock !== null ? ` · ${this.clock}s` : '';
    if (!mine) {
      const id = (p as { playerId: string }).playerId;
      const human = view.players.find((x) => x.id === id)?.kind === 'human';
      return human && this.clock !== null ? `${nameOf(id)} to act${clock}` : `${nameOf(id)} is thinking…`;
    }
    if (p.kind === 'attack') return `Your attack: play any card${clock}`;
    if (p.kind === 'throw') return `${view.taking ? 'They are taking — add matching cards or tap Done' : 'Throw in a matching card, or tap Done'}${clock}`;
    return `${this.target !== null ? 'Beat the marked card' : 'Beat the attack, or Take'}${clock}`;
  }

  private send(action: DurakAction): void {
    if (this.locked || !this.view?.legal) return;
    this.locked = true;
    this.hooks.onAction(action, this.view.seq);
  }

  private handleEvents(view: DurakView, nameOf: (id: string) => string, fresh: boolean): void {
    const events = view.events.slice(this.seenEvents);
    this.seenEvents = view.events.length;
    if (!fresh) return;
    const said: string[] = [];
    for (const e of events) {
      const line = describe(e, nameOf);
      if (line) {
        this.history.push(line);
        said.push(line);
      }
      if (this.soundOn()) {
        if (e.type === 'attack' || e.type === 'defend') this.sound.play('card');
        else if (e.type === 'draw') this.sound.play('deal');
        else if (e.type === 'pickup') this.sound.play('fold');
        else if (e.type === 'over') this.sound.play(e.outcome.kind === 'loser' && e.outcome.loserId === this.heroId ? 'fold' : 'win');
      }
    }
    if (view.legal && this.soundOn() && events.length) this.sound.play('turn');
    const latest = this.history[this.history.length - 1];
    if (latest) setText(this.feedText, latest);
    if (said.length) setText(this.live, said.slice(-3).join(' '));
  }
}

function ordinalShort(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

export function describe(e: DurakEvent, nameOf: (id: string) => string): string | null {
  switch (e.type) {
    case 'deal':
      return `New game · trump is ${SUIT_NAMES[e.trumpCard.suit]} (${cardName(e.trumpCard)} under the deck)`;
    case 'bout':
      return `${nameOf(e.attackerId)} ${nameOf(e.attackerId) === 'You' ? 'attack' : 'attacks'} ${nameOf(e.defenderId)}`;
    case 'attack':
      return `${nameOf(e.playerId)} · ${cardName(e.card)}`;
    case 'defend':
      return `${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'beat' : 'beats'} it with the ${cardName(e.card)}`;
    case 'take':
      return `${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'take' : 'takes'}`;
    case 'pickup':
      return `${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'pick' : 'picks'} up ${e.count} cards`;
    case 'discard':
      return `Beaten — ${e.count} cards to the discard pile`;
    case 'draw':
      return null;
    case 'pass':
      return null;
    case 'out':
      return `${nameOf(e.playerId)} ${nameOf(e.playerId) === 'You' ? 'are' : 'is'} out — safe`;
    case 'over':
      return e.outcome.kind === 'draw' ? 'Game over · a draw' : `Game over · ${nameOf(e.outcome.loserId)} ${nameOf(e.outcome.loserId) === 'You' ? 'are' : 'is'} the durak`;
  }
}

/** Short rules for the "How to play" sheet. */
export function durakRulesBody(): HTMLElement {
  const item = (t: string, d: string) => h('li', {}, h('strong', { text: t }), h('span', { text: ` ${d}` }));
  return h(
    'div',
    { class: 'howto' },
    h('p', { text: 'Podkidnoy Durak, 36 cards (six to ace). Get rid of your cards; the last player holding cards is the durak.' }),
    h(
      'ul',
      { class: 'howto__list' },
      item('Trump.', 'The card under the deck sets the trump suit. The lowest trump attacks first.'),
      item('Attack.', 'Play any card. Others may throw in cards of a rank already on the table.'),
      item('Defend.', 'Beat each card with a higher card of its suit, or with any trump. Tap a card on the table to choose which one to beat.'),
      item('Take.', 'Can’t or won’t beat it? Take: others may still add matching cards, then you pick them all up and miss your attack.'),
      item('Limits.', 'At most five attack cards in the first bout, six later, and never more than the defender holds.'),
      item('Refill.', 'After each bout everyone draws back to six: attacker first, defender last.'),
    ),
  );
}
