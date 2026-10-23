import { cardCode, rankPlural, rankLabel, type Card } from '../game/cards';
import { evaluateDetailed } from '../game/evaluator';
import type { GameEvent } from '../game/types';
import type { PlayerPublicView, TableView } from '../game/views';
import { markCards, renderCards } from './cards';
import { h, setText, toggleClass } from './dom';
import { actionTag, chips, ordinal } from './format';

type SeatPosition = 'bottom' | 'left' | 'top' | 'right';
const POSITIONS_4: SeatPosition[] = ['bottom', 'left', 'top', 'right'];

interface SeatElements {
  root: HTMLElement;
  plate: HTMLElement;
  cards: HTMLElement;
  name: HTMLElement;
  stack: HTMLElement;
  tag: HTMLElement;
  role: HTMLElement;
  hint: HTMLElement | null;
  bet: HTMLElement;
  betAmount: HTMLElement;
  position: SeatPosition;
}

export interface TableRenderOptions {
  animate: boolean;
  dealStagger: number;
}

/**
 * Renders the poker table from a TableView. Owns persistent DOM nodes and
 * patches them in place; it never computes chips or outcomes itself — every
 * number shown comes from the engine view.
 */
export class TableRenderer {
  readonly root: HTMLElement;
  readonly fxLayer: HTMLElement;
  readonly potEl: HTMLElement;
  private readonly potAmount: HTMLElement;
  private readonly boardCards: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly dealerButton: HTMLElement;
  private readonly seats = new Map<string, SeatElements>();
  private lastHandNumber = -1;

  constructor(private readonly heroId: string, players: readonly PlayerPublicView[]) {
    this.potAmount = h('strong', { class: 'pot__amount', text: '0' });
    this.potEl = h(
      'div',
      { class: 'pot', attrs: { 'aria-label': 'Pot' } },
      h('span', { class: 'chip-icon', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'pot__label', text: 'Pot' }),
      this.potAmount,
    );
    this.boardCards = h('div', { class: 'board__cards' });
    const slots = h('div', { class: 'board__slots', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < 5; i++) slots.append(h('div', { class: 'board__slot' }));
    const board = h('div', { class: 'board', attrs: { 'aria-label': 'Community cards' } }, slots, this.boardCards);

    this.bannerTitle = h('div', { class: 'banner__title' });
    this.bannerSub = h('div', { class: 'banner__sub' });
    this.banner = h('div', { class: 'banner', attrs: { hidden: true } }, this.bannerTitle, this.bannerSub);
    this.dealerButton = h('div', { class: 'dealer-button', text: 'D', attrs: { 'aria-hidden': 'true' } });
    this.fxLayer = h('div', { class: 'fx-layer', attrs: { 'aria-hidden': 'true' } });

    const felt = h('div', { class: 'table__felt' });
    this.root = h('div', { class: 'table' }, felt, this.potEl, board, this.banner);

    const hero = players.find((p) => p.id === heroId);
    const heroSeat = hero?.seat ?? 0;
    const count = players.length;
    for (const p of players) {
      const position = POSITIONS_4[(p.seat - heroSeat + count) % count] ?? 'top';
      const seat = this.createSeat(p, position);
      this.seats.set(p.id, seat);
      this.root.append(seat.root, seat.bet);
    }
    this.root.append(this.dealerButton, this.fxLayer);
  }

  seatPlate(playerId: string): HTMLElement | null {
    return this.seats.get(playerId)?.plate ?? null;
  }

  private createSeat(p: PlayerPublicView, position: SeatPosition): SeatElements {
    const isHero = p.id === this.heroId;
    const name = h('div', { class: 'seat__name', text: p.name });
    const stack = h('div', { class: 'seat__stack' });
    const role = h('div', { class: 'seat__role' });
    const plate = h(
      'div',
      { class: 'seat__plate' },
      h('div', { class: 'seat__avatar', attrs: { 'aria-hidden': 'true' } }, h('span', { text: p.name.charAt(0) })),
      h('div', { class: 'seat__meta' }, name, stack),
      role,
    );
    const cards = h('div', { class: 'seat__cards' });
    const tag = h('div', { class: 'seat__tag' });
    const hint = isHero ? h('div', { class: 'seat__hint' }) : null;
    const root = h(
      'div',
      {
        class: `seat${isHero ? ' seat--hero' : ''}`,
        dataset: { pos: position, profile: p.botProfile ?? 'human' },
        attrs: { role: 'group', 'aria-label': isHero ? 'Your seat' : `${p.name}'s seat` },
      },
      cards,
      plate,
      tag,
      hint,
    );
    const betAmount = h('span', { class: 'bet__amount' });
    const bet = h(
      'div',
      { class: 'bet', dataset: { pos: position } },
      h('span', { class: 'chip-icon', attrs: { 'aria-hidden': 'true' } }),
      betAmount,
    );
    return { root, plate, cards, name, stack, tag, role, hint, bet, betAmount, position };
  }

  update(view: TableView, options: TableRenderOptions): void {
    const newHand = view.handNumber !== this.lastHandNumber;
    this.lastHandNumber = view.handNumber;
    const animate = options.animate;

    // Board.
    if (newHand) {
      this.boardCards.dataset.sig = '';
      this.boardCards.replaceChildren();
    }
    renderCards(this.boardCards, view.board, {
      animate,
      stagger: options.dealStagger * 1.4,
      enterClass: 'is-revealing',
    });

    // Pot: chips gathered from previous streets.
    const showPot = view.pending?.kind !== 'complete' && view.collectedPot > 0;
    toggleClass(this.potEl, 'is-hidden', !showPot);
    setText(this.potAmount, chips(view.collectedPot));

    // Dealer button.
    const dealer = view.players.find((p) => p.isDealer);
    const dealerPos = dealer ? this.seats.get(dealer.id)?.position : undefined;
    if (dealerPos && this.dealerButton.dataset.pos !== dealerPos) this.dealerButton.dataset.pos = dealerPos;

    const tags = seatTags(view);
    const winners = winnerInfo(view);

    for (const p of view.players) {
      const seat = this.seats.get(p.id);
      if (!seat) continue;
      this.updateSeat(seat, p, view, { newHand, animate, stagger: options.dealStagger, tag: tags.get(p.id) ?? '' });
    }

    this.updateHighlights(view, winners);
    this.updateBanner(view, winners);
  }

  private updateSeat(
    seat: SeatElements,
    p: PlayerPublicView,
    view: TableView,
    ctx: { newHand: boolean; animate: boolean; stagger: number; tag: string },
  ): void {
    const { root } = seat;
    root.dataset.status = p.status;
    toggleClass(root, 'is-acting', p.isActing);
    toggleClass(root, 'is-thinking', p.isActing && p.kind === 'bot');
    setText(seat.stack, p.status === 'out' ? (p.finishPlace ? `Out · ${ordinal(p.finishPlace)}` : 'Out') : chips(p.stack));

    // Cards: faces when visible to us, backs otherwise.
    if (ctx.newHand) {
      seat.cards.dataset.sig = '';
      seat.cards.replaceChildren();
    }
    let cards: (Card | null)[] = [];
    if (p.holeCards) cards = p.holeCards;
    else if (p.hasCards) cards = [null, null];
    // Deal order: SB first; approximate with seat index for the stagger.
    const dealIndex = (p.seat - (view.players.find((x) => x.isSmallBlind)?.seat ?? 0) + view.players.length) % view.players.length;
    renderCards(seat.cards, cards, {
      animate: ctx.animate,
      stagger: ctx.stagger * view.players.length,
      delay: ctx.newHand ? dealIndex * ctx.stagger : 0,
      enterClass: 'is-dealt',
    });

    // Role badge (SB / BB).
    setText(seat.role, p.status === 'out' ? '' : p.isSmallBlind && p.isBigBlind ? '' : p.isSmallBlind ? 'SB' : p.isBigBlind ? 'BB' : '');
    toggleClass(seat.role, 'is-empty', seat.role.textContent === '');

    // Tag: thinking / last action / hand at showdown.
    setText(seat.tag, p.isActing && p.kind === 'bot' ? '' : ctx.tag);
    toggleClass(seat.tag, 'is-empty', !(p.isActing && p.kind === 'bot') && ctx.tag === '');
    toggleClass(seat.tag, 'is-dots', p.isActing && p.kind === 'bot');

    // Bet in front of the seat.
    const showBet = p.streetBet > 0 && view.pending?.kind !== 'complete';
    toggleClass(seat.bet, 'is-visible', showBet);
    if (showBet) setText(seat.betAmount, chips(p.streetBet));

    // Hero helper: current hand strength.
    if (seat.hint) {
      const hint = p.holeCards && p.status !== 'folded' && !view.result ? describeHeroHand(p.holeCards, view.board) : '';
      setText(seat.hint, hint);
      toggleClass(seat.hint, 'is-empty', hint === '');
    }
  }

  private updateHighlights(view: TableView, winners: WinnerInfo | null): void {
    const best = winners?.bestFive ?? null;
    markCards(this.boardCards, best);
    for (const [id, seat] of this.seats) {
      const isWinner = !!winners && winners.ids.has(id);
      toggleClass(seat.root, 'is-winner', isWinner);
      markCards(seat.cards, best && view.result?.shown.some((s) => s.playerId === id) ? best : null);
    }
  }

  private updateBanner(view: TableView, winners: WinnerInfo | null): void {
    const show = view.pending?.kind === 'complete' && !!winners;
    this.banner.hidden = !show;
    if (!show || !winners) return;
    setText(this.bannerTitle, winners.title);
    setText(this.bannerSub, winners.subtitle);
  }
}

export interface WinnerInfo {
  ids: Set<string>;
  title: string;
  subtitle: string;
  bestFive: Set<string> | null;
}

export function winnerInfo(view: TableView): WinnerInfo | null {
  const result = view.result;
  if (!result) return null;
  const nameOf = (id: string): string => view.players.find((p) => p.id === id)?.name ?? id;
  const totals = new Map<string, number>();
  for (const award of result.awards) {
    for (const w of award.winners) totals.set(w.playerId, (totals.get(w.playerId) ?? 0) + w.amount);
  }
  const ids = new Set(totals.keys());
  const main = result.awards[0];
  const mainWinners = main?.winners.map((w) => w.playerId) ?? [];
  const mainShown = result.shown.find((s) => s.playerId === mainWinners[0]);
  const bestFive = mainShown ? new Set(mainShown.bestFive.map(cardCode)) : null;

  const youId = view.viewerId;
  const label = (id: string): string => (id === youId ? 'You' : nameOf(id));
  let title: string;
  if (mainWinners.length > 1) {
    title = `Split pot · ${mainWinners.map(label).join(' & ')}`;
  } else {
    const id = mainWinners[0] ?? [...ids][0] ?? '';
    const verb = id === youId ? 'win' : 'wins';
    title = `${label(id)} ${verb} ${chips(totals.get(id) ?? 0)}`;
  }
  let subtitle = result.endedBy === 'fold' ? 'Everyone else folded' : (mainShown?.handName ?? '');
  const sideWinners = result.awards.slice(1).flatMap((a) => a.winners.map((w) => w.playerId)).filter((id) => !mainWinners.includes(id));
  if (sideWinners.length > 0) {
    subtitle += ` · side pot: ${[...new Set(sideWinners)].map(label).join(', ')}`;
  }
  return { ids, title, subtitle, bestFive };
}

/** Last action of each player on the current street, folds, and showdown hands. */
function seatTags(view: TableView): Map<string, string> {
  const tags = new Map<string, string>();
  const street = view.street;
  for (const e of view.events) {
    if (e.type === 'action') {
      if (e.action === 'fold') tags.set(e.playerId, 'Fold');
      else if (e.street === street) tags.set(e.playerId, actionTag(e));
    }
    if (e.type === 'street') {
      // New street: clear non-fold, non-all-in tags.
      for (const [id, tag] of tags) if (tag !== 'Fold' && tag !== 'All-in') tags.delete(id);
    }
  }
  for (const p of view.players) {
    if (p.status === 'allin' && view.pending?.kind !== 'complete') tags.set(p.id, 'All-in');
  }
  if (view.result) {
    tags.clear();
    for (const s of view.result.shown) tags.set(s.playerId, s.handName);
    for (const p of view.players) if (p.status === 'folded') tags.set(p.id, 'Fold');
    const won = new Map<string, number>();
    for (const a of view.result.awards) for (const w of a.winners) won.set(w.playerId, (won.get(w.playerId) ?? 0) + w.amount);
    for (const [id, amount] of won) {
      const hand = view.result.shown.find((s) => s.playerId === id)?.handName;
      tags.set(id, hand ? `${hand} · +${chips(amount)}` : `+${chips(amount)}`);
    }
  }
  return tags;
}

function describeHeroHand(hole: readonly Card[], board: readonly Card[]): string {
  const [a, b] = hole;
  if (!a || !b) return '';
  if (board.length >= 3) return evaluateDetailed([...hole, ...board]).name;
  if (a.rank === b.rank) return `Pocket ${rankPlural(a.rank)}`;
  const [hi, lo] = a.rank > b.rank ? [a, b] : [b, a];
  return `${rankLabel(hi.rank)}-${rankLabel(lo.rank)} ${a.suit === b.suit ? 'suited' : 'offsuit'}`;
}

/** Events added since the previous render (or the whole hand on a new hand). */
export function newEvents(previous: TableView | null, next: TableView): GameEvent[] {
  if (!previous || previous.handNumber !== next.handNumber) return next.events;
  return next.events.slice(previous.events.length);
}
