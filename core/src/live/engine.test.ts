import { describe, expect, it } from 'vitest';
import { LiveEngine, type LiveClient, type LiveOrder, type LiveRequest } from './engine';

class Uncertain extends Error {}
class Rejected extends Error {}

/** Corretora falsa: cada perna segue um roteiro. */
class FakeClient implements LiveClient {
  created: Array<{ symbol: string; type: string; side: string; amount: number; price: number; params: Record<string, unknown> }> = [];
  place: () => void = () => {};
  order: Partial<LiveOrder> | null = { status: 'closed', filled: 0.001, average: 100, fee: { cost: 0.1, currency: 'USDT' } };
  finds = 0;
  constructor(readonly step = 0.001) {}
  amountToPrecision(_s: string, n: number) {
    return String(Math.floor(n / this.step) * this.step);
  }
  priceToPrecision(_s: string, n: number) {
    return String(Math.round(n * 100) / 100);
  }
  createOrder(symbol: string, type: string, side: string, amount: number, price: number, params: Record<string, unknown>) {
    this.created.push({ symbol, type, side, amount, price, params });
    this.place();
    return Promise.resolve({ id: `o${this.created.length}` });
  }
  findOrder(_s: string, clientOrderId: string) {
    this.finds += 1;
    return Promise.resolve(this.order ? ({ id: 'x', clientOrderId, status: 'closed', filled: 0, average: 0, ...this.order } as LiveOrder) : null);
  }
  classify(e: unknown): 'rejected' | 'uncertain' {
    return e instanceof Rejected ? 'rejected' : 'uncertain';
  }
  describe(e: unknown) {
    return (e as Error).message;
  }
}

const REQ: LiveRequest = { pair: 'BTC/USDT', buyOn: 'a', sellOn: 'b', sizeUsd: 0.1, quotedAsk: 100, quotedBid: 101, buyFee: 0.001, sellFee: 0.001, maxSlippagePct: 0.1, ref: 'f'.repeat(64) };
const setup = () => {
  const a = new FakeClient();
  const b = new FakeClient();
  b.order = { status: 'closed', filled: 0.001, average: 101, fee: { cost: 0.1, currency: 'USDT' } };
  return { a, b, engine: new LiveEngine(new Map([['a', a], ['b', b]]), { sleep: () => Promise.resolve(), settleTries: 3, now: () => 7 }) };
};

describe('as ordens', () => {
  it('tamanho abaixo do passo, quando a corretora lança erro como o CCXT: nada sai, sem parada', async () => {
    const { a, b, engine } = setup();
    a.amountToPrecision = () => {
      throw new Error('amount must be greater than minimum amount precision');
    };
    const r = await engine.execute(REQ);
    expect(r).toEqual({ status: 'no_fill', at: 7, reasons: ['Tamanho abaixo do passo mínimo da corretora.'] });
    expect(a.created).toEqual([]);
    expect(b.created).toEqual([]);
  });
  it('duas IOC limitadas, uma em cada corretora, com preço travado; nunca a mercado', async () => {
    const { a, b, engine } = setup();
    await engine.execute(REQ);
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(1);
    expect(a.created[0]).toMatchObject({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: 0.001, price: 100.1, params: { timeInForce: 'IOC' } });
    expect(b.created[0]).toMatchObject({ type: 'limit', side: 'sell', amount: 0.001, price: 100.9, params: { timeInForce: 'IOC' } });
  });
  it('quantidade arredonda para o passo mais grosso das duas', async () => {
    const { a, b, engine } = setup();
    a.order = { status: 'closed', filled: 0.01, average: 100 };
    b.order = { status: 'closed', filled: 0.01, average: 101 };
    const coarse = new FakeClient(0.01);
    coarse.order = b.order;
    const e = new LiveEngine(new Map([['a', a], ['b', coarse]]), { sleep: () => Promise.resolve(), settleTries: 3, now: () => 7 });
    await e.execute({ ...REQ, sizeUsd: 1.59 });
    expect(a.created[0].amount).toBe(coarse.created[0].amount);
    expect(a.created[0].amount).toBeCloseTo(0.01);
    void engine;
  });
  it('id próprio derivado da impressão digital, aceito pelas três corretoras, diferente por perna', async () => {
    const { a, b, engine } = setup();
    await engine.execute(REQ);
    const [x, y] = [a.created[0].params.clientOrderId as string, b.created[0].params.clientOrderId as string];
    for (const id of [x, y]) expect(id).toMatch(/^[a-zA-Z0-9]{8,32}$/);
    expect(x).not.toBe(y);
  });
  it('tamanho pequeno demais não envia nada', async () => {
    const { a, b, engine } = setup();
    const r = await engine.execute({ ...REQ, sizeUsd: 0.01 });
    expect(r.status).toBe('no_fill');
    expect(a.created).toHaveLength(0);
    expect(b.created).toHaveLength(0);
  });
  it('corretora sem cliente não envia nenhuma perna', async () => {
    const { a, engine } = setup();
    await expect(engine.execute({ ...REQ, sellOn: 'nada' })).resolves.toMatchObject({ status: 'no_fill' });
    expect(a.created).toHaveLength(0);
  });
});

describe('os resultados', () => {
  it('as duas executam: resultado com a taxa real da execução', async () => {
    const { engine } = setup();
    const r = await engine.execute(REQ);
    expect(r).toMatchObject({ status: 'filled', base: 0.001, buyAvg: 100, sellAvg: 101, partial: false, feeEstimated: false });
    if (r.status !== 'filled') throw new Error();
    expect(r.feesUsd).toBeCloseTo(0.2);
    expect(r.pnlUsd).toBeCloseTo(0.001 - 0.2);
  });
  it('taxa em outra moeda ou ausente: usa a pública e avisa', async () => {
    const { a, b, engine } = setup();
    a.order = { status: 'closed', filled: 0.001, average: 100, fee: { cost: 0.0001, currency: 'BNB' } };
    b.order = { status: 'closed', filled: 0.001, average: 101 };
    const r = await engine.execute(REQ);
    expect(r).toMatchObject({ status: 'filled', feeEstimated: true });
    if (r.status === 'filled') expect(r.feesUsd).toBeCloseTo(0.1 * 0.001 + 0.101 * 0.001);
  });
  it('taxa em moeda-base vira dólar pelo preço médio', async () => {
    const { a, engine } = setup();
    a.order = { status: 'closed', filled: 0.001, average: 100, fee: { cost: 0.000001, currency: 'BTC' } };
    const r = await engine.execute(REQ);
    if (r.status !== 'filled') throw new Error(r.status);
    expect(r.feesUsd).toBeCloseTo(0.0001 + 0.1);
    expect(r.feeEstimated).toBe(false);
  });
  it('uma perna recusada: exposição exata na outra', async () => {
    const { b, engine } = setup();
    b.place = () => {
      throw new Rejected('saldo insuficiente');
    };
    const r = await engine.execute(REQ);
    expect(r).toMatchObject({ status: 'imbalanced', exposures: [{ exchange: 'a', asset: 'BTC', side: 'long', amount: 0.001 }] });
  });
  it('a de venda executa e a de compra não: exposição curta', async () => {
    const { a, engine } = setup();
    a.place = () => {
      throw new Rejected('não');
    };
    expect(await engine.execute(REQ)).toMatchObject({ status: 'imbalanced', exposures: [{ exchange: 'b', side: 'short', amount: 0.001 }] });
  });
  it('as duas recusadas: nada aconteceu, sem exposição', async () => {
    const { a, b, engine } = setup();
    a.place = b.place = () => {
      throw new Rejected('não');
    };
    expect(await engine.execute(REQ)).toMatchObject({ status: 'no_fill', reasons: ['a: não', 'b: não'] });
  });
  it('as duas sem execução (IOC cancelada): sem exposição', async () => {
    const { a, b, engine } = setup();
    a.order = b.order = { status: 'canceled', filled: 0 };
    expect(await engine.execute(REQ)).toMatchObject({ status: 'no_fill' });
  });
  it('parcial de 60% contra 100%: casa o que deu e mostra a sobra', async () => {
    const { a, engine } = setup();
    a.order = { status: 'canceled', filled: 0.0006, average: 100 };
    const r = await engine.execute(REQ);
    expect(r).toMatchObject({ status: 'imbalanced', matched: { base: 0.0006 } });
    if (r.status !== 'imbalanced') throw new Error();
    expect(r.exposures).toHaveLength(1);
    expect(r.exposures[0]).toMatchObject({ exchange: 'b', side: 'short' });
    expect(r.exposures[0].amount).toBeCloseTo(0.0004);
  });
  it('parcial igual nas duas pernas não é exposição', async () => {
    const { a, b, engine } = setup();
    a.order = { status: 'canceled', filled: 0.0005, average: 100 };
    b.order = { status: 'canceled', filled: 0.0005, average: 101 };
    expect(await engine.execute(REQ)).toMatchObject({ status: 'filled', partial: true, base: 0.0005 });
  });
});

describe('tempo esgotado', () => {
  it('ordem achada depois: vale o que ela diz, sem reenviar', async () => {
    const { a, b, engine } = setup();
    a.place = () => {
      throw new Uncertain('tempo esgotado');
    };
    const r = await engine.execute(REQ);
    expect(r.status).toBe('filled');
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(1);
  });
  it('ordem não achada: unknown, e nunca reenvia', async () => {
    const { a, engine } = setup();
    a.place = () => {
      throw new Uncertain('tempo esgotado');
    };
    a.order = null;
    const r = await engine.execute(REQ);
    expect(r).toMatchObject({ status: 'unknown', exposures: [{ exchange: 'a', amount: null }, { exchange: 'b', side: 'short', amount: 0.001 }] });
    expect(a.created).toHaveLength(1);
    expect(a.finds).toBe(3);
  });
  it('ordem que continua aberta depois das tentativas: unknown', async () => {
    const { a, engine } = setup();
    a.order = { status: 'open', filled: 0 };
    expect((await engine.execute(REQ)).status).toBe('unknown');
  });
  it('erro ao consultar conta como dúvida, sem derrubar', async () => {
    const { a, engine } = setup();
    a.findOrder = () => Promise.reject(new Error('rede'));
    expect((await engine.execute(REQ)).status).toBe('unknown');
  });
});

describe('reconciliar e desfazer', () => {
  it('reconcile só consulta, nunca cria ordem', async () => {
    const { a, b, engine } = setup();
    const r = await engine.reconcile(REQ);
    expect(r.status).toBe('filled');
    expect(a.created).toHaveLength(0);
    expect(b.created).toHaveLength(0);
  });
  it('desfazer é uma ordem IOC só, com preço travado', async () => {
    const { a, b, engine } = setup();
    const r = await engine.unwind({ exchange: 'a', pair: 'BTC/USDT', side: 'sell', amount: 0.001, limitPrice: 99, ref: 'e'.repeat(64) });
    expect(a.created).toHaveLength(1);
    expect(a.created[0]).toMatchObject({ type: 'limit', side: 'sell', amount: 0.001, price: 99, params: { timeInForce: 'IOC' } });
    expect(b.created).toHaveLength(0);
    expect(r).toMatchObject({ status: 'done', filled: 0.001 });
  });
  it('desfazer recusado volta como recusado; dúvida volta como unknown', async () => {
    const { a, engine } = setup();
    a.place = () => {
      throw new Rejected('não');
    };
    const args = { exchange: 'a', pair: 'BTC/USDT', side: 'sell' as const, amount: 0.001, limitPrice: 99, ref: 'e'.repeat(64) };
    expect(await engine.unwind(args)).toMatchObject({ status: 'rejected', filled: 0 });
    a.place = () => {
      throw new Uncertain('x');
    };
    a.order = null;
    expect((await engine.unwind(args)).status).toBe('unknown');
  });
});
