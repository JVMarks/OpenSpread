// Relay de teste em memória (só nos testes). Fala o básico do NIP-01 e pode se comportar mal de propósito.
import { WebSocketServer, type WebSocket } from 'ws';
import type { NostrEvent } from '../types';

export interface TestRelayOptions {
  /** Recusa toda publicação com este motivo. */
  rejectWith?: string;
  /** Não responde nada: para testar tempo esgotado. */
  silent?: boolean;
  /** Eventos extras mandados em toda consulta, mesmo inválidos. */
  inject?: unknown[];
  /** Mensagem crua extra mandada em toda consulta (ex.: uma gigante). */
  raw?: string[];
}

export class TestRelay {
  readonly events: NostrEvent[] = [];
  private server!: WebSocketServer;
  url = '';

  constructor(private readonly opts: TestRelayOptions = {}) {}

  start(): Promise<void> {
    this.server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.server.on('connection', (ws) => ws.on('message', (data) => this.handle(ws, String(data))));
    return new Promise((resolve) => this.server.once('listening', () => {
      const a = this.server.address() as { port: number };
      this.url = `ws://127.0.0.1:${a.port}`;
      resolve();
    }));
  }

  private handle(ws: WebSocket, text: string): void {
    if (this.opts.silent) return;
    const msg = JSON.parse(text) as unknown[];
    if (msg[0] === 'EVENT') {
      const e = msg[1] as NostrEvent;
      if (this.opts.rejectWith) ws.send(JSON.stringify(['OK', e.id, false, this.opts.rejectWith]));
      else {
        this.events.push(e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
      }
    } else if (msg[0] === 'REQ') {
      const sub = msg[1] as string;
      const filter = msg[2] as { ids?: string[]; '#e'?: string[]; kinds?: number[]; '#t'?: string[] };
      const match = (e: NostrEvent) =>
        (!filter.ids || filter.ids.includes(e.id)) &&
        (!filter.kinds || filter.kinds.includes(e.kind)) &&
        (!filter['#e'] || e.tags.some((t) => t[0] === 'e' && filter['#e']?.includes(t[1]))) &&
        (!filter['#t'] || e.tags.some((t) => t[0] === 't' && filter['#t']?.includes(t[1])));
      for (const e of this.events.filter(match)) ws.send(JSON.stringify(['EVENT', sub, e]));
      for (const e of this.opts.inject ?? []) ws.send(JSON.stringify(['EVENT', sub, e]));
      for (const r of this.opts.raw ?? []) ws.send(r);
      ws.send(JSON.stringify(['EOSE', sub]));
    }
  }

  stop(): Promise<void> {
    for (const c of this.server.clients) c.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
