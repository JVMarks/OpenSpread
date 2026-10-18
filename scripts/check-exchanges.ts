// Confere, só com dados públicos, quais pares de stablecoins cada corretora lista (direto ou invertido) e a taxa
// taker padrão de cada um. Uso: npm run check:exchanges
import ccxt from 'ccxt';

const EXCHANGES = ['binance', 'okx', 'bybit', 'kraken', 'coinbaseexchange'] as const;
const PAIRS = ['USDC/USDT', 'DAI/USDT', 'FDUSD/USDT', 'USDE/USDT'] as const;

const invert = (pair: string): string => pair.split('/').reverse().join('/');

for (const id of EXCHANGES) {
  const Ctor = (ccxt as unknown as Record<string, new (o: object) => { loadMarkets(): Promise<Record<string, { taker?: number; active?: boolean }>> }>)[id];
  const ex = new Ctor({ enableRateLimit: true });
  try {
    const markets = await ex.loadMarkets();
    const cells = PAIRS.map((p) => {
      const direct = markets[p];
      const inv = markets[invert(p)];
      if (direct) return `${p}: direto (taker ${direct.taker}, ativo ${direct.active})`;
      if (inv) return `${p}: invertido ${invert(p)} (taker ${inv.taker}, ativo ${inv.active})`;
      return `${p}: -`;
    });
    console.log(`${id}\n  ${cells.join('\n  ')}`);
  } catch (e) {
    console.log(`${id}: ERRO ${(e as Error).message.slice(0, 120)}`);
  }
}
