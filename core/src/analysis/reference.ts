// Preço de referência de uma análise: mediana dos meios das corretoras, para uma só não mover o número.
import type { PairState } from '../types';

const median = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

export interface Reference {
  price: number;
  /** Duas taxas taker (compra e venda), em %. */
  costPct: number;
  exchanges: number;
}

export function referenceOf(pair: PairState): Reference | null {
  if (!pair.quotes.length) return null;
  return {
    price: median(pair.quotes.map((q) => (q.bid + q.ask) / 2)),
    costPct: median(pair.quotes.map((q) => q.takerFee)) * 2 * 100,
    exchanges: pair.quotes.length,
  };
}
