# CARDIFY — Poker Core QA Report (Stage 1)

Status: **Stage 1 complete. Gate: PASS (local)** — see §8 for scope and limitations.
Updated: 2026-11-04 · Branch `claude/youthful-pascal-rmmfom` · Base `98c0241` (Walnut Club redesign) · Plan: [`cardify-stage-1-plan.md`](cardify-stage-1-plan.md)

Owner decisions in effect: D1 yes (engine fixes allowed in shared `src/game`; no push to `main` without review), D2 yes (`npm ci`), D3 Playwright outside the dependency list, D4–D6 keep the documented house rules, D7 feature-branch pushes only. The owner asked to fix every confirmed defect and to keep the browser scripts in the repository.

---

## 1. Outcome

The local poker core is demonstrably coherent under the confirmed rules: legal actions, deterministic transitions, correct winners and payouts, and conserved chips. All four confirmed defects are fixed with regressions. The Walnut Club appearance is pixel-identical to the base commit at both checked viewports.

## 2. Discovered implementation and confirmed rules

No-Limit Texas Hold'em Sit & Go. Solo is 4 seats (1 human + 3 bots); online is 2–6 seats. Integer chips, no antes, no rake. A pure engine in `src/game` is shared by the solo client and the authoritative online server (`server/room.ts`). Architecture details are in the plan.

| Topic | Policy | Pinned by |
| --- | --- | --- |
| Button | Moving button; eliminated seats skipped | `engine.test.ts`, `stage1-rules` fixture 2 |
| Heads-up | Button = SB, first preflop, last postflop | fixture 2 |
| Bet amounts | `amount` = raise-**to** street total; min bet 1 BB; min raise = last full increment | fixture 3, amount tests |
| Reopening | Raising rights return only after the bet grew ≥ one full raise since the player's last action (cumulative short all-ins count) | fixtures 4, 5 |
| Short all-in **bet** below 1 BB (D5) | `minRaise` stays 1 BB → next minimum raise-to = all-in + 1 BB | `documents the short all-in bet policy (D5)` |
| Uncalled chips | Unmatched part of the top street bet returns to its owner; folded chips count as matched | fixtures 6, 8, fold ending |
| Odd chip | One at a time, clockwise from the first seat left of the button | ledger fixture + generated-sequence oracle |
| Equal-stack simultaneous busts (D6) | Ordered by seat (no shared place) | documented |
| Deck | A hand is dealt only from a complete, valid 52-card deck (new, BUG-S1-03) | `BUG-S1-03` test |

## 3. Defect register and fixes

| Bug ID | Severity | Status | Changed files |
| --- | --- | --- | --- |
| **BUG-S1-01** | **High** | **Fixed** | `src/ui/controls.ts`, `src/ui/tableScreen.ts`, `src/ui/online.ts` |
| BUG-S1-02 | Low | Fixed | `src/ui/online.ts` |
| BUG-S1-03 | Low | Fixed | `src/game/engine.ts` |
| BUG-S1-04 | Low (latent) | Fixed | `src/ui/controls.ts` |

### BUG-S1-01 — action controls stayed dead after an undelivered or refused tap (High)
- **Symptom (reproduced before the fix):** online, the socket dropped at the hero's turn and a tap was reported "not sent". After the automatic reconnect the same decision came back (same `seq`) with enabled-looking buttons, but **3 clicks and the `C` key sent 0 messages**. About 26–30 s later the server auto-folded the hero. A refused action (server `illegal-action`) and, in solo, a refused engine command left the dock dead the same way. In solo that is a **deadlocked hand**, shown with a 10/25 saved game: "Not allowed: Bet amount must be a whole number of chips", then Call did nothing.
- **Root cause:** `Controls.locked` was cleared only when a view with a different `seq` arrived. A refusal, an undelivered tap and a reconnect snapshot all keep the same `seq`.
- **Fix:** `Controls.release()`. `TableScreen.rerender()`, the re-render after a refusal in solo and online, now releases the lock. `OnlineController.send()` re-renders when a tap could not be sent, and the `welcome` after a (re)connect re-renders too. The double-tap guard is unchanged, and any duplicate that slips through is still rejected by the engine/server `seq` check.
- **Regression:** `docs/qa/browser/regress-bug-s1-01.mts` — before: 6 failed / 4 passed; after: **10 passed / 0 failed** (control double tap still delivered once; tap after reconnect delivered and accepted in ~10 ms; tap after a server refusal delivered and accepted; solo odd-BB raise accepted). `solo-ui.mts` re-run after the fix: 60 turns, 0 findings.

### BUG-S1-02 — stale "Connection lost — reconnecting…" after a successful reconnect (Low)
- **Fix:** when the connection returns from `reconnecting` to `open` in a game, the feed says "Reconnected." This is a text change only, with no styling or layout change.
- **Regression:** `regress-bug-s1-01.mts`. Before: the feed still said "reconnecting"; after: "Reconnected.".

### BUG-S1-03 — a short or invalid injected deck was accepted and failed mid-hand (Low)
- **Fix:** `assertValidDeck` requires exactly 52 valid, unique cards before anything is dealt. The input state stays untouched.
- **Regression:** `stage1-rules.test.ts` → `BUG-S1-03` (previously `it.fails`, now a normal test): 10-card, 53-card and invalid-card decks are refused, the input is unchanged, and a full deck deals.
- **Online note:** this engine change also reaches the server on the next deploy (D1). The server always shuffles a full deck, so behaviour is unchanged there.

### BUG-S1-04 — fractional slider amount with an odd big blind (Low, latent)
- **Symptom:** the slider snapped to `BB / 2`, so with an odd BB it could offer e.g. 62.5 → refused. `s02-reachability.mts` shows this is **unreachable with the shipped blind table** (the first odd BB is 5065 at level 15; a fractional stop would need > 2.5 BB in play, more chips than any table holds). It is reproducible with a 10/25 saved game.
- **Fix:** whole-chip snap step `Math.max(1, Math.floor(BB / 2))`. Identical for every even BB, i.e. every level that can actually be played.
- **Regression:** `regress-bug-s1-01.mts` part C — before: slider showed 62.5 and was refused; after: 60, accepted.

### Investigated, not defects / not reproducible
| ID | Finding | Disposition |
| --- | --- | --- |
| S-04 | A throwing scheduled step would freeze the table silently (solo `app.ts`; the server's `room.ts` logs but does not reschedule) | No trigger in 2,072 generated hands (743 bot-driven) or 120 UI turns. Robustness risk only; the server part is backend and recorded for Stage 2. |
| S-05/S-06/S-07 | House-policy questions | Resolved by D4–D6; S-05 pinned by a test. |
| S-08 | README says "92 tests in 9 files" | Doc drift (now 137 tests in 11 files); left for the owner. |

## 4. Verification

### Commands (final state)
| Command | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | from lockfile; `package-lock.json` SHA-256 unchanged (`7ea9fdc5…e095b`) |
| `npm run check` (typecheck → lint → test → build) | 0 | typecheck clean · lint clean · **137 / 137 tests, 11 files** · build OK |

Baseline before any change (B0): typecheck, lint, 93/93 tests and the build all passed; there were **no** pre-existing failures.

### Generated sequences (`stage1-sequences.test.ts`, part of `npm test`)
| Run | Seeds | Hands | Oracle-checked showdowns | Multi-pot | Commands | Refusals verified |
| --- | --- | --- | --- | --- | --- | --- |
| Random legal play, 2–6 seats, mixed/short stacks | 1–150 | 1,329 | 782 | 205 | 13,377 | 64,881 |
| Bot-driven | 10001–10040 | 743 | 220 | 30 | 4,706 | 22,844 |

Mutation check (on a scratch copy): an odd-chip fault, an always-reopen fault and a no-refund fault were each caught by the new suites.

### Browser checks (Chromium via Playwright, scripts in `docs/qa/browser/`)
| Check | Result |
| --- | --- |
| `regress-bug-s1-01.mts` | 10 / 10 PASS (6 failed before the fixes) |
| `solo-ui.mts 60` (before and after the fixes) | 0 findings both times: dock = engine legality, one action per rapid tap, legal integer slider amounts, inert pause/leave/continue/restart |
| Visual preservation: `shots.mts --fixed` + `compare.mts`, production builds of `98c0241` vs. this branch | **0 differing pixels** in all 4 images (start + table × iPhone 13 + 1280×800) |

### Manual smoke scenarios (brief §8), how they were covered
| Scenario | Evidence |
| --- | --- |
| Multiway hand to the river and the next hand | `solo-ui.mts` (4-seat tournaments, auto next hand), engine 2–6 seat tests |
| Heads-up preflop and postflop | `regress-bug-s1-01.mts` (online heads-up), fixture 2 |
| Fold ending, payout, unmatched chips returned | fold-ending test, fixture 8, `solo-ui.mts` folds |
| All-in run-out, side pots, tie | fixtures 7/8, independent pot settlement, 235 oracle multi-pot showdowns; all-ins played in the UI |
| Boundary amounts and rapid activation | amount tests; slider presets and double taps in `solo-ui.mts` |
| Restart/navigate with pending bot work | `solo-ui.mts` lifecycle |
| Before/after appearance | pixel comparison above |

## 5. P01–P17 matrix (final)

| ID | Status | Evidence | Bug |
| --- | --- | --- | --- |
| P01 Setup/dealing | PASS | 2–6 seat counts, 52 distinct cards; duplicate, short, long and invalid decks refused before dealing | BUG-S1-03 fixed |
| P02 Button/blinds | PASS | fixture 2 over consecutive hands, short SB/BB, rotation/skip/3→HU | — |
| P03 Action order | PASS | BB option (fixture 1), multiway skipping, HU order | — |
| P04 Legal actions | PASS | fixtures 9/9b/10/11 + 87,725 refusals with unchanged state | — |
| P05 Amounts | PASS | NaN/∞/negative/0/fractional/string/min−1/max+1/1e20 refused; exact min/max accepted; raise-to fixture 3; whole-chip slider | BUG-S1-04 fixed |
| P06 Reopening | PASS | fixtures 4 and 5 per player; D5 pinned; mutation caught | — |
| P07 Street closure | PASS | BB option, single transition, no re-deal; seq +1 per command | — |
| P08 Run-out | PASS | fixture 7: no run-out while a decision is pending; exact burn/deal counts; nothing after completion | — |
| P09 Fold ending | PASS | uncalled refund, single award, no reveal | — |
| P10 Evaluation | PASS | brief fixtures + extras; 3,000-hand brute-force cross-check; 1,002 oracle showdowns | — |
| P11 Pot construction | PASS | ledger fixtures; oracle on 235 multi-pot showdowns | — |
| P12 Settlement | PASS | odd chip 8/7, tied side pot + single-winner main pot, settle-twice refused | — |
| P13 Invariants | PASS | 18,083 commands checked for chips, negatives, cards, actor, legal agreement | — |
| P14 New hand | PASS | full per-hand reset, stacks kept | — |
| P15 UI integration | PASS | dock = engine legality (120 hero turns), one action per rapid tap, recovery after undelivered/refused taps | BUG-S1-01, -02 fixed |
| P16 Async lifecycle | PASS | solo pause/leave/continue/restarts inert; server timers covered by existing room tests | — |
| P17 Network boundary | PASS (read-only) | room/server tests (card isolation, stale seq, resume) green; reconnect and refusal exercised against the unmodified local server | S-04 server part recorded |

## 6. Scope audit

- **Production diff:** 4 files, about 30 lines: `src/game/engine.ts` (deck validation), `src/ui/controls.ts` (`release()`, whole-chip step), `src/ui/tableScreen.ts` (release on re-render), `src/ui/online.ts` (re-render on an undelivered tap and on `welcome`, "Reconnected." line).
- **Unchanged:** `server/**`, `src/styles/**`, `public/**`, `index.html`, `package.json`, `package-lock.json`, deployment and CI configuration, `.env.production`.
- **Visual:** pixel-identical at the checked viewports. No layout, colour, typography, spacing, artwork or animation changes.
- **No new dependencies.** Playwright is used from the environment and documented in `docs/qa/browser/README.md`.
- **Git:** commits on `claude/youthful-pascal-rmmfom` only; nothing pushed to `main`.

## 7. Added tests and tools

- `src/game/__tests__/stage1-rules.test.ts` — 42 rule, evaluator, ledger and dealing tests.
- `src/game/__tests__/stage1-sequences.test.ts` — seeded generated play with an independent payout oracle.
- `docs/qa/browser/` — Playwright regression, UI, screenshot and pixel-compare scripts with a README. Not in CI: they need running servers.

## 8. Gate decision and limitations

**Gate: PASS (local Stage 1).** Every P01–P17 row has evidence. No critical or high defect is open, each fixed defect has a regression, the full check passes, and the appearance is preserved.

Limitations, stated explicitly:
- Browser checks ran in Chromium (desktop and iPhone 13 emulation). **Physical iPhone Safari was not checked.** A 5-minute real-device pass is recommended before release.
- A local PASS is **not** proof of multiplayer readiness or production security. The online run used one human and bots on a local server.
- Seeded QA shuffles say nothing about production RNG quality, which uses `crypto.getRandomValues` and was reviewed, not statistically re-tested here.
- The browser regressions are manual-run tools, not CI gates.

## 9. Recommended preparation for Stage 2 (not implemented)

1. **Server robustness (S-04):** `Room.later()` swallows a failing step without rescheduling, which would freeze a table. It needs a recovery policy (retry, safe auto-action, or close the room) — a backend change that needs Stage 2 authorization.
2. Add a two-human browser scenario (two contexts) with concurrent taps and reconnects, and consider running the browser regressions in CI with a service container.
3. Decide the `welcome`/snapshot contract explicitly: protocol version checks on reconnect, and how a client with outdated rules should behave (BUG-S1-01 B showed why a refusal must never lock the client).
4. Optional doc fix: update the test count in `README.md`.
