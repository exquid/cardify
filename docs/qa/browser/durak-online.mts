// Online Durak — two real browsers at one private Durak table against the local table server.
// The host picks "Durak" when creating the table; the guest joins by link. They play a whole game
// heads-up through the UI. Checks: every frame is a Durak frame with only the viewer's own hand
// and no talon; a tap by the player who is not to act never leaves the page; both players drop
// and reconnect once; no stalls; both see the result; "Play again" brings both back to the lobby.
// Needs: npx vite (5173) and npx tsx server/index.ts (8787).
import { APP_URL, Checks, playwright } from './lib.mts';

const checks = new Checks();
const browser = await playwright.chromium.launch();
const settings = JSON.stringify({ speed: 'fast', sound: false, animations: false, autoNextHand: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Playwright install
type Any = any;

interface Seat {
  page: Any;
  socket: Any;
  id: string;
  seq: number;
  view: Any;
  acts: number;
  leaks: string[];
  errors: string[];
  lobbies: number;
}

async function openSeat(profile: object): Promise<Seat> {
  const ctx = await browser.newContext({ ...profile, reducedMotion: 'reduce' });
  await ctx.addInitScript((s: string) => localStorage.setItem('cardify.settings.v1', s), settings);
  const page = await ctx.newPage();
  const seat: Seat = { page, socket: null, id: '', seq: -1, view: null, acts: 0, leaks: [], errors: [], lobbies: 0 };
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
      if (msg.t === 'lobby') seat.lobbies += 1;
      if (msg.t === 'state') {
        if (msg.game !== 'durak') seat.leaks.push(`non-Durak frame (${msg.game})`);
        if (text.includes('"talon"')) seat.leaks.push(`talon in frame at seq ${msg.view.seq}`);
        for (const p of msg.view.players) if (p.id !== seat.id && p.hand) seat.leaks.push(`${p.name}'s hand at seq ${msg.view.seq}`);
        seat.view = msg.view;
        seat.seq = msg.view.seq;
      }
      ws.send(raw);
    });
  });
  return seat;
}

const ann = await openSeat({ viewport: { width: 1280, height: 800 } });
const ben = await openSeat({ ...playwright.devices['iPhone 13'] });
await ann.page.goto(APP_URL);
await ann.page.getByRole('button', { name: 'Play with friends' }).first().click();
await ann.page.locator('#online-name').fill('Ann');
await ann.page.getByRole('radio', { name: 'Durak' }).click();
await ann.page.getByRole('button', { name: 'Create a table' }).first().click();
await ann.page.getByText('Your Durak table').waitFor();
const code = (await ann.page.locator('.code__value').innerText()).trim();
await ben.page.goto(`${APP_URL}?table=${code}`);
await ben.page.locator('#online-name').fill('Ben');
await ben.page.getByRole('button', { name: 'Join' }).first().click();
await ann.page.getByRole('button', { name: /Start game with 2 players/ }).click();
await ann.page.waitForSelector('.screen--durak');
await ben.page.waitForSelector('.screen--durak');

const seats = [ann, ben];
let foreign = 0;
let stalls = 0;
let moves = 0;
let drops = 0;
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const latest = ann.seq >= ben.seq ? ann : ben;
  const pending = latest.view?.pending;
  if (!pending || pending.kind === 'over') break;
  if (!('playerId' in pending)) {
    await ann.page.waitForTimeout(80);
    continue;
  }
  const turn = seats.find((s) => s.id === pending.playerId);
  const other = turn === ann ? ben : ann;
  if (!turn) {
    await ann.page.waitForTimeout(80);
    continue;
  }
  if (moves === 6 || moves === 14) {
    const who = moves === 6 ? ann : ben;
    await who.socket.close({ code: 4999, reason: 'simulated network drop' });
    drops += 1;
    await who.page.waitForTimeout(1500);
  }
  // The waiting player taps a card and presses D: nothing may be sent.
  const otherActs = other.acts;
  await other.page.locator('.durak-hand__card').first().click({ force: true, timeout: 500 }).catch(() => undefined);
  await other.page.keyboard.press('d');
  if (other.acts !== otherActs) foreign += 1;
  const ready = await turn.page.waitForSelector('.durak-dock[data-mode="turn"]', { timeout: 5000 }).catch(() => null);
  if (!ready) {
    stalls += 1;
    continue;
  }
  const seq = turn.seq;
  const playable = turn.page.locator('.durak-hand__card.is-playable');
  const done = turn.page.locator('.durak-actions .btn--call:not(.is-hidden)');
  const take = turn.page.locator('.durak-actions .btn--fold:not(.is-hidden)');
  if ((await playable.count()) > 0 && moves % 5 !== 4) await playable.first().click();
  else if (await done.count()) await done.first().click();
  else if (await take.count()) await take.first().click();
  else await playable.first().click();
  for (let i = 0; i < 60 && turn.seq === seq; i++) await turn.page.waitForTimeout(60);
  if (turn.seq === seq) stalls += 1;
  moves += 1;
}
await ann.page.waitForTimeout(800);
const annResult = await ann.page.locator('.durak-result:not([hidden]) .durak-result__title').innerText().catch(() => '');
const benResult = await ben.page.locator('.durak-result:not([hidden]) .durak-result__title').innerText().catch(() => '');
checks.ok(annResult !== '' && benResult !== '', `the game ended on both screens ("${annResult}" / "${benResult}") after ${moves} human moves`);
checks.ok(ann.seq === ben.seq, `both clients converged on seq ${ann.seq} / ${ben.seq}`);
checks.ok(foreign === 0, `taps by the waiting player were never sent (${foreign})`);
checks.ok(stalls === 0, `no stalls (${stalls})`);
checks.ok(drops === 2, 'both players dropped and reconnected mid-game');
checks.ok(ann.leaks.length + ben.leaks.length === 0, `every frame was a private Durak view (${[...ann.leaks, ...ben.leaks].slice(0, 3).join('; ') || 'no leaks'})`);
checks.ok(ann.errors.length + ben.errors.length === 0, `no page errors ${[...ann.errors, ...ben.errors].slice(0, 2).join(' | ')}`);
if (annResult) {
  const lobbiesBefore = ben.lobbies;
  await ann.page.getByRole('button', { name: 'Play again' }).click();
  await ann.page.getByText('Your Durak table').waitFor({ timeout: 5000 }).catch(() => undefined);
  for (let i = 0; i < 30 && ben.lobbies === lobbiesBefore; i++) await ann.page.waitForTimeout(100);
  checks.ok((await ann.page.getByText('Your Durak table').count()) === 1 && ben.lobbies > lobbiesBefore, 'Play again (host) brings both players back to the Durak lobby');
}
await browser.close();
checks.finish();
