// Custo de transferência (item 6): o melhor spread compra a moeda-base numa corretora e vende em outra; para isso a
// moeda precisa ser sacada de uma para a outra. A taxa de saque é fixa (quantidade da moeda), então o custo em % depende
// do tamanho da operação. Nenhuma das corretoras informa a taxa sem chave (sondagem de 02/11/2026): ela vem do usuário.
// Puro: sem rede.
import type { PairState, SpreadOpportunity, TransferConfig, TransferCost } from './types';

/** Moedas de cotação tratadas como dólar (o tamanho em US$ vale como tamanho na moeda de cotação). */
export const STABLE_QUOTES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'TUSD', 'PYUSD', 'USD']);

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Custo de sacar a moeda-base de `best.buyOn`, convertido pelo `ask` de lá, sobre `sizeUsd`. */
export function transferCost(best: SpreadOpportunity, buyAsk: number | undefined, t: TransferConfig): TransferCost {
  const [asset, quote] = best.pair.split('/');
  const base = { asset, from: best.buyOn, sizeUsd: t.sizeUsd };
  const fee = t.withdrawFees[best.buyOn]?.[asset];
  if (fee === undefined) return { ...base, fee: null, costPct: null, netPct: null, missing: 'fee' };
  if (!STABLE_QUOTES.has(quote) || !buyAsk || !Number.isFinite(buyAsk)) return { ...base, fee, costPct: null, netPct: null, missing: 'quote' };
  const costPct = round4(((fee * buyAsk) / t.sizeUsd) * 100);
  return { ...base, fee, costPct, netPct: round4(best.netPct - costPct) };
}

/** Os pares com `best.transfer` preenchido (não muda o resto do estado). */
export function applyTransfer(pairs: readonly PairState[], t: TransferConfig): PairState[] {
  return pairs.map((p) => {
    if (!p.best) return p;
    const ask = p.quotes.find((q) => q.exchange === p.best!.buyOn)?.ask;
    return { ...p, best: { ...p.best, transfer: transferCost(p.best, ask, t) } };
  });
}

/** O líquido que vale para a sala e para os alertas: com a transferência quando ela foi estimada. */
export function effectiveNet(best: SpreadOpportunity): number {
  return best.transfer?.netPct ?? best.netPct;
}
