import { describe, expect, it } from 'vitest';
import { referenceOf } from './reference';
import type { PairState, Quote } from '../types';

const quote = (mid: number, takerFee = 0.001): Quote => ({ exchange: `e${mid}`, pair: 'BTC/USDT', bid: mid - 1, ask: mid + 1, takerFee, at: 1, inverted: false });
const pair = (quotes: Quote[]): PairState => ({ pair: 'BTC/USDT', quotes, best: null });

describe('referenceOf', () => {
  it('usa a mediana dos meios, então uma corretora fora da curva não move a referência', () => {
    expect(referenceOf(pair([quote(99), quote(100), quote(200)]))).toMatchObject({ price: 100, exchanges: 3 });
  });
  it('com número par de corretoras, tira a média das duas do meio', () => {
    expect(referenceOf(pair([quote(100), quote(102)]))?.price).toBe(101);
  });
  it('custo é duas vezes a mediana da taxa taker, em %', () => {
    expect(referenceOf(pair([quote(100, 0.001), quote(101, 0.001), quote(102, 0.006)]))?.costPct).toBeCloseTo(0.2);
  });
  it('sem cotação dá null', () => {
    expect(referenceOf(pair([]))).toBeNull();
  });
});
