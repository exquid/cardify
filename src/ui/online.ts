import type { TableView } from '../game/views';
import { NetClient, probeServer, type ConnectionStatus } from '../net/client';
import type { ClientMessage, LobbyView, ServerMessage, TableMeta } from '../net/protocol';
import { emptyStats, type SessionStats } from '../storage/session';
import type { SeatExtras } from './table';
import { describeStatus, TableScreen, type FrameContext, type TableScreenEnv } from './tableScreen';
import { entryScreen, lobbyScreen } from './onlineScreens';
import { endScreen, menuBody } from './screens';

/** What the online controller needs from the surrounding app. */
export interface Shell {
  readonly root: HTMLElement;
  readonly env: TableScreenEnv;
  sheet(title: string, body: HTMLElement): HTMLDialogElement;
  openSettings(): void;
  openHowTo(): void;
  openHistory(lines: readonly string[]): void;
  toggleSound(): void;
  showStart(notice?: string | null): void;
  setActive(screen: TableScreen | null): void;
}

interface OnlineSave {
  name: string;
  code: string | null;
  token: string | null;
}

const SAVE_KEY = 'cardify.online.v1';
const SLOW_CONNECT_MS = 4000;
/** First health probe after a connection attempt starts. */
const WATCHDOG_FIRST_MS = 8000;
const WATCHDOG_EVERY_MS = 5000;
/** Server answers /health but the socket still fails this long: it refuses us. */
const BLOCKED_AFTER_HEALTHY_MS = 12_000;
/** Give up waiting for a sleeping server after this long. */
const GIVE_UP_MS = 120_000;

function loadSave(): OnlineSave {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Partial<OnlineSave> | null;
    return {
      name: typeof data?.name === 'string' ? data.name : '',
      code: typeof data?.code === 'string' ? data.code : null,
      token: typeof data?.token === 'string' ? data.token : null,
    };
  } catch {
    return { name: '', code: null, token: null };
  }
}

/** Code of the online table this browser can rejoin, if any. */
export function savedTableCode(): string | null {
  const save = loadSave();
  return save.code && save.token ? save.code : null;
}

function writeSave(save: OnlineSave): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* private mode: rejoin after reload just won't be offered */
  }
}

/**
 * Drives "Play with Friends". The server is authoritative: this controller
 * only shows what it receives (lobby or the player's own TableView) and sends
 * the player's intents. It never sees the deck or other players' cards.
 */
export class OnlineController {
  private client: NetClient | null = null;
  private save = loadSave();
  private playerId: string | null = null;
  /** Message to send as soon as the socket opens (create/join/resume). */
  private intent: ClientMessage | null = null;
  private status: ConnectionStatus = 'closed';
  private mode: 'entry' | 'lobby' | 'game' | 'end' = 'entry';
  private entry = { code: '', error: null as string | null, busy: null as string | null };
  private lobby: LobbyView | null = null;
  private view: TableView | null = null;
  private meta: TableMeta | null = null;
  /** serverNow − Date.now(), so countdowns match the server clock. */
  private clockOffset = 0;
  private screen: TableScreen | null = null;
  private screenKey = '';
  /** The next state is a fresh snapshot (connect/reconnect): no replayed sounds. */
  private snapshot = true;
  private leaving = false;
  private stats: SessionStats = emptyStats();
  private countedHand = -1;
  private ticker: number | undefined;
  private endTimer: number | undefined;
  private slowTimer: number | undefined;
  private watchdog: number | undefined;

  constructor(
    private readonly shell: Shell,
    private readonly url: string | null,
  ) {}

  open(prefillCode = ''): void {
    this.entry = { code: prefillCode, error: null, busy: null };
    this.mode = 'entry';
    this.renderEntry();
    // Start waking a sleeping free-tier server while the player types.
    if (this.url) void probeServer(this.url);
  }

  /** Goes straight back to the saved table (start screen shortcut). */
  rejoin(): void {
    this.open();
    this.connectWith(null);
  }

  dispose(): void {
    window.clearInterval(this.ticker);
    window.clearTimeout(this.endTimer);
    window.clearTimeout(this.slowTimer);
    window.clearTimeout(this.watchdog);
    this.client?.close();
    this.client = null;
    this.shell.setActive(null);
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  private connectWith(intent: ClientMessage | null): void {
    if (!this.url) return;
    this.intent = intent;
    this.leaving = false;
    this.entry.error = null;
    this.entry.busy = 'Connecting to the table server…';
    this.renderEntry();
    window.clearTimeout(this.slowTimer);
    this.slowTimer = window.setTimeout(() => {
      if (this.mode !== 'entry' || !this.entry.busy) return;
      this.entry.busy = 'Waking up the table server — on free hosting this can take up to a minute…';
      this.renderEntry();
    }, SLOW_CONNECT_MS);

    if (this.client?.isOpen) {
      this.onOpen();
      return;
    }
    this.startWatchdog();
    this.client?.close();
    this.client = new NetClient(this.url, {
      onOpen: () => this.onOpen(),
      onMessage: (m) => this.onMessage(m),
      onStatus: (s, detail) => this.onStatus(s, detail),
    });
    this.client.connect();
  }

  /**
   * While the entry screen waits, checks /health so a stuck attempt ends with
   * a clear reason instead of an endless spinner: the server is asleep and
   * unreachable, or it is awake but refuses this site's origin.
   */
  private startWatchdog(): void {
    window.clearTimeout(this.watchdog);
    const url = this.url;
    if (!url) return;
    const started = Date.now();
    let healthySince: number | null = null;
    const check = async (): Promise<void> => {
      if (this.mode !== 'entry' || !this.entry.busy) return;
      const healthy = await probeServer(url);
      if (this.mode !== 'entry' || !this.entry.busy) return;
      const now = Date.now();
      if (healthy) healthySince ??= now;
      if (healthySince !== null && now - healthySince >= BLOCKED_AFTER_HEALTHY_MS) {
        this.failConnect(
          `The table server is running but refused this page (${location.origin}). ` +
            'On Render, open the service → Environment and add this address to ALLOWED_ORIGINS (or set it to *), then save.',
        );
        return;
      }
      if (now - started >= GIVE_UP_MS) {
        this.failConnect("Can't reach the table server right now. It may still be waking up — wait a minute and try again.");
        return;
      }
      this.watchdog = window.setTimeout(() => void check(), WATCHDOG_EVERY_MS);
    };
    this.watchdog = window.setTimeout(() => void check(), WATCHDOG_FIRST_MS);
  }

  private failConnect(message: string): void {
    window.clearTimeout(this.watchdog);
    window.clearTimeout(this.slowTimer);
    this.client?.close();
    this.client = null;
    this.entry.busy = null;
    this.entry.error = message;
    this.renderEntry();
  }

  private onOpen(): void {
    this.snapshot = true;
    const intent = this.intent;
    this.intent = null;
    if (intent) this.client?.send(intent);
    else if (this.save.code && this.save.token) this.client?.send({ t: 'resume', code: this.save.code, token: this.save.token });
  }

  private onStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    if (status === 'closed' && detail) {
      this.dispose();
      this.shell.showStart(detail);
      return;
    }
    if (this.mode === 'lobby') this.renderLobby();
    if (this.mode === 'game' && status === 'reconnecting') this.screen?.notify('Connection lost — reconnecting…');
  }

  private send(message: ClientMessage): void {
    if (!this.client?.send(message)) this.screen?.notify('Not connected — your tap was not sent. Reconnecting…');
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        window.clearTimeout(this.slowTimer);
        window.clearTimeout(this.watchdog);
        this.playerId = msg.playerId;
        this.save = { ...this.save, code: msg.code, token: msg.token };
        writeSave(this.save);
        return;
      case 'lobby':
        this.lobby = msg.lobby;
        this.view = null;
        this.meta = null;
        window.clearTimeout(this.endTimer);
        this.mode = 'lobby';
        this.renderLobby();
        return;
      case 'state':
        this.view = msg.view;
        this.meta = msg.table;
        this.clockOffset = msg.table.serverNow - Date.now();
        if (this.mode !== 'end') this.renderGame();
        return;
      case 'error':
        this.onError(msg.code, msg.message);
        return;
      case 'left': {
        const kicked = !this.leaving;
        this.forgetTable();
        this.dispose();
        this.shell.showStart(kicked ? 'You are no longer seated at that table.' : null);
        return;
      }
      case 'pong':
        return;
    }
  }

  private onError(code: string, message: string): void {
    if (code === 'stale') return; // the table moved on; a fresh state is on its way
    if (this.mode === 'entry') {
      if (code === 'not-found' && this.save.token) this.forgetTable();
      window.clearTimeout(this.slowTimer);
      window.clearTimeout(this.watchdog);
      this.entry.busy = null;
      this.entry.error = message;
      this.renderEntry();
      return;
    }
    if (code === 'not-found') {
      this.forgetTable();
      this.dispose();
      this.shell.showStart('That table has closed.');
      return;
    }
    this.screen?.notify(message);
    this.screen?.rerender();
  }

  private forgetTable(): void {
    this.save = { ...this.save, code: null, token: null };
    writeSave(this.save);
  }

  private leave(): void {
    this.leaving = true;
    if (!this.client?.send({ t: 'leave' })) {
      this.forgetTable();
      this.dispose();
      this.shell.showStart();
    }
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  private renderEntry(): void {
    this.shell.setActive(null);
    this.shell.root.replaceChildren(
      entryScreen({
        name: this.save.name,
        code: this.entry.code,
        rejoinCode: this.save.code && this.save.token ? this.save.code : null,
        unavailable: this.url
          ? null
          : "Online play isn't switched on for this copy of cardify yet: the table server address is missing.",
        busy: this.entry.busy,
        error: this.entry.error,
        onCreate: (name) => {
          this.rememberName(name);
          this.connectWith({ t: 'create', name });
        },
        onJoin: (code, name) => {
          this.rememberName(name);
          this.entry.code = code;
          this.connectWith({ t: 'join', code, name });
        },
        onRejoin: () => this.connectWith(null),
        onBack: () => {
          this.dispose();
          this.shell.showStart();
        },
      }),
    );
  }

  private rememberName(name: string): void {
    this.save = { ...this.save, name };
    writeSave(this.save);
  }

  private renderLobby(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    this.screen = null;
    this.screenKey = '';
    this.stats = emptyStats();
    this.countedHand = -1;
    window.clearInterval(this.ticker);
    this.shell.setActive(null);
    const invite = `${location.origin}${location.pathname}?table=${lobby.code}`;
    this.shell.root.replaceChildren(
      lobbyScreen({
        lobby,
        inviteUrl: invite,
        connection: this.status === 'reconnecting' ? 'Connection lost — reconnecting…' : null,
        onCopy: (text, button) => void copyText(text, button),
        onAddBot: () => this.send({ t: 'add-bot' }),
        onRemove: (playerId) => this.send({ t: 'remove-seat', playerId }),
        onStart: () => this.send({ t: 'start' }),
        onLeave: () => this.leave(),
      }),
    );
  }

  private renderGame(): void {
    const view = this.view;
    const heroId = this.playerId;
    if (!view || !heroId) return;
    const key = view.players.map((p) => p.id).join(',');
    let effects = !this.snapshot;
    if (!this.screen || this.screenKey !== key || this.mode !== 'game') {
      this.screen = new TableScreen(heroId, view, this.shell.env, {
        onAction: (action, seq) => this.send({ t: 'act', action, seq }),
        onNextHand: () => undefined,
        onMenu: () => this.openMenu(),
        onToggleSound: () => this.shell.toggleSound(),
        onHistory: (lines) => this.shell.openHistory(lines),
      });
      this.screenKey = key;
      this.shell.root.replaceChildren(this.screen.root);
      this.shell.setActive(this.screen);
      // A brand-new game should still animate its first deal.
      effects = this.mode === 'lobby' || effects;
    }
    this.mode = 'game';
    this.snapshot = false;
    this.screen.render(view, this.frame(effects));
    this.trackStats(view);

    window.clearInterval(this.ticker);
    if (this.meta?.turnDeadline || this.meta?.nextHandAt) {
      this.ticker = window.setInterval(() => this.screen?.tick(this.frame(false)), 500);
    }
    window.clearTimeout(this.endTimer);
    if (view.status === 'finished') this.endTimer = window.setTimeout(() => this.showEnd(), 3000);
  }

  private frame(effects: boolean): FrameContext {
    const view = this.view as TableView;
    const meta = this.meta;
    const heroId = this.playerId as string;
    const now = Date.now() + this.clockOffset;
    const secondsUntil = (at: number | null | undefined): number | null => (at ? Math.max(0, Math.ceil((at - now) / 1000)) : null);
    const turn = secondsUntil(meta?.turnDeadline);
    const seats = new Map<string, SeatExtras>();
    for (const p of view.players) {
      seats.set(p.id, {
        offline: meta?.connected[p.id] === false,
        seconds: p.isActing && p.kind === 'human' ? turn : null,
      });
    }
    const hero = view.players.find((p) => p.id === heroId);
    return {
      effects,
      status: describeStatus(view, heroId, (name, id) => {
        const actor = view.players.find((p) => p.id === id);
        return actor?.kind === 'human' && turn !== null ? `${name} to act · ${turn}s` : `${name} is thinking…`;
      }),
      final: view.status === 'finished' || hero?.status === 'out',
      autoNextIn: secondsUntil(meta?.nextHandAt),
      canDealNext: false,
      turnSeconds: view.legal ? turn : null,
      seats,
    };
  }

  private trackStats(view: TableView): void {
    const result = view.result;
    const heroId = this.playerId;
    if (!result || !heroId || this.countedHand === view.handNumber) return;
    this.countedHand = view.handNumber;
    const hero = view.players.find((p) => p.id === heroId);
    if (!hero?.holeCards) return;
    this.stats.handsPlayed += 1;
    const won = result.awards.flatMap((a) => a.winners).filter((w) => w.playerId === heroId).reduce((s, w) => s + w.amount, 0);
    if (won > 0) {
      this.stats.handsWon += 1;
      this.stats.biggestPotWon = Math.max(this.stats.biggestPotWon, won);
    }
  }

  private showEnd(): void {
    const view = this.view;
    const heroId = this.playerId;
    if (!view || !heroId) return;
    this.mode = 'end';
    window.clearInterval(this.ticker);
    this.shell.setActive(null);
    const isHost = this.meta?.hostId === heroId;
    this.shell.root.replaceChildren(
      endScreen({
        players: view.players,
        finished: true,
        heroId,
        stats: this.stats,
        primary: isHost
          ? { label: 'Play again at this table', onClick: () => this.send({ t: 'rematch' }) }
          : { label: 'Waiting for the host to start again…', onClick: () => undefined, disabled: true },
        secondary: { label: 'Leave table', onClick: () => this.leave() },
      }),
    );
  }

  private openMenu(): void {
    const midGame = this.view?.status === 'running' && this.view.players.find((p) => p.id === this.playerId)?.status !== 'out';
    let dialog: HTMLDialogElement | null = null;
    const then = (fn: () => void) => () => {
      dialog?.close();
      fn();
    };
    dialog = this.shell.sheet(
      'Table menu',
      menuBody({
        onResume: then(() => undefined),
        onSettings: then(() => this.shell.openSettings()),
        onHowTo: then(() => this.shell.openHowTo()),
        onLeave: then(() => this.leave()),
        leaveLabel: 'Leave table',
        ...(midGame ? { confirmLeave: 'Tap again — your seat will fold every hand' } : {}),
      }),
    );
  }
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const label = button.querySelector('.code__hint') ?? button;
  const original = label.textContent;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = 'Copied';
  } catch {
    // Older browsers / embedded views: fall back to a selectable prompt-free copy.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    label.textContent = ok ? 'Copied' : text;
  }
  window.setTimeout(() => {
    label.textContent = original;
  }, 1800);
}
