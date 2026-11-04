/* eslint-disable no-console -- command-line QA script */
// S-02 / BUG-S1-04 reachability: which levels of the shipped blind table have an odd big blind,
// and could a fractional slider stop (an odd multiple of BB/2 strictly inside [min, max]) ever
// be offered with the chips that exist on a solo (4 × 2000) or full online (6 × 2000) table?
import { blindsForLevel, DEFAULT_CONFIG } from '../../../src/game/config.ts';

for (const [label, total] of [['solo 4x2000', 8000], ['online 6x2000', 12000]] as const) {
  const odd: string[] = [];
  for (let level = 0; level < 40; level++) {
    const { smallBlind, bigBlind } = blindsForLevel(DEFAULT_CONFIG, level);
    if (bigBlind % 2 === 1) {
      // The first fractional stop above a 1 BB minimum bet is 1.5 BB; another active player must
      // also have put in at least 1 BB, so the table needs more than 2.5 BB in total.
      odd.push(`L${level + 1} ${smallBlind}/${bigBlind} reachable=${total > 2.5 * bigBlind}`);
    }
  }
  console.log(`${label} → odd BB levels: ${odd.join('; ') || 'none'}`);
}
