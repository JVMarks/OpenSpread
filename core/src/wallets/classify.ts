// Classificação comum às redes com token (Solana e EVM): a partir de quanto cada ativo mudou na carteira numa
// transação, diz se foi compra, venda, entrada, saída ou "não classificada". Puro.
import type { WalletOp, WalletOpKind } from '../types';

/** Variação de um ativo na carteira numa transação (positivo = entrou). */
export interface Delta {
  /** Id do token (mint/contrato) ou null para a moeda da rede. */
  id: string | null;
  symbol: string;
  amount: number;
  /** Moeda de cotação a que este ativo pertence ('SOL', 'ETH', 'USD') ou null para token comum. */
  quote: string | null;
}

/** Abaixo disto a variação é taxa ou aluguel de conta, não negócio. */
export const DUST: Readonly<Record<string, number>> = { SOL: 0.003, ETH: 0.00005, USD: 0.01 };
/** Moeda da rede pequena ao lado de uma stablecoin: aluguel de conta (Solana) ou gás, não a cotação. */
const NATIVE_SIDE_MAX: Readonly<Record<string, number>> = { SOL: 0.01, ETH: 0.002 };

/** Junta as variações por moeda de cotação (wSOL com SOL, WETH com ETH, USDC + USDT + DAI em USD). */
function byQuote(deltas: readonly Delta[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deltas) if (d.quote) m.set(d.quote, (m.get(d.quote) ?? 0) + d.amount);
  return m;
}

export function classify(deltas: readonly Delta[], tx: string, at: number, url: string, native: string): WalletOp {
  const tokens = deltas.filter((d) => !d.quote && d.amount !== 0);
  const quotes = [...byQuote(deltas)].filter(([q, v]) => Math.abs(v) >= (DUST[q] ?? 0));
  const op = (kind: WalletOpKind, extra: Partial<WalletOp> = {}): WalletOp => ({ tx, at, kind, asset: null, assetId: null, amount: null, quote: null, quoteAmount: null, url, ...extra });

  if (tokens.length === 1) {
    const t = tokens[0];
    let opposite = quotes.filter(([, v]) => Math.sign(v) === -Math.sign(t.amount));
    // Compra com USDC paga também o aluguel da conta do token em SOL: fica a stablecoin.
    if (opposite.length > 1) {
      const usd = opposite.find(([q]) => q === 'USD');
      const others = opposite.filter(([q]) => q !== 'USD');
      if (usd && others.every(([q, v]) => Math.abs(v) <= (NATIVE_SIDE_MAX[q] ?? 0))) opposite = [usd];
    }
    if (opposite.length === 1) {
      const [quote, v] = opposite[0];
      return op(t.amount > 0 ? 'buy' : 'sell', { asset: t.symbol, assetId: t.id, amount: Math.abs(t.amount), quote, quoteAmount: Math.abs(v) });
    }
    if (opposite.length === 0) return op(t.amount > 0 ? 'in' : 'out', { asset: t.symbol, assetId: t.id, amount: Math.abs(t.amount) });
    return op('unclassified');
  }
  if (tokens.length === 0 && quotes.length === 1) {
    const [quote, v] = quotes[0];
    const id = quote === native ? null : (deltas.find((d) => d.quote === quote && d.id)?.id ?? null);
    return op(v > 0 ? 'in' : 'out', { asset: quote, assetId: id, amount: Math.abs(v) });
  }
  return op('unclassified');
}

/** Variação de token comum: símbolo curto ou o endereço encurtado (nada de buscar nome fora). */
export const tokenSymbol = (symbol: string | null | undefined, id: string): string => {
  const s = (symbol ?? '').trim();
  return /^[\p{L}\p{N}$._-]{1,12}$/u.test(s) ? s : `${id.slice(0, 4)}…${id.slice(-4)}`;
};
