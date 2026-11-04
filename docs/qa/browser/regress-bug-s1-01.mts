/* eslint-disable no-console -- command-line QA script */
// Regression for BUG-S1-01 (dead action controls), BUG-S1-02 (stale reconnect line) and
// BUG-S1-04 (fractional slider amount with an odd big blind).
// Needs the dev build (npx vite) and the local, unmodified table server (npx tsx server/index.ts).
//   A  online: the socket drops at the hero's turn, a tap is not delivered, the client reconnects →
//      the next tap must reach the server and be accepted; the feed must not still say "reconnecting".
//   B  online: the server refuses an action (simulated rule skew) → the next tap must be accepted.
//   C  solo: a saved game with blinds 10/25; the hero drags the raise slider and confirms → the
//      amount must be a whole number and accepted (or, if refused, the next tap must still work).
import { startNextHand, startTournament } from '../../../src/game/engine.ts';
import { createSeededRng } from '../../../src/game/deck.ts';
import { defaultSeats } from '../../../src/game/tournament.ts';
import type { GameState } from '../../../src/game/types.ts';
import { APP_URL, Checks, playwright, SESSION_KEY, SETTINGS_KEY } from './lib.mts';

const checks = new Checks();
const t0 = Date.now();
const trace = (what: string) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${what}`);
const browser = await playwright.chromium.launch();
const settings = JSON.stringify({ speed: 'normal', sound: false, animations: false, autoNextHand: false });

// ---------------------------------------------------------------------------
// A + B: online
// ---------------------------------------------------------------------------
{
  console.log('\n== A/B online (local table server)');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((s: string) => localStorage.setItem('cardify.settings.v1', s), settings);
  const page = await ctx.newPage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright WebSocketRoute (untyped install)
  let current: any = null;
  let heroId = '';
  let lastSeq = -1;
  let acts = 0;
  let resumes = 0;
  let errors: string[] = [];
  let rewrite: ((action: { type: string }) => object) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protocol view
  let lastView: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright WebSocketRoute (untyped install)
  await page.routeWebSocket(/:8787\/ws/, (ws: any) => {
    const server = ws.connectToServer();
    current = ws;
    ws.onMessage((raw: string) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'resume') resumes += 1;
      if (msg.t === 'act') {
        acts += 1;
        if (rewrite) {
          msg.action = rewrite(msg.action);
          rewrite = null;
          trace(`client → act (rewritten to ${JSON.stringify(msg.action)}) seq=${msg.seq}`);
          server.send(JSON.stringify(msg));
          return;
        }
        trace(`client → act ${JSON.stringify(msg.action)} seq=${msg.seq}`);
      }
      server.send(raw);
    });
    server.onMessage((raw: string) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'welcome') heroId = msg.playerId;
      if (msg.t === 'state') {
        lastView = msg.view;
        if (msg.view.seq !== lastSeq) trace(`server → state seq=${msg.view.seq}`);
        lastSeq = msg.view.seq;
      }
      if (msg.t === 'error') {
        errors.push(msg.code);
        trace(`server → error ${msg.code}: ${msg.message}`);
      }
      ws.send(raw);
    });
  });

  const heroTurn = async (afterSeq: number): Promise<number> => {
    for (let i = 0; i < 900; i++) {
      const mode = await page.getAttribute('.dock', 'data-mode').catch(() => null);
      if (mode === 'turn' && lastSeq !== afterSeq && lastView?.pending?.playerId === heroId) return lastSeq;
      await page.waitForTimeout(100);
    }
    throw new Error('hero turn never came');
  };
  const accepted = async (seq: number, ms = 3000): Promise<boolean> => {
    for (let i = 0; i < ms / 100 && lastSeq === seq; i++) await page.waitForTimeout(100);
    return lastSeq > seq;
  };

  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Play with friends' }).first().click();
  await page.locator('#online-name').fill('Tester');
  await page.getByRole('button', { name: 'Create a table' }).first().click();
  await page.getByRole('button', { name: 'Add a bot' }).click();
  await page.getByRole('button', { name: /Start game with 2 players/ }).click();

  // Control: a normal tap is delivered once and accepted.
  let seq = await heroTurn(-1);
  let before = acts;
  await page.locator('.btn--call').dblclick();
  checks.ok((await accepted(seq)) && acts === before + 1, 'control: a double tap is delivered once and accepted');

  // A: drop → undelivered tap → reconnect → tap again.
  seq = await heroTurn(seq);
  trace('--- A: dropping the socket at the hero turn');
  const resumesBefore = resumes;
  await current.close({ code: 4999, reason: 'simulated network drop' }); // 4000 is reserved for "seat taken"
  await page.waitForTimeout(50);
  await page.locator('.btn--call').click();
  const offlineFeed = await page.locator('.feed__text').innerText();
  checks.ok(/not sent/i.test(offlineFeed), `A: an undelivered tap is reported ("${offlineFeed}")`);
  for (let i = 0; i < 100 && resumes === resumesBefore; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(800);
  checks.ok(lastSeq === seq, `A: reconnect restored the same decision (seq ${lastSeq})`);
  const feedAfter = await page.locator('.feed__text').innerText();
  checks.ok(!/reconnecting/i.test(feedAfter), `BUG-S1-02: feed no longer says "reconnecting" once back ("${feedAfter}")`);
  before = acts;
  await page.locator('.btn--call').click();
  const deliveredA = await accepted(seq);
  checks.ok(acts === before + 1, `BUG-S1-01 A: the tap after reconnect is delivered (${acts - before} sent)`);
  checks.ok(deliveredA, 'BUG-S1-01 A: … and accepted by the server (no forced timeout fold)');

  // B: the server refuses an action → the next tap works.
  seq = await heroTurn(seq);
  trace('--- B: the next tap is rewritten into an illegal action');
  errors = [];
  rewrite = (action) => (action.type === 'check' ? { type: 'call' } : { type: 'check' });
  await page.locator('.btn--call').click();
  for (let i = 0; i < 30 && errors.length === 0; i++) await page.waitForTimeout(100);
  checks.ok(errors.includes('illegal-action') && lastSeq === seq, 'B: the server refused the action, state unchanged');
  before = acts;
  await page.locator('.btn--call').click();
  checks.ok(acts === before + 1 && (await accepted(seq)), 'BUG-S1-01 B: after a refusal the next tap is delivered and accepted');
  await ctx.close();
}

// ---------------------------------------------------------------------------
// C: solo saved game with an odd big blind
// ---------------------------------------------------------------------------
{
  console.log('\n== C solo (saved game, blinds 10/25)');
  const config = { startingStack: 2000, handsPerLevel: 1000, blindLevels: [{ smallBlind: 10, bigBlind: 25 }], blindGrowthAfterTable: 1.5 };
  const rng = createSeededRng(7);
  // Dealer seat 1 → SB 2, BB 3, so the hero (seat 0) opens the action.
  const state = startNextHand(startTournament(config, defaultSeats(), { firstDealerSeat: 1, rng }), { rng });
  const save = JSON.stringify({ version: 1, savedAt: Date.now(), state, stats: { handsPlayed: 0, handsWon: 0, biggestPotWon: 0 } });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(
    ([k1, v1, k2, v2]: string[]) => {
      if (!sessionStorage.getItem('qa-seeded')) {
        localStorage.setItem(k1 as string, v1 as string);
        localStorage.setItem(k2 as string, v2 as string);
        sessionStorage.setItem('qa-seeded', '1');
      }
    },
    [SESSION_KEY, save, SETTINGS_KEY, settings],
  );
  const page = await ctx.newPage();
  const saved = async (): Promise<GameState> => JSON.parse((await page.evaluate((k: string) => localStorage.getItem(k), SESSION_KEY)) as string).state;
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.waitForSelector('.dock[data-mode="turn"]', { timeout: 10000 });
  const seq0 = (await saved()).seq;
  await page.locator('.btn--raise').click(); // open the sizer
  await page.locator('.sizer__slider').evaluate((el: HTMLInputElement) => {
    el.value = '62'; // a drag between stops; with BB 25 the old half-BB snap lands on 62.5
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const shown = await page.locator('.sizer__amount').innerText();
  await page.locator('.btn--raise').click(); // confirm
  await page.waitForTimeout(600);
  let s = await saved();
  const firstAccepted = s.seq === seq0 + 1;
  const feed = await page.locator('.feed__text').innerText();
  trace(`slider shows ${shown}; first tap ${firstAccepted ? 'accepted' : `refused ("${feed}")`}`);
  let recovered = firstAccepted;
  if (!firstAccepted) {
    await page.locator('.btn--call').click();
    await page.waitForTimeout(600);
    s = await saved();
    recovered = s.seq === seq0 + 1;
  }
  const heroEvent = s.hand!.events.find((e) => e.type === 'action' && e.playerId === 'you') as { action: string; to: number } | undefined;
  trace(`hero action logged: ${JSON.stringify(heroEvent)}`);
  checks.ok(recovered, 'BUG-S1-01 C: a refused tap never leaves the solo table stuck');
  checks.ok(firstAccepted && heroEvent?.action === 'raise' && Number.isInteger(heroEvent.to), 'BUG-S1-04: odd-BB slider amount is a whole number and accepted');
  await ctx.close();
}

await browser.close();
checks.finish();
