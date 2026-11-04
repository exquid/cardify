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
server/room.ts            online tables — still poker-specific (see "Next")
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

1. **The poker shells were not migrated.** `ui/app.ts` (solo) and `server/room.ts` (online) still call the poker engine directly. Migrating working, tested code without review was judged riskier than the benefit. The adapter proves the contract fits.
2. **Card primitives stay in `src/game/cards.ts` and `deck.ts`.** They are already game-agnostic (Durak uses them as is). Moving them to `src/cards/` is a mechanical follow-up.
3. **The Durak solo shell is its own controller** (`ui/durak/durakController.ts`) and uses `TableGame` only. It is the template for future games.

## Next (not done)

- Generalize `server/room.ts` to `Room<TableGame>`: lobby, seats, tokens, timers and broadcasting are already game-agnostic; only `start/act/schedule/autoAct/getPlayerView` need to go through the contract. Then online Durak needs only catalogue `modes.online = true` and a lobby game picker.
- Move the poker solo shell onto a generic "solo driver" shared with Durak.
- Blackjack: a third `TableGame` implementation (dealer as an automatic actor).
