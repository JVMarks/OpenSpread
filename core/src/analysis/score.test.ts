import { describe, expect, it } from 'vitest';
import { MAX_GAP_MS, observe, openOf, resolve } from './score';
import type { Analysis, AnalysisPlan } from '../types';

const H = 3_600_000;
const T0 = 1_000_000;
const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  id: 'a1', pair: 'BTC/USDT', horizon: '1h', direction: 'up', conviction: 70, factors: [], reasoning: 'r', model: 'm', usedChart: false,
  plans: [{ label: 'A', kind: 'market', stop: 98, targets: [104] }],
  submittedAt: T0, expiresAt: T0 + H, referencePrice: 100, costPct: 0.2, exchanges: 3, ...over,
});
/** Por padrão, preenche o intervalo com o preço anterior, como um núcleo ligado faria. `gaps` deixa o buraco. */
const run = (a: Analysis, samples: Array<[number, number]>, gaps = false) => {
  let o = openOf(a);
  let at0 = 0;
  for (const [at, price] of samples) {
    if (!gaps) for (let t = at0 + 600_000; t < at; t += 600_000) o = observe(o, o.lastPrice, T0 + t);
    o = observe(o, price, T0 + at);
    at0 = at;
  }
  return o;
};
const finish = (a: Analysis, samples: Array<[number, number]>, gaps = false) => {
  const last = samples[samples.length - 1][0];
  const r = resolve(run(a, samples, gaps), T0 + last);
  if (!r) throw new Error('não resolveu');
  return r;
};
const down: Partial<Analysis> = { direction: 'down', plans: [{ label: 'A', kind: 'market', stop: 102, targets: [96] }] };
const conf = (plan: Partial<AnalysisPlan>): Partial<Analysis> => ({ plans: [{ label: 'B', kind: 'confirmation', entry: 101, stop: 100, targets: [104], ...plan }] });

describe('direção', () => {
  it('alta que fecha acima acerta', () => {
    const r = finish(analysis(), [[H, 101]]);
    expect(r).toMatchObject({ status: 'resolved', hit: true, closePrice: 101 });
    expect(r.movePct).toBeCloseTo(1);
  });
  it('empate conta como erro', () => {
    expect(finish(analysis(), [[H, 100]]).hit).toBe(false);
  });
  it('baixa que fecha abaixo acerta', () => {
    expect(finish(analysis(down), [[H, 99]]).hit).toBe(true);
  });
  it('vale a primeira amostra depois do vencimento, não as seguintes', () => {
    const o = run(analysis(), [[H + 1000, 90], [H + 2000, 200]], true);
    expect(resolve(o, T0 + H + 2000)?.closePrice).toBe(90);
  });
  it('antes do vencimento não resolve', () => {
    expect(resolve(run(analysis(), [[1000, 101]]), T0 + 1000)).toBeNull();
  });
  it('sem amostra até 15 min depois vira void, e a amostra atrasada não conta', () => {
    expect(resolve(openOf(analysis()), T0 + H + MAX_GAP_MS)).toBeNull();
    const r = resolve(openOf(analysis()), T0 + H + MAX_GAP_MS + 1);
    expect(r).toMatchObject({ status: 'void', reason: 'no_data' });
    expect(r?.hit).toBeUndefined();
    const late = resolve(run(analysis(), [[H + MAX_GAP_MS + 1, 150]], true), T0 + H + MAX_GAP_MS + 1);
    expect(late?.status).toBe('void');
  });
});

describe('planos', () => {
  it('tocar o alvo dá bruto menos custo', () => {
    const p = finish(analysis(), [[1000, 104], [H, 90]]).plans[0];
    expect(p).toMatchObject({ status: 'target', entryPrice: 100, exitPrice: 104 });
    expect(p.netPct).toBeCloseTo(3.8);
  });
  it('tocar o stop dá −2,2', () => {
    const p = finish(analysis(), [[1000, 98], [H, 110]]).plans[0];
    expect(p).toMatchObject({ status: 'stop', exitPrice: 98 });
    expect(p.netPct).toBeCloseTo(-2.2);
  });
  it('preço que pula o stop sai no preço visto, que é pior', () => {
    const p = finish(analysis(), [[1000, 97], [H, 110]]).plans[0];
    expect(p.exitPrice).toBe(97);
    expect(p.netPct).toBeCloseTo(-3.2);
  });
  it('alvo nunca sai melhor que o alvo', () => {
    expect(finish(analysis(), [[1000, 110], [H, 110]]).plans[0].exitPrice).toBe(104);
  });
  it('sem tocar, fecha no vencimento', () => {
    const p = finish(analysis(), [[1000, 101], [H, 101]]).plans[0];
    expect(p).toMatchObject({ status: 'closed', exitPrice: 101 });
    expect(p.netPct).toBeCloseTo(0.8);
  });
  it('baixa: ganha quando cai', () => {
    expect(finish(analysis(down), [[1000, 96], [H, 96]]).plans[0].netPct).toBeCloseTo(3.8);
    expect(finish(analysis(down), [[1000, 102], [H, 96]]).plans[0].netPct).toBeCloseTo(-2.2);
  });
  it('depois de fechar, o plano não muda', () => {
    expect(finish(analysis(), [[1000, 104], [2000, 90], [H, 90]]).plans[0].status).toBe('target');
  });
  it('a amostra depois do vencimento não mexe no plano', () => {
    expect(finish(analysis(), [[H + 1000, 98]]).plans[0].status).toBe('closed');
  });
});

describe('confirmation', () => {
  it('sem tocar a entrada: not_triggered, sem resultado', () => {
    const p = finish(analysis(conf({})), [[H, 100.5]]).plans[0];
    expect(p.status).toBe('not_triggered');
    expect(p.netPct).toBeUndefined();
  });
  it('toca a entrada e depois o alvo; o resultado parte da entrada', () => {
    const p = finish(analysis(conf({})), [[1000, 101], [2000, 104], [H, 104]]).plans[0];
    expect(p).toMatchObject({ status: 'target', entryPrice: 101 });
    expect(p.netPct).toBeCloseTo((3 / 101) * 100 - 0.2);
  });
  it('salto que passa pela entrada, pelo stop e pelo alvo na mesma amostra: vale o stop', () => {
    const p = finish(analysis({ ...conf({}), referencePrice: 99 }), [[1000, 105], [H, 105]]).plans[0];
    expect(p).toMatchObject({ status: 'stop', exitPrice: 100 });
  });
});

describe('buraco nas amostras', () => {
  it('plano aberto vira void; a direção continua valendo', () => {
    const r = finish(analysis(), [[1000, 101], [1000 + MAX_GAP_MS + 1, 101], [H - 1000, 101], [H, 102]], true);
    expect(r.hit).toBe(true);
    expect(r.plans[0].status).toBe('void');
  });
  it('plano já fechado antes do buraco mantém o resultado', () => {
    const r = finish(analysis(), [[1000, 104], [1000 + MAX_GAP_MS + 1, 101], [H, 102]], true);
    expect(r.plans[0].status).toBe('target');
  });
  it('no void de direção, plano fechado antes mantém o resultado', () => {
    const r = resolve(run(analysis(), [[1000, 104]]), T0 + H + MAX_GAP_MS + 1);
    expect(r?.status).toBe('void');
    expect(r?.plans[0].status).toBe('target');
  });
});
