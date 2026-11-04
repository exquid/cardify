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
