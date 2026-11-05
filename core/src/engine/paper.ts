// Motor de paper trading: espera a latência, lê os dois livros públicos e executa o que couber nas duas pernas. Só lê
// dados públicos: não existe caminho daqui até uma ordem de verdade. As duas pernas sempre executam juntas, então a falha
// de uma perna só não é simulada. Se a oportunidade sumiu durante a espera, o resultado é prejuízo, não cancelamento.
import type { EngineAdapter, Execution, ExecutionRequest } from './adapter';
import { walk, type Book } from './book';

export interface PaperOptions {
  latencyMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Folga de arredondamento ao comparar a quantidade executada com a pedida. */
const EPSILON = 1e-12;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PaperEngine implements EngineAdapter {
  readonly kind = 'paper';

  constructor(
    private readonly books: (exchange: string, pair: string) => Promise<Book>,
    private readonly opts: PaperOptions,
  ) {}

  async execute(req: ExecutionRequest): Promise<Execution> {
    const now = this.opts.now ?? Date.now;
    await (this.opts.sleep ?? wait)(this.opts.latencyMs);

    const [buyBook, sellBook] = await Promise.allSettled([this.books(req.buyOn, req.pair), this.books(req.sellOn, req.pair)]);
    if (buyBook.status === 'rejected' || sellBook.status === 'rejected') {
      const [exchange, reason] = buyBook.status === 'rejected' ? [req.buyOn, buyBook.reason] : [req.sellOn, (sellBook as PromiseRejectedResult).reason];
      const detail = reason instanceof Error ? reason.message : String(reason);
      return { ok: false, at: now(), code: 'book_unavailable', message: `Sem livro de ${exchange}: ${detail}` };
    }

    const wanted = req.sizeUsd / req.quotedAsk;
    const base = Math.min(walk(buyBook.value.asks, wanted).base, walk(sellBook.value.bids, wanted).base);
    if (!(base > 0)) return { ok: false, at: now(), code: 'book_unavailable', message: `Livro vazio em ${req.pair}.` };

    const buy = walk(buyBook.value.asks, base);
    const sell = walk(sellBook.value.bids, base);
    const feesUsd = buy.quote * req.buyFee + sell.quote * req.sellFee;
    const pnlUsd = sell.quote - buy.quote - feesUsd;
    return {
      ok: true,
      at: now(),
      base,
      buyAvg: buy.avgPrice,
      sellAvg: sell.avgPrice,
      feesUsd,
      pnlUsd,
      realizedNetPct: (pnlUsd / buy.quote) * 100,
      partial: base < wanted * (1 - EPSILON),
    };
  }
}
