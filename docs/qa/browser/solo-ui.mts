/* eslint-disable no-console -- command-line QA script */
// Stage 1 — solo UI integration (P15) and async lifecycle (P16) against the running dev build.
// Oracle: the saved GameState in localStorage + the real engine's getLegalActions (run here in Node).
// Usage: solo-ui.mts [heroTurns=60]. Exit code 1 on any mismatch or page error.
import { getLegalActions } from '../../../src/game/engine.ts';
import type { GameState, LegalActions } from '../../../src/game/types.ts';
import { APP_URL as URL, playwright } from './lib.mts';

const { chromium } = playwright;
const HERO = 'you';
const TURNS = Number(process.argv[2] ?? 60);

const findings: string[] = [];
const note = (msg: string) => {
  findings.push(msg);
  console.log('  !!', msg);
};
const digits = (t: string | null) => Number((t ?? '').replace(/[^0-9]/g, '') || NaN);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
await ctx.addInitScript(() => {
  const w = window as unknown as { __saves: { seq: number; hand: number; json: string; t: number }[] };
  w.__saves = [];
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k: string, v: string) {
    if (k === 'cardify.session.v1') {
      try {
        const s = JSON.parse(v).state;
        w.__saves.push({ seq: s.seq, hand: s.handNumber, json: v, t: performance.now() });
      } catch {
        /* ignore */
      }
    }
    return orig.call(this, k, v);
  };
  if (!localStorage.getItem('cardify.settings.v1')) {
    orig.call(localStorage, 'cardify.settings.v1', JSON.stringify({ speed: 'fast', sound: false, animations: false, autoNextHand: true }));
  }
});
const page = await ctx.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (e: Error) => pageErrors.push(String(e)));

const saved = async (): Promise<GameState | null> => {
  const raw = await page.evaluate(() => localStorage.getItem('cardify.session.v1'));
  return raw ? (JSON.parse(raw).state as GameState) : null;
};
const saves = async () => page.evaluate(() => (window as unknown as { __saves: { seq: number; hand: number; json: string }[] }).__saves.map((s) => ({ seq: s.seq, hand: s.hand, json: s.json })));
const visible = async (sel: string) => page.locator(sel).evaluate((el: Element) => !el.classList.contains('is-hidden') && !(el as HTMLButtonElement).disabled);
const heroActions = (s: GameState) => s.hand!.events.filter((e) => e.type === 'action' && e.playerId === HERO);

async function startFresh(): Promise<void> {
  await page.goto(URL);
  await page.evaluate(() => localStorage.removeItem('cardify.session.v1'));
  await page.goto(URL);
  await page.getByRole('button', { name: /^(Play poker|New game)$/ }).first().click();
}

/** Waits for the hero's turn; returns null if the tournament ended for the hero. */
async function waitHeroTurn(): Promise<GameState | null> {
  for (let i = 0; i < 300; i++) {
    const mode = await page.getAttribute('.dock', 'data-mode').catch(() => null);
    const s = await saved();
    if (mode === 'turn' && s?.hand?.pending.kind === 'action' && s.hand.pending.playerId === HERO) return s;
    if (!(await page.locator('.dock').count())) return null; // end screen
    await page.waitForTimeout(60);
  }
  throw new Error('hero turn never came (possible stall)');
}

async function checkDock(s: GameState, legal: LegalActions, where: string): Promise<void> {
  if (!(await visible('.btn--fold'))) note(`${where}: Fold not available`);
  const callText = await page.locator('.btn--call').innerText();
  if (legal.canCheck) {
    if (!/^Check/.test(callText)) note(`${where}: expected Check, button says "${callText}"`);
  } else if (digits(callText) !== legal.callAmount) {
    note(`${where}: call label "${callText}" != callAmount ${legal.callAmount}`);
  }
  const raiseShown = await visible('.btn--raise');
  if (raiseShown !== !!legal.raise) note(`${where}: raise shown=${raiseShown} but legal.raise=${JSON.stringify(legal.raise)}`);
  if (legal.raise && raiseShown && digits(await page.locator('.btn--raise').innerText()) !== legal.raise.min) {
    note(`${where}: raise label "${await page.locator('.btn--raise').innerText()}" != min ${legal.raise.min}`);
  }
  const allInShown = await visible('.btn--allin');
  const expectAllIn = legal.canAllIn && !legal.callIsAllIn;
  if (allInShown !== expectAllIn) note(`${where}: all-in shown=${allInShown}, expected ${expectAllIn}`);
  const statusText = await page.locator('.dock__status').innerText();
  if (legal.toCall > 0 && digits(statusText) !== legal.toCall) note(`${where}: status "${statusText}" vs toCall ${legal.toCall}`);
  void s;
}

type Plan = 'dblclick-call' | 'keys-cc' | 'raise-preset' | 'allin-double' | 'fold';
const stats = { turns: 0, byPlan: {} as Record<string, number>, sliderChecks: 0, tournaments: 1 };

await startFresh();
for (let turn = 0; turn < TURNS; turn++) {
  let s = await waitHeroTurn();
  if (!s) {
    stats.tournaments += 1;
    await startFresh();
    s = await waitHeroTurn();
    if (!s) throw new Error('could not start a new tournament');
  }
  const legal = getLegalActions(s, HERO)!;
  const where = `turn ${turn} (hand ${s.handNumber}, seq ${s.seq})`;
  await checkDock(s, legal, where);

  const options: Plan[] = ['dblclick-call', 'keys-cc'];
  if (legal.raise) options.push('raise-preset', 'raise-preset');
  if (legal.canAllIn && !legal.callIsAllIn && turn % 5 === 4) options.push('allin-double');
  if (!legal.canCheck && legal.toCall > 200) options.push('fold');
  const plan = options[turn % options.length] as Plan;
  stats.byPlan[plan] = (stats.byPlan[plan] ?? 0) + 1;
  const before = heroActions(s).length;
  const seq0 = s.seq;
  let expected: { action: string; to?: number } | null = null;

  if (plan === 'dblclick-call') {
    await page.locator('.btn--call').dblclick();
    expected = { action: legal.canCheck ? 'check' : 'call' };
  } else if (plan === 'keys-cc') {
    await page.keyboard.press('c');
    await page.keyboard.press('c');
    expected = { action: legal.canCheck ? 'check' : 'call' };
  } else if (plan === 'fold') {
    await page.locator('.btn--fold').click();
    expected = { action: 'fold' };
  } else if (plan === 'allin-double') {
    await page.locator('.btn--allin').click();
    await page.locator('.btn--allin').click();
    expected = { action: legal.allInIsRaise ? (s.hand!.currentBet === 0 ? 'bet' : 'raise') : 'call', to: legal.allInTo };
  } else {
    await page.locator('.btn--raise').click(); // opens the sizer
    const presets = page.locator('.sizer__presets .chip-btn:not([disabled])');
    const n = await presets.count();
    if (n > 0) await presets.nth(turn % n).click();
    const value = Number(await page.locator('.sizer__slider').inputValue());
    stats.sliderChecks += 1;
    if (!Number.isInteger(value) || value < legal.raise!.min || value > legal.raise!.max) {
      note(`${where}: slider value ${value} outside integer [${legal.raise!.min}, ${legal.raise!.max}]`);
    }
    // Every enabled preset must land on a legal integer amount.
    for (let i = 0; i < n; i++) {
      await presets.nth(i).click();
      const v = Number(await page.locator('.sizer__slider').inputValue());
      if (!Number.isInteger(v) || v < legal.raise!.min || v > legal.raise!.max) note(`${where}: preset ${i} gives ${v}`);
    }
    if (n > 0) await presets.nth(turn % n).click();
    const amount = Number(await page.locator('.sizer__slider').inputValue());
    await page.locator('.btn--raise').dblclick(); // confirm, with an accidental second tap
    expected = { action: s.hand!.currentBet === 0 ? 'bet' : 'raise', to: amount };
  }

  // The hero's command must be committed exactly once.
  await page.waitForTimeout(40);
  for (let i = 0; i < 100 && (await saved())!.seq === seq0; i++) await page.waitForTimeout(30);
  const all = await saves();
  const atNext = all.filter((x) => x.seq === seq0 + 1);
  if (atNext.length !== 1) note(`${where}: ${atNext.length} saves at seq ${seq0 + 1}`);
  const after = JSON.parse(atNext[0]!.json).state as GameState;
  const sameHand = after.hand!.number === s.hand!.number;
  const newHero = sameHand ? heroActions(after).slice(before) : [];
  if (newHero.length !== 1) note(`${where}: ${plan} produced ${newHero.length} hero actions`);
  const ev = newHero[0] as { action: string; to: number } | undefined;
  if (ev && expected && (ev.action !== expected.action || (expected.to !== undefined && ev.to !== expected.to))) {
    note(`${where}: ${plan} expected ${JSON.stringify(expected)}, engine logged ${JSON.stringify(ev)}`);
  }
  stats.turns += 1;
}

// ---------------------------------------------------------------------------
// P16: pending bot/timer work across pause, leave/continue and restart.
// ---------------------------------------------------------------------------
async function waitBotTurn(): Promise<GameState> {
  for (let i = 0; i < 400; i++) {
    const s = await saved();
    const p = s?.hand?.pending;
    if (p?.kind === 'action' && p.playerId !== HERO) return s!;
    if (p?.kind === 'action' && p.playerId === HERO) await page.locator('.btn--call').click();
    if (!(await page.locator('.dock').count())) await startFresh();
    await page.waitForTimeout(25);
  }
  throw new Error('no bot turn');
}
const lifecycle: string[] = [];

// a) Menu open while a bot is "thinking": nothing may happen.
{
  const s = await waitBotTurn();
  await page.getByRole('button', { name: 'Menu' }).click();
  const n0 = (await saves()).length;
  await page.waitForTimeout(2500);
  const n1 = (await saves()).length;
  lifecycle.push(`pause: saves while menu open = ${n1 - n0} (seq ${s.seq})`);
  if (n1 !== n0) note(`P16: ${n1 - n0} commits while the menu was open`);
  // b) Leave while the bot timer was pending, wait, then continue.
  await page.getByRole('button', { name: /Leave table/ }).click();
  const n2 = (await saves()).length;
  await page.waitForTimeout(2500);
  const n3 = (await saves()).length;
  lifecycle.push(`leave: saves on the start screen = ${n3 - n2}`);
  if (n3 !== n2) note(`P16: ${n3 - n2} commits after leaving the table`);
  const keep = await saved();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.waitForTimeout(1500);
  const resumed = await saved();
  lifecycle.push(`continue: resumed at seq ${keep?.seq} → ${resumed?.seq}`);
  if (!resumed || resumed.seq < (keep?.seq ?? 0)) note('P16: continue lost progress');
}
// c) Restart while a bot timer is pending: the new tournament starts clean and advances one command at a time.
for (let round = 0; round < 5; round++) {
  await waitBotTurn();
  await page.evaluate(() => ((window as unknown as { __saves: unknown[] }).__saves.length = 0));
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Restart tournament' }).click();
  await page.getByRole('button', { name: /Tap again|Restart tournament/ }).click();
  await page.waitForTimeout(1800);
  const list = (await saves()).map((x) => ({ seq: x.seq, hand: x.hand }));
  const first = list[0];
  const gaps = list.slice(1).filter((x, i) => x.seq !== list[i]!.seq + 1);
  lifecycle.push(`restart ${round}: first save seq=${first?.seq} hand=${first?.hand}, ${list.length} saves, gaps=${gaps.length}`);
  if (!first || first.seq !== 1 || first.hand !== 1) note(`P16: restart ${round} began at ${JSON.stringify(first)}`);
  if (gaps.length) note(`P16: restart ${round} seq gaps ${JSON.stringify(gaps)}`);
}

await browser.close();
console.log(JSON.stringify({ stats, lifecycle, pageErrors, findings: findings.length }, null, 2));
process.exitCode = findings.length || pageErrors.length ? 1 : 0;
