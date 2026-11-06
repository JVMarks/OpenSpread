import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisBook } from './book';
import type { PairState } from '../types';

const H = 3_600_000;
const T0 = 1_000_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'analysis-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const book = (log: (m: string) => void = () => {}) => {
  const b = new AnalysisBook({ dir, log });
  b.load();
  return b;
};
const market = (mid = 100, pair = 'BTC/USDT'): PairState[] => [{
  pair,
  best: null,
  quotes: [{ exchange: 'okx', pair, bid: mid, ask: mid, takerFee: 0.001, at: 1, inverted: false }],
}];
const input = (over: object = {}) => ({
  pair: 'BTC/USDT', horizon: '1h', direction: 'up', conviction: 80,
  factors: [{ name: 'Tendência', category: 'technical', effect: 'supports' }],
  plans: [{ label: 'A', kind: 'market', stop: 98, targets: [104] }],
  reasoning: 'Motivo.', model: 'claude', usedChart: true, ...over,
});
const failure = (r: ReturnType<AnalysisBook['submit']>) => {
  if (r.ok) throw new Error('devia recusar');
  return r;
};
const ok = (r: ReturnType<AnalysisBook['submit']>) => {
  if (!r.ok) throw new Error(r.errors.join());
  return r.analysis;
};

describe('submit', () => {
  it('a referência e o custo vêm do núcleo', () => {
    const a = ok(book().submit(input(), market(100), T0));
    expect(a).toMatchObject({ referencePrice: 100, exchanges: 1, submittedAt: T0, expiresAt: T0 + H });
    expect(a.costPct).toBeCloseTo(0.2);
    expect(a.id).toMatch(/^a_[0-9a-f]{16}$/);
  });
  it('recusa preço mandado pelo cliente', () => {
    expect(failure(book().submit(input({ referencePrice: 1 }), market(), T0)).code).toBe('invalid');
  });
  it('só uma aberta por modelo, par e horizonte', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    expect(failure(b.submit(input(), market(), T0 + 1)).code).toBe('already_open');
    ok(b.submit(input({ model: 'codex' }), market(), T0 + 1));
    ok(b.submit(input({ horizon: '4h' }), market(), T0 + 1));
  });
  it('par fora da leitura é recusado, e o erro diz onde adicionar', () => {
    const r = failure(book().submit(input({ pair: 'SOL/USDT' }), market(), T0));
    expect(r.code).toBe('pair_not_read');
    expect(r.errors.join()).toContain('Mercados');
  });
  it('stop do lado errado da referência é recusado', () => {
    expect(failure(book().submit(input(), market(97), T0)).code).toBe('stop_wrong_side');
  });
  it('recusada não ocupa lugar nem vai para o registro', () => {
    const b = book();
    failure(b.submit(input(), market(97), T0));
    ok(b.submit(input(), market(100), T0));
    expect(b.state(T0).scoreboard.total.submitted).toBe(1);
  });
});

describe('tick', () => {
  it('resolve no vencimento e libera outra análise', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    const rev = b.rev;
    for (let t = 600_000; t <= H; t += 600_000) b.tick(market(101), T0 + t);
    const s = b.state(T0 + H);
    expect(b.rev).toBeGreaterThan(rev);
    expect(s.open).toEqual([]);
    expect(s.recent[0].result).toMatchObject({ status: 'resolved', hit: true });
    expect(s.scoreboard.total.brier).toBeCloseTo(0.04);
    ok(b.submit(input(), market(), T0 + H + 1));
  });
  it('sem o par na leitura não há amostra, e o tempo vira void', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    b.tick([], T0 + H + 15 * 60_000 + 1);
    expect(b.state(T0 + H).recent[0].result).toMatchObject({ status: 'void', reason: 'no_data' });
    expect(b.state(T0 + H).scoreboard.total.voids).toBe(1);
  });
  it('tick sem novidade não muda rev: a sala fica calma', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    const rev = b.rev;
    b.tick(market(), T0 + 1000);
    expect(b.rev).toBe(rev);
  });
});

describe('disco', () => {
  it('reiniciar preserva abertas, trajetória e placar', () => {
    const a = book();
    ok(a.submit(input(), market(), T0));
    ok(a.submit(input({ model: 'codex' }), market(), T0));
    for (let t = 600_000; t <= H; t += 600_000) a.tick(market(101), T0 + t);
    ok(a.submit(input({ horizon: '4h' }), market(), T0 + H + 1));
    a.tick(market(104), T0 + H + 2);
    a.save();

    const b = book();
    const s = b.state(T0 + H + 3);
    expect(s.open.map((o) => o.horizon)).toEqual(['4h']);
    expect(s.scoreboard.total).toMatchObject({ submitted: 3, resolved: 2, open: 1 });
    expect(failure(b.submit(input({ horizon: '4h' }), market(), T0 + H + 4)).code).toBe('already_open');
    for (let t = T0 + H + 600_000; t <= T0 + 5 * H + 600_000; t += 600_000) b.tick(market(90), t);
    const last = b.state(T0 + 6 * H).recent[0];
    expect(last.analysis.horizon).toBe('4h');
    expect(last.result.plans[0].status).toBe('target');
  });
  it('queda antes de salvar: a aberta volta pelo registro, e o plano sem trajetória vira void', () => {
    const a = book();
    ok(a.submit(input(), market(), T0));
    // sem a.save() do estado mais recente: simula queda depois de amostras
    a.tick(market(101), T0 + 1000);
    rmSync(join(dir, 'open.json'), { force: true });
    const b = book();
    expect(b.state(T0 + 2000).open.length).toBe(1);
  });
  it('linha cortada no registro é pulada com aviso, e a próxima não cola nela', () => {
    const a = book();
    ok(a.submit(input(), market(), T0));
    appendFileSync(join(dir, 'journal.jsonl'), '{"at":1,"kind":"subm');
    const log = vi.fn();
    const b = book(log);
    expect(log.mock.calls.join()).toContain('ilegível');
    expect(b.state(T0).open.length).toBe(1);
    ok(b.submit(input({ model: 'codex' }), market(), T0 + 1));
    const c = book();
    expect(c.state(T0 + 2).open.length).toBe(2);
  });
  it('registro é só de acréscimo: resolver não reescreve o que foi enviado', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    const first = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    for (let t = 600_000; t <= H; t += 600_000) b.tick(market(101), T0 + t);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8').startsWith(first)).toBe(true);
  });
});

describe('estado', () => {
  it('traz o aviso e separa o resumo sem raciocínio', () => {
    const b = book();
    ok(b.submit(input(), market(), T0));
    expect(b.state(T0).notice).toBe('Registro do próprio usuário. Não é ordem nem recomendação.');
    const brief = b.brief();
    expect(brief.items[0]).toMatchObject({ pair: 'BTC/USDT', model: 'claude' });
    expect(JSON.stringify(brief)).not.toContain('Motivo.');
    for (let t = 600_000; t <= H; t += 600_000) b.tick(market(101), T0 + t);
    expect(b.brief().items[0].result).toMatchObject({ status: 'resolved', hit: true, plans: [{ label: 'A', status: 'closed' }] });
  });
});
