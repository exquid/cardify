# Overnight work log

The owner launched an autonomous overnight run ("work through all the plans, don't wait for confirmations, re-check yourself, record the rough edges; I will correct things in the morning").

Rules kept: work only on branch `claude/youthful-pascal-rmmfom` (never `main`, so neither Render nor production changes), keep the Walnut Club design, run `npm run check` before every commit, and record every decision taken on the owner's behalf.

Status is kept per stage below; each section lists **what was done**, **decisions taken for you** (all reversible), and **rough edges**.

---

## Stage 1 — Poker Core QA ✅ (before the overnight run)
Report: [`qa/cardify-poker-core-qa.md`](qa/cardify-poker-core-qa.md). Gate PASS (local).

## Stage 2 — Multiplayer ✅
Report: [`qa/cardify-stage-2-multiplayer.md`](qa/cardify-stage-2-multiplayer.md). Gate PASS (local).

- Fixed **BUG-S2-01 (High)**: a failing scheduled server step froze a table forever. It now auto-checks/folds, retries, or closes the table cleanly.
- Fixed **BUG-S2-02**: the client ignored the protocol version; it now asks to reload.
- Added two-human room tests, recovery tests and a two-browser scenario (8/8).
- **Decisions taken for you:** recovery policy = safe check/fold for a stuck decision, 2 retries for dealing, then close with a message. Change `MAX_STEP_FAILURES` in `server/room.ts` if you prefer otherwise.
- **Rough edges:** in-memory tables (a deploy ends games), no server-side version check of clients, no load test. See the report §6.

## Stage 3 — Card hub architecture ✅ (contract level)
Doc: [`architecture/hub.md`](architecture/hub.md) (written with the Durak UI).

- `src/hub/tableGame.ts`: the `TableGame` contract (create, actor, act, auto steps, private view, timeout and bot actions, seq, isOver) plus a generic `runUntilHuman` driver.
- `src/hub/pokerGame.ts`: poker behind the contract as a thin adapter; the engine is unchanged.
- `src/hub/catalog.ts`: the game catalogue moved here; `ui/components.ts` re-exports it.
- Tests: poker (2/4/6 seats) and Durak (2/3/4/6 seats) both play to the end through the same driver; both views are private.
- **Decision taken for you:** the existing poker solo driver (`ui/app.ts`) and the server room were **not** rewritten onto the contract tonight (too risky without review). The contract is proven by tests; migrating them is a follow-up.

## Stage 4 — Durak ✅ solo playable (online not yet)
Rules: [`durak-rules.md`](durak-rules.md). All rule choices are marked **[decision]** there.

- `src/durak/`: pure engine, private views, bots, hub adapter.
- Tests: 16 rule fixtures, plus 500 seeded games (300 random, 200 bots; about 14,500 bouts and 187,000 refusals verified) with invariants after every command.
- Mutation check: removing the attack limit or the "skip the taker" rule is caught. A third mutant (trump vs. trump) turned out to be equivalent to the original.

- **Solo UI** (`src/ui/durak/`, `src/styles/durak.css`): seat picker (2/3/4 players), a felt with the talon and turned trump card, the bout as attack/defence pairs, opponents' card fans, your hand with the playable cards lifted, Take / Done, history, menu with rules, and a result panel with Play again / Main menu. Built only from Walnut Club tokens and shell classes.
- Durak is **open** on the home page library ("Play Durak"); the poker hero and table are pixel-identical to the redesign commit.
- Browser check `docs/qa/browser/durak-ui.mts`: 15/15 (whole games at 2, 3 and 4 players, double taps, no page errors).
- **Rough edges:**
  - No save/continue for Durak (a reload loses the game).
  - No online Durak (the server room is poker-only; see `architecture/hub.md` → Next).
  - Bots are simple heuristics (they don't track played cards).
  - Defending needs a tap on the target card when several are open; on small phones, hands of 15+ cards overlap tightly.
  - Durak has no sound of its own (it reuses the poker sounds); there are no deal/flip animations beyond the shared card styles.
