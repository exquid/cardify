# CARDIFY — Poker Core QA Report (Stage 1)

Status: **Step B complete (reproduce and classify). Step C (fixes) awaits owner approval.**
Overall gate right now: **BLOCKED**, because one High defect is open (BUG-S1-01).
Updated: 2026-11-04 · Branch `claude/youthful-pascal-rmmfom` · Plan: [`cardify-stage-1-plan.md`](cardify-stage-1-plan.md)

Owner decisions in effect: D1 yes (engine fixes allowed in shared `src/game`, no push to `main` without review), D2 yes (`npm ci`), D3–D7 per the plan's recommendations.

---

## 1. Confirmed rules profile

No-Limit Texas Hold'em Sit & Go, integer chips, no antes, no rake. Material policies, confirmed by the owner (D4–D6) and pinned by tests:

| Topic | Policy | Pinned by |
| --- | --- | --- |
| Button | Moving button; eliminated seats skipped | existing `engine.test.ts`, `stage1-rules` fixture 2 |
| Heads-up | Button = SB, first preflop, last postflop | `stage1-rules` fixture 2 |
| Bet amounts | `amount` = raise-**to** street total; min bet 1 BB; min raise = last full increment | fixture 3, amount tests |
| Reopening | A player re-gains raising rights only once the bet has grown ≥ one full raise since their last action (cumulative short all-ins count) | fixtures 4, 5 |
| Short all-in **bet** below 1 BB (D5) | `minRaise` stays 1 BB → next minimum raise-to = all-in + 1 BB | `documents the short all-in bet policy (D5)` |
| Uncalled chips | Unmatched part of the top street bet returns to its owner; folded chips count as matched | fixtures 6, 8, fold ending |
| Odd chip | One at a time, clockwise from the first seat left of the button | ledger odd-chip fixture + generated-sequence oracle |
| Equal-stack simultaneous busts (D6) | Ordered by seat (no shared place) | documented only |

## 2. Baseline (Step B0, before any change)

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | Installed from lockfile; `package-lock.json` SHA-256 unchanged (`7ea9fdc5…e095b`) |
| `npm run typecheck` | 0 | clean (client + server) |
| `npm run lint` | 0 | clean |
| `npm test` | 0 | **93 / 93** passed, 9 files |
| `npx vite build` | 0 | built |
| Visual baseline | — | Solo start screen + table captured at iPhone 13 and 1280×800 (Playwright, reduced motion). Kept in the session scratchpad. |

Pre-existing failures: **none**.

## 3. Checks after Step B (new tests added, no production code changed)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | clean |
| `npx vitest run` | 0 | **136 passed + 1 expected fail** (`it.fails` = confirmed BUG-S1-03), 11 files |
| `npx vite build` | 0 | built |

New test files:
- `src/game/__tests__/stage1-rules.test.ts` — 42 tests: brief fixtures 1–11, the 7 evaluator fixtures plus wraparound, duplicate-rank, kicker chain and permutation checks, pot-ledger fixtures, dealing counts for 2–6 seats, new-hand reset, and immutability of every refused command.
- `src/game/__tests__/stage1-sequences.test.ts` — seeded generated play with invariants after every command and an **independent payout oracle** (own pot layering + brute-force evaluator + odd-chip rule):

| Run | Seeds | Tournaments | Hands | Showdowns (oracle-checked) | Multi-pot showdowns | Commands | Refusals verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Random legal play, 2–6 seats, mixed/short stacks | 1–150 | 150 | 1,329 | 782 | 205 | 13,377 | 64,881 |
| Bot-driven (`processBotTurn`) | 10001–10040 | 40 | 743 | 220 | 30 | 4,706 | 22,844 |

**Mutation check** (on a scratch copy, the repository untouched): three deliberate engine faults were injected, and each was caught by the new suites:

| Fault | Caught by |
| --- | --- |
| Odd chip given to the last winner | ledger odd-chip fixture **and** generated-sequence oracle |
| Short all-in always re-opens raising | fixture 4 |
| Uncalled excess never refunded | fixtures 6, 8 and fold ending |

## 4. Browser evidence (Step B3)

Run against `npx vite` (dev build) and the unmodified local table server (`npx tsx server/index.ts`). The scripts live in the session scratchpad; they can be added to the repository on request.

**Solo (P15/P16), 60 hero turns over 5 tournaments.** At every turn the saved `GameState` was read from `localStorage` and the real engine's `getLegalActions` was compared with the dock:
- Fold, Check/Call label and amount, Raise visibility and "from N", and All-in visibility matched every time.
- Double clicks, double key presses (`C C`), a double tap on the raise confirm, and the all-in arm+confirm each produced **exactly one** engine action, with the expected type and amount.
- Every enabled slider preset produced an integer amount inside `[min, max]` (25 sizer sessions).
- Lifecycle: **0** commits while the menu was open (2.5 s, bot to act) and **0** after leaving the table; Continue resumed correctly; **5** restarts during a pending bot timer each began at seq 1 / hand 1 with no seq gaps.
- No page errors.

**Online (S-01 reproduction).** Playwright proxied the WebSocket and dropped it once at the hero's turn. See BUG-S1-01.

## 5. Defect register

| Bug ID | Severity | Status | Area |
| --- | --- | --- | --- |
| **BUG-S1-01** | **High** | Confirmed, open | Action controls (`src/ui/controls.ts`, `tableScreen.ts`, `online.ts`) |
| BUG-S1-02 | Low | Confirmed, open | Online status line (`src/ui/online.ts`) |
| BUG-S1-03 | Low | Confirmed (`it.fails`), open | Deck validation (`src/game/engine.ts`) |

### BUG-S1-01 — action controls stay dead after an undelivered or refused tap (High)
- **Reproduction (online, confirmed):** heads-up vs a bot, local server. At the hero's turn the socket drops; the hero taps Call → feed shows "Not connected — your tap was not sent." The client reconnects about 0.3 s later and receives the **same** state (`seq=3`). The dock shows "Your turn: 30 to call, 27s left" with enabled-looking buttons. **3 clicks and the `C` key sent 0 messages.** About 26 s later the server's turn clock auto-folded the hero ("Orion wins 40").
- **Expected:** after a refused or undelivered tap, the controls accept a new tap for the same decision.
- **Root cause:** `Controls.locked` (set on every tap, `controls.ts:234-240`) is cleared only when a view with a **different** `seq` arrives (`controls.ts:138`). Three paths keep the seq unchanged: a refused action → `TableScreen.rerender()` (`tableScreen.ts:161`, called from `app.ts:366` and `online.ts:280`); an undelivered tap (`online.ts:221`); a reconnect snapshot of the same state.
- **Severity rationale:** the engine stays protected, but the player loses agency and the hand (forced auto-fold/check), and it happens on ordinary mobile connection blips. In solo the same root cause would **deadlock** the hand (no timer runs on the hero's turn), but no natural trigger exists in solo (60 UI turns plus code review found no reachable refused action).
- **Proposed fix (Step C, client UI only, no styling or geometry change):** release the lock when the driver re-renders after a refusal and when a tap could not be delivered (including the same-seq reconnect snapshot). The double-tap guard stays: a second tap before the authority answers is still blocked, and the engine/server `seq` check rejects any duplicate that slips through.
- **Regression plan:** a Playwright scenario (drop, tap, reconnect, tap → exactly one `act` delivered and accepted), plus the solo refusal path (a refused command followed by a legal one must be accepted).

### BUG-S1-02 — stale "Connection lost — reconnecting…" after a successful reconnect (Low)
- Seen in the same run: the feed still shows the reconnecting message after the socket is back and the state was re-sent. Misleading, but harmless on its own. The proposed fix is to replace the line once the connection is open again, as a text change only. **Owner may defer.**

### BUG-S1-03 — a short or invalid injected deck is accepted and fails mid-hand (Low)
- `startNextHand(state, { deck })` checks duplicates only. A 10-card deck starts a 4-player hand and later throws a plain `Error('Deck exhausted')`, not an `IllegalActionError`. Regression: `stage1-rules.test.ts` → `it.fails('BUG-S1-03 …')`.
- Production impact: none today. The `deck` option is used only by tests and replays, and production always shuffles a full deck. It matters for future replays and multiplayer fixtures.
- Proposed fix: validate a full 52-card set of valid cards before any state change.

### Investigated, not reproducible / not defects
| ID | Finding | Evidence |
| --- | --- | --- |
| S-02 | Fractional slider stop when BB is odd | `DEFAULT_CONFIG` first reaches an odd BB at level 15 (2530/5065). A fractional stop would need > 2.5 BB in play, more than the 8,000 (solo) or 12,000 (online) chips that exist. **Unreachable with the shipped config**; latent only. |
| S-04 | A throwing scheduled step freezes the table silently (solo `app.ts`; server `room.ts` logs but does not reschedule) | No trigger in 2,072 generated hands (743 bot-driven) or 60 UI turns. Robustness risk only. The server part is backend → recorded, not changed. |
| S-05/S-06/S-07 | House-policy questions | Resolved by D4–D6; S-05 is pinned by a test. |

## 6. P01–P17 matrix (after Step B, before fixes)

| ID | Status | Evidence | Bug |
| --- | --- | --- | --- |
| P01 Setup/dealing | **FAIL (Low)** | 2–6 seat counts and card uniqueness pass; duplicate deck refused; short/invalid deck not refused | BUG-S1-03 |
| P02 Button/blinds | PASS | fixture 2 (HU over consecutive hands), short SB/BB, existing rotation/skip/3→HU tests | — |
| P03 Action order | PASS | fixture 1 (BB option), multiway skipping, HU order | — |
| P04 Legal actions | PASS | fixture 9/9b/10/11 + 87,725 refusals with unchanged state | — |
| P05 Amounts | PASS | NaN/∞/negative/0/fractional/string/min−1/max+1/1e20 refused; exact min/max accepted; raise-to fixture 3 | — |
| P06 Reopening | PASS | fixtures 4 and 5 per player; D5 policy pinned; mutation caught | — |
| P07 Street closure | PASS | BB option, single transition, no re-deal; seq +1 per command in generated play | — |
| P08 Run-out | PASS | fixture 7: no run-out while a decision is pending; burn+deal counts exact; nothing after completion | — |
| P09 Fold ending | PASS | uncalled refund, single award, no reveal | — |
| P10 Evaluation | PASS | 7 brief fixtures + extras; existing 3,000-hand brute-force cross-check; 1,002 oracle showdowns | — |
| P11 Pot construction | PASS | ledger fixtures (2/3 layers, folded, refund); oracle on 235 multi-pot showdowns | — |
| P12 Settlement | PASS | odd chip 8/7, tied side pot + single-winner main pot, settle-twice refused, oracle agreement | — |
| P13 Invariants | PASS | 18,083 commands with chip/negativity/card/actor/legal-agreement invariants | — |
| P14 New hand | PASS | full per-hand reset with stacks kept | — |
| P15 UI integration | **FAIL (High)** | solo: dock = engine legality on 60 turns, single action per rapid tap; **online: controls dead after a reconnect** | BUG-S1-01 |
| P16 Async lifecycle | PASS | solo pause/leave/continue/5 restarts inert; server timers covered by existing room tests | — |
| P17 Network boundary | PASS (read-only) | existing room/server tests (card isolation, stale seq, resume) green; reconnect exercised; client-side defect is BUG-S1-01; server freeze risk S-04 recorded | — |

## 7. Next — Step C (awaiting approval)

1. **BUG-S1-01**: failing regression first (Playwright drop/reconnect plus the solo refusal path), then the smallest change in `controls.ts` / `tableScreen.ts` / `online.ts`. No styling.
2. **BUG-S1-03**: flip `it.fails` to `it`, add 52-card validation in `startNextHand`.
3. **BUG-S1-02** (optional, owner choice): replace the stale reconnect line.
4. Final verification: `npm run check`, generated sequences, the brief's manual smoke scenarios, before/after screenshots at the same viewports, then complete this report and stop.

Limitations: local Stage 1 PASS will not prove multiplayer readiness or production security. Seeded QA shuffles do not say anything about production RNG quality.
