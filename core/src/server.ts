// Servidor local do núcleo: só 127.0.0.1. GET /v1/state (JSON) e GET /v1/stream (SSE, evento "state" a cada
// mudança). CORS só para as origens do Bullroom. Sem dependências além do Node.
import http from 'node:http';
import type { CoreState } from './types';

export const DEFAULT_PORT = 4848;

export interface ServerOptions {
  port?: number;
  /** Origens que podem ler pelo navegador (o Bullroom). */
  allowOrigins?: readonly string[];
  /** De quanto em quanto tempo o stream confere se o estado mudou. */
  pushMs?: number;
}

export function startServer(getState: () => CoreState, opts: ServerOptions = {}): http.Server {
  const allow = new Set(opts.allowOrigins ?? []);
  const clients = new Set<http.ServerResponse>();
  let lastRev = -1;

  const cors = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  };
  const send = (res: http.ServerResponse, state: CoreState) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

  const server = http.createServer((req, res) => {
    cors(req, res);
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(getState()));
      return;
    }
    if (req.method === 'GET' && path === '/v1/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      send(res, getState());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  // Empurra o estado quando ele muda; um comentário a cada 15 s mantém a conexão viva.
  let beats = 0;
  const pushMs = opts.pushMs ?? 1_000;
  const timer = setInterval(() => {
    const state = getState();
    const beat = ++beats % Math.max(1, Math.round(15_000 / pushMs)) === 0;
    for (const res of clients) {
      if (state.rev !== lastRev) send(res, state);
      else if (beat) res.write(': ping\n\n');
    }
    lastRev = state.rev;
  }, pushMs);
  server.on('close', () => clearInterval(timer));
  server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1');
  return server;
}
