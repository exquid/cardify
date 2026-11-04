/* eslint-disable no-console -- command-line QA script */
// Visual preservation check: the start screen and the solo table at iPhone 13 and 1280×800,
// reduced motion. Usage: shots.mts <output-dir> [--fixed]
// --fixed injects one deterministic saved game (seeded deal, hero to act, bots idle), so two
// builds can be compared pixel for pixel (see compare.mts). Without it the deal is random.
import { createSeededRng } from '../../../src/game/deck.ts';
import { startNextHand, startTournament } from '../../../src/game/engine.ts';
import { DEFAULT_CONFIG } from '../../../src/game/config.ts';
import { defaultSeats } from '../../../src/game/tournament.ts';
import { APP_URL, playwright, SESSION_KEY, SETTINGS_KEY } from './lib.mts';

const out = process.argv[2];
if (!out) throw new Error('usage: shots.mts <output-dir> [--fixed]');
const fixed = process.argv.includes('--fixed');
const rng = createSeededRng(2026);
// Dealer seat 1 → SB 2, BB 3: the hero (seat 0) acts first, so nothing moves until a tap.
const fixedState = startNextHand(startTournament(DEFAULT_CONFIG, defaultSeats(), { firstDealerSeat: 1, rng }), { rng });
const fixedSave = JSON.stringify({ version: 1, savedAt: 0, state: fixedState, stats: { handsPlayed: 0, handsWon: 0, biggestPotWon: 0 } });
const settings = JSON.stringify({ speed: 'normal', sound: false, animations: false, autoNextHand: false });

const browser = await playwright.chromium.launch();
const profiles: [string, object][] = [
  ['iphone13', { ...playwright.devices['iPhone 13'] }],
  ['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
];
for (const [name, options] of profiles) {
  const ctx = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  if (fixed) {
    await ctx.addInitScript(
      ([k1, v1, k2, v2]: string[]) => {
        localStorage.setItem(k1 as string, v1 as string);
        localStorage.setItem(k2 as string, v2 as string);
      },
      [SESSION_KEY, fixedSave, SETTINGS_KEY, settings],
    );
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(String(e)));
  await page.goto(APP_URL);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-start.png` });
  await (fixed ? page.getByRole('button', { name: /Continue/ }) : page.locator('.btn--primary').first()).click();
  await page.waitForSelector('.dock[data-mode="turn"]', { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}-table.png` });
  console.log(name, 'dock mode =', await page.getAttribute('.dock', 'data-mode'), 'page errors =', errors.length ? errors : 'none');
  await ctx.close();
}
await browser.close();
