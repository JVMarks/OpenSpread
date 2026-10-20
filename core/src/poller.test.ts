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

  it('reconfigure troca corretoras e pares sem reiniciar e descarta o que saiu', async () => {
    const BTC = { 'BTC/USDT': { active: true, taker: 0.001 } };
    const both = { ...USDC, ...BTC };
    const tick = { 'USDC/USDT': { bid: 1, ask: 1.001 }, 'BTC/USDT': { bid: 60_000, ask: 60_010 } };
    const ex: Record<string, ExchangeLike> = { a: fake(both, tick), b: fake(both, tick), c: fake(both, tick) };
    const p = new Poller(['a', 'b'], ['USDC/USDT'], { create: (id) => ex[id] });
    await p.pollOnce(NOW);
    const rev = p.state(NOW).rev;
    p.reconfigure(['b', 'c'], ['BTC/USDT']);
    expect(p.state(NOW).rev).toBeGreaterThan(rev);
    expect(p.state(NOW).pairs).toEqual([]);
    expect(p.state(NOW).exchanges.map((e) => e.id)).toEqual(['b', 'c']);
    await p.pollOnce(NOW + 10_000);
    const s = p.state(NOW + 10_000);
    expect(s.pairs.map((x) => x.pair)).toEqual(['BTC/USDT']);
    expect(s.pairs[0].quotes.map((q) => q.exchange).sort()).toEqual(['b', 'c']);
  });

  it('check diz o que cada corretora lista (direto, invertido, inativo, ausente) e isola a que falha', async () => {
    const ex: Record<string, ExchangeLike> = {
      a: fake({ ...USDC, 'DAI/USDT': { active: false, taker: 0.002 } }, {}),
      cb: fake({ 'USDT/USDC': { active: true, taker: 0.006 } }, {}),
      down: { loadMarkets: async () => Promise.reject(new Error('Service   unavailable')), fetchTicker: async () => ({}) },
    };
    const p = new Poller([], [], { create: (id) => ex[id] });
    const r = await p.check(['a', 'cb', 'down'], ['USDC/USDT', 'DAI/USDT'], NOW);
    expect(r.at).toBe(NOW);
    const [a, cb, down] = r.exchanges;
    expect(a.listings).toEqual([
      { pair: 'USDC/USDT', symbol: 'USDC/USDT', inverted: false, active: true, takerFee: 0.001 },
      { pair: 'DAI/USDT', symbol: 'DAI/USDT', inverted: false, active: false, takerFee: 0.002 },
    ]);
    expect(cb.listings[0]).toEqual({ pair: 'USDC/USDT', symbol: 'USDT/USDC', inverted: true, active: true, takerFee: 0.006 });
    expect(cb.listings[1].symbol).toBeNull();
    expect(down).toMatchObject({ ok: false, error: 'Service unavailable' });
    expect(down.listings.every((l) => l.symbol === null)).toBe(true);
  });

  it('check desiste da corretora que não responde a tempo', async () => {
    const hang: ExchangeLike = { loadMarkets: () => new Promise(() => {}), fetchTicker: async () => ({}) };
    const p = new Poller([], [], { create: () => hang, checkTimeoutMs: 30 });
    const r = await p.check(['slow'], ['USDC/USDT'], NOW);
    expect(r.exchanges[0]).toMatchObject({ ok: false });
    expect(r.exchanges[0].error).toContain('sem resposta');
  });

  it('rev sobe quando algo muda', async () => {
    const ex: Record<string, ExchangeLike> = { a: fake(USDC, { 'USDC/USDT': { bid: 1, ask: 1.001 } }) };
    const p = new Poller(['a'], ['USDC/USDT'], { create: (id) => ex[id] });
    const before = p.state(NOW).rev;
    await p.pollOnce(NOW);
    expect(p.state(NOW).rev).toBeGreaterThan(before);
  });
});
