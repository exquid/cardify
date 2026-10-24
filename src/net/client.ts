import type { ClientMessage, ServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetClientHandlers {
  /** Called on every successful (re)connection, before any queued message is sent. */
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onStatus(status: ConnectionStatus, detail?: string): void;
}

/** Close code the server uses when the same seat is opened in another tab. */
const SEAT_TAKEN_ELSEWHERE = 4000;
const PING_EVERY_MS = 20_000;

/**
 * Browser WebSocket wrapper with automatic reconnection (exponential backoff
 * with jitter), keep-alive pings and immediate retry when the tab becomes
 * visible again — phones suspend sockets aggressively in the background.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && !this.stopped && this.ws?.readyState !== WebSocket.OPEN) {
      window.clearTimeout(this.retryTimer);
      this.open();
    }
  };

  constructor(
    private readonly url: string,
    private readonly handlers: NetClientHandlers,
  ) {}

  connect(): void {
    this.stopped = false;
    document.addEventListener('visibilitychange', this.onVisible);
    this.open();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    this.handlers.onStatus('closed');
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.handlers.onStatus('open');
      this.handlers.onOpen();
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), PING_EVERY_MS);
    });
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(message);
    });
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.pingTimer);
      if (this.stopped) return;
      if (event.code === SEAT_TAKEN_ELSEWHERE) {
        this.stopped = true;
        this.handlers.onStatus('closed', 'This seat was opened in another tab or device.');
        return;
      }
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped) return;
    this.attempts += 1;
    const base = Math.min(8000, 500 * 2 ** Math.min(this.attempts - 1, 4));
    const delay = base / 2 + Math.random() * (base / 2);
    this.handlers.onStatus('reconnecting');
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }
}

/**
 * Where the table server lives. Production builds set VITE_SERVER_URL
 * (e.g. wss://cardify-server.onrender.com/ws); local and LAN development
 * falls back to port 8787 on the same host. Returns null when online play is
 * not configured for this deployment.
 */
export function resolveServerUrl(): string | null {
  const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  if (configured) return configured;
  const host = globalThis.location?.hostname ?? '';
  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');
  return local ? `ws://${host}:8787/ws` : null;
}

/** https://host/health for a ws(s)://host/ws server address. */
export function healthUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/health';
  url.search = '';
  return url.toString();
}

/**
 * Plain HTTP request to the server's health check. Free hosting puts idle
 * servers to sleep; an early request starts waking it while the player is
 * still typing their name. Resolves true only when the server answered "ok".
 */
export async function probeServer(serverUrl: string, timeoutMs = 8000): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl(serverUrl), { cache: 'no-store', signal: controller.signal });
    return res.ok && (await res.text()).trim() === 'ok';
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
