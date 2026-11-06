import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSandbox } from './probe';
import { LiveRuntime } from './runtime';

const LIVE = { sandbox: true, routes: [{ pair: 'BTC/USDT', exchanges: ['binance', 'bybit'] }], maxTradeUsd: 20, minNetPct: 0.05, maxQuoteAgeMs: 20000, dailyLossLimitUsd: 10, tradesPerDay: 3, maxSlippagePct: 0.1 };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rt-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const STATE = { rev: 1, at: 1, exchanges: [], pairs: [] };

describe('LiveRuntime desligado', () => {
  it('sem OPENSPREAD_LIVE=1: diz por quê, e toda ação responde 409', async () => {
    const r = new LiveRuntime(dir, {}, () => {});
    await r.start();
    expect(r.state()).toMatchObject({ armed: false, off: expect.stringContaining('OPENSPREAD_LIVE') });
    expect(r.brief()).toMatchObject({ armed: false, halted: false, exposures: 0, ticketOpen: false });
    expect(r.stop().status).toBe(409);
    expect(r.reject('x').status).toBe(409);
    expect(r.release({}).status).toBe(409);
    expect(r.unwind({ index: 0 }, STATE).status).toBe(409);
    expect(r.registrationChallenge().status).toBe(409);
    expect(r.register({}).status).toBe(409);
    expect(r.approve('x', {}, STATE)).toMatchObject({ status: 409 });
  });
  it('ligado sem chave: não arma e diz qual falta, sem abrir conexão', async () => {
    writeFileSync(join(dir, 'live.json'), JSON.stringify(LIVE));
    const r = new LiveRuntime(dir, { OPENSPREAD_LIVE: '1' }, () => {});
    await r.start();
    expect(r.state()).toMatchObject({ armed: false, sandbox: true, off: expect.stringContaining('binance') });
  });
});

describe('a prova do ambiente de teste', () => {
  it('recusa dinheiro real e config desligado', () => {
    expect(() => assertSandbox({ ...LIVE, sandbox: false } as never)).toThrow('sandbox');
    expect(() => assertSandbox({ off: 'desligado' })).toThrow('desligado');
    expect(assertSandbox(LIVE as never).sandbox).toBe(true);
  });
});
