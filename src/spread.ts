// Cálculo puro do spread entre corretoras (sem rede, sem CCXT): testável e reaproveitável no navegador.
import type { Quote, SpreadOpportunity } from './types';

export const MAX_QUOTE_AGE_MS = 60_000;

const invert = (pair: string): string => pair.split('/').reverse().join('/');
const valid = (n: number): boolean => Number.isFinite(n) && n > 0;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Cotação de `symbol` no sentido de `pair`. Par invertido: bid = 1/ask e ask = 1/bid. Outro par ou preço inválido
 * (zero, negativo, NaN) = null.
 */
export function normalizeQuote(
  raw: { exchange: string; symbol: string; bid: number; ask: number; takerFee: number; at: number },
  pair: string,
): Quote | null {
  if (!valid(raw.bid) || !valid(raw.ask)) return null;
  const base = { exchange: raw.exchange, pair, takerFee: raw.takerFee, at: raw.at };
  if (raw.symbol === pair) return { ...base, bid: raw.bid, ask: raw.ask, inverted: false };
  if (raw.symbol === invert(pair)) return { ...base, bid: 1 / raw.ask, ask: 1 / raw.bid, inverted: true };
  return null;
}

/** Só cotações com até `maxAgeMs` de idade e bid ≤ ask (dado quebrado fica fora). */
export function freshQuotes(quotes: Quote[], now: number, maxAgeMs = MAX_QUOTE_AGE_MS): Quote[] {
  return quotes.filter((q) => now - q.at <= maxAgeMs && q.bid <= q.ask);
}

/** Melhor compra numa corretora e venda em outra, pelo spread líquido (bruto − taxa taker de cada lado). */
export function bestOpportunity(quotes: Quote[]): SpreadOpportunity | null {
  let best: SpreadOpportunity | null = null;
  for (const buy of quotes) {
    for (const sell of quotes) {
      if (buy.exchange === sell.exchange) continue;
      const gross = (sell.bid - buy.ask) / buy.ask;
      const net = gross - buy.takerFee - sell.takerFee;
      if (!best || net * 100 > best.netPct) {
        best = { pair: buy.pair, buyOn: buy.exchange, sellOn: sell.exchange, grossPct: round4(gross * 100), netPct: round4(net * 100) };
      }
    }
  }
  return best;
}
