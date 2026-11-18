// Motor real: envia as duas pernas de uma arbitragem, ou uma ordem de desfazer. Só chega aqui o que uma pessoa aprovou.
// Regras fixas: nunca a mercado (limitada IOC, com preço travado), nunca reenvia, nunca desfaz sozinho. Em toda dúvida,
// consulta pelo id próprio e, sem resposta, devolve `unknown` para o gerente parar tudo.
// Caminho separado do motor de paper de propósito: o EngineManager não tem nenhuma rota até aqui.
import type { LiveExposure, LiveFilled } from '../types';

export interface LiveOrder {
  id: string;
  clientOrderId?: string;
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired';
  filled: number;
  average: number;
  fee?: { cost: number; currency: string };
}

/** O que o motor precisa de uma corretora. `ccxt-client.ts` é a versão de verdade. */
export interface LiveClient {
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  createOrder(symbol: string, type: 'limit', side: 'buy' | 'sell', amount: number, price: number, params: Record<string, unknown>): Promise<unknown>;
  findOrder(symbol: string, clientOrderId: string): Promise<LiveOrder | null>;
  /** `rejected` = a corretora disse não com certeza; `uncertain` = pode ter saído. */
  classify(e: unknown): 'rejected' | 'uncertain';
  /** Mensagem sem chave, assinatura nem URL. */
  describe(e: unknown): string;
}

export interface LiveRequest {
  pair: string;
  buyOn: string;
  sellOn: string;
  sizeUsd: number;
  quotedAsk: number;
  quotedBid: number;
  /** Taxas públicas em fração, usadas só quando a execução não informa a taxa em moeda conhecida. */
  buyFee: number;
  sellFee: number;
  maxSlippagePct: number;
  /** Impressão digital da operação. */
  ref: string;
}

export interface UnwindRequest {
  exchange: string;
  pair: string;
  side: 'buy' | 'sell';
  amount: number;
  limitPrice: number;
  ref: string;
}

export type LiveExecution =
  | ({ status: 'filled'; at: number } & LiveFilled)
  | { status: 'no_fill'; at: number; reasons: string[] }
  | { status: 'imbalanced'; at: number; exposures: LiveExposure[]; matched: LiveFilled | null }
  | { status: 'unknown'; at: number; exposures: LiveExposure[]; matched: LiveFilled | null; message: string };

export type UnwindExecution =
  | { status: 'done'; at: number; filled: number; average: number }
  | { status: 'rejected'; at: number; filled: 0; message: string }
  | { status: 'unknown'; at: number; message: string };

export interface EngineDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Quantas consultas até desistir de uma ordem. */
  settleTries?: number;
  settleDelayMs?: number;
  now?: () => number;
}

type Leg =
  | { state: 'done'; filled: number; average: number; fee?: { cost: number; currency: string } }
  | { state: 'rejected'; message: string }
  | { state: 'unknown'; message: string };

/** Só letras e números, até 32: o que a Binance, a OKX e a Bybit aceitam. */
export const clientId = (ref: string, leg: string): string => `os${ref.slice(0, 26)}${leg}`;

const SAME = 1e-9;

export class LiveEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tries: number;
  private readonly delay: number;
  private readonly now: () => number;

  constructor(
    private readonly clients: ReadonlyMap<string, LiveClient>,
    deps: EngineDeps = {},
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tries = deps.settleTries ?? 5;
    this.delay = deps.settleDelayMs ?? 500;
    this.now = deps.now ?? Date.now;
  }

  /** Mesma quantidade nas duas pernas, no passo mais grosso. */
  private quantity(req: LiveRequest, buy: LiveClient, sell: LiveClient): number {
    const raw = req.sizeUsd / req.quotedAsk;
    // O CCXT lança erro (InvalidOrder) para quantidade abaixo do passo, em vez de devolver zero. Zero aqui: nenhuma ordem sai.
    const step = (c: LiveClient): number => {
      try {
        return Number(c.amountToPrecision(req.pair, raw));
      } catch {
        return 0;
      }
    };
    return Math.min(step(buy), step(sell));
  }

  private limits(req: LiveRequest, buy: LiveClient, sell: LiveClient): { buy: number; sell: number } {
    const slip = req.maxSlippagePct / 100;
    return { buy: Number(buy.priceToPrecision(req.pair, req.quotedAsk * (1 + slip))), sell: Number(sell.priceToPrecision(req.pair, req.quotedBid * (1 - slip))) };
  }

  async execute(req: LiveRequest): Promise<LiveExecution> {
    const buy = this.clients.get(req.buyOn);
    const sell = this.clients.get(req.sellOn);
    if (!buy || !sell) return { status: 'no_fill', at: this.now(), reasons: [`Sem chave para ${!buy ? req.buyOn : req.sellOn}.`] };
    const amount = this.quantity(req, buy, sell);
    if (!(amount > 0)) return { status: 'no_fill', at: this.now(), reasons: ['Tamanho abaixo do passo mínimo da corretora.'] };
    const price = this.limits(req, buy, sell);
    const [a, b] = await Promise.all([
      this.place(buy, req.pair, 'buy', amount, price.buy, clientId(req.ref, 'b')),
      this.place(sell, req.pair, 'sell', amount, price.sell, clientId(req.ref, 's')),
    ]);
    return this.conclude(req, amount, a, b);
  }

  /** Só consulta: depois de uma queda, descobre o que aconteceu. Nunca cria ordem. */
  async reconcile(req: LiveRequest): Promise<LiveExecution> {
    const buy = this.clients.get(req.buyOn);
    const sell = this.clients.get(req.sellOn);
    const absent = (id: string): Leg => ({ state: 'unknown', message: `Sem chave para ${id}.` });
    const [a, b] = await Promise.all([
      buy ? this.settle(buy, req.pair, clientId(req.ref, 'b')) : absent(req.buyOn),
      sell ? this.settle(sell, req.pair, clientId(req.ref, 's')) : absent(req.sellOn),
    ]);
    const raw = req.sizeUsd / req.quotedAsk;
    return this.conclude(req, buy && sell ? this.quantity(req, buy, sell) : raw, a, b);
  }

  async unwind(req: UnwindRequest): Promise<UnwindExecution> {
    const at = this.now();
    const client = this.clients.get(req.exchange);
    if (!client) return { status: 'rejected', at, filled: 0, message: `Sem chave para ${req.exchange}.` };
    const leg = await this.place(client, req.pair, req.side, req.amount, Number(client.priceToPrecision(req.pair, req.limitPrice)), clientId(req.ref, 'u'));
    if (leg.state === 'done') return { status: 'done', at, filled: leg.filled, average: leg.average };
    if (leg.state === 'rejected') return { status: 'rejected', at, filled: 0, message: leg.message };
    return { status: 'unknown', at, message: leg.message };
  }

  private async place(client: LiveClient, symbol: string, side: 'buy' | 'sell', amount: number, price: number, id: string): Promise<Leg> {
    try {
      await client.createOrder(symbol, 'limit', side, amount, price, { timeInForce: 'IOC', clientOrderId: id });
    } catch (e) {
      if (client.classify(e) === 'rejected') return { state: 'rejected', message: client.describe(e) };
      // Pode ter saído: consulta antes de concluir qualquer coisa.
    }
    return this.settle(client, symbol, id);
  }

  private async settle(client: LiveClient, symbol: string, id: string): Promise<Leg> {
    let last = 'não encontrei a ordem';
    for (let i = 0; i < this.tries; i++) {
      if (i) await this.sleep(this.delay);
      try {
        const o = await client.findOrder(symbol, id);
        if (o && o.status !== 'open') return { state: 'done', filled: o.filled, average: o.average, fee: o.fee };
        if (o) last = 'a ordem continua aberta';
      } catch (e) {
        last = client.describe(e);
      }
    }
    return { state: 'unknown', message: last };
  }

  private conclude(req: LiveRequest, amount: number, a: Leg, b: Leg): LiveExecution {
    const at = this.now();
    const [asset, quote] = req.pair.split('/');
    const expo = (exchange: string, side: 'long' | 'short', qty: number | null, price: number): LiveExposure => ({ exchange, pair: req.pair, asset, side, amount: qty, price });
    const fa = a.state === 'done' ? a.filled : 0;
    const fb = b.state === 'done' ? b.filled : 0;
    const matchedQty = Math.min(fa, fb);
    const matched = matchedQty > 0 ? this.matched(req, a, b, matchedQty, amount, asset, quote) : null;

    if (a.state === 'unknown' || b.state === 'unknown') {
      const exposures: LiveExposure[] = [];
      if (a.state === 'unknown') exposures.push(expo(req.buyOn, 'long', null, req.quotedAsk));
      else if (fa > matchedQty + SAME) exposures.push(expo(req.buyOn, 'long', fa - matchedQty, req.quotedAsk));
      if (b.state === 'unknown') exposures.push(expo(req.sellOn, 'short', null, req.quotedBid));
      else if (fb > matchedQty + SAME) exposures.push(expo(req.sellOn, 'short', fb - matchedQty, req.quotedBid));
      const message = [a.state === 'unknown' ? `${req.buyOn}: ${a.message}` : '', b.state === 'unknown' ? `${req.sellOn}: ${b.message}` : ''].filter(Boolean).join(' · ');
      return { status: 'unknown', at, exposures, matched, message };
    }
    if (Math.abs(fa - fb) > SAME) {
      const exposures = fa > fb ? [expo(req.buyOn, 'long', fa - fb, req.quotedAsk)] : [expo(req.sellOn, 'short', fb - fa, req.quotedBid)];
      return { status: 'imbalanced', at, exposures, matched };
    }
    if (!matched) {
      const reasons = [a.state === 'rejected' ? `${req.buyOn}: ${a.message}` : '', b.state === 'rejected' ? `${req.sellOn}: ${b.message}` : ''].filter(Boolean);
      return { status: 'no_fill', at, reasons: reasons.length ? reasons : ['As ordens expiraram sem execução: o preço saiu da faixa.'] };
    }
    return { status: 'filled', at, ...matched };
  }

  private matched(req: LiveRequest, a: Leg, b: Leg, base: number, amount: number, asset: string, quote: string): LiveFilled {
    const legA = a as Extract<Leg, { state: 'done' }>;
    const legB = b as Extract<Leg, { state: 'done' }>;
    const buyCost = base * legA.average;
    const sellCost = base * legB.average;
    const fee = (leg: Extract<Leg, { state: 'done' }>, notional: number, publicFee: number): { usd: number; estimated: boolean } => {
      const share = leg.filled > 0 ? base / leg.filled : 1;
      if (leg.fee && leg.fee.currency === quote) return { usd: leg.fee.cost * share, estimated: false };
      if (leg.fee && leg.fee.currency === asset) return { usd: leg.fee.cost * share * leg.average, estimated: false };
      return { usd: notional * publicFee, estimated: true };
    };
    const fb = fee(legA, buyCost, req.buyFee);
    const fs = fee(legB, sellCost, req.sellFee);
    const feesUsd = fb.usd + fs.usd;
    const pnlUsd = sellCost - buyCost - feesUsd;
    return {
      base,
      buyAvg: legA.average,
      sellAvg: legB.average,
      feesUsd,
      pnlUsd,
      realizedNetPct: buyCost > 0 ? (pnlUsd / buyCost) * 100 : 0,
      partial: base < amount - SAME,
      feeEstimated: fb.estimated || fs.estimated,
    };
  }
}
