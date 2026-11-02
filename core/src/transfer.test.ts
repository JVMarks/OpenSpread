import { describe, expect, it } from 'vitest';
import { SpreadAlerts } from './alerts';
import { applyTransfer, effectiveNet, transferCost } from './transfer';
import type { PairState, Quote, SpreadOpportunity } from './types';

const BEST: SpreadOpportunity = { pair: 'USDC/USDT', buyOn: 'bybit', sellOn: 'binance', grossPct: 0, netPct: -0.2 };
const q = (exchange: string, bid: number, ask: number): Quote => ({ exchange, pair: 'USDC/USDT', bid, ask, takerFee: 0.001, at: 1, inverted: false });

describe('custo de transferência (saque da moeda-base na corretora de compra)', () => {
  it('desconta a taxa de saque em % do tamanho, convertida pelo ask de onde se compra', () => {
    const t = transferCost(BEST, 1.0001, { sizeUsd: 1000, withdrawFees: { bybit: { USDC: 1 } } });
    expect(t).toEqual({ asset: 'USDC', from: 'bybit', sizeUsd: 1000, fee: 1, costPct: 0.1, netPct: -0.3 });
    // a mesma taxa pesa 10x mais numa operação 10x menor
    expect(transferCost(BEST, 1, { sizeUsd: 100, withdrawFees: { bybit: { USDC: 1 } } }).netPct).toBe(-1.2);
  });

  it('sem a taxa daquela corretora e moeda: não estima e diz por quê', () => {
    expect(transferCost(BEST, 1, { sizeUsd: 1000, withdrawFees: { binance: { USDC: 1 } } })).toMatchObject({ fee: null, costPct: null, netPct: null, missing: 'fee' });
  });

  it('cotação que não é estável (ex.: ETH/BTC): não estima em dólar', () => {
    const eth = { ...BEST, pair: 'ETH/BTC' };
    expect(transferCost(eth, 0.03, { sizeUsd: 1000, withdrawFees: { bybit: { ETH: 0.001 } } })).toMatchObject({ fee: 0.001, netPct: null, missing: 'quote' });
  });

  it('applyTransfer preenche só o melhor spread e usa o ask da corretora de compra', () => {
    const pairs: PairState[] = [
      { pair: 'USDC/USDT', quotes: [q('bybit', 0.9999, 1.0), q('binance', 1.0, 1.0001)], best: BEST },
      { pair: 'DAI/USDT', quotes: [], best: null },
    ];
    const out = applyTransfer(pairs, { sizeUsd: 1000, withdrawFees: { bybit: { USDC: 2 } } });
    expect(out[0].best!.transfer).toMatchObject({ costPct: 0.2, netPct: -0.4 });
    expect(out[1].best).toBeNull();
    expect(pairs[0].best!.transfer).toBeUndefined(); // não muda o estado de origem
  });

  it('o líquido efetivo (sala e alertas) usa a transferência quando estimada', () => {
    expect(effectiveNet({ ...BEST, transfer: { asset: 'USDC', from: 'bybit', sizeUsd: 1000, fee: 1, costPct: 0.1, netPct: -0.3 } })).toBe(-0.3);
    expect(effectiveNet({ ...BEST, transfer: { asset: 'USDC', from: 'bybit', sizeUsd: 1000, fee: null, costPct: null, netPct: null, missing: 'fee' } })).toBe(-0.2);
    // alerta "quando a conta fechar" (≥ 0) não toca se só o líquido sem transferência passa de zero
    const best: SpreadOpportunity = { ...BEST, netPct: 0.05, transfer: { asset: 'USDC', from: 'bybit', sizeUsd: 1000, fee: 1, costPct: 0.1, netPct: -0.05 } };
    expect(new SpreadAlerts().evaluate([{ pair: 'USDC/USDT', abovePct: 0 }], [{ pair: 'USDC/USDT', quotes: [], best }], 1)).toEqual([]);
  });
});
