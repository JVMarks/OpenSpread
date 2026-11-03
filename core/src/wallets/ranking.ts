// Resultado realizado por FIFO e ranking de melhores e piores. Puro.
// Cada compra abre um lote (quantidade, custo) do token naquela moeda de cotação. Cada venda consome os lotes mais
// antigos da mesma moeda: resultado = recebido − custo proporcional do que foi vendido. Venda sem compra conhecida
// (comprou antes do que lemos, ou recebeu de outra carteira) não tem resultado: não inventamos o custo.
import type { WalletChain, WalletOp, WalletRanking, WalletResult, WalletState } from '../types';

export const PERIOD_MS = 7 * 86_400_000;
export const RANK_SIZE = 5;
/** Menos que isto de um lote é sobra de arredondamento, não posição. */
const EPS = 1e-9;

export interface WalletSummary {
  results: WalletResult[];
  trades: number;
  wins: number;
  losses: number;
  open: boolean;
  /** As mesmas operações, com `pnl` nas vendas que fecharam lote. */
  ops: WalletOp[];
}

/** `ops` em qualquer ordem; o resultado conta só as vendas dentro de [now − periodMs, now]. */
export function summarize(ops: readonly WalletOp[], now: number, periodMs = PERIOD_MS): WalletSummary {
  const lots = new Map<string, Array<{ qty: number; cost: number }>>();
  const byQuote = new Map<string, number>();
  let trades = 0;
  let wins = 0;
  let losses = 0;
  const out: WalletOp[] = [];
  for (const op of [...ops].sort((a, b) => a.at - b.at || a.tx.localeCompare(b.tx))) {
    const { pnl: _old, ...clean } = op;
    if ((op.kind !== 'buy' && op.kind !== 'sell') || !op.amount || !op.quote || op.quoteAmount == null) {
      out.push(clean);
      continue;
    }
    const key = `${op.assetId ?? op.asset}|${op.quote}`;
    const list = lots.get(key) ?? [];
    lots.set(key, list);
    if (op.kind === 'buy') {
      list.push({ qty: op.amount, cost: op.quoteAmount });
      out.push(clean);
      continue;
    }
    let left = op.amount;
    let cost = 0;
    let matched = 0;
    while (left > EPS && list.length) {
      const lot = list[0];
      const take = Math.min(lot.qty, left);
      const part = (lot.cost * take) / lot.qty;
      cost += part;
      matched += take;
      lot.qty -= take;
      lot.cost -= part;
      left -= take;
      if (lot.qty <= EPS) list.shift();
    }
    if (matched <= EPS) {
      out.push(clean);
      continue;
    }
    // Só a parte casada da venda entra no resultado.
    const pnl = (op.quoteAmount * matched) / op.amount - cost;
    out.push({ ...clean, pnl });
    if (op.at >= now - periodMs && op.at <= now) {
      trades++;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      byQuote.set(op.quote, (byQuote.get(op.quote) ?? 0) + pnl);
    }
  }
  const open = [...lots.values()].some((l) => l.some((lot) => lot.qty > EPS));
  const results = [...byQuote].map(([quote, amount]) => ({ quote, amount })).sort((a, b) => a.quote.localeCompare(b.quote));
  return { results, trades, wins, losses, open, ops: out.sort((a, b) => b.at - a.at) };
}

/** Por rede e moeda de cotação: os de maior resultado e, separados, os de menor (sem repetir quem já está nos melhores). */
export function rank(wallets: readonly Pick<WalletState, 'chain' | 'address' | 'results' | 'trades'>[], size = RANK_SIZE): WalletRanking[] {
  const groups = new Map<string, { chain: WalletChain; quote: string; rows: Array<{ address: string; amount: number }> }>();
  for (const w of wallets) {
    if (!w.trades) continue;
    for (const r of w.results) {
      const k = `${w.chain}|${r.quote}`;
      const g = groups.get(k) ?? { chain: w.chain, quote: r.quote, rows: [] };
      g.rows.push({ address: w.address, amount: r.amount });
      groups.set(k, g);
    }
  }
  const out: WalletRanking[] = [];
  for (const g of groups.values()) {
    const desc = [...g.rows].sort((a, b) => b.amount - a.amount || a.address.localeCompare(b.address));
    const best = desc.filter((r) => r.amount > 0).slice(0, size).map((r) => r.address);
    const worst = desc
      .reverse()
      .filter((r) => r.amount <= 0 && !best.includes(r.address))
      .slice(0, size)
      .map((r) => r.address);
    out.push({ chain: g.chain, quote: g.quote, best, worst });
  }
  const order: WalletChain[] = ['solana', 'ethereum', 'base', 'bitcoin'];
  return out.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain) || a.quote.localeCompare(b.quote));
}
