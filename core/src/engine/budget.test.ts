import { describe, expect, it } from 'vitest';
import { allocate } from './budget';

const OPTS = { reservePct: 20, capPct: 50, minUsd: 50 };

const cents = (n: number) => Math.round(n * 100);
const sum = (r: ReturnType<typeof allocate>) => Object.values(r.perBot).reduce((s, v) => s + cents(v), 0) + cents(r.reserveUsd) + cents(r.idleUsd);

describe('divisão do capital', () => {
  it('tira a reserva primeiro e divide o resto pelos pesos', () => {
    expect(allocate(1000, OPTS, { a: 1, b: 1 })).toEqual({ perBot: { a: 400, b: 400 }, reserveUsd: 200, idleUsd: 0, dropped: [] });
  });

  it('normaliza os pesos', () => {
    expect(allocate(1000, OPTS, { a: 3, b: 5 }).perBot).toEqual({ a: 300, b: 500 });
  });

  it('o teto é sobre o total e o excesso vai para quem está abaixo dele', () => {
    expect(allocate(1000, OPTS, { a: 9, b: 1 }).perBot).toEqual({ a: 500, b: 300 });
  });

  it('o excesso pode empurrar outro robô para o teto, e ninguém passa', () => {
    const r = allocate(1000, { reservePct: 0, capPct: 40, minUsd: 50 }, { a: 90, b: 8, c: 2 });
    expect(r.perBot).toEqual({ a: 400, b: 400, c: 200 });
  });

  it('todos no teto: a sobra fica parada e aparece', () => {
    const r = allocate(1000, OPTS, { a: 1 });
    expect(r.perBot).toEqual({ a: 500 });
    expect(r.idleUsd).toBe(300);
  });

  it('fatia abaixo do mínimo é descartada e o valor volta para os outros', () => {
    const r = allocate(1000, { reservePct: 0, capPct: 100, minUsd: 50 }, { a: 99, b: 1 });
    expect(r.perBot).toEqual({ a: 1000 });
    expect(r.dropped).toEqual(['b']);
  });

  it('peso zero, negativo ou inválido não recebe capital', () => {
    const r = allocate(1000, OPTS, { a: 1, b: 0, c: -1, d: Number.NaN });
    expect(Object.keys(r.perBot)).toEqual(['a']);
    expect(r.dropped.sort()).toEqual(['b', 'c', 'd']);
  });

  it('sem robôs, tudo menos a reserva fica parado', () => {
    expect(allocate(1000, OPTS, {})).toEqual({ perBot: {}, reserveUsd: 200, idleUsd: 800, dropped: [] });
  });

  it('nem o menor robô alcança o mínimo: nada é alocado', () => {
    const r = allocate(100, { reservePct: 0, capPct: 100, minUsd: 200 }, { a: 1, b: 1 });
    expect(r.perBot).toEqual({});
    expect(r.idleUsd).toBe(100);
    expect(r.dropped.sort()).toEqual(['a', 'b']);
  });

  it('o centavo que sobra da divisão vai para o maior robô fora do teto', () => {
    const r = allocate(100, { reservePct: 0, capPct: 100, minUsd: 1 }, { a: 1, b: 1, c: 1 });
    expect(r.perBot).toEqual({ a: 33.34, b: 33.33, c: 33.33 });
  });

  it.each([
    [1000, OPTS, { a: 1, b: 2, c: 3 }],
    [999.99, { reservePct: 12.5, capPct: 37, minUsd: 10 }, { a: 7, b: 11, c: 13, d: 1 }],
    [0.07, { reservePct: 33, capPct: 100, minUsd: 0 }, { a: 1, b: 1 }],
  ])('a soma fecha com o total em centavos (%s)', (total, opts, weights) => {
    expect(sum(allocate(total, opts, weights))).toBe(cents(total));
  });

  it('é determinística: a ordem das chaves não muda o resultado', () => {
    expect(allocate(100, OPTS, { a: 1, b: 1, c: 1 }).perBot).toEqual(allocate(100, OPTS, { c: 1, b: 1, a: 1 }).perBot);
  });

  it.each([
    [-1, OPTS],
    [Number.NaN, OPTS],
    [100, { ...OPTS, reservePct: 101 }],
    [100, { ...OPTS, capPct: 0 }],
    [100, { ...OPTS, minUsd: -1 }],
  ])('recusa parâmetro inválido (%s)', (total, opts) => {
    expect(() => allocate(total, opts, { a: 1 })).toThrow(RangeError);
  });
});
