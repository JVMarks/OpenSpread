import ccxt from 'ccxt';
import { describe, expect, it } from 'vitest';
import { CcxtLiveClient, createExchange, findParams, normalizeOrder, permissionReader, sanitize } from './ccxt-client';
import { Credential } from './credentials';

const cred = new Credential({ apiKey: 'CHAVE123', secret: 'SEGREDO456', password: 'SENHA789' });
const fake = (over: object = {}) => ({ fetchOrder: () => Promise.resolve({}), ...over }) as never;

describe('sanitize', () => {
  it('tira chave, segredo, assinatura e URL', () => {
    const out = sanitize('binance https://api.binance.com/x?signature=abc&timestamp=1 SEGREDO456 CHAVE123 signature=zzz', ['CHAVE123', 'SEGREDO456']);
    expect(out).not.toMatch(/SEGREDO456|CHAVE123|abc|zzz|api\.binance/);
  });
  it('corta mensagem longa', () => {
    expect(sanitize('x'.repeat(1000), []).length).toBeLessThanOrEqual(240);
  });
});

describe('normalizeOrder', () => {
  it('converte o que veio', () => {
    expect(normalizeOrder({ id: '1', status: 'closed', filled: 2, average: 10, fee: { cost: 0.1, currency: 'USDT' } })).toMatchObject({ status: 'closed', filled: 2, average: 10, fee: { cost: 0.1, currency: 'USDT' } });
  });
  it('sem average, calcula pelo custo; sem nada, zero', () => {
    expect(normalizeOrder({ status: 'closed', filled: 2, cost: 30 }).average).toBe(15);
    expect(normalizeOrder({ status: 'canceled' })).toMatchObject({ filled: 0, average: 0 });
  });
  it('taxa pode vir em fees', () => {
    expect(normalizeOrder({ status: 'closed', filled: 1, average: 1, fees: [{ cost: 1, currency: 'BTC' }] }).fee).toEqual({ cost: 1, currency: 'BTC' });
  });
  it('estado desconhecido conta como aberta: nunca como concluída', () => {
    expect(normalizeOrder({ status: 'esquisito', filled: 1 }).status).toBe('open');
    expect(normalizeOrder({}).status).toBe('open');
  });
});

describe('cliente', () => {
  it('parâmetros de busca por corretora', () => {
    expect(findParams('binance', 'x')).toEqual({ origClientOrderId: 'x' });
    expect(findParams('okx', 'x')).toEqual({ clOrdId: 'x' });
    expect(findParams('bybit', 'x')).toEqual({ orderLinkId: 'x', acknowledged: true });
  });
  it('ordem não encontrada vira null; outro erro sobe', async () => {
    const c = new CcxtLiveClient('binance', fake({ fetchOrder: () => Promise.reject(new ccxt.OrderNotFound('não')) }), cred);
    await expect(c.findOrder('BTC/USDT', 'x')).resolves.toBeNull();
    const d = new CcxtLiveClient('binance', fake({ fetchOrder: () => Promise.reject(new ccxt.NetworkError('rede')) }), cred);
    await expect(d.findOrder('BTC/USDT', 'x')).rejects.toThrow('rede');
  });
  it('rede e tempo esgotado são dúvida; a corretora dizendo não é recusa; erro estranho é dúvida', () => {
    const c = new CcxtLiveClient('binance', fake(), cred);
    expect(c.classify(new ccxt.RequestTimeout('x'))).toBe('uncertain');
    expect(c.classify(new ccxt.ExchangeNotAvailable('x'))).toBe('uncertain');
    expect(c.classify(new ccxt.NetworkError('x'))).toBe('uncertain');
    expect(c.classify(new ccxt.InsufficientFunds('x'))).toBe('rejected');
    expect(c.classify(new ccxt.InvalidOrder('x'))).toBe('rejected');
    expect(c.classify(new TypeError('x'))).toBe('uncertain');
  });
  it('describe nunca repete a chave', () => {
    const c = new CcxtLiveClient('binance', fake(), cred);
    const out = c.describe(new ccxt.AuthenticationError('falhou com SEGREDO456 e CHAVE123'));
    expect(out).not.toMatch(/SEGREDO456|CHAVE123/);
    expect(out).toContain('AuthenticationError');
  });
  it('saldo só das moedas pedidas', async () => {
    const c = new CcxtLiveClient('okx', fake({ fetchBalance: () => Promise.resolve({ free: { BTC: 1, DOGE: 9 } }) }), cred);
    await expect(c.freeBalance(new Set(['BTC', 'USDT']))).resolves.toEqual({ BTC: 1, USDT: 0 });
  });
});

describe('instâncias de verdade do CCXT (sem rede)', () => {
  it('ambiente de teste aponta para as URLs de teste, e o real não', () => {
    const test = createExchange('bybit', cred, true) as unknown as { urls: { api: Record<string, string> } };
    expect(JSON.stringify(test.urls.api)).toContain('testnet');
    const real = createExchange('bybit', cred, false) as unknown as { urls: { api: Record<string, string> } };
    expect(JSON.stringify(real.urls.api)).not.toContain('testnet');
  });
  it('as três rotas de permissão existem no CCXT instalado', () => {
    for (const [id, method] of [['binance', 'sapiGetAccountApiRestrictions'], ['okx', 'privateGetAccountConfig'], ['bybit', 'privateGetV5UserQueryApi']] as const) {
      const ex = createExchange(id, cred, false) as unknown as Record<string, unknown>;
      expect(typeof ex[method], `${id}.${method}`).toBe('function');
      expect(typeof permissionReader(id, ex)).toBe('function');
    }
  });
});
