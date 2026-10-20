// OpenSpread core: lê cotações públicas nas corretoras configuradas e serve em 127.0.0.1:4848.
// Uso: npm start  (porta: OPENSPREAD_PORT; arquivo de configuração: OPENSPREAD_CONFIG, padrão ~/.openspread/config.json)
import ccxt from 'ccxt';
import { configPath, LIMITS, loadConfig, saveConfig, validateConfig } from './config';
import { Poller } from './poller';
import { DEFAULT_PORT, startServer } from './server';
import type { CoreConfig } from './types';

const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4747', 'http://127.0.0.1:4747'];
const KNOWN: readonly string[] = ccxt.exchanges;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const file = configPath();
let config: CoreConfig = loadConfig(file, KNOWN, log);
log(`lendo ${config.exchanges.length} corretoras e ${config.pairs.length} pares a cada ${config.pollMs / 1000} s (${file})`);

const poller = new Poller(config.exchanges, config.pairs, { log });
const port = Number(process.env.OPENSPREAD_PORT ?? DEFAULT_PORT);

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
let timer = setInterval(() => void tick(), config.pollMs);

const server = startServer(() => poller.state(), {
  port,
  allowOrigins: ORIGINS,
  config: {
    info: () => ({ config, limits: { ...LIMITS }, known: [...KNOWN] }),
    validate: (raw) => validateConfig(raw, KNOWN),
    check: (c) => poller.check(c.exchanges, c.pairs),
    save: (next) => {
      saveConfig(file, next);
      config = next;
      poller.reconfigure(next.exchanges, next.pairs);
      clearInterval(timer);
      timer = setInterval(() => void tick(), next.pollMs);
      void tick();
      log(`configuração salva: ${next.exchanges.length} corretoras, ${next.pairs.length} pares, a cada ${next.pollMs / 1000} s`);
    },
  },
});
server.on('listening', () => log(`OpenSpread core em http://127.0.0.1:${port} (dados públicos de mercado; sem chave, sem ordem)`));
server.on('error', (e) => {
  log(`não consegui abrir a porta ${port}: ${(e as Error).message}`);
  process.exit(1);
});

void tick();
