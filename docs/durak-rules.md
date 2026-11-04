# Durak — rules implemented in cardify

Variant: **podkidnoy durak** (throw-in), 36 cards, 2–6 players. This is the house ruleset the engine (`src/durak/`) enforces. It was **chosen during the overnight run on the owner's behalf**. Every line marked **[decision]** can be changed; tell me which, and the engine and tests will follow.

## Cards and deal

- 36 cards: 6, 7, 8, 9, 10, J, Q, K, A in four suits. Ace is high.
- Six cards each, dealt one at a time starting with seat 0.
- The bottom card of the talon is turned face up; its suit is **trump**. It is the last card drawn. With 6 players the talon is empty after the deal, and the trump card ends up in the last player's hand.

## Who starts

- **[decision]** The player holding the **lowest trump** attacks first; the next player clockwise defends. If nobody holds a trump, seat 0 attacks.
- Every game starts fresh: there is no "attack the previous durak" rule yet.

## A bout

1. The attacker leads any card.
2. The defender beats it with a higher card of the same suit, or with any trump if the attack card is not a trump. A trump attack is beaten only by a higher trump.
3. Every player except the defender may then **throw in** cards whose rank is already on the table (attack or defence cards). The main attacker gets priority, then the others clockwise. **[decision]** All non-defenders may throw in, not only the neighbours.
4. **[decision] Limit:** at most **5** attack cards in the first bout of the game and **6** afterwards, and never more than the defender held at the start of the bout.
5. **[simplification]** Cards are thrown in **one at a time**, and the defender answers each one before the next is added. Real tables allow several at once; the engine is turn-based.
6. The defender may **take** at any point while an attack card is unbeaten. After "take", attackers may still add matching cards (within the limit); then the defender picks up everything on the table.
7. An attacker with nothing to add passes. A player with no matching card is skipped automatically.

## End of the bout

- **Beaten** (every attack card covered and nobody adds more): the cards are discarded ("bito"), and the **defender attacks next**.
- **Taken:** the defender picks the cards up and is **skipped**: the player after the defender attacks next.
- Hands are refilled to six from the talon: the main attacker first, then the other attackers clockwise, the defender last.

## End of the game

- Once the talon is empty, a player with no cards is **out** (safe). Places are recorded in the order players get out.
- The last player still holding cards is the **durak** (loser).
- If the last players run out in the same bout, the game is a **draw**.

## Not implemented (yet)

- Perevodnoy (transferring the attack by playing the same rank).
- "The durak defends first next game" and multi-game series and scoring.
- The 5-card first-bout rule is on. Some houses use 6; it is one constant (`FIRST_BOUT_LIMIT`).
- Online Durak works on private tables for 2–4 seats. A human whose clock runs out plays the safe move: lead the lowest card, pass a throw-in, or take.
