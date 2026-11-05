import { describe, expect, it } from 'vitest';
import { checkBatch, checkTrade, fingerprint, type ProposedTrade, type RiskContext } from './risk';
import type { RiskPolicy } from '../types';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const POLICY: RiskPolicy = { maxTradeUsd: 100, minNetPct: 0.05, maxQuoteAgeMs: 10_000, dailyLossLimitUsd: 5, allowedPairs: ['BTC/USDT', 'USDC/USDT'] };

const TRADE: ProposedTrade = { botId: 'bot-1', pair: 'BTC/USDT', buyOn: 'binance', sellOn: 'kraken', sizeUsd: 60, netPct: 0.1, mode: 'paper' };

it('motivo de saldo com número legível, sem o ruído do ponto flutuante', () => {
  const reasons = checkTrade(
    { ...TRADE, sellOn: 'c', buyOn: 'a', sizeUsd: 49.6781234 },
    { now: NOW, balances: { a: { USDT: 0.2720323637064155 }, c: { BTC: 1 } }, priceUsd: { USDT: 1, BTC: 100 }, quoteAt: { a: NOW, c: NOW }, exchangeOk: { a: true, c: true }, minOrderUsd: {}, pnlTodayUsd: 0 },
    POLICY,
  ).reasons;
  expect(reasons.find((r) => r.code === 'no_balance_buy')?.message).toBe('Saldo de USDT em a (0.272) não cobre US$ 49.68.');
});

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  now: NOW,
  balances: { binance: { USDT: 100, BTC: 0 }, kraken: { USDT: 0, BTC: 0.002 } },
  priceUsd: { BTC: 60_000, USDT: 1 },
  quoteAt: { binance: NOW - 1_000, kraken: NOW - 1_000 },
  exchangeOk: { binance: true, kraken: true },
  minOrderUsd: { binance: 10, kraken: 10 },
  pnlTodayUsd: 0,
  ...over,
});

const codes = (t: ProposedTrade, c: RiskContext, p: RiskPolicy = POLICY) => checkTrade(t, c, p).reasons.map((r) => r.code);

describe('trava de risco: uma operação', () => {
  it('aprova a operação dentro de todos os limites', () => {
    const v = checkTrade(TRADE, ctx(), POLICY);
    expect(v).toMatchObject({ result: 'PASS', reasons: [], checkedAt: NOW });
    expect(v.fingerprint).toBe(fingerprint(TRADE, '2026-11-04'));
  });

  it.each<[string, Partial<ProposedTrade>, Partial<RiskContext>]>([
    ['pair_not_allowed', { pair: 'ETH/USDT' }, { balances: { binance: { USDT: 100 }, kraken: { ETH: 1 } }, priceUsd: { ETH: 3_000, USDT: 1 } }],
    ['trade_too_large', { sizeUsd: 100.01 }, { balances: { binance: { USDT: 1_000 }, kraken: { BTC: 1 } } }],
    ['net_below_min', { netPct: 0.049 }, {}],
    ['invalid_size', { sizeUsd: Number.NaN }, {}],
    ['same_exchange', { sellOn: 'binance' }, { balances: { binance: { USDT: 100, BTC: 1 } } }],
    ['stale_quote', {}, { quoteAt: { binance: NOW - 10_001, kraken: NOW } }],
    ['stale_quote', {}, { quoteAt: { binance: NOW, kraken: NOW - 10_001 } }],
    ['stale_quote', {}, { quoteAt: { binance: NOW } }],
    ['exchange_down', {}, { exchangeOk: { binance: false, kraken: true } }],
    ['exchange_down', {}, { exchangeOk: { binance: true, kraken: false } }],
    ['exchange_down', {}, { exchangeOk: { binance: true } }],
    ['below_exchange_min', {}, { minOrderUsd: { binance: 60.01, kraken: 10 } }],
    ['below_exchange_min', {}, { minOrderUsd: { binance: 10, kraken: 60.01 } }],
    ['no_balance_buy', {}, { balances: { binance: { USDT: 59.99 }, kraken: { BTC: 0.002 } } }],
    ['no_balance_sell', {}, { balances: { binance: { USDT: 100 }, kraken: { BTC: 0.0009 } } }],
    ['no_balance_sell', {}, { balances: { binance: { USDT: 100 } } }],
    ['no_price', {}, { priceUsd: { USDT: 1 } }],
    ['daily_loss_hit', {}, { pnlTodayUsd: -5 }],
  ])('bloqueia com %s', (code, trade, context) => {
    const v = checkTrade({ ...TRADE, ...trade }, ctx(context), POLICY);
    expect(v.result).toBe('BLOCK');
    expect(v.reasons.map((r) => r.code)).toEqual([code]);
    expect(v.reasons[0].message).not.toBe('');
    expect(v.reasons[0].fix).not.toBe('');
  });

  it('recusa modo que não seja paper, mesmo vindo de JSON sem tipo', () => {
    expect(codes({ ...TRADE, mode: 'live' as unknown as 'paper' }, ctx())).toEqual(['mode_not_paper']);
  });

  it('junta todas as razões no mesmo veredito', () => {
    expect(codes({ ...TRADE, sizeUsd: 101, netPct: 0 }, ctx({ pnlTodayUsd: -6 }))).toEqual(expect.arrayContaining(['trade_too_large', 'net_below_min', 'daily_loss_hit']));
  });

  it('lista de pares vazia: nada opera até o usuário escolher', () => {
    expect(codes(TRADE, ctx(), { ...POLICY, allowedPairs: [] })).toEqual(['pair_not_allowed']);
  });

  it('não muda a política nem o contexto recebidos', () => {
    const c = ctx();
    const before = JSON.stringify([c, POLICY]);
    checkBatch([TRADE, TRADE], c, POLICY);
    expect(JSON.stringify([c, POLICY])).toBe(before);
  });
});

describe('trava de risco: lote', () => {
  it('confere em sequência, como se cada operação aprovada já tivesse saído', () => {
    const [a, b] = checkBatch([TRADE, TRADE], ctx(), POLICY);
    expect(a.result).toBe('PASS');
    expect(b.result).toBe('BLOCK');
    expect(b.reasons.map((r) => r.code)).toContain('no_balance_buy');
  });

  it('operação bloqueada não gasta saldo da seguinte', () => {
    const [a, b] = checkBatch([{ ...TRADE, sizeUsd: 101 }, TRADE], ctx({ balances: { binance: { USDT: 1_000 }, kraken: { BTC: 1 } } }), POLICY);
    expect(a.result).toBe('BLOCK');
    expect(b.result).toBe('PASS');
  });

  it('não conta o que a operação anterior renderia: a perna pode falhar', () => {
    const volta: ProposedTrade = { ...TRADE, buyOn: 'kraken', sellOn: 'binance' };
    const c = ctx({ balances: { binance: { USDT: 60 }, kraken: { BTC: 0.001 } } });
    const [a, b] = checkBatch([TRADE, volta], c, POLICY);
    expect(a.result).toBe('PASS');
    expect(b.result).toBe('BLOCK');
    expect(b.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['no_balance_buy', 'no_balance_sell']));
  });
});

describe('impressão digital', () => {
  it('é igual para a mesma operação no mesmo dia', () => {
    expect(fingerprint(TRADE, '2026-11-04')).toBe(fingerprint({ ...TRADE }, '2026-11-04'));
    expect(fingerprint(TRADE, '2026-11-04')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('muda com o tamanho e com o dia', () => {
    const base = fingerprint(TRADE, '2026-11-04');
    expect(fingerprint({ ...TRADE, sizeUsd: 61 }, '2026-11-04')).not.toBe(base);
    expect(fingerprint(TRADE, '2026-11-05')).not.toBe(base);
  });

  it('o veredito de um dia não vale no outro', () => {
    const hoje = checkTrade(TRADE, ctx(), POLICY).fingerprint;
    const amanha = NOW + 86_400_000;
    const c = ctx({ now: amanha, quoteAt: { binance: amanha, kraken: amanha } });
    expect(checkTrade(TRADE, c, POLICY).fingerprint).not.toBe(hoje);
  });
});
