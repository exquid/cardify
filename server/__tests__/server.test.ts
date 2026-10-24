import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/net/protocol';
import { startServer, type RunningServer } from '../server';

const TIMINGS = { botThink: [5, 10] as [number, number], street: 5, runout: 5, showdown: 5, nextHand: 30, turn: 5000, awayTurn: 500, leftTurn: 10 };

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

/** Test client that records every message and can wait for a matching one. */
function client(port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    opened,
    send: (msg: unknown) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: <T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) => {
      const found = messages.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
      return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 4000);
        waiters.push({
          pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as Extract<ServerMessage, { t: T }>);
          },
        });
      });
    },
  };
}

describe('table server', () => {
  it('runs a private table end to end over WebSockets', async () => {
    server = await startServer({ port: 0, timings: TIMINGS, log: () => undefined });
    const ann = client(server.port);
    await ann.opened;
    ann.send({ t: 'create', name: 'Ann' });
    const welcome = await ann.next('welcome');
    expect(welcome.code).toMatch(/^[A-Z2-9]{5}$/);
    expect(welcome.token).toMatch(/^[a-f0-9]{32}$/);

    const bob = client(server.port);
    await bob.opened;
    bob.send({ t: 'join', code: welcome.code.toLowerCase(), name: 'Bob' });
    const bobWelcome = await bob.next('welcome');
    await ann.next('lobby', (m) => m.lobby.seats.length === 2);

    bob.send({ t: 'start' });
    const notHost = await bob.next('error');
    expect(notHost.code).toBe('not-host');

    ann.send({ t: 'add-bot' });
    await ann.next('lobby', (m) => m.lobby.seats.length === 3);
    ann.send({ t: 'start' });

    const annState = await ann.next('state');
    const bobState = await bob.next('state');
    expect(JSON.stringify(annState)).not.toContain('"deck"');
    const annMe = annState.view.players.find((p) => p.id === welcome.playerId)!;
    expect(annMe.holeCards).toHaveLength(2);
    expect(annState.view.players.find((p) => p.id === bobWelcome.playerId)!.holeCards).toBeNull();
    expect(bobState.table.code).toBe(welcome.code);

    // Whoever is first to act among the humans folds; the server advances.
    const turn = await Promise.race([
      ann.next('state', (m) => m.view.legal !== null).then((m) => ({ c: ann, m })),
      bob.next('state', (m) => m.view.legal !== null).then((m) => ({ c: bob, m })),
    ]);
    turn.c.send({ t: 'act', action: { type: 'fold' }, seq: turn.m.view.seq });
    await turn.c.next('state', (m) => m.view.seq > turn.m.view.seq);
    // Replaying the same tap is rejected as stale.
    turn.c.send({ t: 'act', action: { type: 'fold' }, seq: turn.m.view.seq });
    const stale = await turn.c.next('error', (e) => e.code === 'stale' || e.code === 'illegal-action');
    expect(['stale', 'illegal-action']).toContain(stale.code);
  });

  it('rejects malformed input, rate-limits floods and supports resume', async () => {
    server = await startServer({ port: 0, timings: TIMINGS, log: () => undefined });
    const c = client(server.port);
    await c.opened;
    c.send('{not json');
    expect((await c.next('error')).code).toBe('bad-request');
    c.send({ t: 'join', code: 'ZZZZZ', name: 'X' });
    expect((await c.next('error', (e) => e.code === 'not-found')).code).toBe('not-found');
    c.send({ t: 'create', name: '   ' });
    expect(c.messages.filter((m) => m.t === 'welcome')).toHaveLength(0);

    for (let i = 0; i < 40; i++) c.send({ t: 'ping' });
    expect((await c.next('error', (e) => e.code === 'rate-limited')).code).toBe('rate-limited');

    const host = client(server.port);
    await host.opened;
    host.send({ t: 'create', name: 'Host' });
    const w = await host.next('welcome');
    host.ws.terminate();

    const again = client(server.port);
    await again.opened;
    again.send({ t: 'resume', code: w.code, token: w.token });
    const resumed = await again.next('welcome');
    expect(resumed.playerId).toBe(w.playerId);
    const lobby = await again.next('lobby');
    expect(lobby.lobby.hostId).toBe(w.playerId);

    again.send({ t: 'resume', code: w.code, token: 'f'.repeat(32) });
    expect((await again.next('error', (e) => e.code === 'not-found')).code).toBe('not-found');
  });

  it('refuses browsers from origins that are not allowed', async () => {
    server = await startServer({ port: 0, timings: TIMINGS, allowedOrigins: ['https://cardify.example'], log: () => undefined });
    const ok = client(server.port, 'https://cardify.example');
    await expect(ok.opened).resolves.toBeUndefined();
    const evil = client(server.port, 'https://evil.example');
    await expect(evil.opened).rejects.toThrow();
  });
});

describe('origin allow-list', () => {
  it('ignores case and trailing slashes and supports wildcards', async () => {
    const { createOriginMatcher } = await import('../origins');
    const allow = createOriginMatcher([' https://Cardify-Blue.vercel.app/ ', 'https://cardify-*.vercel.app']);
    expect(allow('https://cardify-blue.vercel.app')).toBe(true);
    expect(allow('https://cardify-git-main-exquids-projects.vercel.app')).toBe(true);
    expect(allow('https://evil.vercel.app')).toBe(false);
    expect(allow('https://cardify-blue.vercel.app.evil.com')).toBe(false);
    expect(allow(undefined)).toBe(false);
    expect(createOriginMatcher([])('https://anything.example')).toBe(true);
    expect(createOriginMatcher(['*'])('https://anything.example')).toBe(true);
  });
});
