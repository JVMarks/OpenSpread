// Servidor local do núcleo: só 127.0.0.1. GET /v1/state (JSON) e GET /v1/stream (SSE, evento "state" a cada
// mudança). CORS só para as origens do Bullroom. Sem dependências além do Node.
// Configuração (quando ligada): GET /v1/config, POST /v1/check (confere sem gravar) e PUT /v1/config (grava e aplica).
// Essas rotas exigem Host local (contra DNS rebinding), Origin da lista quando vier, JSON e corpo pequeno.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Validation } from './config';
import type { CheckResult, ConfigInfo, CoreConfig, CoreState } from './types';

export const DEFAULT_PORT = 4848;
const MAX_BODY = 16 * 1024;

/** O que o servidor precisa para as rotas de configuração (main.ts liga no Poller e no arquivo). */
export interface ConfigHandlers {
  info(): ConfigInfo;
  validate(raw: unknown): Validation;
  check(config: CoreConfig): Promise<CheckResult>;
  save(config: CoreConfig): Promise<void> | void;
}

export interface ServerOptions {
  port?: number;
  /** Origens que podem ler pelo navegador (o Bullroom). */
  allowOrigins?: readonly string[];
  /** De quanto em quanto tempo o stream confere se o estado mudou. */
  pushMs?: number;
  /** Sem isto, as rotas de configuração respondem 404. */
  config?: ConfigHandlers;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: string[],
  ) {
    super(code);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'json_required'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    // Passou do limite: responde 413 e só descarta o resto (destruir a conexão impediria a resposta de chegar).
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        reject(new HttpError(413, 'body_too_large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer(getState: () => CoreState, opts: ServerOptions = {}): http.Server {
  const allow = new Set(opts.allowOrigins ?? []);
  const clients = new Set<http.ServerResponse>();
  let lastRev = -1;
  let checking = false;

  const cors = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  };
  const send = (res: http.ServerResponse, state: CoreState) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** Host local na porta do núcleo e, se o navegador mandou Origin, uma origem da lista. */
  const guard = (req: http.IncomingMessage) => {
    const port = (server.address() as AddressInfo).port;
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'host_not_allowed');
    const origin = req.headers.origin;
    if (origin && !allow.has(origin)) throw new HttpError(403, 'origin_not_allowed');
  };

  const handleConfig = async (req: http.IncomingMessage, res: http.ServerResponse, path: string, cfg: ConfigHandlers) => {
    guard(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      res.end();
      return;
    }
    if (path === '/v1/config' && req.method === 'GET') return json(res, 200, cfg.info());
    if (path === '/v1/check' && req.method === 'POST') {
      const v = cfg.validate(await readJson(req));
      if (!v.ok) throw new HttpError(422, 'invalid_config', v.errors);
      if (checking) throw new HttpError(429, 'check_in_progress');
      checking = true;
      try {
        return json(res, 200, await cfg.check(v.config));
      } finally {
        checking = false;
      }
    }
    if (path === '/v1/config' && req.method === 'PUT') {
      const v = cfg.validate(await readJson(req));
      if (!v.ok) throw new HttpError(422, 'invalid_config', v.errors);
      await cfg.save(v.config);
      return json(res, 200, cfg.info());
    }
    throw new HttpError(405, 'method_not_allowed');
  };

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
    if (opts.config && (path === '/v1/config' || path === '/v1/check')) {
      handleConfig(req, res, path, opts.config).catch((e: unknown) => {
        if (res.headersSent) return;
        if (e instanceof HttpError) json(res, e.status, { error: e.code, ...(e.details ? { details: e.details } : {}) });
        else json(res, 500, { error: 'internal', details: [(e as Error).message] });
      });
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
