import { describe, expect, it } from 'vitest';
import { Poller, type ExchangeLike } from './poller';

const NOW = 1_760_000_000_000;

/** Corretora falsa: mercados fixos e tickers fixos; `fail` faz o fetchTicker lançar. */
function fake(markets: Record<string, { active?: boolean; taker?: number }>, tickers: Record<string, { bid: number; ask: number }>, fail?: string): ExchangeLike {
  return {
    loadMarkets: async () => markets,
    fetchTicker: async (symbol: string) => {
      if (fail) throw new Error(fail);
      return { symbol, bid: tickers[symbol].bid, ask: tickers[symbol].ask, timestamp: NOW };
    },
  };
}

const USDC = { 'USDC/USDT': { active: true, taker: 0.001 } };

describe('Poller', () => {
  it('corretora com erro não derruba as outras; o par só entra com 2+ corretoras', async () => {
    const ex: Record<string, ExchangeLike> = {
      a: fake(USDC, { 'USDC/USDT': { bid: 1.0005, ask: 1.001 } }),
      b: fake(USDC, {}, 'Service unavailable from a restricted location'),
      c: fake(USDC, { 'USDC/USDT': { bid: 1.0013, ask: 1.0014 } }),
    };
    const p = new Poller(['a', 'b', 'c'], ['USDC/USDT'], { create: (id) => ex[id] });
    await p.pollOnce(NOW);
    const s = p.state(NOW);
    expect(s.exchanges.find((e) => e.id === 'a')).toMatchObject({ ok: true, lastAt: NOW });
    expect(s.exchanges.find((e) => e.id === 'b')).toMatchObject({ ok: false });
    expect(s.exchanges.find((e) => e.id === 'b')!.error).toContain('restricted');
    expect(s.pairs).toHaveLength(1);
    expect(s.pairs[0].quotes.map((q) => q.exchange).sort()).toEqual(['a', 'c']);
    expect(s.pairs[0].best).toMatchObject({ buyOn: 'a', sellOn: 'c' });
  });

  it('par que ninguém mais lista fica fora, sem erro (e o inativo não conta)', async () => {
    const ex: Record<string, ExchangeLike> = {
      a: fake({ ...USDC, 'DAI/USDT': { active: true, taker: 0.001 } }, { 'USDC/USDT': { bid: 1, ask: 1.001 }, 'DAI/USDT': { bid: 1, ask: 1.001 } }),
      b: fake({ ...USDC, 'DAI/USDT': { active: false, taker: 0.001 } }, { 'USDC/USDT': { bid: 1, ask: 1.001 } }),
    };
    const p = new Poller(['a', 'b'], ['USDC/USDT', 'DAI/USDT'], { create: (id) => ex[id] });
    await p.pollOnce(NOW);
    const s = p.state(NOW);
    expect(s.pairs.map((x) => x.pair)).toEqual(['USDC/USDT']);
    expect(s.exchanges.every((e) => e.ok)).toBe(true);
  });

  it('par invertido na corretora é buscado pelo símbolo dela e normalizado', async () => {
    const ex: Record<string, ExchangeLike> = {
      a: fake(USDC, { 'USDC/USDT': { bid: 1.0012, ask: 1.0013 } }),
      cb: fake({ 'USDT/USDC': { active: true, taker: 0.006 } }, { 'USDT/USDC': { bid: 0.9988, ask: 0.9989 } }),
    };
    const p = new Poller(['a', 'cb'], ['USDC/USDT'], { create: (id) => ex[id] });
    await p.pollOnce(NOW);
    const cb = p.state(NOW).pairs[0].quotes.find((q) => q.exchange === 'cb')!;
    expect(cb.inverted).toBe(true);
    expect(cb.bid).toBeCloseTo(1 / 0.9989, 8);
  });

  it('idade da cotação = quando o núcleo recebeu, não o último negócio (a Coinbase manda a hora do último trade)', async () => {
    const lastTradeLongAgo: ExchangeLike = {
      loadMarkets: async () => USDC,
      fetchTicker: async () => ({ bid: 1.0012, ask: 1.0013, timestamp: NOW - 300_000 }),
    };
    const ex: Record<string, ExchangeLike> = { a: fake(USDC, { 'USDC/USDT': { bid: 1.0012, ask: 1.0013 } }), cb: lastTradeLongAgo };
    const p = new Poller(['a', 'cb'], ['USDC/USDT'], { create: (id) => ex[id] });
    await p.pollOnce(NOW);
    expect(p.state(NOW).pairs[0].quotes.map((q) => q.exchange).sort()).toEqual(['a', 'cb']);
  });

  it('log só quando o estado da corretora muda', async () => {
    const logs: string[] = [];
    const ex: Record<string, ExchangeLike> = { b: fake(USDC, {}, 'timeout') };
    const p = new Poller(['b'], ['USDC/USDT'], { create: (id) => ex[id], log: (m) => logs.push(m) });
    for (let i = 0; i < 3; i++) await p.pollOnce(NOW + i * 10_000);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('b');
  });

  it('rev sobe quando algo muda', async () => {
    const ex: Record<string, ExchangeLike> = { a: fake(USDC, { 'USDC/USDT': { bid: 1, ask: 1.001 } }) };
    const p = new Poller(['a'], ['USDC/USDT'], { create: (id) => ex[id] });
    const before = p.state(NOW).rev;
    await p.pollOnce(NOW);
    expect(p.state(NOW).rev).toBeGreaterThan(before);
  });
});
