import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { startServer, type ConfigHandlers } from './server';
import { DEFAULT_CONFIG, LIMITS, validateConfig } from './config';
import type { CoreConfig, CoreState } from './types';

const STATE: CoreState = { rev: 3, at: 1, exchanges: [{ id: 'okx', ok: true, lastAt: 1 }], pairs: [] };
const BULLROOM = 'http://localhost:5173';
let server: http.Server | null = null;
afterEach(() => server?.close());

async function start(config?: ConfigHandlers): Promise<string> {
  server = startServer(() => STATE, { port: 0, allowOrigins: [BULLROOM], config });
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const a = server.address() as AddressInfo;
  expect(a.address).toBe('127.0.0.1');
  return `http://127.0.0.1:${a.port}`;
}

/** Handlers falsos que registram o que foi salvo e conferido. */
function handlers() {
  const saved: CoreConfig[] = [];
  const checked: CoreConfig[] = [];
  let current: CoreConfig = { ...DEFAULT_CONFIG };
  let release: (() => void) | null = null;
  const h: ConfigHandlers & { slow: boolean } = {
    slow: false,
    info: () => ({ config: current, limits: { ...LIMITS }, known: ['binance', 'okx', 'kucoin'] }),
    validate: (raw) => validateConfig(raw, ['binance', 'okx', 'kucoin']),
    check: async (c) => {
      checked.push(c);
      if (h.slow) await new Promise<void>((r) => (release = r));
      return { at: 1, exchanges: [] };
    },
    save: (c) => {
      saved.push(c);
      current = c;
    },
  };
  return { h, saved, checked, release: () => release?.() };
}

const put = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Pedido com cabeçalho Host trocado (o fetch não deixa mudar o Host). */
function rawRequest(base: string, host: string): Promise<number> {
  const u = new URL(`${base}/v1/config`);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('servidor local do núcleo', () => {
  it('GET /v1/state devolve o estado; rota desconhecida = 404', async () => {
    const base = await start();
    const r = await fetch(`${base}/v1/state`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(STATE);
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });

  it('CORS só para a origem do Bullroom', async () => {
    const base = await start();
    const ok = await fetch(`${base}/v1/state`, { headers: { Origin: BULLROOM } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(BULLROOM);
    const other = await fetch(`${base}/v1/state`, { headers: { Origin: 'https://site-qualquer.com' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('GET /v1/stream manda o evento "state" logo ao conectar', async () => {
    const base = await start();
    const ac = new AbortController();
    const r = await fetch(`${base}/v1/stream`, { signal: ac.signal });
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: state');
    expect(text).toContain(`"rev":3`);
    ac.abort();
  });
});

describe('rotas de configuração', () => {
  it('sem handlers, as rotas não existem (404)', async () => {
    const base = await start();
    expect((await fetch(`${base}/v1/config`)).status).toBe(404);
  });

  it('GET /v1/config devolve configuração, limites e corretoras conhecidas', async () => {
    const { h } = handlers();
    const base = await start(h);
    const r = await fetch(`${base}/v1/config`, { headers: { Origin: BULLROOM } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(BULLROOM);
    const body = await r.json();
    expect(body.config).toEqual(DEFAULT_CONFIG);
    expect(body.limits).toEqual(LIMITS);
    expect(body.known).toContain('kucoin');
  });

  it('PUT /v1/config valida, normaliza, salva e devolve a configuração nova', async () => {
    const { h, saved } = handlers();
    const base = await start(h);
    const r = await put(base, { exchanges: ['Binance', 'kucoin'], pairs: ['btc/usdt'], pollMs: 20_000 }, { Origin: BULLROOM });
    expect(r.status).toBe(200);
    expect(saved).toEqual([{ exchanges: ['binance', 'kucoin'], pairs: ['BTC/USDT'], pollMs: 20_000, alerts: [] }]);
    expect((await r.json()).config.pairs).toEqual(['BTC/USDT']);
  });

  it('PUT inválido = 422 com os motivos, e nada é salvo', async () => {
    const { h, saved } = handlers();
    const base = await start(h);
    const r = await put(base, { exchanges: ['binance', 'fakex'], pairs: ['BTC/USDT'], apiKey: 'x' });
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.error).toBe('invalid_config');
    expect(body.details.join()).toContain('fakex');
    expect(body.details.join()).toContain('apiKey');
    expect(saved).toEqual([]);
  });

  it('recusa origem de outro site, Host de fora, corpo que não é JSON, JSON quebrado e corpo grande', async () => {
    const { h, saved } = handlers();
    const base = await start(h);
    const ok = { exchanges: ['binance', 'okx'], pairs: ['BTC/USDT'] };
    expect((await put(base, ok, { Origin: 'https://site-qualquer.com' })).status).toBe(403);
    expect(await rawRequest(base, 'evil.example.com')).toBe(403);
    expect(await rawRequest(base, `localhost:${new URL(base).port}`)).toBe(200);
    const form = await fetch(`${base}/v1/config`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(ok) });
    expect(form.status).toBe(415);
    const broken = await fetch(`${base}/v1/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"exchanges":' });
    expect(broken.status).toBe(400);
    const big = await put(base, { ...ok, pad: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
    expect(saved).toEqual([]);
  });

  it('preflight OPTIONS só para a origem do Bullroom; método errado = 405', async () => {
    const { h } = handlers();
    const base = await start(h);
    const pre = await fetch(`${base}/v1/config`, { method: 'OPTIONS', headers: { Origin: BULLROOM } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('PUT');
    expect((await fetch(`${base}/v1/config`, { method: 'OPTIONS', headers: { Origin: 'https://site-qualquer.com' } })).status).toBe(403);
    expect((await fetch(`${base}/v1/config`, { method: 'DELETE' })).status).toBe(405);
  });

  it('POST /v1/check confere sem salvar e só uma conferência por vez (429)', async () => {
    const { h, saved, checked, release } = handlers();
    const base = await start(h);
    const body = JSON.stringify({ exchanges: ['binance', 'okx'], pairs: ['ETH/USDT'] });
    const post = () => fetch(`${base}/v1/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    h.slow = true;
    const first = post();
    await new Promise((r) => setTimeout(r, 50));
    expect((await post()).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect(checked).toHaveLength(1);
    expect(checked[0].pairs).toEqual(['ETH/USDT']);
    expect(saved).toEqual([]);
  });
});
