import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE, scoreboard } from './board';
import type { AnalysisResult, PlanResult } from '../types';

const res = (over: Partial<AnalysisResult>): AnalysisResult => ({
  id: 'x', pair: 'BTC/USDT', model: 'm', horizon: '1h', direction: 'up', conviction: 80, status: 'resolved', hit: true, resolvedAt: 1, plans: [], ...over,
});
const many = (n: number, over: Partial<AnalysisResult>) => Array.from({ length: n }, () => res(over));

describe('scoreboard', () => {
  it('Brier: acerto com 80 = 0,04; erro com 80 = 0,64; os dois = 0,34 e skill −0,36', () => {
    expect(scoreboard([res({})], []).total.brier).toBeCloseTo(0.04);
    expect(scoreboard([res({ hit: false })], []).total.brier).toBeCloseTo(0.64);
    const t = scoreboard([res({}), res({ hit: false })], []).total;
    expect(t.brier).toBeCloseTo(0.34);
    expect(t.skill).toBeCloseTo(-0.36);
    expect(t.baselineBrier).toBe(0.25);
  });
  it('abaixo da amostra mínima não dá percentual, mas mostra o Brier', () => {
    expect(MIN_SAMPLE).toBe(30);
    const small = scoreboard(many(29, {}), []).total;
    expect(small.hitPct).toBeNull();
    expect(small.hits).toBe(29);
    expect(small.brier).not.toBeNull();
    expect(scoreboard(many(30, {}), []).total.hitPct).toBe(100);
  });
  it('void conta à parte e fica fora do Brier e do acerto', () => {
    const t = scoreboard([res({}), res({ status: 'void', reason: 'no_data', hit: undefined })], []).total;
    expect(t).toMatchObject({ resolved: 1, voids: 1, submitted: 2, hits: 1 });
    expect(t.brier).toBeCloseTo(0.04);
  });
  it('vazio não quebra', () => {
    const t = scoreboard([], []).total;
    expect(t).toMatchObject({ submitted: 0, brier: null, skill: null, hitPct: null });
    expect(t.plans).toEqual({ triggered: 0, avgNetPct: null, worstNetPct: null });
    expect(scoreboard([], []).byModel).toEqual([]);
  });
  it('separa por modelo e horizonte, e conta as abertas', () => {
    const b = scoreboard([res({ model: 'a' }), res({ model: 'b', horizon: '24h' })], [{ model: 'a', horizon: '1h' }, { model: 'c', horizon: '7d' }]);
    expect(b.total).toMatchObject({ submitted: 4, open: 2, resolved: 2 });
    expect(b.byModel.map((l) => `${l.model}/${l.horizon}/${l.open}`).sort()).toEqual(['a/1h/1', 'b/24h/0', 'c/7d/1']);
  });
  it('calibração em cinco faixas, 100 entra na última', () => {
    const c = scoreboard([res({ conviction: 50 }), res({ conviction: 59, hit: false }), res({ conviction: 100 })], []).total.calibration;
    expect(c.map((b) => [b.from, b.to])).toEqual([[50, 59], [60, 69], [70, 79], [80, 89], [90, 100]]);
    expect(c[0]).toMatchObject({ n: 2, hitPct: 50 });
    expect(c[0].meanConviction).toBeCloseTo(54.5);
    expect(c[1]).toMatchObject({ n: 0, hitPct: null, meanConviction: null });
    expect(c[4].n).toBe(1);
  });
  it('planos: só os que entraram e têm resultado', () => {
    const p = (status: PlanResult['status'], netPct?: number): PlanResult => ({ label: 'A', status, netPct });
    const t = scoreboard([res({ plans: [p('target', 3.8), p('stop', -2.2)] }), res({ plans: [p('closed', 0.4), p('not_triggered'), p('void')] })], []).total;
    expect(t.plans.triggered).toBe(3);
    expect(t.plans.avgNetPct).toBeCloseTo(2 / 3);
    expect(t.plans.worstNetPct).toBeCloseTo(-2.2);
  });
});
