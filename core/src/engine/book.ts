// Livro de ofertas: caminhar pelos níveis e inverter o livro de um par listado ao contrário. Puro: sem rede.

/** Preço e quantidade da moeda-base. A CCXT pode mandar campos a mais em cada nível; só estes dois importam. */
export type Level = [price: number, amount: number];

/** Melhor preço primeiro nos dois lados. */
export interface Book {
  bids: Level[];
  asks: Level[];
}

const valid = (n: number): boolean => Number.isFinite(n) && n > 0;

/** Consome até `baseAmount` da moeda-base, na ordem dos níveis. Nível inválido é pulado. */
export function walk(levels: readonly Level[], baseAmount: number): { base: number; quote: number; avgPrice: number } {
  let base = 0;
  let quote = 0;
  for (const [price, amount] of levels) {
    const left = baseAmount - base;
    if (left <= 0) break;
    if (!valid(price) || !valid(amount)) continue;
    const take = Math.min(left, amount);
    base += take;
    quote += take * price;
  }
  return { base, quote, avgPrice: base > 0 ? quote / base : 0 };
}

/** Livro de USDT/USDC lido como USDC/USDT: quem comprava vira quem vende, com preço 1/p e quantidade p×a. */
export function invertBook(book: Book): Book {
  const flip = (levels: readonly Level[]): Level[] => levels.filter(([p, a]) => valid(p) && valid(a)).map(([p, a]) => [1 / p, p * a]);
  return { bids: flip(book.asks), asks: flip(book.bids) };
}
