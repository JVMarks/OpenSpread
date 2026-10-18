// Busca as cotações públicas nas corretoras (CCXT) e monta o estado do núcleo. Sem chave, sem ordem.
// Uma corretora com erro (fora do ar, bloqueada no país) não derruba as outras; o log só registra mudança de estado.
import ccxt from 'ccxt';
import { bestOpportunity, freshQuotes, MAX_QUOTE_AGE_MS, normalizeQuote } from './spread';
import type { CoreState, ExchangeStatus, Quote } from './types';

/** O pedaço da CCXT que o núcleo usa (permite corretoras falsas nos testes). */
export interface ExchangeLike {
  loadMarkets(): Promise<Record<string, { active?: boolean; taker?: number }>>;
  fetchTicker(symbol: string): Promise<{ bid?: number; ask?: number; timestamp?: number }>;
}

export interface PollerOptions {
  create?: (id: string) => ExchangeLike;
  log?: (msg: string) => void;
  maxAgeMs?: number;
}

const invert = (pair: string): string => pair.split('/').reverse().join('/');

/** Corretora real da CCXT, com o limitador de taxa ligado. */
export function createCcxtExchange(id: string): ExchangeLike {
  const Ctor = (ccxt as unknown as Record<string, new (o: object) => ExchangeLike>)[id];
  if (!Ctor) throw new Error(`corretora desconhecida na CCXT: ${id}`);
  return new Ctor({ enableRateLimit: true });
}

export class Poller {
  private exchanges = new Map<string, ExchangeLike>();
  /** Por corretora: par do OpenSpread → símbolo na corretora (direto ou invertido) e taxa taker. */
  private symbols = new Map<string, Map<string, { symbol: string; taker: number }>>();
  private quotes = new Map<string, Quote>();
  private status = new Map<string, ExchangeStatus>();
  private rev = 0;

  constructor(
    private ids: readonly string[],
    private pairs: readonly string[],
    private opts: PollerOptions = {},
  ) {}

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
        const markets = await ex.loadMarkets();
        const map = new Map<string, { symbol: string; taker: number }>();
        for (const pair of this.pairs) {
          for (const symbol of [pair, invert(pair)]) {
            const m = markets[symbol];
            if (m && m.active !== false) {
              map.set(pair, { symbol, taker: m.taker ?? 0 });
              break;
            }
          }
        }
        this.symbols.set(id, map);
      }
      for (const [pair, { symbol, taker }] of this.symbols.get(id)!) {
        const t = await ex.fetchTicker(symbol);
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

  private setStatus(next: ExchangeStatus): void {
    const prev = this.status.get(next.id);
    this.status.set(next.id, next);
    if (!prev || prev.ok !== next.ok || prev.error !== next.error) {
      this.opts.log?.(next.ok ? `${next.id}: recebendo cotações` : `${next.id}: sem dados (${next.error})`);
    }
  }
}
