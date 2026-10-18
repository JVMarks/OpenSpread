// OpenSpread core: lê cotações públicas de stablecoins em 5 corretoras e serve em 127.0.0.1:4848.
// Uso: npm start  (porta: OPENSPREAD_PORT)
import { Poller } from './poller';
import { DEFAULT_PORT, startServer } from './server';

const EXCHANGES = ['binance', 'okx', 'bybit', 'kraken', 'coinbaseexchange'];
const PAIRS = ['USDC/USDT', 'USDE/USDT', 'DAI/USDT', 'FDUSD/USDT'];
const POLL_MS = 10_000;
const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4747', 'http://127.0.0.1:4747'];

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const poller = new Poller(EXCHANGES, PAIRS, { log });
const port = Number(process.env.OPENSPREAD_PORT ?? DEFAULT_PORT);

const server = startServer(() => poller.state(), { port, allowOrigins: ORIGINS });
server.on('listening', () => log(`OpenSpread core em http://127.0.0.1:${port} (só leitura, dados públicos)`));
server.on('error', (e) => {
  log(`não consegui abrir a porta ${port}: ${(e as Error).message}`);
  process.exit(1);
});

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await poller.pollOnce();
  } finally {
    running = false;
  }
};
void tick();
setInterval(() => void tick(), POLL_MS);
