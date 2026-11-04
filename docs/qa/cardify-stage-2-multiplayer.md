# CARDIFY — Stage 2 (Multiplayer) Report

Status: **done (overnight autonomous run, awaiting owner review). Gate: PASS (local)** with the limitations in §6.
Date: 2026-11-04 · Branch `claude/youthful-pascal-rmmfom`. The owner authorized backend changes for the overnight run ("work through the plans, record the rough edges").

## 1. What already existed (audit)

The private-table multiplayer from v0.2 already covered most of the Stage 2 gate.

| Requirement (roadmap) | Existing implementation | Evidence |
| --- | --- | --- |
| Authoritative state | `server/room.ts` owns the `GameState`; the client only renders `TableView` | code review, `room.test.ts` |
| Authenticated seat ownership | 128-bit random token per human seat; a seat is bound per socket; the newest socket wins (code 4000) | `server.ts` `bind`, `findByToken` |
| Private per-player views | `getPlayerView(state, viewerId)` per recipient; no deck | existing + new privacy tests, browser frame inspection |
| Validated actions | `parseClientMessage` (strict shapes, 2 KB cap) → `Room.act` → engine | `protocol.test.ts`, `server.test.ts` |
| Ordering / versioning | `seq` on every command; stale → `stale` error | existing + new tests |
| Reconnect snapshots | `resume` → `welcome` + snapshot | existing + new tests, browser |
| Timeouts | 30 s turn, 8 s when away/offline, 1 s after leaving; auto check/fold | `room.test.ts` |
| Room lifecycle | lobby → playing → finished → rematch; abandoned rooms swept | `room.test.ts`, `server.test.ts` |
| Abuse limits | token-bucket rate limit, Origin allow-list, heartbeat | `server.test.ts` |

## 2. Defects found and fixed

| Bug ID | Severity | Fix | Regression |
| --- | --- | --- | --- |
| **BUG-S2-01** | **High** | A scheduled step (bot move, deal, showdown, next hand) that threw was logged and then **nothing was rescheduled**: the table froze forever, with players staring at a dead table until it was swept. Now `Room.recover()` resolves a pending decision with the always-legal safe default (check, else fold), retries dealing/showdown/next-hand up to 2 times, and otherwise closes the table cleanly: timers stop, players get `error not-found` ("This table ran into a problem and was closed"), the room counts as abandoned and its tokens stop resolving. | `server/__tests__/room-recovery.test.ts` (3 tests; all 3 failed before the fix) |
| BUG-S2-02 | Medium | The client ignored `welcome.v`. After a deploy that changes the protocol, an open tab would keep talking a protocol it may misunderstand. Now a mismatch stops the online session and shows "cardify was updated. Reload the page to keep playing." The seat token is kept, so a reload can resume. | `docs/qa/browser/stage2-online.mts` part 2 |

## 3. New verification

| Check | Result |
| --- | --- |
| `room-two-humans.test.ts` (4 tests) | A whole game with two humans and a bot: every tap by the non-actor with the same `seq` → `illegal-action` with an unchanged state; every duplicate → `stale`; chips conserved after every action; both clients end on the same `seq` and agree on every public number; no foreign hole cards before `show` and no deck in any frame; a reconnect snapshot is private and current; a player leaving mid-hand keeps their chips in play and the host role passes on; a seat resolves only with its own token. |
| Mutation check | Sending every player all hole cards (`canSee = true`) on a scratch copy → the privacy assertions fail in 2 of 4 tests. |
| `room-recovery.test.ts` (3 tests) | transient shuffle failure retried; a permanently failing bot is auto-checked/folded; a permanent failure closes the table and notifies players |
| Browser `stage2-online.mts` | **8 / 8**: two real browser contexts played 6 hands heads-up; 0 taps sent by the player not to act; 0 stalls; both players dropped and reconnected; both converged on seq 67; 0 card/deck leaks in any frame; 0 page errors; version mismatch handled |
| Stage 1 regression re-run on the new server | `regress-bug-s1-01.mts` 10 / 10 |
| `npm run check` | typecheck, lint, **144 / 144 tests (13 files)**, build — all pass |

## 4. Interrupted-session policy (documented, unchanged behaviour)

- **Disconnect:** the seat stays; the player's turns auto-act after 8 s (check, else fold). Reconnect restores the full 30 s clock on their own turn.
- **Two missed turns in a row:** the player is marked away and gets the 8 s clock until they act again.
- **Leave mid-game:** the seat and chips stay in play and auto-fold after 1 s; the host role passes to the next human; left seats are removed at rematch.
- **Server restart/deploy:** tables live in memory, so running games end. Clients see "That table has closed" on resume (known limitation, §6).
- **Broken table (new):** closed cleanly after repeated step failures, as described in §2.

## 5. Files changed

- `server/room.ts` — `recover()`, `closeBroken()`, a `broken` flag honoured by `findByToken`, `isAbandoned` and `rematch`.
- `src/ui/online.ts` — protocol version check on `welcome`.
- Tests: `server/__tests__/harness.ts` (shared fakes), `room-recovery.test.ts`, `room-two-humans.test.ts`.
- QA tool: `docs/qa/browser/stage2-online.mts`.

## 6. Known limitations / open items (for the owner)

| ID | Item | Why not done tonight |
| --- | --- | --- |
| S2-L1 | Tables are in memory: a Render restart or deploy ends every running game, and the free tier sleeps after ~15 min. | Needs persistence (Redis/SQLite) or a paid always-on plan — an infrastructure and money decision. |
| S2-L2 | The client does not send its protocol version, so the server cannot refuse outdated clients itself (only the client side checks). | A protocol change; it is safe to add as an optional field later. |
| S2-L3 | No spectators; a player can only join before the start. | Product decision (Stage 5 or later). |
| S2-L4 | The duplicate `state` on resume (`connect()` broadcasts and `sendSnapshot()` sends again) is harmless but wasteful. | Cosmetic. |
| S2-L5 | No load testing (many rooms, slow clients). | Belongs to Stage 6 (release). |
| S2-L6 | Two-human browser runs used one machine and Chromium only. | A real two-phone test is recommended. |

## 7. Addendum — the room hosts any hub game (later in the night)

- `server/room.ts` is now `Room<S, A, V>` over the hub's `TableGame` contract. It defaults to Texas Hold'em (`createPokerGame()` with the bots' full strength), and lobby bot profiles are passed through, so behaviour is unchanged.
- **Regression evidence for poker:** every pre-existing server test passed without changes to their assertions (only type narrowing for the new `game` field), plus `stage2-online.mts` 8/8 and `regress-bug-s1-01.mts` 10/10 on the new server.
- Protocol: `create` takes an optional `game` (`holdem` by default, so older clients keep working); `lobby` and `state` carry the game; `act` accepts Durak actions with strict shape checks (the room's game refuses actions of another game).
- Online Durak: `server/__tests__/room-durak.test.ts` (4 tests: 4-seat cap, a whole game with two humans and a bot, safe timeout move, private reconnect snapshot) and the browser scenario `durak-online.mts` 8/8.
