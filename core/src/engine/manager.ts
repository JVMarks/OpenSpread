// Gerente do motor: a cada leitura, procura oportunidade para cada robô, passa pela trava e manda executar. Só entra
// aqui o que o usuário configurou: a IA não muda limite, e nada vira ordem real (o motor é o PaperEngine).
// Calma: leitura abaixo do mínimo só conta; bloqueio repetido não grava de novo.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bestOpportunity } from '../spread';
import { STABLE_QUOTES } from '../transfer';
import type { CoreState, EngineBlock, EngineBot, EngineConfig, EngineFill, EngineState, PairState, Quote, RiskReason } from '../types';
import type { EngineAdapter, Execution } from './adapter';
import { allocate } from './budget';
import type { Ledger, LedgerEntry } from './ledger';
import { checkTrade, type ProposedTrade, type RiskContext } from './risk';

export interface BotRequest {
  pair: string;
  exchanges: [string, string];
  capitalUsd?: number;
}

export interface ManagerOptions {
  /** Arquivo com robôs e operações (engine/bots.json, ao lado do config). */
  file: string;
  ledger: Ledger;
  config: () => EngineConfig | undefined;
  minOrderUsd: (exchange: string, pair: string) => number | undefined;
  now?: () => number;
  log?: (msg: string) => void;
}

type StartResult = EngineBot | { errors: RiskReason[] };

const BOT_FIELDS = new Set(['pair', 'exchanges', 'capitalUsd']);
const PAIR = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;
const EXCHANGE = /^[a-z0-9_-]{1,40}$/;
const SERIES = 60;
const KEEP_FILLS = 50;
const KEEP_BLOCKS = 20;
/** Robôs parados guardados, além dos ativos. */
const KEEP_STOPPED = 20;
/** Abaixo disto a operação seria pó: fica como falta de saldo. */
const MIN_TRADE_USD = 10;

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const reason = (code: string, message: string, fix: string): RiskReason => ({ code, message, fix });

/** Confere o corpo de POST /v1/engine/bots. Formato errado ou campo desconhecido = null. */
export function parseBotRequest(raw: unknown): BotRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !BOT_FIELDS.has(k))) return null;
  if (typeof r.pair !== 'string' || !Array.isArray(r.exchanges) || r.exchanges.length !== 2) return null;
  const pair = r.pair.trim().toUpperCase();
  if (!PAIR.test(pair)) return null;
  const [a, b] = r.exchanges as unknown[];
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const exchanges: [string, string] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (!exchanges.every((id) => EXCHANGE.test(id))) return null;
  if (r.capitalUsd === undefined) return { pair, exchanges };
  if (typeof r.capitalUsd !== 'number' || !Number.isFinite(r.capitalUsd) || r.capitalUsd <= 0) return null;
  return { pair, exchanges, capitalUsd: r.capitalUsd };
}

const active = (b: EngineBot): boolean => b.status === 'running' || b.status === 'parked';

export class EngineManager {
  /** Sobe a cada novidade (robô, operação, bloqueio), para o núcleo avisar o Bullroom. */
  rev = 0;
  private bots: EngineBot[] = [];
  private fills: EngineFill[] = [];
  private blocks: EngineBlock[] = [];
  private nextId = 1;
  private error: string | undefined;
  private last: CoreState | undefined;
  private readonly busy = new Map<string, Promise<void>>();
  /** Por robô: hora da última tentativa, motivos do último bloqueio, dia do `pnlTodayUsd`, pico do resultado e dia da ejeção. */
  private readonly lastRun = new Map<string, number>();
  private readonly lastBlock = new Map<string, string>();
  private readonly day = new Map<string, string>();
  private readonly peak = new Map<string, number>();
  private readonly ejectedOn = new Map<string, string>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly adapter: EngineAdapter,
    private readonly opts: ManagerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  enabled(): boolean {
    return this.opts.config()?.enabled === true;
  }

  /** Espera as execuções em andamento (encerramento e testes). */
  async idle(): Promise<void> {
    await Promise.all(this.busy.values());
  }

  /** Lê robôs e operações salvos. Arquivo quebrado é guardado como .bad e o motor começa vazio. */
  load(): void {
    const { file } = this.opts;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        bots: EngineBot[];
        fills: EngineFill[];
        blocks: EngineBlock[];
        nextId: number;
        days?: Record<string, string>;
        peaks?: Record<string, number>;
        ejected?: Record<string, string>;
      };
      if (!Array.isArray(raw.bots) || !Array.isArray(raw.fills)) throw new Error('formato inesperado');
      this.bots = raw.bots;
      this.fills = raw.fills;
      this.blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
      this.nextId = Number.isInteger(raw.nextId) ? raw.nextId : this.bots.length + 1;
      for (const [id, d] of Object.entries(raw.days ?? {})) this.day.set(id, d);
      for (const [id, p] of Object.entries(raw.peaks ?? {})) this.peak.set(id, p);
      for (const [id, d] of Object.entries(raw.ejected ?? {})) this.ejectedOn.set(id, d);
      this.log(`motor: ${this.bots.filter(active).length} robô(s) simulado(s) de volta (${file})`);
    } catch (e) {
      const bad = `${file}.bad`;
      this.log(`motor: ${file} ilegível (${(e as Error).message}); guardado em ${bad}, começando vazio`);
      renameSync(file, bad);
    }
  }

  /** Grava num temporário e renomeia. Falha aparece no estado, sem derrubar o núcleo. */
  save(): void {
    const { file } = this.opts;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      const body = {
        bots: this.bots,
        fills: this.fills,
        blocks: this.blocks,
        nextId: this.nextId,
        days: Object.fromEntries(this.day),
        peaks: Object.fromEntries(this.peak),
        ejected: Object.fromEntries(this.ejectedOn),
      };
      writeFileSync(tmp, JSON.stringify(body), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      this.fail(`não consegui salvar ${file}: ${(e as Error).message}`);
    }
  }

  state(now: number): EngineState {
    return {
      at: now,
      engine: { kind: this.adapter.kind, ok: !this.error, ...(this.error ? { error: this.error } : {}) },
      mode: 'paper',
      bots: this.bots,
      fills: this.fills,
      blocks: this.blocks,
      latencyMs: this.opts.config()?.latencyMs ?? 0,
      dailyLossLimitUsd: this.opts.config()?.policy.dailyLossLimitUsd ?? 0,
    };
  }

  startBot(req: BotRequest): StartResult {
    const cfg = this.opts.config();
    if (!cfg?.enabled) return { errors: [reason('engine_off', 'O motor de paper está desligado.', 'Ligue o motor nas configurações.')] };
    const now = this.now();
    const [a, b] = req.exchanges;
    const [asset, quote] = req.pair.split('/');
    const errors: RiskReason[] = [];
    if (!cfg.policy.allowedPairs.includes(req.pair)) errors.push(reason('pair_not_allowed', `${req.pair} não está na lista de pares permitidos.`, 'Inclua o par na política de risco, se quiser operá-lo.'));
    if (a === b) errors.push(reason('same_exchange', `As duas pernas estão em ${a}.`, 'Escolha duas corretoras diferentes.'));
    if (!STABLE_QUOTES.has(quote)) errors.push(reason('unsupported_quote', `Cotação em ${quote}: o motor só simula pares cotados em dólar.`, 'Escolha um par cotado em stablecoin.'));

    const same = (x: EngineBot) => x.pair === req.pair && new Set(x.exchanges).has(a) && new Set(x.exchanges).has(b);
    if (this.bots.some((x) => same(x) && active(x))) errors.push(reason('bot_exists', 'Já existe um robô nesse par e nessas corretoras.', 'Pare o robô atual antes de ligar outro.'));
    if (this.bots.some((x) => same(x) && this.ejectedOn.get(x.id) === utcDay(now))) errors.push(reason('ejected_today', 'Esse robô bateu o limite de perda hoje.', 'Ele pode voltar amanhã (dia UTC).'));

    const price = this.midPrice(req.pair, a, b);
    if (!errors.length && price === undefined) errors.push(reason('no_price', `Sem cotação de ${req.pair} em ${a} e ${b}.`, 'Espere as duas corretoras responderem.'));
    if (errors.length) return { errors };

    const capital = this.capitalFor(req, cfg);
    if ('errors' in capital) return capital;

    const quarter = capital.usd / 4;
    const wallet = () => ({ [asset]: quarter / (price as number), [quote]: quarter });
    const bot: EngineBot = {
      id: `bot-${this.nextId++}`,
      pair: req.pair,
      exchanges: [a, b],
      capitalUsd: capital.usd,
      startedAt: now,
      status: 'running',
      pnlUsd: 0,
      pnlTodayUsd: 0,
      feesUsd: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      maxDrawdownUsd: 0,
      balances: { [a]: wallet(), [b]: wallet() },
      samples: 0,
      samplesAbove: 0,
      series: [],
    };
    this.bots.push(bot);
    this.day.set(bot.id, utcDay(now));
    this.prune();
    this.write({ at: now, kind: 'start', botId: bot.id, data: { pair: bot.pair, exchanges: bot.exchanges, capitalUsd: bot.capitalUsd } });
    this.changed();
    return bot;
  }

  stopBot(id: string): EngineBot | undefined {
    const bot = this.bots.find((b) => b.id === id);
    if (!bot) return undefined;
    if (bot.status === 'stopped' || bot.status === 'ejected') return bot;
    bot.status = 'stopped';
    delete bot.statusReason;
    this.write({ at: this.now(), kind: 'stop', botId: id, data: { pnlUsd: bot.pnlUsd, trades: bot.trades } });
    this.changed();
    return bot;
  }

  /** Chamado a cada leitura. Nunca espera a execução, para não segurar o núcleo. */
  evaluate(state: CoreState): void {
    this.last = state;
    const cfg = this.opts.config();
    if (!cfg?.enabled) return;
    for (const bot of this.bots) {
      this.rollDay(bot, state.at);
      if (!active(bot)) continue;
      const pair = state.pairs.find((p) => p.pair === bot.pair);
      if (pair) this.evaluateBot(bot, pair, state, cfg);
    }
  }

  private evaluateBot(bot: EngineBot, pair: PairState, state: CoreState, cfg: EngineConfig): void {
    const quotes = pair.quotes.filter((q) => bot.exchanges.includes(q.exchange));
    const opp = bestOpportunity(quotes);
    if (!opp) return;
    bot.samples += 1;
    if (opp.netPct < cfg.policy.minNetPct) return;
    bot.samplesAbove += 1;
    if (this.busy.has(bot.id)) return;
    const lastRun = this.lastRun.get(bot.id);
    if (lastRun !== undefined && state.at - lastRun < cfg.cooldownMs) return;

    const buy = quotes.find((q) => q.exchange === opp.buyOn) as Quote;
    const sell = quotes.find((q) => q.exchange === opp.sellOn) as Quote;
    const ctx = this.context(bot, quotes, state, buy);
    const trade: ProposedTrade = { botId: bot.id, pair: bot.pair, buyOn: opp.buyOn, sellOn: opp.sellOn, sizeUsd: this.tradeSize(bot, buy, sell, ctx, cfg), netPct: opp.netPct, mode: 'paper' };
    const verdict = checkTrade(trade, ctx, cfg.policy);
    const reasons = [...verdict.reasons];
    // O Poller grava taxa ausente como 0, e taxa 0 inventaria lucro.
    for (const q of [buy, sell]) if (!(q.takerFee > 0)) reasons.push(reason('fee_unknown', `${q.exchange} não informa a taxa de ${bot.pair}.`, 'Sem a taxa, o resultado seria inventado: escolha outra corretora.'));

    if (reasons.length) {
      this.block(bot, trade, reasons, state.at);
      const noBalance = reasons.find((r) => r.code === 'no_balance_buy' || r.code === 'no_balance_sell');
      const next = noBalance ? 'parked' : bot.status;
      if (next !== bot.status || (noBalance && bot.statusReason !== noBalance.message)) {
        bot.status = 'parked';
        bot.statusReason = noBalance?.message;
        this.changed();
      }
      return;
    }

    this.write({ at: state.at, kind: 'proposal', botId: bot.id, data: trade });
    this.write({ at: state.at, kind: 'verdict', botId: bot.id, data: verdict });
    this.lastBlock.delete(bot.id);
    if (bot.status === 'parked') {
      bot.status = 'running';
      delete bot.statusReason;
      this.changed();
    }
    this.lastRun.set(bot.id, state.at);
    const running = this.run(bot, trade, buy, sell, cfg).finally(() => this.busy.delete(bot.id));
    this.busy.set(bot.id, running);
  }

  private async run(bot: EngineBot, trade: ProposedTrade, buy: Quote, sell: Quote, cfg: EngineConfig): Promise<void> {
    let result: Execution;
    try {
      result = await this.adapter.execute({ pair: trade.pair, buyOn: trade.buyOn, sellOn: trade.sellOn, sizeUsd: trade.sizeUsd, quotedAsk: buy.ask, quotedBid: sell.bid, buyFee: buy.takerFee, sellFee: sell.takerFee });
    } catch (e) {
      this.fail((e as Error).message);
      return;
    }
    if (this.error) this.error = undefined;
    if (!result.ok) {
      this.block(bot, trade, [reason(result.code, result.message, 'Tenta de novo na próxima oportunidade.')], result.at);
      return;
    }
    this.applyFill(bot, trade, result, buy, sell, cfg);
  }

  private applyFill(bot: EngineBot, trade: ProposedTrade, r: Extract<Execution, { ok: true }>, buy: Quote, sell: Quote, cfg: EngineConfig): void {
    const [asset, quote] = bot.pair.split('/');
    const buyWallet = bot.balances[trade.buyOn];
    const sellWallet = bot.balances[trade.sellOn];
    buyWallet[asset] += r.base;
    buyWallet[quote] -= r.base * r.buyAvg * (1 + buy.takerFee);
    sellWallet[asset] -= r.base;
    sellWallet[quote] += r.base * r.sellAvg * (1 - sell.takerFee);

    this.rollDay(bot, r.at);
    bot.pnlUsd += r.pnlUsd;
    bot.pnlTodayUsd += r.pnlUsd;
    bot.feesUsd += r.feesUsd;
    bot.trades += 1;
    if (r.pnlUsd > 0) bot.wins += 1;
    else if (r.pnlUsd < 0) bot.losses += 1;
    const peak = Math.max(this.peak.get(bot.id) ?? 0, bot.pnlUsd);
    this.peak.set(bot.id, peak);
    bot.maxDrawdownUsd = Math.max(bot.maxDrawdownUsd, peak - bot.pnlUsd);
    bot.series = [...bot.series, bot.pnlUsd].slice(-SERIES);

    const fill: EngineFill = {
      id: `${bot.id}-${bot.trades}`,
      botId: bot.id,
      at: r.at,
      pair: bot.pair,
      buyOn: trade.buyOn,
      sellOn: trade.sellOn,
      base: r.base,
      buyAvg: r.buyAvg,
      sellAvg: r.sellAvg,
      feesUsd: r.feesUsd,
      pnlUsd: r.pnlUsd,
      quotedNetPct: trade.netPct,
      realizedNetPct: r.realizedNetPct,
      partial: r.partial,
    };
    this.fills = [fill, ...this.fills].slice(0, KEEP_FILLS);
    this.write({ at: r.at, kind: 'fill', botId: bot.id, data: fill });

    if (bot.pnlTodayUsd <= -cfg.policy.dailyLossLimitUsd && active(bot)) {
      bot.status = 'ejected';
      bot.statusReason = `Perda de hoje chegou ao limite de US$ ${cfg.policy.dailyLossLimitUsd}.`;
      this.ejectedOn.set(bot.id, utcDay(r.at));
      this.write({ at: r.at, kind: 'eject', botId: bot.id, data: { pnlTodayUsd: bot.pnlTodayUsd, limit: cfg.policy.dailyLossLimitUsd } });
      this.log(`motor: ${bot.id} (${bot.pair}) ejetado: perda de hoje chegou ao limite`);
    }
    this.changed();
  }

  /** Grava o bloqueio só quando os motivos mudam. */
  private block(bot: EngineBot, trade: ProposedTrade, reasons: RiskReason[], at: number): void {
    const key = reasons.map((r) => r.code).join();
    if (this.lastBlock.get(bot.id) === key) return;
    this.lastBlock.set(bot.id, key);
    this.write({ at, kind: 'proposal', botId: bot.id, data: trade });
    this.write({ at, kind: 'verdict', botId: bot.id, data: { result: 'BLOCK', reasons } });
    this.blocks = [{ botId: bot.id, at, reasons }, ...this.blocks].slice(0, KEEP_BLOCKS);
    this.changed();
  }

  private context(bot: EngineBot, quotes: readonly Quote[], state: CoreState, buy: Quote): RiskContext {
    const [asset, quote] = bot.pair.split('/');
    const known = (id: string) => [id, this.opts.minOrderUsd(id, bot.pair)] as const;
    return {
      now: state.at,
      balances: bot.balances,
      // Par só entra com cotação em dólar; a moeda-base vale o ask de onde ela seria comprada.
      priceUsd: { [quote]: 1, [asset]: buy.ask },
      quoteAt: Object.fromEntries(quotes.map((q) => [q.exchange, q.at])),
      exchangeOk: Object.fromEntries(state.exchanges.map((e) => [e.id, e.ok])),
      minOrderUsd: Object.fromEntries(bot.exchanges.map(known).filter((e): e is readonly [string, number] => e[1] !== undefined)),
      pnlTodayUsd: bot.pnlTodayUsd,
    };
  }

  /** O máximo da política, encolhido ao saldo de cada perna. Pó fica como falta de saldo, para a trava dar o motivo certo. */
  private tradeSize(bot: EngineBot, buy: Quote, sell: Quote, ctx: RiskContext, cfg: EngineConfig): number {
    const [asset, quote] = bot.pair.split('/');
    const quoteUsd = (ctx.balances[buy.exchange]?.[quote] ?? 0) * ctx.priceUsd[quote];
    const baseUsd = (ctx.balances[sell.exchange]?.[asset] ?? 0) * ctx.priceUsd[asset];
    const size = Math.min(cfg.policy.maxTradeUsd, quoteUsd, baseUsd);
    return size >= MIN_TRADE_USD ? size : cfg.policy.maxTradeUsd;
  }

  private capitalFor(req: BotRequest, cfg: EngineConfig): { usd: number } | { errors: RiskReason[] } {
    const running = this.bots.filter(active);
    const used = running.reduce((s, b) => s + b.capitalUsd, 0);
    const free = cfg.totalUsd * (1 - cfg.reservePct / 100) - used;
    const cap = (cfg.totalUsd * cfg.capPct) / 100;
    const tooSmall = (usd: number) => ({ errors: [reason('capital_too_small', `US$ ${usd} abaixo do mínimo de US$ ${cfg.minUsd} por robô.`, 'Pare um robô ou aumente o capital simulado.')] });
    if (req.capitalUsd !== undefined) {
      if (req.capitalUsd < cfg.minUsd) return tooSmall(req.capitalUsd);
      if (req.capitalUsd > free || req.capitalUsd > cap) {
        return { errors: [reason('capital_too_large', `US$ ${req.capitalUsd} passa do livre (US$ ${free}) ou do teto por robô (US$ ${cap}).`, 'Reduza o capital do robô.')] };
      }
      return { usd: req.capitalUsd };
    }
    const weights = Object.fromEntries([...running.map((b) => [b.id, 1]), ['new', 1]]);
    const share = allocate(cfg.totalUsd, { reservePct: cfg.reservePct, capPct: cfg.capPct, minUsd: cfg.minUsd }, weights).perBot.new ?? 0;
    const usd = Math.min(share, free);
    return usd < cfg.minUsd ? tooSmall(usd) : { usd };
  }

  /** Preço do meio entre as duas corretoras na última leitura; sem uma delas = sem preço. */
  private midPrice(pair: string, a: string, b: string): number | undefined {
    const quotes = this.last?.pairs.find((p) => p.pair === pair)?.quotes ?? [];
    const of = (id: string) => quotes.find((q) => q.exchange === id);
    const qa = of(a);
    const qb = of(b);
    if (!qa || !qb) return undefined;
    return (qa.bid + qa.ask + qb.bid + qb.ask) / 4;
  }

  private rollDay(bot: EngineBot, at: number): void {
    const today = utcDay(at);
    if (this.day.get(bot.id) === today) return;
    this.day.set(bot.id, today);
    if (bot.pnlTodayUsd !== 0) {
      bot.pnlTodayUsd = 0;
      this.changed();
    }
  }

  private prune(): void {
    const stopped = this.bots.filter((b) => !active(b));
    for (const b of stopped.slice(0, Math.max(0, stopped.length - KEEP_STOPPED))) {
      this.bots = this.bots.filter((x) => x !== b);
      for (const m of [this.lastRun, this.lastBlock, this.day, this.peak, this.ejectedOn]) m.delete(b.id);
    }
  }

  private write(entry: LedgerEntry): void {
    try {
      this.opts.ledger.append(entry);
    } catch (e) {
      this.fail(`não consegui gravar o registro do motor: ${(e as Error).message}`);
    }
  }

  private fail(message: string): void {
    if (this.error !== message) this.log(`motor: ${message}`);
    this.error = message;
    this.rev += 1;
  }

  private changed(): void {
    this.rev += 1;
    this.save();
  }
}
