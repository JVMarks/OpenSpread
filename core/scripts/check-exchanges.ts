// Confere, só com dados públicos, quais pares cada corretora lista (direto ou invertido) e a taxa taker padrão.
// Usa as corretoras e os pares do arquivo de configuração; pares passados na linha de comando substituem os do arquivo
// (não grava nada). Uso: npm run check:exchanges  ou  npm run check:exchanges -- BTC/USDT ETH/USDT
import ccxt from 'ccxt';
import { configPath, loadConfig, validateConfig } from '../src/config';
import { Poller } from '../src/poller';

const known: readonly string[] = ccxt.exchanges;
const config = loadConfig(configPath(), known, console.log);
const args = process.argv.slice(2);
let pairs = config.pairs;
if (args.length) {
  const v = validateConfig({ exchanges: config.exchanges, pairs: args }, known);
  if (!v.ok) {
    console.error(v.errors.join('\n'));
    process.exit(1);
  }
  pairs = v.config.pairs;
}

const result = await new Poller(config.exchanges, pairs).check(config.exchanges, pairs);
for (const ex of result.exchanges) {
  if (!ex.ok) {
    console.log(`${ex.id}: ERRO ${ex.error}`);
    continue;
  }
  const cells = ex.listings.map((l) =>
    l.symbol === null ? `${l.pair}: -` : `${l.pair}: ${l.inverted ? `invertido ${l.symbol}` : 'direto'} (taker ${l.takerFee}, ativo ${l.active})`,
  );
  console.log(`${ex.id}\n  ${cells.join('\n  ')}`);
}
