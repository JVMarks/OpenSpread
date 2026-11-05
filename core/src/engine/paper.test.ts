import { describe, expect, it } from 'vitest';
import type { ExecutionRequest } from './adapter';
import type { Book } from './book';
import { PaperEngine } from './paper';

const REQ: ExecutionRequest = { pair: 'BTC/USDT', buyOn: 'a', sellOn: 'b', sizeUsd: 1000, quotedAsk: 100, quotedBid: 101, buyFee: 0.001, sellFee: 0.002 };

const engine = (books: Record<string, Book | Error>, order: string[] = []) =>
  new PaperEngine(
    async (exchange) => {
      order.push(`book:${exchange}`);
      const b = books[exchange];
      if (b instanceof Error) throw b;
      return b;
    },
    {
      latencyMs: 1000,
      sleep: async (ms) => {
        order.push(`sleep:${ms}`);
      },
      now: () => 5000,
    },
  );

const deep = (bid: number, ask: number): Book => ({ bids: [[bid, 1000]], asks: [[ask, 1000]] });

describe('execução simulada', () => {
  it('espera a latência antes de ler o livro', async () => {
    const order: string[] = [];
    await engine({ a: deep(99, 100), b: deep(101, 102) }, order).execute(REQ);
    expect(order[0]).toBe('sleep:1000');
    expect(order.slice(1).sort()).toEqual(['book:a', 'book:b']);
  });

  it('lucro exato com as taxas das duas pernas', async () => {
    const r = await engine({ a: deep(99, 100), b: deep(101, 102) }).execute(REQ);
    if (!r.ok) throw new Error('devia executar');
    expect(r.base).toBe(10);
    expect(r.buyAvg).toBe(100);
    expect(r.sellAvg).toBe(101);
    // compra 1000 + 1 de taxa; venda 1010 - 2,02 de taxa
    expect(r.feesUsd).toBeCloseTo(3.02, 10);
    expect(r.pnlUsd).toBeCloseTo(6.98, 10);
    expect(r.realizedNetPct).toBeCloseTo(0.698, 10);
    expect(r.partial).toBe(false);
    expect(r.at).toBe(5000);
  });

  it('o livro piorou durante a latência: entra como prejuízo, não some', async () => {
    const r = await engine({ a: deep(100, 101), b: deep(100, 101) }).execute(REQ);
    if (!r.ok) throw new Error('devia executar');
    expect(r.pnlUsd).toBeLessThan(0);
    expect(r.realizedNetPct).toBeLessThan(0);
  });

  it('livro raso de um lado: as duas pernas com a mesma quantidade e marcada como parcial', async () => {
    const r = await engine({ a: deep(99, 100), b: { bids: [[101, 4]], asks: [] } }).execute(REQ);
    if (!r.ok) throw new Error('devia executar');
    expect(r.base).toBe(4);
    expect(r.partial).toBe(true);
    expect(r.pnlUsd).toBeCloseTo(404 * 0.998 - 400 * 1.001, 10);
  });

  it('caminha pelos níveis nas duas pernas', async () => {
    const a: Book = {
      bids: [],
      asks: [
        [100, 5],
        [100.5, 5],
      ],
    };
    const b: Book = {
      bids: [
        [101, 5],
        [100.8, 5],
      ],
      asks: [],
    };
    const r = await engine({ a, b }).execute(REQ);
    if (!r.ok) throw new Error('devia executar');
    expect(r.buyAvg).toBeCloseTo(100.25, 10);
    expect(r.sellAvg).toBeCloseTo(100.9, 10);
  });

  it('corretora sem livro: sem número', async () => {
    const r = await engine({ a: deep(99, 100), b: new Error('caiu') }).execute(REQ);
    expect(r).toEqual({ ok: false, at: 5000, code: 'book_unavailable', message: expect.stringContaining('caiu') });
  });

  it('livro vazio: sem número', async () => {
    const r = await engine({ a: { bids: [], asks: [] }, b: deep(101, 102) }).execute(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('book_unavailable');
  });

  it('tem kind paper e não expõe nada além de execute', () => {
    const e = engine({});
    expect(e.kind).toBe('paper');
  });
});
