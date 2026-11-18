import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveExecution, LiveRequest, UnwindExecution, UnwindRequest } from './engine';
import { HARD_LIMITS } from './limits';
import { LiveManager, type LiveEnginePort } from './manager';
import { b64url } from './passkey';
import type { CoreState, Quote } from '../types';
import type { LiveConfig } from './config';

const ORIGIN = 'http://localhost:5173';
const T0 = Date.UTC(2026, 10, 5, 12);
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = b64url(publicKey.export({ type: 'spki', format: 'der' }));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
let counter = 10;
/** O que o navegador produziria com a passkey, assinando o desafio recebido. */
const sign = (challenge: string) => {
  counter += 1;
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64url(Buffer.from(challenge)), origin: ORIGIN }));
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  const auth = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
  return { credentialId: 'cred', clientDataJSON: b64url(client), authenticatorData: b64url(auth), signature: b64url(createSign('sha256').update(auth).update(sha(client)).sign(privateKey)) };
};

const CONFIG: LiveConfig = { sandbox: true, routes: [{ pair: 'BTC/USDT', exchanges: ['binance', 'bybit'] }], maxTradeUsd: 20, minNetPct: 0.05, maxQuoteAgeMs: 20_000, dailyLossLimitUsd: 10, tradesPerDay: 3, maxSlippagePct: 0.1 };
const quote = (exchange: string, bid: number, ask: number, at: number): Quote => ({ exchange, pair: 'BTC/USDT', bid, ask, takerFee: 0.001, at, inverted: false });
/** Com spread de 1% bruto, o líquido passa do mínimo. */
const state = (at: number, sellBid = 101, buyAsk = 100): CoreState => ({
  rev: 1,
  at,
  exchanges: [{ id: 'binance', ok: true, lastAt: at }, { id: 'bybit', ok: true, lastAt: at }],
  pairs: [{ pair: 'BTC/USDT', best: null, quotes: [quote('binance', buyAsk - 0.01, buyAsk, at), quote('bybit', sellBid, sellBid + 0.01, at)] }],
});
const FILLED: LiveExecution = { status: 'filled', at: T0, base: 0.1, buyAvg: 100, sellAvg: 101, feesUsd: 0.02, pnlUsd: 0.08, realizedNetPct: 0.8, partial: false, feeEstimated: false };

class FakeEngine implements LiveEnginePort {
  calls: LiveRequest[] = [];
  unwinds: UnwindRequest[] = [];
  reconciled: LiveRequest[] = [];
  next: LiveExecution = FILLED;
  unwindNext: UnwindExecution = { status: 'done', at: T0, filled: 0.1, average: 100 };
  execute(req: LiveRequest) {
    this.calls.push(req);
    return Promise.resolve(this.next);
  }
  reconcile(req: LiveRequest) {
    this.reconciled.push(req);
    return Promise.resolve(this.next);
  }
  unwind(req: UnwindRequest) {
    this.unwinds.push(req);
    return Promise.resolve(this.unwindNext);
  }
}

let dir: string;
let clock: number;
let engine: FakeEngine;
const manager = (over: { config?: LiveConfig; register?: boolean } = {}) => {
  const m = new LiveManager({ dir, config: over.config ?? CONFIG, engine, now: () => clock, origins: [ORIGIN], rpId: 'localhost', registerOpen: over.register ?? false, readBalances: () => Promise.resolve({ binance: { USDT: 1000, BTC: 1 }, bybit: { USDT: 1000, BTC: 1 } }), minOrderUsd: () => 5 });
  m.load();
  return m;
};
const withKey = () => writeFileSync(join(dir, 'passkey.json'), JSON.stringify({ credentialId: 'cred', publicKey: spki, counter: 0 }));
/** Gerente com passkey, saldo lido e uma ficha aberta. */
const ticketed = async () => {
  withKey();
  const m = manager();
  await m.refreshBalances();
  m.tick(state(clock));
  const t = m.state().ticket;
  if (!t) throw new Error(`sem ficha: ${JSON.stringify(m.state().blocked)}`);
  return { m, t };
};
const log = () => (existsSync(join(dir, 'ledger.jsonl')) ? readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string }) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'livem-'));
  clock = T0;
  engine = new FakeEngine();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('criar ficha', () => {
  it('sem saldo lido, nenhuma ficha', () => {
    withKey();
    const m = manager();
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
    expect(m.state().blocked.map((b) => b.code)).toContain('balance_stale');
  });
  it('sem passkey registrada, nenhuma ficha', async () => {
    const m = manager();
    await m.refreshBalances();
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
  });
  it('spread abaixo do mínimo: nenhuma ficha, e calma', async () => {
    withKey();
    const m = manager();
    await m.refreshBalances();
    const before = m.rev;
    m.tick(state(clock, 100.01));
    expect(m.state().ticket).toBeNull();
    expect(m.rev).toBe(before);
  });
  it('spread bom: ficha com o preço travado, 20 s de prazo, e nenhuma ordem enviada', async () => {
    const { m, t } = await ticketed();
    expect(t).toMatchObject({ kind: 'arbitrage', pair: 'BTC/USDT', buyOn: 'binance', sellOn: 'bybit', sizeUsd: 20, quotedAsk: 100, quotedBid: 101, expiresAt: clock + HARD_LIMITS.ticketMs });
    expect(t.limitAsk).toBeCloseTo(100.1);
    expect(t.limitBid).toBeCloseTo(100.899);
    expect(engine.calls).toEqual([]);
    expect(m.state().armed).toBe(true);
  });
  it('só uma ficha aberta', async () => {
    const { m, t } = await ticketed();
    clock += 1000;
    m.tick(state(clock));
    expect(m.state().ticket?.id).toBe(t.id);
  });
  it('par com cotação invertida não gera ficha: a ordem real seria no sentido errado', async () => {
    withKey();
    const m = manager();
    await m.refreshBalances();
    const s = state(clock);
    s.pairs[0].quotes[0].inverted = true;
    m.tick(s);
    expect(m.state().ticket).toBeNull();
  });
});

describe('aprovar', () => {
  it('aprovação válida envia a ordem com o preço da ficha, e o registro grava a intenção antes do envio', async () => {
    const { m, t } = await ticketed();
    let kindsAtSend: string[] = [];
    const exec = engine.execute.bind(engine);
    engine.execute = (req) => {
      kindsAtSend = log().map((e) => e.kind);
      return exec(req);
    };
    const r = await m.approve(t.id, sign(t.challenge), state(clock));
    expect(r).toMatchObject({ ok: true, execution: { status: 'filled' } });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ pair: 'BTC/USDT', buyOn: 'binance', sellOn: 'bybit', sizeUsd: 20, quotedAsk: 100, quotedBid: 101, ref: t.fingerprint, maxSlippagePct: 0.1 });
    expect(kindsAtSend).toContain('intent');
    expect(log().map((e) => e.kind)).toContain('result');
    expect(m.state().ticket).toBeNull();
    expect(m.state().today).toMatchObject({ trades: 1 });
    expect(m.state().today.pnlUsd).toBeCloseTo(0.08);
    expect(m.state().fills[0]).toMatchObject({ pair: 'BTC/USDT', base: 0.1 });
  });
  it('aprova uma vez só', async () => {
    const { m, t } = await ticketed();
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect((await m.approve(t.id, sign(t.challenge), state(clock))).ok).toBe(false);
    expect(engine.calls).toHaveLength(1);
  });
  it('sem prova, com prova errada ou de outro desafio: recusa, e não envia', async () => {
    const { m, t } = await ticketed();
    expect(await m.approve(t.id, null, state(clock))).toMatchObject({ ok: false, code: 'proof' });
    expect(await m.approve(t.id, { credentialId: 'cred' }, state(clock))).toMatchObject({ ok: false, code: 'proof' });
    expect(await m.approve(t.id, sign('outro desafio'), state(clock))).toMatchObject({ ok: false, code: 'proof' });
    expect(engine.calls).toEqual([]);
    expect(m.state().ticket?.id).toBe(t.id);
  });
  it('ficha vencida recusa', async () => {
    const { m, t } = await ticketed();
    clock += HARD_LIMITS.ticketMs + 1;
    expect(await m.approve(t.id, sign(t.challenge), state(clock))).toMatchObject({ ok: false, code: 'expired' });
    expect(engine.calls).toEqual([]);
    expect(m.state().today.expired).toBe(1);
  });
  it('tick depois do prazo expira a ficha e registra', async () => {
    const { m } = await ticketed();
    clock += HARD_LIMITS.ticketMs + 1;
    m.tick(state(clock, 100.01));
    expect(m.state().ticket).toBeNull();
    expect(log().map((e) => e.kind)).toContain('expired');
  });
  it('preço saiu da faixa da ficha: não envia', async () => {
    const { m, t } = await ticketed();
    expect(await m.approve(t.id, sign(t.challenge), state(clock, 101, 100.5))).toMatchObject({ ok: false, code: 'quote_moved' });
    expect(engine.calls).toEqual([]);
  });
  it('a trava revê na hora de aprovar: corretora caiu, não envia', async () => {
    const { m, t } = await ticketed();
    const s = state(clock);
    s.exchanges[1].ok = false;
    const r = await m.approve(t.id, sign(t.challenge), s);
    expect(r).toMatchObject({ ok: false, code: 'blocked' });
    expect(JSON.stringify(r)).toContain('exchange_down');
    expect(engine.calls).toEqual([]);
    expect(m.state().ticket).toBeNull();
  });
  it('recusar cancela e registra', async () => {
    const { m, t } = await ticketed();
    expect(m.reject(t.id)).toBe(true);
    expect(m.state().ticket).toBeNull();
    expect(m.state().today.refused).toBe(1);
    expect(log().map((e) => e.kind)).toContain('refused');
  });
  it('limite de operações por dia para de gerar ficha', async () => {
    withKey();
    const m = manager({ config: { ...CONFIG, tradesPerDay: 1 } });
    await m.refreshBalances();
    m.tick(state(clock));
    const t = m.state().ticket!;
    await m.approve(t.id, sign(t.challenge), state(clock));
    clock += 1000;
    await m.refreshBalances();
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
    expect(m.state().blocked.map((b) => b.code)).toContain('trades_per_day_hit');
  });
  it('perda do dia chega ao limite: para de gerar ficha', async () => {
    const { m, t } = await ticketed();
    engine.next = { ...FILLED, pnlUsd: -10 } as LiveExecution;
    await m.approve(t.id, sign(t.challenge), state(clock));
    clock += 1000;
    await m.refreshBalances();
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
    expect(m.state().blocked.map((b) => b.code)).toContain('daily_loss_hit');
  });
});

describe('parada', () => {
  const EXPO = { exchange: 'binance', pair: 'BTC/USDT', asset: 'BTC', side: 'long' as const, amount: 0.1, price: 100 };
  it('perna desequilibrada para tudo e mostra a exposição', async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'imbalanced', at: T0, exposures: [EXPO], matched: null };
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(m.state().halted).toBeTruthy();
    expect(m.state().exposures).toEqual([EXPO]);
    clock += 1000;
    await m.refreshBalances();
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
  });
  it('resultado desconhecido também para tudo', async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'unknown', at: T0, exposures: [{ ...EXPO, amount: null }], matched: null, message: 'x' };
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(m.state().halted).toContain('x');
  });
  it('exceção no motor para tudo, sem derrubar', async () => {
    const { m, t } = await ticketed();
    engine.execute = () => Promise.reject(new Error('quebrou'));
    await expect(m.approve(t.id, sign(t.challenge), state(clock))).resolves.toMatchObject({ ok: false, code: 'engine' });
    expect(m.state().halted).toBeTruthy();
  });
  it('parada geral não pede passkey, cancela a ficha e para', async () => {
    const { m } = await ticketed();
    m.stop();
    expect(m.state().halted).toBeTruthy();
    expect(m.state().ticket).toBeNull();
    clock += 1000;
    m.tick(state(clock));
    expect(m.state().ticket).toBeNull();
  });
  it('liberar exige passkey', async () => {
    const { m } = await ticketed();
    m.stop();
    expect(m.release(null).ok).toBe(false);
    expect(m.state().halted).toBeTruthy();
    const ch = m.state().releaseChallenge as string;
    expect(m.release(sign('outro')).ok).toBe(false);
    expect(m.release(sign(ch)).ok).toBe(true);
    expect(m.state().halted).toBeNull();
    expect(m.state().releaseChallenge).toBeNull();
  });
  it('liberar limpa a exposição, registrando que a pessoa assumiu', async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'imbalanced', at: T0, exposures: [EXPO], matched: null };
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(m.release(sign(m.state().releaseChallenge as string)).ok).toBe(true);
    expect(m.state().exposures).toEqual([]);
    expect(log().map((e) => e.kind)).toContain('release');
  });
});

describe('desfazer', () => {
  const EXPO = { exchange: 'binance', pair: 'BTC/USDT', asset: 'BTC', side: 'long' as const, amount: 0.1, price: 100 };
  const halted = async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'imbalanced', at: T0, exposures: [EXPO], matched: null };
    await m.approve(t.id, sign(t.challenge), state(clock));
    return m;
  };
  it('oferece ficha, sem enviar nada sozinho', async () => {
    const m = await halted();
    expect(engine.unwinds).toEqual([]);
    const r = m.proposeUnwind(0, state(clock));
    expect(r.ok).toBe(true);
    expect(m.state().ticket).toMatchObject({ kind: 'unwind', sellOn: 'binance', amount: 0.1 });
    expect(engine.unwinds).toEqual([]);
  });
  it('comprado desfaz vendendo, com preço travado; aprovar reduz a exposição, e segue parado', async () => {
    const m = await halted();
    m.proposeUnwind(0, state(clock));
    const t = m.state().ticket!;
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(engine.unwinds[0]).toMatchObject({ exchange: 'binance', side: 'sell', amount: 0.1 });
    expect(engine.unwinds[0].limitPrice).toBeCloseTo(99.99 * 0.999);
    expect(m.state().exposures).toEqual([]);
    expect(m.state().halted).toBeTruthy();
  });
  it('desfazer parcial deixa o resto', async () => {
    const m = await halted();
    engine.unwindNext = { status: 'done', at: T0, filled: 0.04, average: 100 };
    m.proposeUnwind(0, state(clock));
    const t = m.state().ticket!;
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(m.state().exposures[0].amount).toBeCloseTo(0.06);
  });
  it('quantidade desconhecida não permite desfazer: a pessoa olha na corretora', async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'unknown', at: T0, exposures: [{ ...EXPO, amount: null }], matched: null, message: 'x' };
    await m.approve(t.id, sign(t.challenge), state(clock));
    expect(m.proposeUnwind(0, state(clock)).ok).toBe(false);
  });
});

describe('reinício', () => {
  it('queda entre a intenção e o resultado: fica parado e reconcilia, sem criar ordem', async () => {
    const { m, t } = await ticketed();
    engine.execute = () => new Promise(() => {}); // nunca responde: simula a queda
    void m.approve(t.id, sign(t.challenge), state(clock));
    await new Promise((r) => setTimeout(r, 10));
    expect(log().map((e) => e.kind)).toContain('intent');

    engine = new FakeEngine();
    const again = manager();
    expect(again.state().halted).toBeTruthy();
    await again.reconcile();
    expect(engine.reconciled).toHaveLength(1);
    expect(engine.calls).toEqual([]);
    expect(again.state().halted).toBeTruthy();
    expect(log().map((e) => e.kind)).toContain('reconcile');
  });
  it('consulta que falha continua pendente; liberar encerra, e o próximo início não para de novo', async () => {
    const { m, t } = await ticketed();
    engine.execute = () => new Promise(() => {});
    void m.approve(t.id, sign(t.challenge), state(clock));
    await new Promise((r) => setTimeout(r, 10));
    engine = new FakeEngine();
    engine.reconcile = () => Promise.reject(new Error('rede'));
    const again = manager();
    await again.reconcile();
    expect(again.state().halted).toBeTruthy();
    expect(again.release(sign(again.state().releaseChallenge as string)).ok).toBe(true);
    expect(manager().state().halted).toBeNull();
  });
  it('disco falhou ao gravar a intenção: nada é enviado, e a próxima tentativa não fica travada', async () => {
    const { m, t } = await ticketed();
    const ledger = (m as unknown as { ledger: { append: (e: unknown) => void } }).ledger;
    const append = ledger.append.bind(ledger);
    ledger.append = (e) => {
      if ((e as { kind: string }).kind === 'intent') throw new Error('disco cheio');
      append(e);
    };
    await expect(m.approve(t.id, sign(t.challenge), state(clock))).rejects.toThrow('disco cheio');
    expect(engine.calls).toEqual([]);
    expect((m as unknown as { busy: boolean }).busy).toBe(false);
  });
  it('reconciliar com exposição mostra a exposição', async () => {
    const { m, t } = await ticketed();
    engine.execute = () => new Promise(() => {});
    void m.approve(t.id, sign(t.challenge), state(clock));
    await new Promise((r) => setTimeout(r, 10));
    engine = new FakeEngine();
    engine.next = { status: 'imbalanced', at: T0, exposures: [{ exchange: 'binance', pair: 'BTC/USDT', asset: 'BTC', side: 'long', amount: 0.1, price: 100 }], matched: null };
    const again = manager();
    await again.reconcile();
    expect(again.state().exposures).toHaveLength(1);
  });
  it('parada, exposição, resultado e contagens do dia sobrevivem ao reinício', async () => {
    const { m, t } = await ticketed();
    engine.next = { status: 'imbalanced', at: T0, exposures: [{ exchange: 'binance', pair: 'BTC/USDT', asset: 'BTC', side: 'long', amount: 0.1, price: 100 }], matched: { base: 0.05, buyAvg: 100, sellAvg: 101, feesUsd: 0.01, pnlUsd: 0.04, realizedNetPct: 0.8, partial: true, feeEstimated: false } };
    await m.approve(t.id, sign(t.challenge), state(clock));
    const again = manager();
    expect(again.state().halted).toBeTruthy();
    expect(again.state().exposures).toHaveLength(1);
    expect(again.state().today).toMatchObject({ trades: 1 });
    expect(again.state().today.pnlUsd).toBeCloseTo(0.04);
  });
  it('dia novo zera o dia, e a parada continua', async () => {
    const { m } = await ticketed();
    m.stop();
    clock += 86_400_000;
    const again = manager();
    expect(again.state().today).toMatchObject({ trades: 0, pnlUsd: 0 });
    expect(again.state().halted).toBeTruthy();
  });
  it('a contagem de contador da passkey sobrevive: assinatura antiga não volta a valer', async () => {
    const { m, t } = await ticketed();
    const proof = sign(t.challenge);
    await m.approve(t.id, proof, state(clock));
    const stored = JSON.parse(readFileSync(join(dir, 'passkey.json'), 'utf8')) as { counter: number };
    expect(stored.counter).toBe(counter);
  });
});

describe('registro da passkey', () => {
  const body = (challenge: string) => ({
    credentialId: 'cred',
    publicKey: spki,
    algorithm: -7,
    clientDataJSON: b64url(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: b64url(Buffer.from(challenge)), origin: ORIGIN }))),
  });
  it('sem OPENSPREAD_LIVE_REGISTER=1 não registra', () => {
    const m = manager();
    expect(m.registrationChallenge()).toBeNull();
    expect(m.register(body('x')).ok).toBe(false);
    expect(existsSync(join(dir, 'passkey.json'))).toBe(false);
  });
  it('com a chave aberta registra uma vez, e não aceita trocar', () => {
    const m = manager({ register: true });
    const ch = m.registrationChallenge() as string;
    expect(m.register(body(ch)).ok).toBe(true);
    expect(existsSync(join(dir, 'passkey.json'))).toBe(true);
    expect(m.state().passkey.registered).toBe(true);
    expect(m.register(body(ch)).ok).toBe(false);
    expect(m.registrationChallenge()).toBeNull();
  });
  it('já registrada, a chave aberta não troca: precisa apagar o arquivo à mão', () => {
    withKey();
    const m = manager({ register: true });
    expect(m.registrationChallenge()).toBeNull();
    expect(m.state().passkey).toEqual({ registered: true, registerOpen: false });
  });
});

describe('estado', () => {
  it('nunca traz chave, e diz os tetos e se é ambiente de teste', async () => {
    const { m } = await ticketed();
    const s = m.state();
    expect(s.sandbox).toBe(true);
    expect(s.limits).toEqual({ maxTradeUsd: 20, dailyLossLimitUsd: 10, tradesPerDay: 3 });
    expect(JSON.stringify(s)).not.toMatch(/apiKey|secret|password/i);
  });
});
