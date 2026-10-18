import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { startServer } from './server';
import type { CoreState } from './types';

const STATE: CoreState = { rev: 3, at: 1, exchanges: [{ id: 'okx', ok: true, lastAt: 1 }], pairs: [] };
let server: http.Server | null = null;
afterEach(() => server?.close());

async function start(): Promise<string> {
  server = startServer(() => STATE, { port: 0, allowOrigins: ['http://localhost:5173'] });
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const a = server.address() as AddressInfo;
  expect(a.address).toBe('127.0.0.1');
  return `http://127.0.0.1:${a.port}`;
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
    const ok = await fetch(`${base}/v1/state`, { headers: { Origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
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
