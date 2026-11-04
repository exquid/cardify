# Card hub architecture (Stage 3)

Goal: add card games without rewriting the ones that work, and without forcing poker concepts (chips, blinds, streets) on games that have none.

## Layers

```
src/game, src/bots        Texas Hold'em engine + bots (unchanged)
src/durak                 Durak engine, views, bots (new)
src/hub/tableGame.ts      TableGame<State, Action, View> — the contract
src/hub/pokerGame.ts      poker behind the contract (thin adapter)
src/durak/game.ts         Durak behind the contract
src/hub/catalog.ts        the catalogue: id, name, status, modes (solo/online)
src/ui/…                  shells: poker solo (app.ts), online poker (online.ts), Durak solo (durak/)
server/room.ts            online tables for any TableGame (Hold'em by default, Durak by choice)
```

## The contract

`TableGame` (see `src/hub/tableGame.ts`) is what any turn-based card game gives a shell or a server:

| Member | Meaning |
| --- | --- |
| `create(seats, rng)` | New game, first round dealt |
| `actor(state)` | Who must decide now, or null |
| `act(state, player, action, expectedSeq?)` | Validated, pure command; throws the game's rule error, input untouched |
| `auto(state, rng)` | Automatic work (deal, showdown, next round, end of a bout) with a pacing hint |
| `view(state, viewer)` | Private projection; never other players' hidden cards or the deck |
| `timeoutAction` / `botAction` | Always-legal moves for clocks and bots |
| `seq(state)`, `isOver(state)` | Stale-command protection; termination |

Rules a game must follow: states are plain JSON, commands are pure, `seq` increases by one per accepted command, and a refused command leaves the state unchanged.

## Proof

`src/hub/__tests__/tableGame.test.ts` plays whole poker tournaments (2/4/6 seats) and whole Durak games (2/3/4/6 seats) through the **same** generic driver (`runUntilHuman`), and checks that both views are private.

## Decisions taken during the overnight run (reversible)

1. **The solo poker shell was not migrated.** `ui/app.ts` still calls the poker engine directly; it works and is tested, so it stays. **The server room was migrated** (second half of the night): `Room<S, A, V>` takes any `TableGame`, defaults to poker, and passed every pre-existing server test unchanged, plus both poker browser regressions.
2. **Card primitives stay in `src/game/cards.ts` and `deck.ts`.** They are already game-agnostic (Durak uses them as is). Moving them to `src/cards/` is a mechanical follow-up.
3. **The Durak solo shell is its own controller** (`ui/durak/durakController.ts`) and uses `TableGame` only. It is the template for future games.

## Next (not done)

- ~~Generalize `server/room.ts`~~ — done: online Durak tables run on the same room code path (`create` carries `game`, `state`/`lobby` report it; table size = min(6, game.maxPlayers)).
- Move the poker solo shell onto a generic "solo driver" shared with Durak.
- Blackjack: a third `TableGame` implementation (dealer as an automatic actor).
