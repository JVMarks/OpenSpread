// Relays escolhidos pelo usuário (NIP-01). Uma conexão por pedido, com tempo esgotado: simples e sem estado.
// Todo evento que chega tem id e assinatura conferidos; o que não confere é descartado. Tamanho e quantidade limitados.
import type { NostrEvent } from '../types';
import { verifyEvent } from './event';

export const MAX_EVENTS = 500;
export const MAX_MESSAGE = 64 * 1024;
const DEFAULT_TIMEOUT = 8_000;

export interface RelayResult {
  relay: string;
  accepted: boolean;
  message: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#t'?: string[];
  since?: number;
  limit?: number;
}

type WsLike = {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: (e: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
};
type WsFactory = (url: string) => WsLike;

export interface RelayPoolOptions {
  timeoutMs?: number;
  /** Só nos testes: aceita ws:// em 127.0.0.1. */
  allowLocal?: boolean;
  socket?: WsFactory;
  /** Conta os pedidos na sala de máquinas. */
  onRequest?: (relay: string, ms: number) => void;
}

/** Só wss://; ws:// apenas em 127.0.0.1 e só quando o teste pede. */
export function validRelayUrl(url: string, allowLocal = false): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'wss:') return !!u.hostname && !u.username && !u.password;
    return allowLocal && u.protocol === 'ws:' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export class RelayPool {
  private readonly timeout: number;
  private readonly socket: WsFactory;

  constructor(
    private readonly urls: readonly string[],
    private readonly opts: RelayPoolOptions = {},
  ) {
    this.timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.socket = opts.socket ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  private relays(): string[] {
    return this.urls.filter((u) => validRelayUrl(u, this.opts.allowLocal));
  }

  /** Publica em todos e diz quais aceitaram. Relay fora do ar não trava os outros. */
  publish(event: NostrEvent): Promise<RelayResult[]> {
    return Promise.all(this.relays().map((relay) => this.publishOne(relay, event)));
  }

  private publishOne(relay: string, event: NostrEvent): Promise<RelayResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      let done = false;
      let ws: WsLike | null = null;
      const finish = (accepted: boolean, message: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          /* já fechado */
        }
        this.opts.onRequest?.(relay, Date.now() - started);
        resolve({ relay, accepted, message });
      };
      const timer = setTimeout(() => finish(false, 'tempo esgotado'), this.timeout);
      try {
        ws = this.socket(relay);
      } catch {
        finish(false, 'não conectou');
        return;
      }
      ws.addEventListener('open', () => ws?.send(JSON.stringify(['EVENT', event])));
      ws.addEventListener('message', (m) => {
        const msg = parse(m.data);
        if (msg && msg[0] === 'OK' && msg[1] === event.id) finish(msg[2] === true, typeof msg[3] === 'string' ? msg[3].slice(0, 200) : '');
      });
      ws.addEventListener('error', () => finish(false, 'erro de conexão'));
      ws.addEventListener('close', () => finish(false, 'conexão fechada'));
    });
  }

  /** Consulta todos, junta sem repetir, confere cada evento e para em EOSE ou no tempo. */
  async query(filter: NostrFilter): Promise<NostrEvent[]> {
    const lists = await Promise.all(this.relays().map((relay) => this.queryOne(relay, filter)));
    const seen = new Map<string, NostrEvent>();
    for (const list of lists) for (const e of list) if (!seen.has(e.id) && seen.size < MAX_EVENTS) seen.set(e.id, e);
    return [...seen.values()].sort((a, b) => a.created_at - b.created_at);
  }

  private queryOne(relay: string, filter: NostrFilter): Promise<NostrEvent[]> {
    const started = Date.now();
    const sub = `os${Math.random().toString(36).slice(2, 10)}`;
    const out: NostrEvent[] = [];
    return new Promise((resolve) => {
      let done = false;
      let ws: WsLike | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws?.send(JSON.stringify(['CLOSE', sub]));
          ws?.close();
        } catch {
          /* já fechado */
        }
        this.opts.onRequest?.(relay, Date.now() - started);
        resolve(out);
      };
      const timer = setTimeout(finish, this.timeout);
      try {
        ws = this.socket(relay);
      } catch {
        finish();
        return;
      }
      ws.addEventListener('open', () => ws?.send(JSON.stringify(['REQ', sub, { limit: MAX_EVENTS, ...filter }])));
      ws.addEventListener('message', (m) => {
        const msg = parse(m.data);
        if (!msg || msg[1] !== sub) return;
        if (msg[0] === 'EOSE') return finish();
        if (msg[0] === 'EVENT' && verifyEvent(msg[2])) {
          out.push(msg[2]);
          if (out.length >= MAX_EVENTS) finish();
        }
      });
      ws.addEventListener('error', finish);
      ws.addEventListener('close', finish);
    });
  }
}

/** Mensagem de relay: JSON em lista, até 64 KB. Qualquer outra coisa é ignorada. */
function parse(data: unknown): unknown[] | null {
  const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : String(data ?? '');
  if (text.length > MAX_MESSAGE) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
