import { describe, expect, it } from 'vitest';
import { LiveEngine, type LiveRequest } from './engine';
import { SimLiveClient, type PublicExchange } from './sim-client';

/** Corretora pública de mentira: passo de 0,0001 na quantidade e 0,1 no preço, livro fixo. */
function exchange(book: { asks: number[][]; bids: number[][] }): PublicExchange {
  return {
    markets: { 'BTC/USDT': { taker: 0.001, limits: { cost: { min: 5 } } } },
    // Como o CCXT: abaixo do passo (inclusive zero) é erro.
    amountToPrecision: (_s, a) => {
      if (Math.floor(a * 1e4) <= 0) throw new Error('amount must be greater than minimum amount precision');
      return (Math.floor(a * 1e4) / 1e4).toFixed(4);
    },
    priceToPrecision: (_s, p) => (Math.round(p * 10) / 10).toFixed(1),
    fetchOrderBook: async () => book,
  };
}
const A = exchange({ asks: [[100, 0.05], [100.2, 0.05], [101, 1]], bids: [[99.9, 1]] });
const B = exchange({ asks: [[100.5, 1]], bids: [[100.4, 0.1], [100.3, 0.1], [99, 1]] });
const req = (over: Partial<LiveRequest> = {}): LiveRequest => ({ pair: 'BTC/USDT', buyOn: 'a', sellOn: 'b', sizeUsd: 10, quotedAsk: 100, quotedBid: 100.4, buyFee: 0.001, sellFee: 0.001, maxSlippagePct: 0.3, ref: 'r'.repeat(32), ...over });
const pair = (balA = { USDT: 1000 }, balB = { BTC: 1 }) => {
  const a = new SimLiveClient('a', A, { balances: balA });
  const b = new SimLiveClient('b', B, { balances: balB });
  return { a, b, engine: new LiveEngine(new Map([['a', a], ['b', b]]), { sleep: async () => {}, settleTries: 2 }) };
};

describe('corretora simulada', () => {
  it('ordem IOC anda pelo livro dentro do preço travado, e as duas pernas fecham', async () => {
    const { a, b, engine } = pair();
    const r = await engine.execute(req());
    expect(r.status).toBe('filled');
    // 0,1 BTC: 0,05 a 100 e 0,05 a 100,2 (limite 100,3); venda 0,1 a 100,4.
    expect(a.fills[0]).toMatchObject({ side: 'buy', amount: 0.1, limit: 100.3, filled: 0.1, levels: 2 });
    expect(a.fills[0].average).toBeCloseTo(100.1, 6);
    expect(b.fills[0]).toMatchObject({ side: 'sell', filled: 0.1, average: 100.4, levels: 1 });
    expect((await a.freeBalance(new Set(['BTC']))).BTC).toBeCloseTo(0.1, 9);
  });
  it('preço fora da faixa: a perna não executa, sobra a exposição exata', async () => {
    const { engine } = pair();
    const r = await engine.execute(req({ quotedBid: 150 }));
    expect(r.status).toBe('imbalanced');
    if (r.status === 'imbalanced') expect(r.exposures).toEqual([{ exchange: 'a', pair: 'BTC/USDT', asset: 'BTC', side: 'long', amount: 0.1, price: 100 }]);
  });
  it('execução parcial do livro vira exposição da diferença', async () => {
    const thin = exchange({ asks: [[100.5, 1]], bids: [[100.4, 0.06]] });
    const a = new SimLiveClient('a', A, { balances: { USDT: 1000 } });
    const b = new SimLiveClient('b', thin, { balances: { BTC: 1 } });
    const r = await new LiveEngine(new Map([['a', a], ['b', b]]), { sleep: async () => {} }).execute(req());
    expect(r.status).toBe('imbalanced');
    if (r.status === 'imbalanced') expect(r.exposures[0].amount).toBeCloseTo(0.04, 9);
  });
  it('saldo insuficiente é recusado antes de executar, como na corretora', async () => {
    const { a, engine } = pair({ USDT: 5 });
    const r = await engine.execute(req());
    expect(r.status).toBe('imbalanced');
    expect(a.fills).toEqual([]);
  });
  it('resposta perdida: o motor acha a ordem pela consulta e não envia de novo', async () => {
    const { a, engine } = pair();
    a.failNext('lost_reply');
    const r = await engine.execute(req());
    expect(r.status).toBe('filled');
    expect(a.fills).toHaveLength(1);
  });
  it('corretora fora do ar: o motor não inventa resultado, devolve unknown', async () => {
    const { a, engine } = pair();
    a.failNext('offline');
    const r = await engine.execute(req());
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.exposures.find((e) => e.exchange === 'a')?.amount).toBeNull();
  });
  it('recusa: id repetido, ordem que não é IOC', async () => {
    const { a } = pair();
    await a.createOrder('BTC/USDT', 'limit', 'buy', 0.01, 101, { timeInForce: 'IOC', clientOrderId: 'x' });
    await expect(a.createOrder('BTC/USDT', 'limit', 'buy', 0.01, 101, { timeInForce: 'IOC', clientOrderId: 'x' })).rejects.toThrow('repetido');
    await expect(a.createOrder('BTC/USDT', 'limit', 'buy', 0.01, 101, { clientOrderId: 'y' })).rejects.toThrow('IOC');
    expect(a.classify(new Error('x'))).toBe('uncertain');
  });
  it('desfazer a exposição pela mesma corretora', async () => {
    const { engine } = pair({ USDT: 1000 }, { BTC: 1 });
    const r = await engine.execute(req({ quotedBid: 150 }));
    expect(r.status).toBe('imbalanced');
    const u = await engine.unwind({ exchange: 'a', pair: 'BTC/USDT', side: 'sell', amount: 0.1, limitPrice: 99.8, ref: 'u'.repeat(32) });
    expect(u).toMatchObject({ status: 'done', filled: 0.1 });
    if (u.status === 'done') expect(u.average).toBeCloseTo(99.9, 9);
  });
});
