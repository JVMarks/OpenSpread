// Busca as cotações públicas nas corretoras (CCXT) e monta o estado do núcleo. Sem chave, sem ordem.
// Uma corretora com erro (fora do ar, bloqueada no país) não derruba as outras; o log só registra mudança de estado.
import ccxt from 'ccxt';
import { invertBook, type Book } from './engine/book';
import { bestOpportunity, freshQuotes, MAX_QUOTE_AGE_MS, normalizeQuote } from './spread';
import type { CheckResult, CoreState, ExchangeStatus, Listing, Quote } from './types';

/** O pedaço da CCXT que o núcleo usa (permite corretoras falsas nos testes). */
export interface ExchangeLike {
  /** Ms entre pedidos que a CCXT respeita (ausente nas corretoras falsas dos testes). */
  rateLimit?: number;
  loadMarkets(): Promise<Record<string, { active?: boolean; taker?: number; limits?: { cost?: { min?: number } } }>>;
  fetchTicker(symbol: string): Promise<{ bid?: number; ask?: number; timestamp?: number }>;
  /** Só o motor de paper usa, e só quando há oportunidade. */
  fetchOrderBook?(symbol: string): Promise<Book>;
}

/** Tempo-limite de um livro: uma execução simulada não pode ficar pendurada numa corretora lenta. */
const BOOK_TIMEOUT_MS = 10_000;

export interface PollerOptions {
  create?: (id: string) => ExchangeLike;
  log?: (msg: string) => void;
  maxAgeMs?: number;
  /** Tempo-limite de cada corretora na conferência (POST /v1/check). */
  checkTimeoutMs?: number;
  /** Avisado a cada pedido à corretora (id e duração), para a sala de máquinas. */
  onRequest?: (id: string, ms: number) => void;
}

const invert = (pair: string): string => pair.split('/').reverse().join('/');

/** Rejeita se a promessa não resolver a tempo; o cronômetro é sempre cancelado. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sem resposta em ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Corretora real da CCXT, com o limitador de taxa ligado. */
export function createCcxtExchange(id: string): ExchangeLike {
  const Ctor = (ccxt as unknown as Record<string, new (o: object) => ExchangeLike>)[id];
  if (!Ctor) throw new Error(`corretora desconhecida na CCXT: ${id}`);
  return new Ctor({ enableRateLimit: true });
}

export class Poller {
  private exchanges = new Map<string, ExchangeLike>();
  /** Por corretora: par do OpenSpread → símbolo na corretora (direto ou invertido) e taxa taker. */
  private symbols = new Map<string, Map<string, { symbol: string; taker: number; minCost?: number }>>();
  private quotes = new Map<string, Quote>();
  private status = new Map<string, ExchangeStatus>();
  private rev = 0;

  constructor(
    private ids: readonly string[],
    private pairs: readonly string[],
    private opts: PollerOptions = {},
  ) {}

  /** Troca corretoras e pares sem reiniciar: refaz o mapa de símbolos e descarta o que saiu. */
  reconfigure(ids: readonly string[], pairs: readonly string[]): void {
    this.ids = [...ids];
    this.pairs = [...pairs];
    this.symbols.clear();
    for (const [k, q] of this.quotes) if (!ids.includes(q.exchange) || !pairs.includes(q.pair)) this.quotes.delete(k);
    for (const id of [...this.status.keys()]) if (!ids.includes(id)) this.status.delete(id);
    for (const id of [...this.exchanges.keys()]) if (!ids.includes(id)) this.exchanges.delete(id);
    this.rev++;
  }

  /** Confere, sem mudar nada, o que cada corretora lista (direto ou invertido), se está ativo e a taxa taker. */
  async check(ids: readonly string[], pairs: readonly string[], now = Date.now()): Promise<CheckResult> {
    const timeoutMs = this.opts.checkTimeoutMs ?? 20_000;
    const one = async (id: string) => {
      const empty = (pair: string): Listing => ({ pair, symbol: null, inverted: false, active: false, takerFee: null });
      try {
        const markets = await withTimeout(this.exchange(id).loadMarkets(), timeoutMs);
        const listings = pairs.map((pair): Listing => {
          const found = [pair, invert(pair)].map((symbol) => ({ symbol, m: markets[symbol] })).filter((x) => x.m);
          const pick = found.find((x) => x.m!.active !== false) ?? found[0];
          if (!pick) return empty(pair);
          return { pair, symbol: pick.symbol, inverted: pick.symbol !== pair, active: pick.m!.active !== false, takerFee: pick.m!.taker ?? null };
        });
        return { id, ok: true, listings };
      } catch (e) {
        const error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160);
        return { id, ok: false, error, listings: pairs.map(empty) };
      }
    };
    return { at: now, exchanges: await Promise.all(ids.map(one)) };
  }

  /** Uma rodada em todas as corretoras, em paralelo. */
  async pollOnce(now = Date.now()): Promise<void> {
    await Promise.all(this.ids.map((id) => this.pollExchange(id, now)));
  }

  state(now = Date.now()): CoreState {
    const listed = (pair: string) => [...this.symbols.values()].filter((m) => m.has(pair)).length;
    const pairs = this.pairs
      .filter((pair) => listed(pair) >= 2)
      .map((pair) => {
        const quotes = freshQuotes(
          [...this.quotes.values()].filter((q) => q.pair === pair),
          now,
          this.opts.maxAgeMs ?? MAX_QUOTE_AGE_MS,
        );
        return { pair, quotes, best: bestOpportunity(quotes) };
      });
    return { rev: this.rev, at: now, exchanges: this.ids.map((id) => this.status.get(id) ?? { id, ok: false, error: 'aguardando a primeira leitura' }), pairs };
  }

  private exchange(id: string): ExchangeLike {
    let ex = this.exchanges.get(id);
    if (!ex) this.exchanges.set(id, (ex = (this.opts.create ?? createCcxtExchange)(id)));
    return ex;
  }

  private async pollExchange(id: string, now: number): Promise<void> {
    try {
      const ex = this.exchange(id);
      if (!this.symbols.has(id)) {
        const markets = await this.timed(id, () => ex.loadMarkets());
        const map = new Map<string, { symbol: string; taker: number; minCost?: number }>();
        for (const pair of this.pairs) {
          for (const symbol of [pair, invert(pair)]) {
            const m = markets[symbol];
            if (m && m.active !== false) {
              map.set(pair, { symbol, taker: m.taker ?? 0, minCost: m.limits?.cost?.min });
              break;
            }
          }
        }
        this.symbols.set(id, map);
      }
      for (const [pair, { symbol, taker }] of this.symbols.get(id)!) {
        const t = await this.timed(id, () => ex.fetchTicker(symbol));
        // Idade = quando recebemos o book. O `timestamp` do ticker é a hora do último negócio em algumas corretoras
        // (a Coinbase manda minutos atrás em par parado), e descartaria um bid/ask atual.
        const q = normalizeQuote({ exchange: id, symbol, bid: t.bid ?? Number.NaN, ask: t.ask ?? Number.NaN, takerFee: taker, at: now }, pair);
        if (q) this.quotes.set(`${id}|${pair}`, q);
      }
      this.setStatus({ id, ok: true, lastAt: now });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160);
      this.setStatus({ id, ok: false, error: msg, lastAt: this.status.get(id)?.lastAt });
    }
    this.rev++;
  }

  /** Livro público de um par, sempre no sentido do OpenSpread. O pedido conta na sala de máquinas. */
  async fetchBook(exchange: string, pair: string): Promise<Book> {
    const listed = this.symbols.get(exchange)?.get(pair);
    if (!listed) throw new Error(`${exchange} não lista ${pair}`);
    const ex = this.exchange(exchange);
    if (!ex.fetchOrderBook) throw new Error(`${exchange} não informa o livro de ofertas`);
    const fetch = ex.fetchOrderBook.bind(ex);
    const book = await this.timed(exchange, () => withTimeout(fetch(listed.symbol), BOOK_TIMEOUT_MS));
    return listed.symbol === pair ? book : invertBook(book);
  }

  /** Ordem mínima na moeda de cotação, quando a corretora informa. Par listado ao contrário: o limite é na outra moeda, então fica sem informação. */
  minOrderUsd(exchange: string, pair: string): number | undefined {
    const listed = this.symbols.get(exchange)?.get(pair);
    return listed?.symbol === pair ? listed.minCost : undefined;
  }

  /** ms entre pedidos de cada corretora (CCXT). */
  rateLimits(): Record<string, number | undefined> {
    return Object.fromEntries([...this.exchanges].map(([id, ex]) => [id, ex.rateLimit]));
  }

  private async timed<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.opts.onRequest?.(id, performance.now() - started);
    }
  }

  private setStatus(next: ExchangeStatus): void {
    const prev = this.status.get(next.id);
    this.status.set(next.id, next);
    if (!prev || prev.ok !== next.ok || prev.error !== next.error) {
      this.opts.log?.(next.ok ? `${next.id}: recebendo cotações` : `${next.id}: sem dados (${next.error})`);
    }
  }
}
