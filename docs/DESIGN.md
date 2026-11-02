# cardify design system — The Walnut Club

> Classic atmosphere. Modern experience.
> A private card room you can open in a browser tab: dark walnut, evergreen felt,
> honest playing cards, warm light. 70% contemporary product, 30% club character.

This document records the decisions behind the redesign so later games (Durak,
Blackjack, …) can extend the system instead of re-inventing it. Tokens live in
`src/styles/tokens.css`; everything else consumes them.

## 1. Subject, audience, job

- **Subject:** a card room — a collection of card games, with Texas Hold'em as the
  first open table.
- **Audience:** casual players on phones and laptops who want a quick, good-looking
  game against bots or friends. Virtual chips only; this is not a casino.
- **Primary job of the home page:** get someone into a hand in one tap, and make it
  obvious that more games are coming.

## 2. Palette

| Token | Hex | Role |
| --- | --- | --- |
| `--walnut` | `#1B1512` | App background. Warm, almost-black brown. |
| `--espresso` | `#2B211C` | Panels, navigation, the action dock, sheets. |
| `--mahogany` | `#4A3025` | Wood: the table rail, the game shelf, framing. Never a page background. |
| `--evergreen` | `#28503D` | The brand accent and the primary action (Play, Call/Check, Create). |
| `--brass` | `#B99A6B` | Hairline inlays, focus rings, small highlights. Not a button colour. |
| `--parchment` | `#F1E7D6` | Primary text, card stock, the one light section (Private tables). |

Supporting neutrals are derived from the same warm hue: `--ink-2` (secondary text,
≥ 6:1 on walnut), `--ink-3` (tertiary/disabled), `--line` / `--line-2` (dividers).
Semantic colours are deliberately off-palette so they never read as decoration:
`--danger` (brick red, fold/all-in confirmation, errors), `--warning` (amber, turn
clock), `--success` (sage, winners). Card suits keep the traditional red and black.

**Distribution:** walnut and espresso cover ~85% of every screen; evergreen marks
what you can do next; brass appears only as thin lines and small marks; wood grain
appears in exactly two places (table rail, game shelf).

## 3. Typography

- **Fraunces** (variable, the weight + `SOFT` axis file, SOFT at 100) for
  headlines, the wordmark, game names and celebratory moments. The soft axis
  rounds the serifs so the club feels welcoming rather than stiff — that is the
  "exclusivity without elitism" lever.
- **Onest** for everything functional: navigation, buttons, seats, stacks, bets,
  the log. All chip amounts use tabular figures.
- Gameplay-critical information (ranks, stacks, bets, actions) is never set in the
  serif.
- Scale (rem): 0.75 · 0.875 · 1 · 1.125 · 1.3125 · 1.5 · 2.25 · 3 · 4 — a classical
  scale; body at 16px, line length kept under ~70 characters.
- No tracked-out all-caps labels anywhere. Sentence case throughout.

## 4. Shape, depth, texture

- Radii follow hierarchy rather than one value for everything: 4px badges, 8px
  inputs and chips, 12px buttons, 20px sheets, a full racetrack for the table.
  Capsules are used only for things that are physically round on a real table
  (chips, pot marker).
- Shadows are warm and directional (light comes from a lamp above the table).
- Wood grain and felt nap are generated in CSS/SVG (`feTurbulence`), so no image
  assets are shipped.

## 5. Layout concepts

**Home** opens *at the table*: the hero is a walnut-railed felt surface with the
headline and actions printed on the felt and a hand of real cardify cards lying
on it. Below it, the game library is a **shelf of card decks** — each game is a
tuck box; Hold'em's is open, the others are sealed with "Coming soon". Private
tables get the one light, parchment section, styled like a reservation card.

```
┌ cardify ─────────────── Games  Private tables  How to play  Settings ┐
│╔═══════════════════════ walnut rail ════════════════════════════════╗│
│║ No-Limit Texas Hold'em          │                 ╱╲  fanned      ║│
│║ Pull up a chair.                │              cards on felt      ║│
│║ lead copy                       │          chips  · dealer button ║│
│║ [Play poker] [Play with friends]│                                 ║│
│╚════════════════════════════════════════════════════════════════════╝│
│ The card room                                                        │
│  [open deck]      [sealed deck]      [sealed deck]                   │
│ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ walnut shelf ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │
│ ┌ parchment: Private tables ───────────── [Create] [code][Join] ┐    │
│ The regulars: Nova · Vex · Orion                                     │
└──────────────────────────────────────────────────────────────────────┘
```

Alignment: left-aligned copy everywhere except the poker room, which is
symmetrical around the table.

**Poker room**: top bar → table (centre stage) → log line → action dock. Mobile
uses a portrait racetrack with its own seat geometry; landscape phones get a
compact band layout. The dock always reserves the same height so the table never
jumps when it becomes your turn.

## 6. Principles

1. **The table is the hero.** Spend boldness on the rail, the felt and the cards;
   keep chrome quiet.
2. **Evergreen means "your move."** One primary action per moment.
3. **Numbers are sacred.** Exact action + exact amount, always fully visible
   (two-line button labels on narrow screens), tabular figures.
4. **Readable after folding.** Folded seats dim their cards, never their name or
   stack.
5. **Motion answers the player.** One orchestrated reveal on the home page; in the
   room, motion only shows what changed (deal, chips to the winner, your turn).
   Everything respects `prefers-reduced-motion` and the Animations setting.

## 7. Review against the brief (what changed after the first pass)

- *First idea:* a split hero — headline left, illustration right. That is the
  default landing-page composition. **Changed to** text printed on the felt of a
  railed table, so the page literally opens at the table.
- *First idea:* game library as three equal cards with an image, title and
  button. That is the SaaS-card kit. **Changed to** a shelf of tuck boxes on a
  walnut plank; unfinished games are sealed and have no buttons.
- *Risk:* "dark brown + gold + serif" is the generic luxury template. Mitigations:
  evergreen (not brass) carries every primary action; brass is limited to
  hairlines; Fraunces is used with its soft axis at moderate weights instead of a
  sharp high-contrast display; no all-caps eyebrows, no dot-joined meta strings.
- *Risk:* a racetrack table with a pulsing gold ring on the active seat. **Changed
  to** a steady brass edge plus a short "light falls on your seat" transition; no
  infinite pulsing.

## 8. Components (presentation only)

`src/ui/components.ts` holds the reusable pieces: brand mark, buttons, status
badge, game tile (deck), notice/empty state, loading line. Sheets (`openSheet`)
cover dialogs, help, settings and history. The poker room shell (`TableScreen`)
is the template future game rooms follow: top bar, stage, log line, dock.

## 9. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--t-fast` | 140ms | Button press, toggles |
| `--t-med` | 240ms | Seat state, sheet open, chips |
| `--t-slow` | 420ms | Card deal/reveal, dealer button travel |

Easing: `--ease-out: cubic-bezier(.2,.7,.2,1)` — no overshoot or bounce.
`[data-motion='off']` (Animations setting or system reduced motion) removes all
animation and transition durations.
