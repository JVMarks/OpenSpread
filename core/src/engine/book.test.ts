import { describe, expect, it } from 'vitest';
import { invertBook, walk, type Level } from './book';

describe('caminhar pelo livro', () => {
  it('um nível basta: preço do nível', () => {
    expect(walk([[100, 5]], 2)).toEqual({ base: 2, quote: 200, avgPrice: 100 });
  });

  it('três níveis: preço médio exato', () => {
    const levels: Level[] = [
      [100, 1],
      [101, 1],
      [102, 2],
    ];
    const r = walk(levels, 3);
    expect(r.base).toBe(3);
    expect(r.quote).toBe(100 + 101 + 102);
    expect(r.avgPrice).toBeCloseTo(101, 10);
  });

  it('livro raso: executa só o que existe', () => {
    expect(walk([[100, 1]], 3)).toEqual({ base: 1, quote: 100, avgPrice: 100 });
  });

  it('livro vazio: nada executa', () => {
    expect(walk([], 3)).toEqual({ base: 0, quote: 0, avgPrice: 0 });
  });

  it('ignora nível inválido em vez de inventar preço', () => {
    const levels: Level[] = [
      [Number.NaN, 1],
      [0, 1],
      [100, Number.NaN],
      [101, 1],
    ];
    expect(walk(levels, 1)).toEqual({ base: 1, quote: 101, avgPrice: 101 });
  });
});

describe('livro de par invertido', () => {
  it('USDT/USDC vira USDC/USDT: preço 1/p, quantidade p×a, bids e asks trocados', () => {
    const book = invertBook({ bids: [[0.5, 10]], asks: [[0.8, 10]] });
    // Quem vende 10 USDT a 0,8 USDC está comprando 8 USDC a 1,25 USDT: o ask do par listado vira bid do par lido.
    expect(book.bids).toEqual([[1.25, 8]]);
    expect(book.asks).toEqual([[2, 5]]);
  });

  it('mantém a ordem do melhor para o pior', () => {
    const book = invertBook({
      bids: [
        [0.5, 1],
        [0.4, 1],
      ],
      asks: [
        [0.8, 1],
        [1, 1],
      ],
    });
    expect(book.asks.map((l) => l[0])).toEqual([2, 2.5]);
    expect(book.bids.map((l) => l[0])).toEqual([1.25, 1]);
  });
});
