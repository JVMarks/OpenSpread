// OpenSpread core: lê cotações públicas nas corretoras configuradas e serve em 127.0.0.1:4848.
// Uso: npm start  (porta: OPENSPREAD_PORT; arquivo de configuração: OPENSPREAD_CONFIG, padrão ~/.openspread/config.json)
import ccxt from 'ccxt';
import { SpreadAlerts } from './alerts';
import { applyTransfer } from './transfer';
import { SpreadHistory } from './history';
import { dirname, join } from 'node:path';
import { configPath, LIMITS, loadConfig, saveConfig, validateConfig } from './config';
import { Poller } from './poller';
import { DEFAULT_PORT, startServer } from './server';
import { loadKeys } from './keys';
import { BlockscoutReader } from './wallets/ethereum';
import { MempoolReader } from './wallets/bitcoin';
import { SolanaReader, SOLANA_RPC } from './wallets/solana';
import { ROUND_MS, WalletWatcher, type WatchEntry } from './wallets/watcher';
import { discover, DISCOVERY_MS } from './wallets/birdeye';
import type { FetchLike } from './wallets/http';
import type { CoreConfig, CoreState } from './types';

const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4747', 'http://127.0.0.1:4747'];
const KNOWN: readonly string[] = ccxt.exchanges;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const file = configPath();
let config: CoreConfig = loadConfig(file, KNOWN, log);
log(`lendo ${config.exchanges.length} corretoras e ${config.pairs.length} pares a cada ${config.pollMs / 1000} s (${file})`);

// Carteiras on-chain: leitura pública, a cada 60 s, com cache ao lado do config. A URL do RPC da Solana pode ser a
// de um provedor do usuário (OPENSPREAD_SOLANA_RPC); chaves de dados só no ambiente ou em keys.json.
const keys = loadKeys(file, process.env, log);
const http: FetchLike = (url, init) => fetch(url, init);
const watcher = new WalletWatcher(
  [new SolanaReader(http, process.env.OPENSPREAD_SOLANA_RPC || SOLANA_RPC), new BlockscoutReader('ethereum', http), new BlockscoutReader('base', http, keys.blockscout), new MempoolReader(http)],
  { cacheFile: join(dirname(file), 'cache', 'wallets.json'), log },
);
watcher.loadCache();
/** Descobertas no máximo, somando todos os tokens (o RPC público não aguenta muito mais). */
const MAX_DISCOVERED = 20;
let discovered: WatchEntry[] = [];
const watchList = () => watcher.setList([...(config.wallets ?? []).map((w): WatchEntry => ({ ...w, source: 'curated' })), ...discovered]);
watchList();
let discovering = false;
const runDiscovery = async () => {
  const d = config.discovery;
  if (discovering || !keys.birdeye || !d?.tokens.length) {
    if (discovered.length && !d?.tokens.length) {
      discovered = [];
      watchList();
    }
    return;
  }
  discovering = true;
  try {
    discovered = (await discover(http, keys.birdeye, d)).slice(0, MAX_DISCOVERED);
    log(`descoberta: ${discovered.length} carteiras dos top traders de ${d.tokens.length} tokens (Birdeye)`);
    watchList();
  } catch (e) {
    log(`descoberta pelo Birdeye falhou: ${(e as Error).message}`);
  } finally {
    discovering = false;
  }
};
let watching = false;
const watchTick = async () => {
  if (watching) return;
  watching = true;
  try {
    await watcher.round();
  } catch (e) {
    log(`carteiras: rodada falhou: ${(e as Error).message}`);
  } finally {
    watching = false;
  }
};
setInterval(() => void watchTick(), ROUND_MS).unref();
setInterval(() => void runDiscovery(), DISCOVERY_MS).unref();
void runDiscovery().then(() => watchTick());

const poller = new Poller(config.exchanges, config.pairs, { log });
const alerts = new SpreadAlerts();
/** Estado servido: o do Poller com o custo de transferência da configuração em cada melhor spread. */
const history = new SpreadHistory();
const historyFile = join(dirname(file), 'history.json');
history.load(historyFile, Date.now());
const current = (): CoreState => {
  const s = poller.state();
  const out: CoreState = { ...s, rev: s.rev + watcher.rev, pairs: history.apply(applyTransfer(s.pairs, config.transfer), s.at) };
  if (watcher.hasWallets()) out.wallets = watcher.state(s.at);
  return out;
};
const saveHistory = () => {
  try {
    history.save(historyFile);
  } catch (e) {
    log(`não consegui salvar o histórico em ${historyFile}: ${(e as Error).message}`);
  }
};
setInterval(saveHistory, 5 * 60_000).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    saveHistory();
    watcher.saveCache();
    process.exit(0);
  });
}
const port = Number(process.env.OPENSPREAD_PORT ?? DEFAULT_PORT);

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await poller.pollOnce();
    const s = current();
    history.record(s.pairs, s.at);
    for (const e of alerts.evaluate(config.alerts, s.pairs, s.at)) {
      log(`alerta: ${e.pair} com spread líquido de ${e.netPct.toFixed(3)}% (nível ${e.abovePct}%), ${e.buyOn} → ${e.sellOn}`);
    }
  } finally {
    running = false;
  }
};
let timer = setInterval(() => void tick(), config.pollMs);

const server = startServer(() => ({ ...current(), alerts: alerts.events() }), {
  port,
  allowOrigins: ORIGINS,
  config: {
    info: () => ({ config, limits: { ...LIMITS }, known: [...KNOWN], keys: { birdeye: !!keys.birdeye, blockscout: !!keys.blockscout } }),
    validate: (raw) => validateConfig(raw, KNOWN),
    check: (c) => poller.check(c.exchanges, c.pairs),
    save: (next) => {
      const prev = config;
      saveConfig(file, next);
      config = next;
      poller.reconfigure(next.exchanges, next.pairs);
      clearInterval(timer);
      timer = setInterval(() => void tick(), next.pollMs);
      void tick();
      const discoveryChanged = JSON.stringify(prev.discovery ?? null) !== JSON.stringify(next.discovery ?? null);
      watchList();
      if (discoveryChanged) void runDiscovery().then(() => watchTick());
      else void watchTick();
      log(`configuração salva: ${next.exchanges.length} corretoras, ${next.pairs.length} pares, ${next.alerts.length} alertas, ${next.wallets?.length ?? 0} carteiras, a cada ${next.pollMs / 1000} s`);
    },
  },
});
server.on('listening', () => log(`OpenSpread core em http://127.0.0.1:${port} (dados públicos de mercado; sem chave, sem ordem)`));
server.on('error', (e) => {
  log(`não consegui abrir a porta ${port}: ${(e as Error).message}`);
  process.exit(1);
});

void tick();
