import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEEP_MS, SpreadHistory } from './history';
import type { PairState } from './types';

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const pair = (netPct: number, transferNet?: number): PairState => ({
  pair: 'USDC/USDT',
  quotes: [],
  best: {
    pair: 'USDC/USDT',
    buyOn: 'bybit',
    sellOn: 'binance',
    grossPct: 0,
    netPct,
    ...(transferNet !== undefined ? { transfer: { asset: 'USDC', from: 'bybit', sizeUsd: 1000, fee: 1, costPct: 0.1, netPct: transferNet } } : {}),
  },
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('histórico do spread em janelas de tempo', () => {
  it('sem histórico suficiente, a janela fica vazia (nada de "24 h" com 10 minutos de dados)', () => {
    const h = new SpreadHistory();
    for (let i = 0; i <= 10; i++) h.record([pair(-0.2)], T0 + i * MIN);
    const w = h.windows('USDC/USDT', T0 + 10 * MIN);
    expect(w['5m']).not.toBeNull();
    expect(w['1h']).toBeNull();
    expect(w['24h']).toBeNull();
  });

  it('variação = agora menos o líquido de uma janela atrás; mínimo e máximo dentro dela', () => {
    const h = new SpreadHistory();
    // 70 minutos: começa em -0,30, cai a -0,40 no minuto 20, sobe a -0,10 no fim
    for (let i = 0; i <= 70; i++) h.record([pair(i === 20 ? -0.4 : i < 60 ? -0.3 : -0.1)], T0 + i * MIN);
    const w = h.windows('USDC/USDT', T0 + 70 * MIN);
    expect(w['5m']).toEqual({ changePp: 0, min: -0.1, max: -0.1 });
    expect(w['1h']).toEqual({ changePp: 0.2, min: -0.4, max: -0.1 });
  });

  it('uma amostra por minuto: a última leitura do minuto vale', () => {
    const h = new SpreadHistory();
    h.record([pair(-0.2)], T0);
    h.record([pair(-0.5)], T0 + 20_000);
    for (let i = 1; i <= 6; i++) h.record([pair(-0.1)], T0 + i * MIN);
    // o minuto 0 guardou -0,5 (a última leitura dele), não -0,2: cinco minutos depois a variação é -0,1 − (−0,5)
    expect(h.windows('USDC/USDT', T0 + 5 * MIN)['5m']).toEqual({ changePp: 0.4, min: -0.5, max: -0.1 });
    // um minuto mais tarde a janela já começa no minuto 1 (-0,1): sem variação
    expect(h.windows('USDC/USDT', T0 + 6 * MIN)['5m']!.changePp).toBe(0);
  });

  it('usa o líquido com saque quando ele foi estimado', () => {
    const h = new SpreadHistory();
    for (let i = 0; i <= 5; i++) h.record([pair(-0.2, i < 5 ? -0.3 : -0.25)], T0 + i * MIN);
    expect(h.windows('USDC/USDT', T0 + 5 * MIN)['5m']!.changePp).toBe(0.05);
  });

  it('salva e lê de volta; descarta o que passou de 25 h e aguenta arquivo quebrado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openspread-hist-'));
    dirs.push(dir);
    const file = join(dir, 'h', 'history.json');
    const a = new SpreadHistory();
    a.record([pair(-0.9)], T0 - KEEP_MS - MIN);
    for (let i = 0; i <= 5; i++) a.record([pair(-0.2)], T0 + i * MIN);
    a.save(file);
    const b = new SpreadHistory();
    b.load(file, T0 + 5 * MIN);
    expect(b.windows('USDC/USDT', T0 + 5 * MIN)['5m']).toEqual({ changePp: 0, min: -0.2, max: -0.2 });
    expect(b.windows('USDC/USDT', T0 + 5 * MIN)['24h']).toBeNull(); // a amostra de 25 h atrás saiu
    writeFileSync(file, '{ quebrado', 'utf8');
    const c = new SpreadHistory();
    expect(() => c.load(file, T0)).not.toThrow();
  });

  it('apply acrescenta as janelas sem mudar o resto do par', () => {
    const h = new SpreadHistory();
    const out = h.apply([pair(-0.2)], T0);
    expect(out[0].windows).toEqual({ '5m': null, '1h': null, '24h': null });
    expect(out[0].best!.netPct).toBe(-0.2);
  });
});
