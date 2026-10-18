import { describe, expect, it } from 'vitest';
import { bestOpportunity, freshQuotes, normalizeQuote } from './spread';
import type { Quote } from './types';

const NOW = 1_760_000_000_000;
const q = (exchange: string, bid: number, ask: number, takerFee = 0.001, at = NOW): Quote => ({ exchange, pair: 'USDC/USDT', bid, ask, takerFee, at, inverted: false });

describe('normalizeQuote', () => {
  it('par direto passa igual', () => {
    expect(normalizeQuote({ exchange: 'okx', symbol: 'USDC/USDT', bid: 1.0012, ask: 1.0013, takerFee: 0.0015, at: NOW }, 'USDC/USDT')).toEqual({
      exchange: 'okx', pair: 'USDC/USDT', bid: 1.0012, ask: 1.0013, takerFee: 0.0015, at: NOW, inverted: false,
    });
  });

  it('par invertido: preço = 1/preço, bid e ask trocados', () => {
    const r = normalizeQuote({ exchange: 'coinbaseexchange', symbol: 'USDT/USDC', bid: 0.9988, ask: 0.9989, takerFee: 0.006, at: NOW }, 'USDC/USDT')!;
    expect(r.inverted).toBe(true);
    expect(r.bid).toBeCloseTo(1 / 0.9989, 8);
    expect(r.ask).toBeCloseTo(1 / 0.9988, 8);
    expect(r.bid).toBeLessThan(r.ask);
  });

  it('outro par ou preço inválido: null', () => {
    expect(normalizeQuote({ exchange: 'x', symbol: 'BTC/USDT', bid: 1, ask: 1, takerFee: 0, at: NOW }, 'USDC/USDT')).toBeNull();
    expect(normalizeQuote({ exchange: 'x', symbol: 'USDC/USDT', bid: 0, ask: 1, takerFee: 0, at: NOW }, 'USDC/USDT')).toBeNull();
    expect(normalizeQuote({ exchange: 'x', symbol: 'USDC/USDT', bid: Number.NaN, ask: 1, takerFee: 0, at: NOW }, 'USDC/USDT')).toBeNull();
  });
});

describe('freshQuotes', () => {
  it('descarta velho (> 60 s) e quebrado (bid > ask)', () => {
    const list = [q('a', 1, 1.001), q('velho', 1, 1.001, 0.001, NOW - 61_000), q('quebrado', 1.002, 1.001)];
    expect(freshQuotes(list, NOW).map((x) => x.exchange)).toEqual(['a']);
  });
});

describe('bestOpportunity', () => {
  it('spread bruto e líquido (já sem a taxa de compra e a de venda)', () => {
    const best = bestOpportunity([q('kraken', 1.0005, 1.001), q('okx', 1.0013, 1.0014)])!;
    expect(best).toMatchObject({ pair: 'USDC/USDT', buyOn: 'kraken', sellOn: 'okx' });
    expect(best.grossPct).toBeCloseTo(0.03, 2);
    expect(best.netPct).toBeCloseTo(-0.17, 2);
  });

  it('escolhe o melhor líquido, não o melhor bruto (a taxa conta)', () => {
    const best = bestOpportunity([q('barata', 1.0, 1.0, 0.001), q('cara', 1.004, 1.0041, 0.006), q('media', 1.002, 1.0021, 0.001)])!;
    expect(best.sellOn).toBe('media');
  });

  it('uma corretora só: null', () => {
    expect(bestOpportunity([q('a', 1, 1.001)])).toBeNull();
    expect(bestOpportunity([])).toBeNull();
  });
});
