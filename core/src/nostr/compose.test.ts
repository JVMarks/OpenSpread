import { describe, expect, it } from 'vitest';
import { analysisNote, MAX_CONTENT, resultReply } from './compose';
import type { Analysis, AnalysisResult } from '../types';

const T0 = Date.UTC(2026, 10, 17, 12, 0);
const A: Analysis = {
  id: 'a_1', pair: 'BTC/USDT', horizon: '24h', direction: 'up', conviction: 70,
  factors: [{ name: 'Tendência', category: 'technical', effect: 'supports' }, { name: 'Funding', category: 'derivatives', effect: 'weakens' }],
  plans: [{ label: 'A', kind: 'market', stop: 74000, targets: [79999] }, { label: 'B', kind: 'confirmation', entry: 77777, stop: 75555, targets: [81234] }],
  reasoning: 'Rompeu a resistência.', model: 'claude', usedChart: true,
  submittedAt: T0, expiresAt: T0 + 86_400_000, referencePrice: 76144.45, costPct: 0.2, exchanges: 3,
};
const R: AnalysisResult = { id: 'a_1', pair: 'BTC/USDT', model: 'claude', horizon: '24h', direction: 'up', conviction: 70, status: 'resolved', hit: false, closePrice: 75800, movePct: -0.45, resolvedAt: T0 + 86_400_000, plans: [] };

describe('analysisNote', () => {
  it('mostra par, horizonte, direção, convicção, fatores e raciocínio, com o aviso', () => {
    const e = analysisNote(A, 'pt-BR', T0);
    expect(e.kind).toBe(1);
    expect(e.created_at).toBe(T0 / 1000);
    expect(e.content).toContain('Análise BTC/USDT · 24h');
    expect(e.content).toContain('Direção: alta · convicção 70%');
    expect(e.content).toContain('+ Tendência (técnico)');
    expect(e.content).toContain('− Funding (derivativos)');
    expect(e.content).toContain('Rompeu a resistência.');
    expect(e.content).toContain('Registro pessoal, não é recomendação.');
    expect(e.content).toContain('Usou print de gráfico.');
  });
  it('nunca leva entrada, stop nem alvos (decisão do diretor)', () => {
    const text = JSON.stringify(analysisNote(A, 'pt-BR', T0));
    for (const n of ['74000', '74.000', '79999', '79.999', '77777', '77.777', '75555', '81234', 'stop', 'alvo', 'entrada']) expect(text).not.toContain(n);
  });
  it('tags: openspread, o par sem barra em minúsculas e o id da análise', () => {
    expect(analysisNote(A, 'pt-BR', T0).tags).toEqual([['t', 'openspread'], ['t', 'btcusdt'], ['openspread', 'analysis', 'a_1']]);
  });
  it('em inglês', () => {
    const e = analysisNote(A, 'en', T0);
    expect(e.content).toContain('Direction: up · conviction 70%');
    expect(e.content).toContain('Personal record, not a recommendation.');
  });
  it('raciocínio enorme é cortado, e o aviso continua', () => {
    const e = analysisNote({ ...A, reasoning: 'x'.repeat(5000) }, 'pt-BR', T0);
    expect(e.content.length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(e.content).toContain('(cortado)');
    expect(e.content).toContain('Registro pessoal, não é recomendação.');
  });
  it('fator com valor fora da lista (registro antigo) não vira "undefined"', () => {
    const old = { ...A, factors: [{ name: 'ETF', category: 'flow', effect: 'opposes' }] } as unknown as Analysis;
    const e = analysisNote(old, 'pt-BR', T0);
    expect(e.content).not.toContain('undefined');
    expect(e.content).toContain('· ETF (flow)');
  });
});

describe('resultReply', () => {
  const root = 'e'.repeat(64);
  const author = 'b'.repeat(64);
  it('resposta marcada como raiz da thread, com o autor', () => {
    const e = resultReply(A, R, root, author, 'pt-BR', T0);
    expect(e?.tags).toEqual([['e', root, '', 'root', author], ['p', author], ['t', 'openspread'], ['openspread', 'result', 'a_1']]);
  });
  it('erro aparece como erro, com o movimento', () => {
    const e = resultReply(A, R, root, author, 'pt-BR', T0);
    expect(e?.content).toContain('errou, fechou em 75.800 (−0,45% sobre a referência)');
    expect(e?.content).toContain('Empate conta como erro.');
  });
  it('acerto e sem dados', () => {
    expect(resultReply(A, { ...R, hit: true, movePct: 1 }, root, author, 'pt-BR', T0)?.content).toContain('acertou');
    expect(resultReply(A, { ...R, status: 'void', hit: undefined }, root, author, 'pt-BR', T0)?.content).toContain('sem dados');
  });
  it('sem resultado, ou resultado de outra análise, não gera resposta', () => {
    expect(resultReply(A, undefined, root, author, 'pt-BR', T0)).toBeNull();
    expect(resultReply(A, { ...R, id: 'a_2' }, root, author, 'pt-BR', T0)).toBeNull();
  });
});
