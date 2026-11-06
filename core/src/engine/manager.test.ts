import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreState, EngineConfig, Quote } from '../types';
import type { EngineAdapter, Execution, ExecutionRequest } from './adapter';
import { Ledger } from './ledger';
import { EngineManager, parseBotRequest } from './manager';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 4, 12);

const CONFIG: EngineConfig = {
  enabled: true,
  policy: { maxTradeUsd: 100, minNetPct: 0.05, maxQuoteAgeMs: 20_000, dailyLossLimitUsd: 5, allowedPairs: ['BTC/USDT'] },
  totalUsd: 1000,
  reservePct: 20,
  capPct: 50,
  minUsd: 50,
  latencyMs: 0,
  cooldownMs: 30_000,
};

const quote = (exchange: string, bid: number, ask: number, at: number, takerFee = 0.001): Quote => ({ exchange, pair: 'BTC/USDT', bid, ask, takerFee, at, inverted: false });

/** Estado com A e B cotados; `spread` é o quanto o bid de B passa do ask de A. */
const state = (at: number, opts: { spread?: number; reverse?: boolean; fee?: number; aOk?: boolean } = {}): CoreState => {
  const s = opts.spread ?? 0;
  const [a, b] = opts.reverse ? [100 + s, 100] : [100, 100 + s];
  return {
    rev: 1,
    at,
    exchanges: [
      { id: 'a', ok: opts.aOk ?? true, lastAt: at },
      { id: 'b', ok: true, lastAt: at },
    ],
    pairs: [{ pair: 'BTC/USDT', quotes: [quote('a', a - 0.01, a, at, opts.fee), quote('b', b, b + 0.01, at, opts.fee)], best: null }],
  };
};

const GOOD = 1; // 1% de bruto: bem acima do mínimo com 0,1% de taxa em cada perna

class FakeEngine implements EngineAdapter {
  readonly kind = 'paper';
  calls: ExecutionRequest[] = [];
  next: (req: ExecutionRequest) => Execution | Promise<Execution> = (req) => {
    const base = req.sizeUsd / req.quotedAsk;
    return { ok: true, at: T0, base, buyAvg: req.quotedAsk, sellAvg: req.quotedBid, feesUsd: 0.2, pnlUsd: 0.8, realizedNetPct: 0.8, partial: false };
  };
  execute(req: ExecutionRequest): Promise<Execution> {
    this.calls.push(req);
    return Promise.resolve(this.next(req));
  }
}

describe('gerente do motor', () => {
  let dir: string;
  let config: EngineConfig | undefined;
  let engine: FakeEngine;
  let logs: string[];
  let clock: number;
  let ledger: Ledger;

  const manager = () =>
    new EngineManager(engine, { file: join(dir, 'engine', 'bots.json'), ledger, config: () => config, minOrderUsd: () => undefined, now: () => clock, log: (m) => logs.push(m) });
  const kinds = () => ledger.read(100).map((e) => e.kind);

  /** Gerente com um robô de US$ 400 ligado. */
  const started = () => {
    const m = manager();
    m.evaluate(state(clock));
    const bot = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 400 });
    if ('errors' in bot) throw new Error(JSON.stringify(bot.errors));
    return { m, id: bot.id };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openspread-engine-'));
    config = structuredClone(CONFIG);
    engine = new FakeEngine();
    logs = [];
    clock = T0;
    ledger = new Ledger(join(dir, 'engine', 'ledger.jsonl'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('guarda quem ligou o robô e registra; robô antigo sem source continua carregando', () => {
    expect(parseBotRequest({ pair: 'BTC/USDT', exchanges: ['a', 'b'], source: 'mcp' })?.source).toBe('mcp');
    expect(parseBotRequest({ pair: 'BTC/USDT', exchanges: ['a', 'b'], source: 'outro' })).toBeNull();
    const m = manager();
    m.evaluate(state(clock));
    const bot = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'], source: 'mcp' });
    if ('errors' in bot) throw new Error(JSON.stringify(bot.errors));
    expect(bot.source).toBe('mcp');
    expect(ledger.read(100).find((e) => e.kind === 'start')?.data).toMatchObject({ source: 'mcp' });

    const { source: _source, ...old } = bot;
    m.stopBot(bot.id);
    m.save();
    const file = join(dir, 'engine', 'bots.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { bots: unknown[] };
    saved.bots = [old];
    writeFileSync(file, JSON.stringify(saved));
    const again = manager();
    again.load();
    expect(again.state(clock).bots[0].source).toBeUndefined();
  });

  it('sem engine no config, ou desligado: não faz nada', async () => {
    for (const c of [undefined, { ...CONFIG, enabled: false }]) {
      config = c;
      const m = manager();
      m.evaluate(state(clock, { spread: GOOD }));
      await m.idle();
      expect(engine.calls).toEqual([]);
      expect(m.enabled()).toBe(false);
      const r = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'] });
      expect('errors' in r && r.errors[0].code).toBe('engine_off');
    }
  });

  it('saldo inicial: metade em cada corretora e, em cada uma, metade em cada moeda', () => {
    const { m } = started();
    const bot = m.state(clock).bots[0];
    expect(bot.status).toBe('running');
    expect(bot.balances).toEqual({ a: { BTC: 1, USDT: 100 }, b: { BTC: 1, USDT: 100 } });
    expect(kinds()).toEqual(['start']);
  });

  it('abaixo do mínimo: não executa, conta a leitura e não grava nada', async () => {
    const { m } = started();
    m.evaluate(state(clock));
    await m.idle();
    const bot = m.state(clock).bots[0];
    expect(engine.calls).toEqual([]);
    expect(bot.samples).toBe(1);
    expect(bot.samplesAbove).toBe(0);
    expect(kinds()).toEqual(['start']);
  });

  it('acima do mínimo: proposta, veredito e operação no registro, com saldos e resultado atualizados', async () => {
    const { m, id } = started();
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ pair: 'BTC/USDT', buyOn: 'a', sellOn: 'b', sizeUsd: 100, quotedAsk: 100, quotedBid: 101, buyFee: 0.001, sellFee: 0.001 });
    expect(kinds()).toEqual(['start', 'proposal', 'verdict', 'fill']);
    const s = m.state(clock);
    const bot = s.bots[0];
    expect(bot).toMatchObject({ trades: 1, wins: 1, losses: 0, pnlUsd: 0.8, pnlTodayUsd: 0.8, samples: 1, samplesAbove: 1, series: [0.8] });
    // Compra de 1 BTC por 100 + 0,1 de taxa em A; venda de 1 BTC por 101 − 0,101 de taxa em B
    expect(bot.balances.a.BTC).toBeCloseTo(2, 10);
    expect(bot.balances.a.USDT).toBeCloseTo(-0.1, 10);
    expect(bot.balances.b.BTC).toBeCloseTo(0, 10);
    expect(bot.balances.b.USDT).toBeCloseTo(100 + 100.899, 10);
    expect(s.fills[0]).toMatchObject({ botId: id, buyOn: 'a', sellOn: 'b', pnlUsd: 0.8, partial: false });
    expect(s.mode).toBe('paper');
  });

  it('o sentido contrário usa as pernas trocadas', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD, reverse: true }));
    await m.idle();
    expect(engine.calls[0]).toMatchObject({ buyOn: 'b', sellOn: 'a' });
  });

  it('prejuízo depois da latência entra como prejuízo', async () => {
    const { m } = started();
    engine.next = (r) => ({ ok: true, at: T0, base: r.sizeUsd / r.quotedAsk, buyAvg: 100, sellAvg: 99.9, feesUsd: 0.2, pnlUsd: -0.3, realizedNetPct: -0.3, partial: false });
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(m.state(clock).bots[0]).toMatchObject({ trades: 1, wins: 0, losses: 1, pnlUsd: -0.3, maxDrawdownUsd: 0.3 });
  });

  it('par fora da lista: recusa ao ligar, com o motivo, e não cria robô', () => {
    const m = manager();
    m.evaluate(state(clock));
    config!.policy.allowedPairs = [];
    const r = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'] });
    expect('errors' in r && r.errors.map((e) => e.code)).toEqual(['pair_not_allowed']);
    expect(m.state(clock).bots).toEqual([]);
  });

  it('recusa ao ligar: mesma corretora, cotação que não é dólar, sem preço e robô repetido', () => {
    const m = manager();
    const codes = (req: Parameters<EngineManager['startBot']>[0]) => {
      const r = m.startBot(req);
      return 'errors' in r ? r.errors.map((e) => e.code) : [];
    };
    expect(codes({ pair: 'BTC/USDT', exchanges: ['a', 'b'] })).toEqual(['no_price']);
    m.evaluate(state(clock));
    expect(codes({ pair: 'BTC/USDT', exchanges: ['a', 'a'] })).toEqual(['same_exchange']);
    config!.policy.allowedPairs.push('ETH/BTC');
    expect(codes({ pair: 'ETH/BTC', exchanges: ['a', 'b'] })).toEqual(['unsupported_quote']);
    expect(codes({ pair: 'BTC/USDT', exchanges: ['a', 'b'] })).toEqual([]);
    expect(codes({ pair: 'BTC/USDT', exchanges: ['b', 'a'] })).toEqual(['bot_exists']);
  });

  it('capital: padrão pela divisão, nunca além do livre, do teto ou abaixo do mínimo', () => {
    const m = manager();
    const three = state(clock);
    three.pairs[0].quotes.push(quote('c', 100, 100.01, clock));
    m.evaluate(three);
    const first = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'] });
    if ('errors' in first) throw new Error('devia ligar');
    expect(first.capitalUsd).toBe(500); // reserva 200; teto 50% de 1000

    const codes = (capitalUsd: number) => {
      const r = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'c'], capitalUsd });
      return 'errors' in r ? r.errors.map((e) => e.code) : [];
    };
    expect(codes(400)).toEqual(['capital_too_large']); // só restam 300 livres
    expect(codes(49)).toEqual(['capital_too_small']);
  });

  it('pedido fora do formato ou com campo desconhecido: parseBotRequest recusa', () => {
    expect(parseBotRequest({ pair: 'btc/usdt', exchanges: ['A', 'B'] })).toEqual({ pair: 'BTC/USDT', exchanges: ['a', 'b'] });
    expect(parseBotRequest({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 100 })).toEqual({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 100 });
    for (const bad of [null, 'x', { pair: 'BTC' }, { pair: 'BTC/USDT', exchanges: ['a'] }, { pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: -1 }, { pair: 'BTC/USDT', exchanges: ['a', 'b'], chave: 'x' }]) {
      expect(parseBotRequest(bad)).toBeNull();
    }
  });

  it('taxa zero é taxa desconhecida: bloqueia, porque inventaria lucro', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD, fee: 0 }));
    await m.idle();
    expect(engine.calls).toEqual([]);
    // um motivo por perna, para dizer qual corretora não informou
    expect(m.state(clock).blocks[0].reasons.map((r) => r.code)).toEqual(['fee_unknown', 'fee_unknown']);
  });

  it('mesmo bloqueio grava uma vez; motivo novo grava de novo', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD, aOk: false }));
    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD, aOk: false }));
    await m.idle();
    expect(kinds().filter((k) => k === 'verdict')).toHaveLength(1);
    expect(m.state(clock).blocks).toHaveLength(1);

    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD, fee: 0 }));
    await m.idle();
    expect(kinds().filter((k) => k === 'verdict')).toHaveLength(2);
    expect(m.state(clock).blocks[0].reasons.map((r) => r.code)).toEqual(['fee_unknown', 'fee_unknown']);
  });

  it('saldo acaba num sentido: parado com o motivo; oportunidade no outro sentido volta a operar', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(engine.calls).toHaveLength(1);
    const parked = m.state(clock).bots[0];
    expect(parked.status).toBe('parked');
    expect(parked.statusReason).toContain('Saldo');

    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD, reverse: true }));
    await m.idle();
    expect(engine.calls).toHaveLength(2);
    expect(m.state(clock).bots[0].status).toBe('running');
    expect(m.state(clock).bots[0].statusReason).toBeUndefined();
  });

  it('saldo menor que o tamanho: a operação encolhe em vez de travar por centavos', async () => {
    const { m } = started();
    // O preço caiu para 80: o 1 BTC guardado em B vale US$ 80, menos que os US$ 100 da política.
    const low = state(clock, { spread: GOOD });
    low.pairs[0].quotes = [quote('a', 79.99, 80, clock), quote('b', 82, 82.01, clock)];
    m.evaluate(low);
    await m.idle();
    expect(engine.calls[0].sizeUsd).toBeCloseTo(80, 10);
  });

  it('sobrou pó: não opera, e o motivo é falta de saldo', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD })); // gasta o USDT de A e o BTC de B
    await m.idle();
    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(engine.calls).toHaveLength(1);
    expect(m.state(clock).blocks[0].reasons.map((r) => r.code)).toEqual(['no_balance_buy', 'no_balance_sell']);
  });

  it('perda chega ao limite: ejetado, para de operar e só religa no dia seguinte', async () => {
    const { m } = started();
    engine.next = (r) => ({ ok: true, at: T0, base: r.sizeUsd / r.quotedAsk, buyAvg: 100, sellAvg: 95, feesUsd: 0.2, pnlUsd: -5, realizedNetPct: -5, partial: false });
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(m.state(clock).bots[0].status).toBe('ejected');
    expect(kinds()).toContain('eject');

    clock += 40_000;
    m.evaluate(state(clock, { spread: GOOD, reverse: true }));
    await m.idle();
    expect(engine.calls).toHaveLength(1);

    const again = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 100 });
    expect('errors' in again && again.errors[0].code).toBe('ejected_today');

    clock += DAY;
    m.evaluate(state(clock));
    expect(m.state(clock).bots[0].pnlTodayUsd).toBe(0);
    expect(m.state(clock).bots[0].status).toBe('ejected');
    expect('errors' in m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 100 })).toBe(false);
  });

  it('o dia novo zera o resultado do dia, sem mexer no total', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    clock += DAY;
    m.evaluate(state(clock));
    expect(m.state(clock).bots[0]).toMatchObject({ pnlTodayUsd: 0, pnlUsd: 0.8 });
  });

  it('respeita a pausa e não executa duas vezes ao mesmo tempo', async () => {
    const { m } = started();
    let release!: (e: Execution) => void;
    engine.next = () => new Promise<Execution>((r) => (release = r));
    m.evaluate(state(clock, { spread: GOOD }));
    m.evaluate(state(clock + 60_000, { spread: GOOD, reverse: true })); // execução ainda em andamento
    expect(engine.calls).toHaveLength(1);
    release({ ok: true, at: clock, base: 1, buyAvg: 100, sellAvg: 101, feesUsd: 0.2, pnlUsd: 0.8, realizedNetPct: 0.8, partial: false });
    await m.idle();

    clock += 10_000;
    m.evaluate(state(clock, { spread: GOOD, reverse: true })); // dentro da pausa de 30 s
    await m.idle();
    expect(engine.calls).toHaveLength(1);

    clock += 25_000;
    engine.next = (r) => ({ ok: true, at: clock, base: r.sizeUsd / r.quotedAsk, buyAvg: 100, sellAvg: 101, feesUsd: 0, pnlUsd: 0, realizedNetPct: 0, partial: false });
    m.evaluate(state(clock, { spread: GOOD, reverse: true }));
    await m.idle();
    expect(engine.calls).toHaveLength(2);
  });

  it('sem livro: nenhuma operação, nenhum número, e o robô continua', async () => {
    const { m } = started();
    engine.next = () => ({ ok: false, at: clock, code: 'book_unavailable', message: 'Sem livro de b: caiu' });
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    const s = m.state(clock);
    expect(s.fills).toEqual([]);
    expect(s.bots[0]).toMatchObject({ status: 'running', trades: 0, pnlUsd: 0 });
    expect(s.blocks[0].reasons[0].code).toBe('book_unavailable');
    expect(kinds()).not.toContain('fill');
  });

  it('erro inesperado do motor aparece no estado e não derruba nada', async () => {
    const { m } = started();
    engine.next = () => {
      throw new Error('quebrou');
    };
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(m.state(clock).engine).toEqual({ kind: 'paper', ok: false, error: 'quebrou' });
    expect(m.state(clock).bots[0].status).toBe('running');
  });

  it('parar: status parado, sai do capital ativo e não opera mais', async () => {
    const { m, id } = started();
    expect(m.stopBot(id)?.status).toBe('stopped');
    expect(kinds()).toContain('stop');
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(engine.calls).toEqual([]);
    expect(m.stopBot('nao-existe')).toBeUndefined();
    // Parado libera o capital: com ele ativo, só restariam 400 livres.
    const next = m.startBot({ pair: 'BTC/USDT', exchanges: ['a', 'b'], capitalUsd: 500 });
    expect('errors' in next).toBe(false);
  });

  it('reinício: saldos e resultado voltam, e o robô continua', async () => {
    const { m } = started();
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    const again = manager();
    again.load();
    const bot = again.state(clock).bots[0];
    expect(bot).toMatchObject({ status: 'running', trades: 1, pnlUsd: 0.8 });
    expect(bot.balances.a.BTC).toBeCloseTo(2, 10);
    expect(again.state(clock).fills).toHaveLength(1);
  });

  it('arquivo quebrado: guardado como .bad, com aviso, e começa vazio', () => {
    const file = join(dir, 'engine', 'bots.json');
    started();
    writeFileSync(file, '{ quebrado');
    const m = manager();
    m.load();
    expect(m.state(clock).bots).toEqual([]);
    expect(existsSync(`${file}.bad`)).toBe(true);
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{ quebrado');
    expect(logs.join()).toContain('bots.json');
  });

  it('muda a cada novidade (rev) e não muda parado', async () => {
    const { m } = started();
    const before = m.rev;
    m.evaluate(state(clock));
    expect(m.rev).toBe(before);
    m.evaluate(state(clock, { spread: GOOD }));
    await m.idle();
    expect(m.rev).toBeGreaterThan(before);
  });
});
