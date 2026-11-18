import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLiveConfig } from './config';
import { HARD_LIMITS } from './limits';

const valid = () => ({
  sandbox: true,
  routes: [{ pair: 'BTC/USDT', exchanges: ['binance', 'bybit'] }],
  maxTradeUsd: 20,
  minNetPct: 0.05,
  maxQuoteAgeMs: 20_000,
  dailyLossLimitUsd: 10,
  tradesPerDay: 5,
  maxSlippagePct: 0.1,
});
const ON = { OPENSPREAD_LIVE: '1' };
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-'));
  file = join(dir, 'live.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (v: unknown) => writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
const off = (over: object) => {
  write({ ...valid(), ...over });
  const r = loadLiveConfig(file, ON);
  if (!('off' in r)) throw new Error('devia desligar');
  return r.off;
};

describe('loadLiveConfig', () => {
  it('sem OPENSPREAD_LIVE=1 fica desligado mesmo com arquivo certo', () => {
    write(valid());
    expect(loadLiveConfig(file, {})).toHaveProperty('off');
    expect(loadLiveConfig(file, { OPENSPREAD_LIVE: 'true' })).toHaveProperty('off');
  });
  it('sem arquivo fica desligado e diz o que falta', () => {
    expect(loadLiveConfig(file, ON)).toMatchObject({ off: expect.stringContaining('live.json') });
  });
  it('arquivo certo e chave ligada: armado', () => {
    write(valid());
    expect(loadLiveConfig(file, ON)).toMatchObject({ sandbox: true, maxTradeUsd: 20, routes: [{ pair: 'BTC/USDT' }] });
  });
  it('sandbox precisa ser dito: ausente recusa, para o real nunca ser o padrão por engano', () => {
    const { sandbox: _s, ...rest } = valid();
    write(rest);
    expect(loadLiveConfig(file, ON)).toHaveProperty('off');
  });
  it('JSON quebrado desliga e avisa', () => {
    write('{ nada');
    expect(loadLiveConfig(file, ON)).toMatchObject({ off: expect.stringContaining('JSON') });
  });
  it('campo desconhecido recusa', () => {
    expect(off({ apiKey: 'x' })).toContain('apiKey');
  });
  it('nada passa dos tetos do código', () => {
    expect(off({ maxTradeUsd: HARD_LIMITS.maxTradeUsd + 1 })).toContain('maxTradeUsd');
    expect(off({ dailyLossLimitUsd: HARD_LIMITS.dailyLossLimitUsd + 1 })).toContain('dailyLossLimitUsd');
    expect(off({ tradesPerDay: HARD_LIMITS.tradesPerDay + 1 })).toContain('tradesPerDay');
    expect(off({ maxSlippagePct: HARD_LIMITS.maxSlippagePct + 0.1 })).toContain('maxSlippagePct');
  });
  it('recusa valores que não fazem sentido', () => {
    expect(off({ maxTradeUsd: 0 })).toContain('maxTradeUsd');
    expect(off({ dailyLossLimitUsd: -1 })).toContain('dailyLossLimitUsd');
    expect(off({ minNetPct: -0.5 })).toContain('minNetPct');
    expect(off({ tradesPerDay: 1.5 })).toContain('tradesPerDay');
  });
  it('rota só nas corretoras permitidas, com duas diferentes', () => {
    expect(off({ routes: [{ pair: 'BTC/USDT', exchanges: ['binance', 'kraken'] }] })).toContain('kraken');
    expect(off({ routes: [{ pair: 'BTC/USDT', exchanges: ['binance', 'binance'] }] })).toContain('diferentes');
    expect(off({ routes: [] })).toContain('routes');
    expect(off({ routes: [{ pair: 'btc', exchanges: ['binance', 'okx'] }] })).toContain('btc');
  });
});
