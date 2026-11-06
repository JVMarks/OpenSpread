import { describe, expect, it } from 'vitest';
import { checkPermissions, readPermission } from './permissions';

describe('readPermission', () => {
  const ok = { ok: true };
  it('Binance: enableWithdrawals precisa ser false', () => {
    expect(readPermission('binance', { enableWithdrawals: false, enableSpotAndMarginTrading: true })).toEqual(ok);
    expect(readPermission('binance', { enableWithdrawals: true, enableSpotAndMarginTrading: true })).toMatchObject({ ok: false, reason: expect.stringContaining('saque') });
    expect(readPermission('binance', { enableSpotAndMarginTrading: true }).ok).toBe(false);
    expect(readPermission('binance', { enableWithdrawals: false, enableSpotAndMarginTrading: false }).ok).toBe(false);
  });
  it('OKX: perm sem withdraw e com trade', () => {
    expect(readPermission('okx', { data: [{ perm: 'read_only,trade' }] })).toEqual(ok);
    expect(readPermission('okx', { data: [{ perm: 'read_only,withdraw,trade' }] })).toMatchObject({ ok: false, reason: expect.stringContaining('saque') });
    expect(readPermission('okx', { data: [{ perm: 'read_only' }] }).ok).toBe(false);
    expect(readPermission('okx', { data: [] }).ok).toBe(false);
    expect(readPermission('okx', { data: [{}] }).ok).toBe(false);
  });
  it('Bybit: Wallet sem Withdraw e chave que escreve', () => {
    expect(readPermission('bybit', { result: { readOnly: 0, permissions: { Wallet: ['AccountTransfer'], Spot: ['SpotTrade'] } } })).toEqual(ok);
    expect(readPermission('bybit', { result: { readOnly: 0, permissions: { Wallet: ['AccountTransfer', 'Withdraw'], Spot: ['SpotTrade'] } } })).toMatchObject({ ok: false, reason: expect.stringContaining('saque') });
    expect(readPermission('bybit', { result: { readOnly: 1, permissions: { Wallet: [], Spot: [] } } }).ok).toBe(false);
    expect(readPermission('bybit', { result: { readOnly: 0, permissions: {} } }).ok).toBe(false);
    expect(readPermission('bybit', {}).ok).toBe(false);
  });
  it('corretora desconhecida ou resposta estranha recusa', () => {
    expect(readPermission('kraken', {}).ok).toBe(false);
    for (const raw of [null, undefined, 'x', 1, []]) for (const id of ['binance', 'okx', 'bybit']) expect(readPermission(id, raw).ok).toBe(false);
  });
});

describe('checkPermissions', () => {
  it('falha de rede recusa', async () => {
    const r = await checkPermissions('binance', () => Promise.reject(new Error('rede')), false);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('confirmar') });
  });
  it('dinheiro real sempre consulta', async () => {
    let calls = 0;
    const r = await checkPermissions('binance', () => {
      calls += 1;
      return Promise.resolve({ enableWithdrawals: true, enableSpotAndMarginTrading: true });
    }, false);
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
  });
  it('ambiente de teste não consulta: a Binance Testnet não tem essa rota, e ali não há dinheiro', async () => {
    let calls = 0;
    const r = await checkPermissions('binance', () => {
      calls += 1;
      return Promise.resolve(null);
    }, true);
    expect(calls).toBe(0);
    expect(r.ok).toBe(true);
  });
});
