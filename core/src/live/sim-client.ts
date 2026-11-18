// Corretora simulada para o modo real: mesmo contrato da CcxtLiveClient, sem chave e sem ordem de verdade. Usa os
// mercados reais (precisão e mínimo de ordem) e o livro de ofertas público, e executa cada ordem limitada IOC nível a
// nível dentro do preço travado; o que não executa na hora é cancelado, como na corretora. Saldos são de mentira.
// Serve para simular as ordens do motor real (`npm run live:sim`); nunca entra no LiveRuntime.
import type { LiveClient, LiveOrder } from './engine';

/** O que usamos de uma instância pública do CCXT (sem chave). */
export interface PublicExchange {
  markets: Record<string, { taker?: number; limits?: { cost?: { min?: number } } } | undefined>;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  fetchOrderBook(symbol: string, limit?: number): Promise<{ asks: number[][]; bids: number[][] }>;
}

/** Recusa com certeza (saldo, ordem estranha): o motor trata como `rejected`. */
export class SimRejected extends Error {}
/** Queda de rede simulada: o motor trata como "pode ter saído" e consulta. */
export class SimNetworkError extends Error {}

/** Falha da próxima ordem, para provar os caminhos ruins. */
export type SimFault =
  | 'reject'
  /** A ordem sai, mas a resposta se perde: o motor precisa achar pela consulta. */
  | 'lost_reply'
  /** A ordem não sai e a consulta também falha: o motor não pode saber. */
  | 'offline';

export interface SimOptions {
  /** Saldo livre por moeda. */
  balances: Record<string, number>;
  /** Taxa de taker em fração; sem ela, a do mercado (ou 0,1%). */
  fee?: number;
  /** Quantos níveis do livro ler. */
  depth?: number;
}

export interface SimFill {
  side: 'buy' | 'sell';
  amount: number;
  limit: number;
  filled: number;
  average: number;
  /** Níveis do livro tocados. */
  levels: number;
}

export class SimLiveClient implements LiveClient {
  private readonly orders = new Map<string, LiveOrder>();
  private readonly balances: Record<string, number>;
  private fault: SimFault | null = null;
  readonly fills: SimFill[] = [];

  constructor(
    readonly id: string,
    private readonly ex: PublicExchange,
    private readonly opts: SimOptions,
  ) {
    this.balances = { ...opts.balances };
  }

  /** A próxima ordem falha deste jeito (uma vez). */
  failNext(fault: SimFault): void {
    this.fault = fault;
  }

  amountToPrecision(symbol: string, amount: number): string {
    return this.ex.amountToPrecision(symbol, amount);
  }

  priceToPrecision(symbol: string, price: number): string {
    return this.ex.priceToPrecision(symbol, price);
  }

  private feeOf(symbol: string): number {
    return this.opts.fee ?? this.ex.markets[symbol]?.taker ?? 0.001;
  }

  async createOrder(symbol: string, type: 'limit', side: 'buy' | 'sell', amount: number, price: number, params: Record<string, unknown>): Promise<unknown> {
    const cid = typeof params.clientOrderId === 'string' ? params.clientOrderId : '';
    const fault = this.fault;
    this.fault = null;
    if (fault === 'reject') throw new SimRejected('ordem recusada pela corretora simulada');
    if (fault === 'offline') {
      this.offline = true;
      throw new SimNetworkError('sem resposta da corretora simulada');
    }
    if (type !== 'limit' || params.timeInForce !== 'IOC' || !cid) throw new SimRejected('só ordem limitada IOC com id próprio');
    if (!(amount > 0) || !(price > 0)) throw new SimRejected('quantidade ou preço inválido');
    if (this.orders.has(cid)) throw new SimRejected('id próprio repetido');
    const [base, quote] = symbol.split('/');
    const fee = this.feeOf(symbol);
    // Como na corretora: o saldo é conferido antes, pelo pior caso do preço limite.
    if (side === 'buy' && amount * price * (1 + fee) > (this.balances[quote] ?? 0) + 1e-9) throw new SimRejected(`saldo de ${quote} insuficiente`);
    if (side === 'sell' && amount > (this.balances[base] ?? 0) + 1e-9) throw new SimRejected(`saldo de ${base} insuficiente`);

    const book = await this.ex.fetchOrderBook(symbol, this.opts.depth ?? 50);
    const levels = side === 'buy' ? book.asks : book.bids;
    let left = amount;
    let cost = 0;
    let touched = 0;
    for (const [p, q] of levels) {
      if (left <= 1e-12) break;
      if (side === 'buy' ? p > price : p < price) break;
      const take = Math.min(left, q);
      left -= take;
      cost += take * p;
      touched += 1;
    }
    // O CCXT lança erro para quantidade abaixo do passo (inclusive zero): nada executado é zero, sem perguntar a ele.
    const executed = amount - left;
    const filled = executed > 1e-12 ? Number(this.ex.amountToPrecision(symbol, executed)) : 0;
    const average = filled > 0 ? cost / (amount - left) : 0;
    const feeCost = filled * average * fee;
    if (side === 'buy') {
      this.balances[quote] = (this.balances[quote] ?? 0) - filled * average - feeCost;
      this.balances[base] = (this.balances[base] ?? 0) + filled;
    } else {
      this.balances[base] = (this.balances[base] ?? 0) - filled;
      this.balances[quote] = (this.balances[quote] ?? 0) + filled * average - feeCost;
    }
    // IOC: o que não executou na hora é cancelado.
    const order: LiveOrder = { id: `sim-${this.orders.size + 1}`, clientOrderId: cid, status: filled >= amount - 1e-12 ? 'closed' : 'canceled', filled, average, ...(filled > 0 ? { fee: { cost: feeCost, currency: quote } } : {}) };
    this.orders.set(cid, order);
    this.fills.push({ side, amount, limit: price, filled, average, levels: touched });
    if (fault === 'lost_reply') throw new SimNetworkError('resposta perdida (a ordem saiu)');
    return order;
  }

  private offline = false;

  async findOrder(_symbol: string, clientOrderId: string): Promise<LiveOrder | null> {
    if (this.offline) throw new SimNetworkError('sem resposta da corretora simulada');
    return this.orders.get(clientOrderId) ?? null;
  }

  /** Volta a responder depois de um `offline`. */
  reconnect(): void {
    this.offline = false;
  }

  classify(e: unknown): 'rejected' | 'uncertain' {
    return e instanceof SimRejected ? 'rejected' : 'uncertain';
  }

  describe(e: unknown): string {
    return `${(e as Error)?.constructor?.name ?? 'Erro'}: ${String((e as Error)?.message ?? e).slice(0, 240)}`;
  }

  minOrderUsd(symbol: string): number | undefined {
    return this.ex.markets[symbol]?.limits?.cost?.min;
  }

  async freeBalance(assets: ReadonlySet<string>): Promise<Record<string, number>> {
    return Object.fromEntries([...assets].map((a) => [a, this.balances[a] ?? 0]));
  }
}
