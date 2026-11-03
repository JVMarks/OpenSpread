import { describe, expect, it } from 'vitest';
import { ccxtLimitPerMin, machineState, sourceLevel, Usage } from './machine';
import { Poller, type ExchangeLike } from './poller';

describe('sala de máquinas', () => {
  it('conta pedidos só do último minuto e guarda a latência do último', () => {
    const u = new Usage();
    u.record('okx', 0, 100);
    u.record('okx', 30_000, 140);
    u.record('okx', 61_000, 90);
    expect(u.perMinute('okx', 61_000)).toBe(2);
    expect(u.perMinute('okx', 200_000)).toBe(0);
    expect(u.lastLatency('okx')).toBe(90);
    expect(u.perMinute('nada', 0)).toBe(0);
  });

  it('limite da CCXT em pedidos por minuto', () => {
    expect(ccxtLimitPerMin(50)).toBe(1200);
    expect(ccxtLimitPerMin(1000)).toBe(60);
    expect(ccxtLimitPerMin(undefined)).toBeNull();
  });

  it('monta o estado: memória, corretoras e redes on-chain com limite conhecido; nível do LED', () => {
    const u = new Usage();
    for (let i = 0; i < 50; i++) u.record('kraken', 1_000 + i, 300);
    u.record('api.mainnet-beta.solana.com', 1_000, 420);
    const m = machineState({
      now: 2_000,
      cpuPct: 7.5,
      exchanges: [
        { id: 'kraken', ok: true, lastAt: 1 },
        { id: 'okx', ok: false, error: 'timeout' },
      ],
      rateLimits: { kraken: 1000, okx: 110 },
      chains: [
        { chain: 'solana', source: 'api.mainnet-beta.solana.com', ok: false, error: 'limite', backoffUntil: 60_000 },
        { chain: 'bitcoin', source: 'mempool.space', ok: true },
      ],
      usage: u,
      mem: { rss: 200 * 1024 * 1024, heapUsed: 80 * 1024 * 1024 },
      sys: { total: 16, free: 4 },
      uptimeS: 3600,
    });
    expect(m).toMatchObject({ at: 2_000, cpuPct: 7.5, rssMb: 200, heapMb: 80, sysMemPct: 75, uptimeS: 3600 });
    expect(m.sources).toEqual([
      { id: 'kraken', kind: 'exchange', ok: true, latencyMs: 300, perMin: 50, limitPerMin: 60 },
      { id: 'okx', kind: 'exchange', ok: false, error: 'timeout', perMin: 0, limitPerMin: 545 },
      { id: 'api.mainnet-beta.solana.com', kind: 'chain', chain: 'solana', ok: false, error: 'limite', latencyMs: 420, perMin: 1, limitPerMin: 600, backoffUntil: 60_000 },
      { id: 'mempool.space', kind: 'chain', chain: 'bitcoin', ok: true, perMin: 0, limitPerMin: null },
    ]);
    expect(m.sources.map((s) => sourceLevel(s, 2_000))).toEqual(['warn', 'down', 'warn', 'ok']);
  });

  it('o Poller avisa cada pedido à corretora (para contar o uso)', async () => {
    const seen: string[] = [];
    const ex: ExchangeLike = {
      rateLimit: 100,
      loadMarkets: async () => ({ 'USDC/USDT': { active: true, taker: 0.001 } }),
      fetchTicker: async () => ({ bid: 1, ask: 1.001 }),
    };
    const p = new Poller(['okx'], ['USDC/USDT'], { create: () => ex, onRequest: (id) => seen.push(id) });
    await p.pollOnce(1);
    expect(seen).toEqual(['okx', 'okx']);
    expect(p.rateLimits()).toEqual({ okx: 100 });
  });
});
