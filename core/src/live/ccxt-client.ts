// A corretora de verdade, pelo CCXT. Só aqui a chave encosta numa biblioteca; toda mensagem de erro sai sem chave,
// assinatura nem URL. Como achar uma ordem pelo id próprio muda por corretora: conferido no código do CCXT 4.5.92 e
// provado no ambiente de teste (etapa 5, Tarefa 9).
import ccxt from 'ccxt';
import type { Credential } from './credentials';
import type { LiveClient, LiveOrder } from './engine';

/** O que usamos de uma instância do CCXT. */
interface CcxtExchange {
  setSandboxMode(on: boolean): void;
  loadMarkets(): Promise<unknown>;
  markets: Record<string, { limits?: { cost?: { min?: number } } } | undefined>;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  createOrder(symbol: string, type: string, side: string, amount: number, price: number, params: Record<string, unknown>): Promise<unknown>;
  fetchOrder(id: string | undefined, symbol: string, params: Record<string, unknown>): Promise<RawOrder>;
  fetchBalance(): Promise<{ free?: Record<string, number> }>;
}

interface RawOrder {
  id?: string;
  clientOrderId?: string;
  status?: string;
  filled?: number;
  average?: number;
  cost?: number;
  fee?: { cost?: number; currency?: string };
  fees?: Array<{ cost?: number; currency?: string }>;
}

/** Tira segredos, assinatura e URL de uma mensagem. */
export function sanitize(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const s of secrets) if (s) out = out.split(s).join('[oculto]');
  return out.replace(/https?:\/\/\S+/g, '[url]').replace(/(signature|sign|apikey|api_key|x-mbx-apikey)=?[^\s&,"}]*/gi, '$1=[oculto]').slice(0, 240);
}

const STATUSES = new Set(['open', 'closed', 'canceled', 'rejected', 'expired']);

export function normalizeOrder(o: RawOrder): LiveOrder {
  const filled = o.filled ?? 0;
  const average = o.average ?? (o.cost && filled > 0 ? o.cost / filled : 0);
  const fee = o.fee ?? o.fees?.[0];
  return {
    id: o.id ?? '',
    clientOrderId: o.clientOrderId,
    // Estado que não conhecemos conta como aberta: o motor insiste e, se não mudar, para tudo.
    status: (STATUSES.has(o.status ?? '') ? o.status : 'open') as LiveOrder['status'],
    filled,
    average,
    ...(fee && typeof fee.cost === 'number' && typeof fee.currency === 'string' ? { fee: { cost: fee.cost, currency: fee.currency } } : {}),
  };
}

/** Parâmetros para achar uma ordem pelo id próprio em cada corretora. */
export function findParams(exchange: string, clientOrderId: string): Record<string, unknown> {
  if (exchange === 'binance') return { origClientOrderId: clientOrderId };
  if (exchange === 'okx') return { clOrdId: clientOrderId };
  return { orderLinkId: clientOrderId, acknowledged: true };
}

export class CcxtLiveClient implements LiveClient {
  private readonly secrets: string[];

  constructor(
    readonly id: string,
    readonly ex: CcxtExchange,
    credential: Credential,
  ) {
    const v = credential.reveal();
    this.secrets = [v.apiKey, v.secret, v.password ?? ''];
  }

  amountToPrecision(symbol: string, amount: number): string {
    return this.ex.amountToPrecision(symbol, amount);
  }

  priceToPrecision(symbol: string, price: number): string {
    return this.ex.priceToPrecision(symbol, price);
  }

  createOrder(symbol: string, type: 'limit', side: 'buy' | 'sell', amount: number, price: number, params: Record<string, unknown>): Promise<unknown> {
    return this.ex.createOrder(symbol, type, side, amount, price, params);
  }

  async findOrder(symbol: string, clientOrderId: string): Promise<LiveOrder | null> {
    try {
      return normalizeOrder(await this.ex.fetchOrder(undefined, symbol, findParams(this.id, clientOrderId)));
    } catch (e) {
      if (e instanceof ccxt.OrderNotFound) return null;
      throw e;
    }
  }

  classify(e: unknown): 'rejected' | 'uncertain' {
    // Rede, tempo esgotado e corretora fora do ar: pode ter saído. O resto é a corretora dizendo não.
    if (e instanceof ccxt.NetworkError) return 'uncertain';
    return e instanceof ccxt.ExchangeError ? 'rejected' : 'uncertain';
  }

  describe(e: unknown): string {
    const name = (e as Error)?.constructor?.name ?? 'Erro';
    return `${name}: ${sanitize(String((e as Error)?.message ?? e), this.secrets)}`;
  }

  minOrderUsd(symbol: string): number | undefined {
    return this.ex.markets?.[symbol]?.limits?.cost?.min;
  }

  async freeBalance(assets: ReadonlySet<string>): Promise<Record<string, number>> {
    const free = (await this.ex.fetchBalance()).free ?? {};
    return Object.fromEntries([...assets].map((a) => [a, free[a] ?? 0]));
  }
}

/** A consulta de permissão de cada corretora (ver permissions.ts). */
export function permissionReader(id: string, ex: unknown): () => Promise<unknown> {
  const api = ex as Record<string, (p?: object) => Promise<unknown>>;
  if (id === 'binance') return () => api.sapiGetAccountApiRestrictions();
  if (id === 'okx') return () => api.privateGetAccountConfig();
  return () => api.privateGetV5UserQueryApi();
}

export function createExchange(id: string, credential: Credential, sandbox: boolean): CcxtExchange {
  const Exchange = (ccxt as unknown as Record<string, new (o: object) => CcxtExchange>)[id];
  const ex = new Exchange({ ...credential.reveal(), enableRateLimit: true, options: { defaultType: 'spot' } });
  if (sandbox) ex.setSandboxMode(true);
  return ex;
}
