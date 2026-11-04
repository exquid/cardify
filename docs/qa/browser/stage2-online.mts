/* eslint-disable no-console -- command-line QA script */
// Stage 2 — two real browsers at one private table against the local table server.
//   1  Two humans (separate browser contexts) play several hands heads-up. Each side's frames are
//      inspected: no deck, no opponent hole cards before a "show" event, the two clients converge
//      on the same seq, a tap by the player who is not to act never leaves the page, both players
//      drop and reconnect once mid-game, and the table never stalls.
//   2  Protocol mismatch: the server's welcome is rewritten to another version → the client stops
//      and tells the player to reload, instead of silently misbehaving.
// Needs: npx vite (5173) and npx tsx server/index.ts (8787).
import { APP_URL, Checks, playwright } from './lib.mts';

const checks = new Checks();
const browser = await playwright.chromium.launch();
const settings = JSON.stringify({ speed: 'fast', sound: false, animations: false, autoNextHand: false });
const HANDS = Number(process.argv[2] ?? 6);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Playwright install
type Any = any;

interface Seat {
  name: string;
  page: Any;
  socket: Any;
  id: string;
  seq: number;
  view: Any;
  acts: number;
  leaks: string[];
  errors: string[];
}

async function openSeat(name: string): Promise<Seat> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((s: string) => localStorage.setItem('cardify.settings.v1', s), settings);
  const page = await ctx.newPage();
  const seat: Seat = { name, page, socket: null, id: '', seq: -1, view: null, acts: 0, leaks: [], errors: [] };
  page.on('pageerror', (e: Error) => seat.errors.push(String(e)));
  await page.routeWebSocket(/:8787\/ws/, (ws: Any) => {
    const server = ws.connectToServer();
    seat.socket = ws;
    ws.onMessage((raw: string) => {
      if (JSON.parse(String(raw)).t === 'act') seat.acts += 1;
      server.send(raw);
    });
    server.onMessage((raw: string) => {
      const text = String(raw);
      const msg = JSON.parse(text);
      if (msg.t === 'welcome') seat.id = msg.playerId;
      if (msg.t === 'state') {
        if (text.includes('"deck"')) seat.leaks.push(`deck in frame at seq ${msg.view.seq}`);
        for (const p of msg.view.players) {
          if (p.id === seat.id || !p.holeCards) continue;
          const shown = msg.view.events.some((e: Any) => e.type === 'show' && e.playerId === p.id);
          if (!shown) seat.leaks.push(`${p.name}'s cards at seq ${msg.view.seq}`);
        }
        seat.view = msg.view;
        seat.seq = msg.view.seq;
      }
      ws.send(raw);
    });
  });
  return seat;
}

// ---------------------------------------------------------------------------
// 1. Two humans
// ---------------------------------------------------------------------------
console.log('== two humans');
const ann = await openSeat('Ann');
const ben = await openSeat('Ben');
await ann.page.goto(APP_URL);
await ann.page.getByRole('button', { name: 'Play with friends' }).first().click();
await ann.page.locator('#online-name').fill('Ann');
await ann.page.getByRole('button', { name: 'Create a table' }).first().click();
const tableCode = (await ann.page.locator('.code__value').innerText()).trim();
await ben.page.goto(`${APP_URL}?table=${tableCode}`);
await ben.page.locator('#online-name').fill('Ben');
await ben.page.getByRole('button', { name: 'Join' }).first().click();
await ann.page.getByRole('button', { name: /Start game with 2 players/ }).click();

const seats = [ann, ben];
const actor = (): Seat | undefined => {
  const p = (ann.seq >= ben.seq ? ann : ben).view?.pending;
  return p?.kind === 'action' ? seats.find((s) => s.id === p.playerId) : undefined;
};
let hands = 0;
let lastHand = 0;
let foreignTaps = 0;
let reconnects = 0;
let stalls = 0;
const deadline = Date.now() + 150_000;
while (hands < HANDS && Date.now() < deadline) {
  const view = (ann.seq >= ben.seq ? ann : ben).view;
  if (view?.status === 'finished') break;
  if (view && view.handNumber !== lastHand) {
    lastHand = view.handNumber;
    hands += 1;
    // Mid-game: both players drop once (at different moments) and come back by themselves.
    if (hands === 2 || hands === 4) {
      const who = hands === 2 ? ann : ben;
      await who.socket.close({ code: 4999, reason: 'simulated network drop' });
      reconnects += 1;
      await who.page.waitForTimeout(1200);
    }
  }
  const turn = actor();
  if (!turn) {
    await ann.page.waitForTimeout(80);
    continue;
  }
  const other = turn === ann ? ben : ann;
  const seqBefore = turn.seq;
  // The waiting player hammers the call button and the key at the same time: nothing may be sent.
  const otherActs = other.acts;
  await other.page.locator('.btn--call').click({ force: true, timeout: 500 }).catch(() => undefined);
  await other.page.keyboard.press('c');
  if (other.acts !== otherActs) foreignTaps += 1;
  const ready = await turn.page.waitForSelector('.dock[data-mode="turn"]', { timeout: 5000 }).catch(() => null);
  if (!ready) {
    stalls += 1;
    continue;
  }
  await turn.page.locator('.btn--call').click();
  for (let i = 0; i < 50 && turn.seq === seqBefore; i++) await turn.page.waitForTimeout(60);
  if (turn.seq === seqBefore) stalls += 1;
}
await ann.page.waitForTimeout(800);
checks.ok(hands >= Math.min(HANDS, 3), `played ${hands} hands with two humans`);
checks.ok(foreignTaps === 0, `taps by the player not to act were never sent (${foreignTaps} leaked)`);
checks.ok(stalls === 0, `no stalls (${stalls})`);
checks.ok(reconnects === 2, `both players dropped and reconnected (${reconnects})`);
checks.ok(ann.seq === ben.seq, `both clients converged on seq ${ann.seq} / ${ben.seq}`);
checks.ok(ann.leaks.length === 0 && ben.leaks.length === 0, `no hidden-card or deck leaks (${[...ann.leaks, ...ben.leaks].slice(0, 3).join('; ') || 'none'})`);
checks.ok(ann.errors.length === 0 && ben.errors.length === 0, 'no page errors');
await ann.page.context().close();
await ben.page.context().close();

// ---------------------------------------------------------------------------
// 2. Protocol mismatch
// ---------------------------------------------------------------------------
console.log('\n== protocol mismatch');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.routeWebSocket(/:8787\/ws/, (ws: Any) => {
    const server = ws.connectToServer();
    server.onMessage((raw: string) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'welcome') msg.v = 999;
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Play with friends' }).first().click();
  await page.locator('#online-name').fill('Old tab');
  await page.getByRole('button', { name: 'Create a table' }).first().click();
  const notice = await page
    .getByText(/cardify was updated/i)
    .first()
    .innerText({ timeout: 5000 })
    .catch(() => '');
  checks.ok(/reload/i.test(notice), `a version mismatch asks the player to reload ("${notice}")`);
  await ctx.close();
}

await browser.close();
checks.finish();
