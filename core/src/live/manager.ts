// Gerente do modo real. A cada leitura, se a rota passa pela trava, cria uma ficha; a ordem só sai quando uma pessoa
// aprova com a passkey. Qualquer dúvida para tudo: exposição, resultado desconhecido, exceção ou queda no meio.
// Registro só de acréscimo em live/ledger.jsonl, com a intenção gravada ANTES do envio. Nunca grava chave.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTrade, type ProposedTrade, type RiskContext } from '../engine/risk';
import { bestOpportunity } from '../spread';
import { STABLE_QUOTES } from '../transfer';
import type { CoreState, LiveExposure, LiveFillRecord, LiveFilled, LiveState, LiveTicket, RiskPolicy, RiskReason } from '../types';
import { JsonlFile } from '../jsonl';
import type { LiveConfig } from './config';
import type { LiveExecution, LiveRequest, UnwindExecution, UnwindRequest } from './engine';
import { HARD_LIMITS } from './limits';
import { registerPasskey, verifyAssertion, type StoredPasskey } from './passkey';

export interface LiveEnginePort {
  execute(req: LiveRequest): Promise<LiveExecution>;
  reconcile(req: LiveRequest): Promise<LiveExecution>;
  unwind(req: UnwindRequest): Promise<UnwindExecution>;
}

export interface LiveManagerOptions {
  /** Pasta live/, ao lado do config. */
  dir: string;
  config: LiveConfig;
  engine: LiveEnginePort;
  origins: readonly string[];
  rpId: string;
  /** OPENSPREAD_LIVE_REGISTER=1 e nenhuma passkey no arquivo. */
  registerOpen: boolean;
  readBalances: () => Promise<Record<string, Record<string, number>>>;
  minOrderUsd: (exchange: string, pair: string) => number | undefined;
  now?: () => number;
  log?: (msg: string) => void;
}

type Kind = 'proposal' | 'ticket' | 'approved' | 'refused' | 'expired' | 'intent' | 'result' | 'exposure' | 'halt' | 'release' | 'reconcile' | 'unwind';
interface Entry {
  at: number;
  kind: Kind;
  ref?: string;
  data?: unknown;
}

const KINDS = new Set<string>(['proposal', 'ticket', 'approved', 'refused', 'expired', 'intent', 'result', 'exposure', 'halt', 'release', 'reconcile', 'unwind']);
const isEntry = (v: unknown): v is Entry => {
  const e = v as Partial<Entry> | null;
  return !!e && typeof e.at === 'number' && typeof e.kind === 'string' && KINDS.has(e.kind);
};
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const KEEP_FILLS = 30;
const reason = (code: string, message: string, fix: string): RiskReason => ({ code, message, fix });

export type ApproveResult =
  | { ok: true; execution?: LiveExecution; unwind?: UnwindExecution }
  | { ok: false; code: 'not_found' | 'expired' | 'proof' | 'quote_moved' | 'blocked' | 'engine' | 'busy'; message: string; reasons?: RiskReason[] };

export class LiveManager {
  /** Sobe só quando algo acontece: a sala fica calma entre uma coisa e outra. */
  rev = 0;
  private ticket: LiveTicket | null = null;
  private halted: string | null = null;
  private exposures: LiveExposure[] = [];
  private blocked: RiskReason[] = [];
  private blockedSig = '[]';
  private balances: Record<string, Record<string, number>> = {};
  private balanceAt: number | null = null;
  private fills: LiveFillRecord[] = [];
  private day = '';
  private today = { pnlUsd: 0, trades: 0, expired: 0, refused: 0 };
  private passkey: StoredPasskey | null = null;
  private registerChallenge: string | null = null;
  private releaseCh: string | null = null;
  private pending: LiveRequest[] = [];
  private busy = false;
  private last: CoreState | undefined;
  private readonly ledger: JsonlFile<Entry>;
  private readonly passkeyFile: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: LiveManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    mkdirSync(opts.dir, { recursive: true });
    this.passkeyFile = join(opts.dir, 'passkey.json');
    this.ledger = new JsonlFile(join(opts.dir, 'ledger.jsonl'), isEntry, (bad, f) => this.log(`modo real: ignorei ${bad} linha(s) ilegível(is) em ${f}`));
  }

  /** O registro manda: refaz parada, exposição, resultado do dia e o que ficou sem desfecho. */
  load(): void {
    this.passkey = this.readPasskey();
    if (this.opts.registerOpen && !this.passkey) this.registerChallenge = randomBytes(32).toString('base64url');
    const open = new Map<string, LiveRequest>();
    const today = utcDay(this.now());
    this.day = today;
    for (const e of this.ledger.readAll()) {
      const sameDay = utcDay(e.at) === today;
      if (e.kind === 'intent' && e.ref) {
        open.set(e.ref, e.data as LiveRequest);
        if (sameDay) this.today.trades += 1;
      } else if ((e.kind === 'result' || e.kind === 'reconcile') && e.ref) {
        open.delete(e.ref);
        const matched = (e.data as { matched?: LiveFilled; pnlUsd?: number; status?: string });
        const fill = matched.status === 'filled' ? (matched as unknown as LiveFilled) : matched.matched;
        if (fill) {
          if (sameDay) this.today.pnlUsd += fill.pnlUsd;
          const req = this.requestOf(e.ref);
          this.fills.unshift({ ...fill, at: e.at, pair: req?.pair ?? '', buyOn: req?.buyOn ?? '', sellOn: req?.sellOn ?? '' });
        }
      } else if (e.kind === 'exposure') this.exposures = e.data as LiveExposure[];
      else if (e.kind === 'halt') this.halted = String((e.data as { why?: unknown })?.why ?? 'parado');
      else if (e.kind === 'release') {
        this.halted = null;
        this.exposures = [];
      } else if (e.kind === 'expired' && sameDay) this.today.expired += 1;
      else if (e.kind === 'refused' && sameDay) this.today.refused += 1;
      if (e.kind === 'intent' && e.ref) this.intents.set(e.ref, e.data as LiveRequest);
    }
    this.fills = this.fills.slice(0, KEEP_FILLS);
    this.pending = [...open.values()];
    if (this.pending.length) this.halt(`Ficou ordem sem desfecho no registro (${this.pending.length}). Confira nas corretoras.`, false);
    if (this.halted) this.releaseCh = randomBytes(32).toString('base64url');
  }

  private readonly intents = new Map<string, LiveRequest>();
  private requestOf(ref: string): LiveRequest | undefined {
    return this.intents.get(ref);
  }

  private readPasskey(): StoredPasskey | null {
    if (!existsSync(this.passkeyFile)) return null;
    try {
      const p = JSON.parse(readFileSync(this.passkeyFile, 'utf8')) as StoredPasskey;
      return typeof p.credentialId === 'string' && typeof p.publicKey === 'string' && typeof p.counter === 'number' ? p : null;
    } catch {
      this.log(`modo real: ${this.passkeyFile} ilegível; sem passkey, nenhuma ficha é criada`);
      return null;
    }
  }

  private writePasskey(p: StoredPasskey): void {
    const tmp = `${this.passkeyFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(p), 'utf8');
    renameSync(tmp, this.passkeyFile);
  }

  private write(kind: Kind, ref: string | undefined, data: unknown): void {
    this.ledger.append({ at: this.now(), kind, ...(ref ? { ref } : {}), data });
  }

  private rollDay(): void {
    const d = utcDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.today = { pnlUsd: 0, trades: 0, expired: 0, refused: 0 };
    }
  }

  private halt(why: string, record = true): void {
    if (!this.halted || record) this.halted = why;
    this.releaseCh = randomBytes(32).toString('base64url');
    this.cancelArbitrageTicket();
    this.write('halt', undefined, { why });
    this.rev += 1;
    this.log(`modo real PARADO: ${why}`);
  }

  private cancelArbitrageTicket(): void {
    if (this.ticket?.kind === 'arbitrage') this.ticket = null;
  }

  private policy(): RiskPolicy {
    const c = this.opts.config;
    return { maxTradeUsd: c.maxTradeUsd, minNetPct: c.minNetPct, maxQuoteAgeMs: c.maxQuoteAgeMs, dailyLossLimitUsd: c.dailyLossLimitUsd, allowedPairs: c.routes.map((r) => r.pair) };
  }

  async refreshBalances(): Promise<void> {
    try {
      this.balances = await this.opts.readBalances();
      this.balanceAt = this.now();
    } catch (e) {
      this.balanceAt = null;
      this.log(`modo real: não consegui ler os saldos: ${(e as Error).message}`);
    }
  }

  /** Monta a operação com a cotação de agora, para criar a ficha ou rever na aprovação. */
  private review(route: { pair: string; exchanges: [string, string] }, s: CoreState): { trade?: ProposedTrade; buyFee?: number; sellFee?: number; ask?: number; bid?: number; reasons: RiskReason[] } {
    const pair = s.pairs.find((p) => p.pair === route.pair);
    if (!pair) return { reasons: [reason('no_quote', `Sem cotação de ${route.pair}.`, 'Inclua o par nas configurações do núcleo.')] };
    const quotes = pair.quotes.filter((q) => route.exchanges.includes(q.exchange));
    const opp = bestOpportunity(quotes);
    if (!opp) return { reasons: [reason('no_quote', `Sem cotação de ${route.pair} nas duas corretoras.`, 'Espere as duas responderem.')] };
    const buy = quotes.find((q) => q.exchange === opp.buyOn);
    const sell = quotes.find((q) => q.exchange === opp.sellOn);
    if (!buy || !sell) return { reasons: [reason('no_quote', `Sem cotação de ${route.pair}.`, 'Espere as duas responderem.')] };
    const [base, quote] = route.pair.split('/');
    const mid = (buy.ask + sell.bid) / 2;
    const ctx: RiskContext = {
      now: this.now(),
      balances: this.balances,
      priceUsd: { [base]: mid, [quote]: STABLE_QUOTES.has(quote) ? 1 : mid },
      quoteAt: Object.fromEntries(quotes.map((q) => [q.exchange, q.at])),
      exchangeOk: Object.fromEntries(s.exchanges.map((e) => [e.id, e.ok])),
      minOrderUsd: Object.fromEntries(route.exchanges.flatMap((id) => {
        const min = this.opts.minOrderUsd(id, route.pair);
        return min === undefined ? [] : [[id, min]];
      })),
      pnlTodayUsd: this.today.pnlUsd,
      live: { armed: true, balanceAt: this.balanceAt, pending: !!this.halted || this.exposures.length > 0, tradesToday: this.today.trades, tradesPerDay: this.opts.config.tradesPerDay },
    };
    const trade: ProposedTrade = { botId: `route:${route.pair}`, pair: route.pair, buyOn: opp.buyOn, sellOn: opp.sellOn, sizeUsd: this.opts.config.maxTradeUsd, netPct: opp.netPct, mode: 'live' };
    const verdict = checkTrade(trade, ctx, this.policy());
    const reasons = [...verdict.reasons];
    for (const q of [buy, sell]) {
      if (!(q.takerFee > 0)) reasons.push(reason('fee_unknown', `${q.exchange} não informa a taxa de ${route.pair}.`, 'Sem a taxa, o resultado seria inventado.'));
      // O núcleo aceita par invertido para mostrar o spread; a ordem de verdade sairia no sentido errado.
      if (q.inverted) reasons.push(reason('inverted_route', `${q.exchange} lista ${route.pair} ao contrário.`, 'Escolha outra rota: o modo real só usa pares diretos.'));
    }
    if (!STABLE_QUOTES.has(quote)) reasons.push(reason('unsupported_quote', `Cotação em ${quote}.`, 'O modo real só opera pares cotados em dólar.'));
    return { trade, buyFee: buy.takerFee, sellFee: sell.takerFee, ask: buy.ask, bid: sell.bid, reasons };
  }

  /** Chamado a cada leitura. Nunca envia ordem: no máximo cria uma ficha. */
  tick(s: CoreState): void {
    this.last = s;
    this.rollDay();
    const now = this.now();
    if (this.ticket && now > this.ticket.expiresAt) {
      this.write('expired', this.ticket.fingerprint, { id: this.ticket.id });
      this.today.expired += 1;
      this.ticket = null;
      this.rev += 1;
    }
    if (this.ticket || this.halted || !this.passkey) return;
    for (const route of this.opts.config.routes) {
      const r = this.review(route, s);
      if (!r.trade || r.trade.netPct < this.opts.config.minNetPct) continue;
      if (r.reasons.length) {
        this.setBlocked(r.reasons);
        return;
      }
      this.createTicket(r.trade, r.ask as number, r.bid as number, r.buyFee as number, r.sellFee as number);
      this.setBlocked([]);
      return;
    }
    // Calma: nada acima do mínimo não é bloqueio. Mesmo assim, saldo velho precisa aparecer.
    const stale = this.balanceAt === null || now - this.balanceAt > HARD_LIMITS.balanceAgeMs;
    this.setBlocked(stale ? this.staleOnly() : this.today.trades >= Math.min(this.opts.config.tradesPerDay, HARD_LIMITS.tradesPerDay) ? this.perDayOnly() : []);
  }

  private staleOnly(): RiskReason[] {
    return [reason('balance_stale', 'Saldo da corretora velho ou não lido.', 'Espere uma nova leitura de saldo.')];
  }

  private perDayOnly(): RiskReason[] {
    return [reason('trades_per_day_hit', 'Limite de operações por dia atingido.', 'Volta amanhã (dia UTC).')];
  }

  private setBlocked(reasons: RiskReason[]): void {
    const sig = JSON.stringify(reasons.map((r) => r.code));
    this.blocked = reasons;
    if (sig !== this.blockedSig) {
      this.blockedSig = sig;
      this.rev += 1;
    }
  }

  private createTicket(trade: ProposedTrade, ask: number, bid: number, buyFee: number, sellFee: number): void {
    const now = this.now();
    const slip = this.opts.config.maxSlippagePct / 100;
    const challenge = randomBytes(32).toString('base64url');
    const fingerprint = createHash('sha256').update(JSON.stringify([trade, ask, bid, now, challenge])).digest('hex');
    this.ticket = {
      id: `t_${fingerprint.slice(0, 16)}`,
      kind: 'arbitrage',
      pair: trade.pair,
      buyOn: trade.buyOn,
      sellOn: trade.sellOn,
      sizeUsd: trade.sizeUsd,
      quotedAsk: ask,
      quotedBid: bid,
      limitAsk: ask * (1 + slip),
      limitBid: bid * (1 - slip),
      netPct: trade.netPct,
      buyFee,
      sellFee,
      createdAt: now,
      expiresAt: now + HARD_LIMITS.ticketMs,
      fingerprint,
      challenge,
    };
    this.write('proposal', fingerprint, trade);
    this.write('ticket', fingerprint, { id: this.ticket.id, limitAsk: this.ticket.limitAsk, limitBid: this.ticket.limitBid, expiresAt: this.ticket.expiresAt });
    this.rev += 1;
  }

  private checkProof(proof: unknown, challenge: string): boolean {
    if (!this.passkey) return false;
    const v = verifyAssertion(this.passkey, proof, { challenge, origins: this.opts.origins, rpId: this.opts.rpId });
    if (!v.ok) return false;
    this.passkey = { ...this.passkey, counter: v.counter };
    this.writePasskey(this.passkey);
    return true;
  }

  async approve(id: string, proof: unknown, s: CoreState): Promise<ApproveResult> {
    this.rollDay();
    const t = this.ticket;
    if (this.busy) return { ok: false, code: 'busy', message: 'Já há uma ordem em andamento.' };
    if (!t || t.id !== id) return { ok: false, code: 'not_found', message: 'Essa ficha não existe mais.' };
    const now = this.now();
    if (now > t.expiresAt) {
      this.write('expired', t.fingerprint, { id: t.id });
      this.today.expired += 1;
      this.ticket = null;
      this.rev += 1;
      return { ok: false, code: 'expired', message: 'A ficha venceu: nada foi enviado.' };
    }
    if (!this.checkProof(proof, t.challenge)) return { ok: false, code: 'proof', message: 'Aprovação sem prova válida da passkey: nada foi enviado.' };

    if (t.kind === 'unwind') return this.runUnwind(t);

    // Rever com a cotação de agora: a ficha travou o preço e o mundo pode ter mudado.
    const route = this.opts.config.routes.find((r) => r.pair === t.pair && r.exchanges.includes(t.buyOn as string) && r.exchanges.includes(t.sellOn as string));
    const r = route ? this.review(route, s) : { reasons: [reason('no_route', 'A rota saiu do live.json.', 'Confira o live.json.')] };
    const fresh = this.freshPrices(t, s);
    if (fresh && (fresh.ask > t.limitAsk || fresh.bid < t.limitBid)) {
      this.refuse(t, 'quote_moved');
      return { ok: false, code: 'quote_moved', message: 'O preço saiu da faixa aprovada: nada foi enviado.' };
    }
    if (r.reasons.length) {
      this.refuse(t, 'blocked');
      return { ok: false, code: 'blocked', message: 'A trava reviu e bloqueou: nada foi enviado.', reasons: r.reasons };
    }

    const req: LiveRequest = { pair: t.pair, buyOn: t.buyOn as string, sellOn: t.sellOn as string, sizeUsd: t.sizeUsd, quotedAsk: t.quotedAsk, quotedBid: t.quotedBid, buyFee: t.buyFee, sellFee: t.sellFee, maxSlippagePct: this.opts.config.maxSlippagePct, ref: t.fingerprint };
    this.ticket = null;
    this.write('approved', t.fingerprint, { id: t.id });
    // Antes do envio: se cair aqui, o próximo início sabe que pode ter saído ordem. Se o disco falhar, nada é enviado.
    this.write('intent', t.fingerprint, req);
    this.intents.set(t.fingerprint, req);
    this.today.trades += 1;
    this.rev += 1;
    this.busy = true;
    try {
      const execution = await this.opts.engine.execute(req);
      this.write('result', t.fingerprint, execution);
      this.applyExecution(execution, req);
      return { ok: true, execution };
    } catch (e) {
      this.write('result', t.fingerprint, { status: 'unknown', message: (e as Error).message });
      this.halt(`Erro ao enviar a ordem: ${(e as Error).message}. Confira nas corretoras.`);
      return { ok: false, code: 'engine', message: 'O envio falhou no meio. Tudo parado: confira nas corretoras.' };
    } finally {
      this.busy = false;
    }
  }

  private freshPrices(t: LiveTicket, s: CoreState): { ask: number; bid: number } | null {
    const quotes = s.pairs.find((p) => p.pair === t.pair)?.quotes ?? [];
    const buy = quotes.find((q) => q.exchange === t.buyOn);
    const sell = quotes.find((q) => q.exchange === t.sellOn);
    return buy && sell ? { ask: buy.ask, bid: sell.bid } : null;
  }

  private refuse(t: LiveTicket, why: string): void {
    this.write('refused', t.fingerprint, { id: t.id, why });
    this.today.refused += 1;
    this.ticket = null;
    this.rev += 1;
  }

  private applyExecution(x: LiveExecution, req: LiveRequest): void {
    const fill = x.status === 'filled' ? x : x.status === 'imbalanced' || x.status === 'unknown' ? x.matched : null;
    if (fill) {
      this.today.pnlUsd += fill.pnlUsd;
      this.fills.unshift({ ...fill, at: x.at, pair: req.pair, buyOn: req.buyOn, sellOn: req.sellOn });
      this.fills = this.fills.slice(0, KEEP_FILLS);
    }
    if (x.status === 'imbalanced') {
      this.setExposures(x.exposures);
      this.halt('Uma perna não casou com a outra. Veja a exposição.');
    } else if (x.status === 'unknown') {
      this.setExposures(x.exposures);
      this.halt(`Não deu para confirmar a ordem: ${x.message}. Confira nas corretoras.`);
    }
    this.rev += 1;
  }

  private setExposures(list: LiveExposure[]): void {
    this.exposures = list;
    this.write('exposure', undefined, list);
  }

  reject(id: string): boolean {
    if (!this.ticket || this.ticket.id !== id) return false;
    this.refuse(this.ticket, 'recusada pela pessoa');
    return true;
  }

  /** Parada geral: a única ação que não pede passkey, porque só deixa as coisas mais seguras. */
  stop(): void {
    this.ticket = null;
    this.halt('Parada geral acionada por você.');
  }

  /** Volta a operar. A pessoa assume que olhou as corretoras: a exposição sai da tela e fica no registro. */
  release(proof: unknown): { ok: boolean; message?: string } {
    if (!this.halted || !this.releaseCh) return { ok: false, message: 'Não há parada para liberar.' };
    if (!this.checkProof(proof, this.releaseCh)) return { ok: false, message: 'Liberar exige a passkey.' };
    for (const req of this.pending) this.write('reconcile', req.ref, { status: 'released', at: this.now() });
    this.write('release', undefined, { exposures: this.exposures, pending: this.pending.length });
    this.halted = null;
    this.exposures = [];
    this.pending = [];
    this.releaseCh = null;
    this.rev += 1;
    return { ok: true };
  }

  /** Depois de uma queda: consulta o que aconteceu com o que ficou sem desfecho. Nunca envia ordem, e segue parado. */
  async reconcile(): Promise<void> {
    const failed: LiveRequest[] = [];
    for (const req of this.pending) {
      try {
        const x = await this.opts.engine.reconcile(req);
        this.write('reconcile', req.ref, x);
        if (x.status === 'imbalanced' || x.status === 'unknown') this.setExposures([...this.exposures, ...x.exposures]);
        const fill = x.status === 'filled' ? x : x.status === 'imbalanced' || x.status === 'unknown' ? x.matched : null;
        if (fill) {
          if (utcDay(x.at) === this.day) this.today.pnlUsd += fill.pnlUsd;
          this.fills.unshift({ ...fill, at: x.at, pair: req.pair, buyOn: req.buyOn, sellOn: req.sellOn });
        }
      } catch (e) {
        failed.push(req);
        this.log(`modo real: não consegui reconciliar ${req.pair}: ${(e as Error).message}`);
      }
    }
    this.pending = failed;
    this.rev += 1;
  }

  /** Oferece uma ficha para desfazer a exposição. Quem decide é a pessoa, e aprovar não tira a parada. */
  proposeUnwind(index: number, s: CoreState): { ok: boolean; message?: string } {
    const e = this.exposures[index];
    if (!e) return { ok: false, message: 'Essa exposição não existe mais.' };
    if (e.amount === null) return { ok: false, message: 'A quantidade é desconhecida: confira na corretora antes de desfazer.' };
    if (this.ticket) return { ok: false, message: 'Já há uma ficha aberta.' };
    const q = s.pairs.find((p) => p.pair === e.pair)?.quotes.find((x) => x.exchange === e.exchange);
    if (!q) return { ok: false, message: `Sem cotação de ${e.pair} em ${e.exchange}.` };
    const now = this.now();
    const slip = this.opts.config.maxSlippagePct / 100;
    const challenge = randomBytes(32).toString('base64url');
    const fingerprint = createHash('sha256').update(JSON.stringify([e, q.bid, q.ask, now, challenge])).digest('hex');
    const selling = e.side === 'long';
    this.ticket = {
      id: `u_${fingerprint.slice(0, 16)}`,
      kind: 'unwind',
      pair: e.pair,
      ...(selling ? { sellOn: e.exchange } : { buyOn: e.exchange }),
      sizeUsd: e.amount * q.bid,
      amount: e.amount,
      quotedAsk: q.ask,
      quotedBid: q.bid,
      limitAsk: q.ask * (1 + slip),
      limitBid: q.bid * (1 - slip),
      netPct: 0,
      buyFee: q.takerFee,
      sellFee: q.takerFee,
      createdAt: now,
      expiresAt: now + HARD_LIMITS.ticketMs,
      fingerprint,
      challenge,
    };
    this.write('ticket', fingerprint, { id: this.ticket.id, kind: 'unwind', exposure: e });
    this.rev += 1;
    return { ok: true };
  }

  private async runUnwind(t: LiveTicket): Promise<ApproveResult> {
    const exchange = (t.sellOn ?? t.buyOn) as string;
    const selling = !!t.sellOn;
    const req: UnwindRequest = { exchange, pair: t.pair, side: selling ? 'sell' : 'buy', amount: t.amount as number, limitPrice: selling ? t.limitBid : t.limitAsk, ref: t.fingerprint };
    this.ticket = null;
    this.write('approved', t.fingerprint, { id: t.id, kind: 'unwind' });
    this.write('unwind', t.fingerprint, req);
    this.busy = true;
    try {
      const unwind = await this.opts.engine.unwind(req);
      this.write('unwind', t.fingerprint, unwind);
      if (unwind.status === 'done') {
        const side = selling ? 'long' : 'short';
        const next = this.exposures.flatMap((e) => {
          if (e.exchange !== exchange || e.pair !== t.pair || e.side !== side || e.amount === null) return [e];
          const left = e.amount - unwind.filled;
          return left > 1e-9 ? [{ ...e, amount: left }] : [];
        });
        this.setExposures(next);
      } else if (unwind.status === 'unknown') {
        this.halt(`Não deu para confirmar o desfazer: ${unwind.message}. Confira na corretora.`);
      }
      this.rev += 1;
      return { ok: true, unwind };
    } catch (e) {
      this.halt(`Erro ao desfazer: ${(e as Error).message}. Confira na corretora.`);
      return { ok: false, code: 'engine', message: 'O desfazer falhou no meio. Confira na corretora.' };
    } finally {
      this.busy = false;
    }
  }

  registrationChallenge(): string | null {
    return this.registerChallenge;
  }

  register(raw: unknown): { ok: boolean; message?: string } {
    if (!this.registerChallenge || this.passkey) return { ok: false, message: 'Registro fechado. Para trocar a passkey, apague passkey.json à mão e religue com OPENSPREAD_LIVE_REGISTER=1.' };
    const r = registerPasskey(raw, { challenge: this.registerChallenge, origins: this.opts.origins });
    if (!r.ok) return { ok: false, message: `Registro recusado (${r.reason}).` };
    this.passkey = r.passkey;
    this.writePasskey(r.passkey);
    this.registerChallenge = null;
    this.rev += 1;
    return { ok: true };
  }

  state(): LiveState {
    const c = this.opts.config;
    return {
      armed: true,
      sandbox: c.sandbox,
      halted: this.halted,
      exposures: this.exposures,
      ticket: this.ticket,
      blocked: this.blocked,
      passkey: { registered: !!this.passkey, registerOpen: !!this.registerChallenge },
      releaseChallenge: this.halted ? this.releaseCh : null,
      today: { ...this.today },
      limits: { maxTradeUsd: c.maxTradeUsd, dailyLossLimitUsd: c.dailyLossLimitUsd, tradesPerDay: c.tradesPerDay },
      balances: this.balances,
      balanceAt: this.balanceAt,
      fills: this.fills,
    };
  }

  /** A última leitura do núcleo, para as rotas. */
  lastState(): CoreState | undefined {
    return this.last;
  }
}
