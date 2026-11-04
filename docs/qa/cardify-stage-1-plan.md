# CARDIFY — Stage 1 (Poker Core QA) Plan

Status: **Stage 1 complete (Steps A–C). Gate: PASS (local).** Results: [`cardify-poker-core-qa.md`](cardify-poker-core-qa.md).
Prepared: 2026-11-03 · Branch: `claude/youthful-pascal-rmmfom` · Base commit: `98c0241` (Walnut Club redesign)
Source brief: `CARDIFY_Post_Redesign_Roadmap_Claude_Code.md` (Stage 1, Section 4 Step A)

Nothing in this step changed production code, tests, configuration or dependencies.
"Suspected" items below come from code reading only. None has been reproduced yet; Step B reproduces them.

---

## 1. Discovered stack

| Item | Evidence |
| --- | --- |
| Language / build | TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vite 8, vanilla DOM UI (no framework) — `package.json`, `tsconfig.json` |
| Tests | Vitest 5, `environment: 'node'`, files `src/**/*.test.ts`, `server/**/*.test.ts` — `vite.config.ts`. **No DOM test environment** (no jsdom/happy-dom). |
| Lint | ESLint 9 flat config + typescript-eslint — `eslint.config.js` |
| Package manager | npm (lockfile v3, `package-lock.json`); Node ≥ 20.19, CI uses 22 |
| Commands | `npm test`, `npm run typecheck` (client + server tsconfig), `npm run lint`, `npm run build` (typecheck + vite build), `npm run check` (all four) |
| CI | `.github/workflows/ci.yml`: `npm ci → typecheck → lint → test → vite build` on push to `main` and PRs |
| Deploy surfaces (do not touch) | Vercel (`vercel.json`), Netlify (`netlify.toml`), GitHub Pages (`deploy-pages.yml`, manual), Render table server (`render.yaml`, **`autoDeploy: true`**), `.env.production` |
| Agent guidance files | No `AGENTS.md` / `CLAUDE.md`. `README.md` (Russian) is the main architecture and rules reference; `docs/DESIGN.md` is the Walnut Club design system. |

## 2. Poker variant and architecture

- **Variant (confirmed from repository):** No-Limit Texas Hold'em, **Sit & Go tournament**. Solo is 1 human vs 3 bots (4 seats); online private tables seat 2–6 (`MIN_PLAYERS`/`MAX_SEATS` in `src/net/protocol.ts`). Integer chips, starting stack 2000, blind schedule in `src/game/config.ts`, no antes, no straddle, no rake.
- **Engine:** a pure functional state machine. Every command is `GameState → GameState` on a `structuredClone`, and `state.seq` increments once per accepted command. `hand.pending ∈ action | deal | showdown | complete`.

| Concern | Location |
| --- | --- |
| State shape | `src/game/types.ts` (`GameState`, `HandState`, `Player`, `LegalActions`) |
| Legal actions (single source of truth) | `src/game/rules.ts` → `computeLegalActions` |
| Action acceptance | `src/game/engine.ts` → `applyPlayerAction` (+ `raiseTo`, `commitChips`) |
| Turn order / street closure | `engine.ts` → `settle`, `bettingRoundComplete`; `rules.ts` → `needsToAct`, `nextPlayer` |
| Button / blinds | `rules.ts` → `blindPositions`; `engine.ts` → `startNextHand`, `postBlind` |
| Deck / shuffle | `src/game/deck.ts` (Fisher–Yates on `crypto.getRandomValues` with rejection sampling; seeded mulberry32 for tests) |
| Evaluator | `src/game/evaluator.ts` (single-pass 5–7 cards; brute-force reference for tests) |
| Pots / settlement | `src/game/pots.ts` (`buildPots`, `splitPot`); `engine.ts` → `refundUncalled`, `resolveShowdown`, `awardUncontested`, `finishHand` |
| Eliminations / tournament end | `engine.ts` → `recordEliminations` |
| Private views | `src/game/views.ts` (`getPlayerView` — no deck, no foreign hole cards before showdown) |
| Bots | `src/bots/*` (observation built from the bot's own view; output mapped onto `LegalActions`) |
| Solo driver (state owner, timers) | `src/ui/app.ts` (`schedule`/`later` guarded by `seq`) |
| Action controls | `src/ui/controls.ts`; screen glue `src/ui/tableScreen.ts` |
| Online driver | `src/ui/online.ts`, `src/net/client.ts`, `src/net/protocol.ts` |
| Server authority | `server/room.ts` (owns the `GameState`, timers, bots), `server/server.ts` (sockets, limits) |

### End-to-end action trace (solo)
Button click → `Controls.send()` sets `locked = true` and calls `onAction(action, seq)` → `App.onHumanAction` checks `state.seq === seq` → `applyPlayerAction(state, 'you', action, seq)` (validates against `computeLegalActions`, mutates the clone, then `settle()`, `seq++`) → `App.commit()` → persist to `localStorage` → `TableScreen.render(getPlayerView(...))` → `App.schedule()` plans one `seq`-guarded timer for the bot move, deal or showdown.
**Owner of the result in solo:** the local engine in the browser (documented as not cheat-proof).

### Online trace
`Controls` → `OnlineController.send({t:'act', action, seq})` → `server/server.ts` → `Room.act()` checks `seq` and calls the **same** `applyPlayerAction` → `Room.schedule()` → per-player `getPlayerView` broadcast.
**Owner of the result online:** the server.

### ⚠️ Authority boundary — needs an owner decision (D1)
`server/room.ts` imports `src/game/*` and `src/bots/*` directly. One engine serves both modes. **Any fix to `src/game` also changes the authoritative online logic the next time the Render service deploys** (`autoDeploy: true`). The brief forbids editing server-hosted poker logic, but this logic is shared, client-side code. See §8, D1.

## 3. Rules profile (from README "Правила и принятые решения" + code)

| Topic | Implemented behaviour | Evidence | Status |
| --- | --- | --- | --- |
| Button | Moving button; skips eliminated seats; no dead button | `startNextHand`, `blindPositions` | Documented policy — confirm (D4) |
| Heads-up | Button = SB, acts first preflop and last postflop | `blindPositions`, `settle(fromSeat)` | Matches standard |
| Min bet / raise | Bet ≥ 1 BB; raise ≥ last full increment; `amount` = **raise-to** street total | `computeLegalActions`, `PlayerAction` docs | Matches standard |
| Short all-in reopening | Reopens for a player only if `currentBet − actedAtLevel ≥ minRaise` (cumulative) | `rules.ts:99-101` | Matches the brief's fixtures 4 and 5 on paper; verify in Step B |
| Short all-in **bet** below 1 BB | `minRaise` stays BB, so the next minimum raise is all-in + BB | `raiseTo` | Policy ambiguity (D5) |
| BB all-in for less | Others still owe the full BB; the unmatched excess is refunded | `startNextHand` (`currentBet = bigBlind`), `refundUncalled` | Documented |
| Uncalled bets | Refunded at the end of each street (folded bets count as matched) | `refundUncalled` | Verify in Step B (fixture 8) |
| Side pots | Layered by contribution; folded chips feed pots but are ineligible | `buildPots` | Verify against the brief's ledger fixtures |
| Odd chip | One chip at a time, clockwise from the first seat left of the button | `splitPot` + `order` in `resolveShowdown` | Documented policy — confirm (D4) |
| Showdown | Everyone remaining shows (no mucking) | `resolveShowdown` | Documented simplification |
| Bust ordering | Several busts in one hand: the bigger starting stack places higher; equal stacks are ordered by array position | `recordEliminations` | Tie case undocumented (D6) |

## 4. Baseline checks (actual runs, Step A)

`node_modules` is **absent** and installing dependencies was out of scope, so no `npm` script could run. Substitutes were used, and every one stayed outside the repository:

| Check | Command / method | Result |
| --- | --- | --- |
| Working tree | `git status` | Clean at `98c0241` before Step A |
| Unit tests (indicative) | Node 22.23 built-in TS transform + a **minimal vitest-compatible shim and import resolver kept in the session scratchpad**. This is not real Vitest. | **89 passed / 0 failed** across 8 files (deck 6, evaluator 32, pots 8, engine 21, bots 6, protocol 3, session 2, room 11) |
| `server/__tests__/server.test.ts` | same | **NOT RUN**: the `ws` package is not installed (4 tests) |
| Typecheck (partial) | global `tsc 6.0.2` (repo pins 6.0.3), `types: []`, client `src/**` without tests | Only environmental errors: missing `vite/client` types (`import.meta.env` in `src/net/client.ts`), CSS and font side-effect imports in `src/main.ts`. **No errors in `src/game`, `src/bots`, `src/ui`, `src/storage`.** |
| Server typecheck | — | NOT RUN (`@types/node`, `@types/ws` missing) |
| Lint | — | NOT RUN (`@eslint/js`, `typescript-eslint`, `globals` missing; global eslint is v10 vs pinned 9) |
| Build | — | NOT RUN (vite missing) |
| Browser / visual baseline | — | NOT RUN (no dev server without vite; Chromium + Playwright exist globally) |

> The shim results are evidence that the suite is green, **not** an official baseline. The real baseline is `npm ci && npm run check`, which needs approval (D2).

## 5. P01–P17 pre-assessment (coverage before Step B)

Legend: **Covered** = an existing test exercises it · **Partial** · **Gap** · status values come in Step B/C.

| ID | Existing evidence | Gap to close in Stage 1 |
| --- | --- | --- |
| P01 Setup/dealing | deck tests; `assertValidDeck` (duplicates only) | Exact hole/board counts per player count 2–6; deck of the wrong size or malformed fails safely (S-03) |
| P02 Button/blinds | rotation, skip eliminated, 3→HU switch | Short-stack SB/BB posting; HU transition over consecutive hands under the moving-button policy |
| P03 Action order | 4/3/2-player order tests | BB unraised option (fixture 1) asserted explicitly; folded/all-in skipping multiway |
| P04 Legal actions | check-vs-bet, out-of-turn, wrong bet type, stale seq | Unknown action type; stale *hand* (seq from previous hand); assert unchanged state after every rejection |
| P05 Amounts | min raise, stack cap, partial call | Negative, NaN, Infinity, fractional, string amounts; raise-to vs raise-by fixture 3; boundary `min−1`, `max+1` |
| P06 Reopening | short all-in and cumulative tests | Brief fixtures 4 and 5 verbatim, per player, including a player yet to act; short **bet** below BB (D5) |
| P07 Street closure | indirectly | Equal contributions without required action (BB option, checks around); transition exactly once |
| P08 Runout | everyone all-in run-out | Fixture 7: one actionable player still facing a call → no premature run-out; no duplicate dealing; deck monotonic |
| P09 Fold ending | uncontested award | Uncalled excess plus fold ending (fixture 8), no double award |
| P10 Evaluation | strong suite + 3,000-hand brute-force cross-check | The brief's 7 evaluator fixtures, invalid ace wraparound (Q-K-A-2-3), permutation invariance |
| P11 Pot construction | multi side pots, folded contributors | Brief ledger fixtures (two layers, folded, three layers 160/180/200, refund 120/160) |
| P12 Settlement | split and odd chip | Odd chip 15 → 8/7 per policy; one pot tied while another has one winner; strongest hand ineligible for a side pot; settle-twice rejected |
| P13 Invariants | 40 random tournaments, chip conservation | ≥ 100 seeded hand sequences, 2–6 players and mixed stacks; invariants after **every accepted and rejected** action (no duplicate cards, legal actor, legal/accept agreement) |
| P14 New hand | implicit | Assert reset of `streetBet`, `contribution`, `actedAtLevel`, `revealed`, `result`, `lastAggressorId`; stacks kept |
| P15 UI integration | **none** (no DOM test env) | Controls lock/unlock, legal ↔ button visibility, slider amounts are integers within `[min,max]`, a rapid double tap cannot consume two turns (S-01, S-02) |
| P16 Async lifecycle | room tests on fake clocks (server side) | Solo `App.schedule` stale timers inert after leave/restart; throwing step does not freeze silently (S-04) |
| P17 Network boundary | room/server tests (card isolation, stale seq) | Read-only review plus rerunning the existing room/server tests; record server-side findings only (S-04b) |

## 6. Suspected risks (unconfirmed — to reproduce in Step B)

| ID | Area | Suspicion (from code) | Likely severity if confirmed |
| --- | --- | --- | --- |
| **S-01** | `src/ui/controls.ts:65,138,234-240`; `tableScreen.ts:161`; `app.ts:358-368`; `online.ts:221,279-280` | `Controls.locked` is released **only when `view.seq` changes**. After a refused action (solo `IllegalActionError` → `rerender()` with the same seq), a refused online action (`illegal-action` → `rerender()`), a tap that never left the client (`Not connected…`), or a same-seq snapshot after a reconnect, all action buttons stay dead. **Solo:** no timer is pending on the human's turn → the hand can deadlock. **Online:** dead until the 30 s server auto-check/fold. | High (deadlocked hand) if a refused UI action is reachable; otherwise Medium |
| S-02 | `controls.ts:310-343` | The slider snap step is `bigBlind / 2`; blind growth past the table can produce an odd BB (e.g. level 15 → 2530/5065), giving fractional amounts → engine refuses → triggers S-01. Very late game, possibly unreachable. | Low → Medium via S-01 |
| S-03 | `engine.ts:376-388` | `assertValidDeck` checks duplicates only. A short injected deck throws a plain `Error('Deck exhausted')` mid-hand. Only reachable through the test/replay `deck` option. | Low |
| S-04 | `app.ts:290-298` (solo); `server/room.ts:369-383` (server, read-only) | A throwing scheduled step (bot/advance) is uncaught in solo → silent freeze. The server catches and logs but **does not reschedule** → the room freezes. | Medium (no known trigger yet) |
| S-05 | `engine.ts:407-420` | Short all-in bet below 1 BB: next minimum raise = all-in + BB (not "complete to BB, then raise"). Policy question, not necessarily a bug. | Decision (D5) |
| S-06 | `rules.ts:49-59` | The moving button lets a player skip a blind around eliminations. Documented. | Decision (D4) |
| S-07 | `engine.ts:555-567` | Equal starting stacks busting in the same hand get places by array order (seat), not a shared place. | Low / decision (D6) |
| S-08 | README | Doc drift: README says "92 tests in 9 files"; the files contain 89 (it.each expanded) + 4 = 93. | Cosmetic |

Things that look right on paper (to confirm by fixtures, not assumed): BB option; heads-up order; short-call arithmetic (fixture 6); uncalled-excess refund; folded dead money; layered side pots; `seq` stale-command rejection; input immutability; view privacy (no deck, no foreign cards).

## 7. Ordered execution plan (Steps B → C)

Each block is a separate review checkpoint.

**B0 — Real baseline (needs D2).** `npm ci` (lockfile-faithful, no lockfile changes) → `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Record pre-existing failures separately. Capture the solo table with Playwright at iPhone 13 + desktop using the existing app (no debug menus).

**B1 — Engine rules fixtures** (new file `src/game/__tests__/stage1-rules.test.ts`, reusing `helpers.ts`): betting fixtures 1–9 from the brief, the 7 evaluator fixtures, the ledger fixtures, and rejected-action immutability (deep-equal before/after, including deck, turn and seq). Independent oracles: hand-computed expected values, never re-running the algorithm.

**B2 — Generated sequences**: a seeded loop (`createSeededRng`), ≥ 100 hands across 2–6 players and mixed/short stacks, checking after every command: chip conservation, no negative values, 52 unique cards (hole + board + deck + burned), the actor is `active` with `needsToAct`, legal ↔ accept agreement (every advertised action accepted, a sample of non-advertised ones refused), one-way deck consumption and single settlement. Report seed and count.

**B3 — UI/async reproduction**: reproduce S-01 through Playwright on the running dev build (preferred: no new dependency) or a minimal DOM shim; reproduce S-04 with an injected throwing step in a test only.

**B4 — Classify**: assign bug IDs (`BUG-S1-xx`), severity, root cause; write failing regressions first.

**C1 — Fixes, smallest first, one root cause per change**, e.g. for S-01: release `locked` when an action is refused or a same-seq view is re-applied (behaviour-only change in `controls.ts`/`tableScreen.ts`, no styling or geometry). Engine fixes only after D1.

**C2 — Final verification**: full `npm run check`, generated sequences, manual smoke scenarios from the brief §8, before/after screenshots at the same viewport, the QA report `docs/qa/cardify-poker-core-qa.md`, then stop.

### Verification commands (once D2 is approved)
```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## 8. Owner decisions required

| ID | Decision | Recommendation |
| --- | --- | --- |
| **D1** | `src/game` is shared by solo and the online server. May Stage 1 fix engine defects there, knowing the next Render deploy carries them online? | **Yes, with a guard:** engine fixes allowed only with regressions, and **no push to `main`** until you review (Render and Vercel deploy from Git). `server/**` stays untouched. |
| **D2** | Allow `npm ci` (exact lockfile, no upgrades, no lockfile churn) for the real baseline, the build and the dev server for smoke tests. | **Yes** — without it no official check, lint, build or browser smoke can run, and the gate cannot pass. |
| D3 | For P15 UI tests: Playwright against the dev server (already in the environment, not added to the repo) vs. adding a DOM test dependency. | Playwright, run from the scratchpad; **no new repo dependency**. |
| D4 | Confirm the moving-button and odd-chip (clockwise from left of the button) policies as the official house rules. | Keep both (documented, common in casual online play). |
| D5 | Short all-in **bet** below 1 BB: keep "next minimum raise = all-in + BB", or adopt "next player may complete to 1 BB, minimum raise = 2 BB". | Keep the current rule; just pin it with a test and document it. |
| D6 | Equal-stack simultaneous busts: keep seat order, or share the place. | Keep for now (virtual chips); document. |
| D7 | Git policy for this stage: commit locally only, or push the feature branch (a Vercel preview build may trigger). | Commit on the feature branch; push only with your explicit go-ahead. |
