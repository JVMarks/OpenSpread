import { describe, expect, it } from 'vitest';
import { checkSides, HORIZON_MS, parseAnalysis } from './schema';

const valid = () => ({
  pair: 'btc/usdt',
  horizon: '24h',
  direction: 'up',
  conviction: 70,
  factors: [{ name: 'Tendência', category: 'technical', effect: 'supports' }],
  plans: [{ label: 'A', kind: 'market', stop: 98, targets: [104] }],
  reasoning: 'Motivo.',
  model: 'claude',
  usedChart: false,
});
const errors = (raw: unknown) => {
  const r = parseAnalysis(raw);
  return r.ok ? [] : r.errors;
};

describe('parseAnalysis', () => {
  it('aceita uma análise válida e normaliza o par', () => {
    const r = parseAnalysis(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.pair).toBe('BTC/USDT');
  });
  it('recusa campo desconhecido, inclusive preço de referência mandado pelo cliente', () => {
    expect(errors({ ...valid(), referencePrice: 100 }).join()).toContain('referencePrice');
    expect(errors({ ...valid(), plans: [{ ...valid().plans[0], x: 1 }] }).join()).toContain('x');
  });
  it('recusa convicção fora de 50 a 100 ou quebrada', () => {
    for (const conviction of [49, 101, 70.5, '70', null]) expect(errors({ ...valid(), conviction }).length).toBe(1);
    for (const conviction of [50, 100]) expect(errors({ ...valid(), conviction })).toEqual([]);
  });
  it('recusa direção e horizonte fora da lista', () => {
    expect(errors({ ...valid(), direction: 'flat' }).length).toBe(1);
    expect(errors({ ...valid(), horizon: '2h' }).length).toBe(1);
  });
  it('confirmation exige entry; market não aceita', () => {
    expect(errors({ ...valid(), plans: [{ label: 'B', kind: 'confirmation', stop: 98, targets: [104] }] }).length).toBe(1);
    expect(errors({ ...valid(), plans: [{ label: 'A', kind: 'market', entry: 100, stop: 98, targets: [104] }] }).length).toBe(1);
  });
  it('limita tamanhos', () => {
    expect(errors({ ...valid(), reasoning: 'x'.repeat(4001) }).length).toBe(1);
    expect(errors({ ...valid(), reasoning: 'x'.repeat(4000) })).toEqual([]);
    expect(errors({ ...valid(), reasoning: '  ' }).length).toBe(1);
    expect(errors({ ...valid(), model: 'x'.repeat(65) }).length).toBe(1);
    expect(errors({ ...valid(), factors: [] }).length).toBe(1);
    expect(errors({ ...valid(), factors: Array(13).fill(valid().factors[0]) }).length).toBe(1);
    expect(errors({ ...valid(), plans: Array(3).fill(valid().plans[0]) }).length).toBeGreaterThan(0);
    expect(errors({ ...valid(), plans: [{ ...valid().plans[0], targets: [] }] }).length).toBe(1);
    expect(errors({ ...valid(), plans: [{ ...valid().plans[0], targets: [1, 2, 3, 4] }] }).length).toBe(1);
  });
  it('aceita zero planos, recusa rótulo repetido e preço não positivo', () => {
    expect(errors({ ...valid(), plans: [] })).toEqual([]);
    expect(errors({ ...valid(), plans: [valid().plans[0], valid().plans[0]] }).length).toBe(1);
    expect(errors({ ...valid(), plans: [{ ...valid().plans[0], stop: 0 }] }).length).toBe(1);
    expect(errors({ ...valid(), plans: [{ ...valid().plans[0], targets: [Infinity] }] }).length).toBe(1);
  });
  it('recusa o que não é objeto', () => {
    for (const raw of [null, [], 'x', 1]) expect(errors(raw).length).toBe(1);
  });
});

describe('checkSides', () => {
  const input = (over: object) => {
    const r = parseAnalysis({ ...valid(), ...over });
    if (!r.ok) throw new Error(r.errors.join());
    return r.input;
  };
  it('alta: stop abaixo e alvo acima da entrada', () => {
    expect(checkSides(input({}), 100)).toEqual([]);
    expect(checkSides(input({ plans: [{ label: 'A', kind: 'market', stop: 101, targets: [104] }] }), 100).length).toBe(1);
    expect(checkSides(input({ plans: [{ label: 'A', kind: 'market', stop: 98, targets: [99] }] }), 100).length).toBe(1);
  });
  it('baixa: stop acima e alvo abaixo', () => {
    expect(checkSides(input({ direction: 'down', plans: [{ label: 'A', kind: 'market', stop: 102, targets: [96] }] }), 100)).toEqual([]);
    expect(checkSides(input({ direction: 'down' }), 100).length).toBe(2);
  });
  it('confirmation mede a partir de entry, não da referência', () => {
    expect(checkSides(input({ plans: [{ label: 'B', kind: 'confirmation', entry: 110, stop: 108, targets: [115] }] }), 100)).toEqual([]);
  });
});

it('horizontes em ms', () => {
  expect(HORIZON_MS['1h']).toBe(3_600_000);
  expect(HORIZON_MS['7d']).toBe(604_800_000);
});
