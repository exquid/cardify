/* eslint-disable no-console -- command-line QA script */
// Stage 4 — Durak solo UI smoke test against the dev build. The hero plays whole games through the
// UI (cards, Take, Done) at 2, 3 and 4 players: every hero turn must offer something to do, a double
// tap on a card plays exactly one card, the game reaches its result panel, and no page error occurs.
// Usage: durak-ui.mts [shots-dir]
import { APP_URL, Checks, playwright } from './lib.mts';

const checks = new Checks();
const shots = process.argv[2];
const browser = await playwright.chromium.launch();
const settings = JSON.stringify({ speed: 'fast', sound: false, animations: false, autoNextHand: false });

for (const [players, label, profile] of [
  [2, 'You vs Nova (2 players)', { ...playwright.devices['iPhone 13'] }],
  [3, 'You, Nova and Vex (3 players)', { viewport: { width: 1280, height: 800 } }],
  [4, 'Full table of four', { ...playwright.devices['iPhone 13'] }],
] as const) {
  console.log(`\n== ${players} players`);
  const ctx = await browser.newContext({ ...profile, reducedMotion: 'reduce' });
  await ctx.addInitScript((s: string) => localStorage.setItem('cardify.settings.v1', s), settings);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(String(e)));
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Play Durak' }).click();
  await page.getByRole('button', { name: label }).click();
  await page.waitForSelector('.screen--durak');

  let turns = 0;
  let stuck = 0;
  let doubleTaps = 0;
  let badDouble = 0;
  let shot = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await page.locator('.durak-result:not([hidden])').count()) break;
    const mode = await page.getAttribute('.durak-dock', 'data-mode');
    if (mode !== 'turn') {
      await page.waitForTimeout(60);
      continue;
    }
    turns += 1;
    if (shots && !shot && turns === 3) {
      await page.screenshot({ path: `${shots}/durak-${players}p.png` });
      shot = true;
    }
    const playable = page.locator('.durak-hand__card.is-playable');
    const n = await playable.count();
    const take = page.locator('.durak-actions .btn--fold:not(.is-hidden)');
    const done = page.locator('.durak-actions .btn--call:not(.is-hidden)');
    const before = await page.locator('.durak-hand__card').count();
    const status = await page.locator('.dock__status').innerText();
    if (n > 0 && (turns % 4 !== 0 || ((await take.count()) === 0 && (await done.count()) === 0))) {
      if (turns % 3 === 0) {
        await playable.first().dblclick();
        doubleTaps += 1;
        await page.waitForTimeout(120);
        const after = await page.locator('.durak-hand__card').count();
        if (after !== before - 1 && (await page.locator('.durak-result:not([hidden])').count()) === 0) badDouble += 1;
      } else {
        await playable.first().click();
      }
    } else if (await done.count()) {
      await done.first().click();
    } else if (await take.count()) {
      await take.first().click();
    } else {
      stuck += 1;
      console.log(`  no option at a hero turn: "${status}"`);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(40);
  }
  const result = await page.locator('.durak-result:not([hidden]) .durak-result__title').innerText().catch(() => '');
  if (shots) await page.screenshot({ path: `${shots}/durak-${players}p-end.png` });
  checks.ok(result !== '', `${players}p: the game reached its result ("${result}") after ${turns} hero turns`);
  checks.ok(stuck === 0, `${players}p: every hero turn offered an action (${stuck} without)`);
  checks.ok(badDouble === 0, `${players}p: ${doubleTaps} double taps each played exactly one card`);
  checks.ok(errors.length === 0, `${players}p: no page errors ${errors.slice(0, 2).join(' | ')}`);
  // Play again returns to the seat picker; Main menu goes home.
  if (result) {
    await page.getByRole('button', { name: 'Main menu' }).click();
    checks.ok((await page.locator('.screen--home').count()) === 1, `${players}p: Main menu returns to the card room`);
  }
  await ctx.close();
}
// Continue after a reload.
{
  console.log('\n== continue after reload');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((s: string) => localStorage.setItem('cardify.settings.v1', s), settings);
  const page = await ctx.newPage();
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Play Durak' }).click();
  await page.getByRole('button', { name: 'You vs Nova (2 players)' }).click();
  await page.waitForSelector('.screen--durak');
  for (let i = 0; i < 100 && (await page.getAttribute('.durak-dock', 'data-mode')) !== 'turn'; i++) await page.waitForTimeout(60);
  await page.locator('.durak-hand__card.is-playable').first().click();
  await page.waitForTimeout(300);
  const handBefore = await page.locator('.durak-hand__card').count();
  const infoBefore = await page.locator('.topbar__info').innerText();
  await page.reload();
  await page.getByRole('button', { name: 'Play Durak' }).click();
  const resume = page.getByRole('button', { name: /Continue game · bout/ });
  checks.ok((await resume.count()) === 1, 'a saved game offers "Continue game"');
  await resume.click();
  await page.waitForSelector('.screen--durak');
  checks.ok((await page.locator('.durak-hand__card').count()) === handBefore, `the hand came back (${handBefore} cards)`);
  checks.ok((await page.locator('.topbar__info').innerText()).split('\n')[1] === infoBefore.split('\n')[1], 'the same bout came back');
  await ctx.close();
}

await browser.close();
checks.finish();
