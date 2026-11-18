// Prova do ambiente de teste das corretoras (etapa 5, Tarefa 9). Só roda com "sandbox": true: não há caminho daqui até
// dinheiro real, de propósito. A prova real é pelo painel, com a passkey (Tarefa 10).
// Uso: OPENSPREAD_LIVE=1 npm run live:probe [-- --force-fail]
import { dirname, join } from 'node:path';
import { configPath } from '../config';
import { CcxtLiveClient, createExchange } from './ccxt-client';
import { loadLiveConfig, type LiveConfig } from './config';
import { loadCredentials } from './credentials';
import { LiveEngine, type LiveRequest } from './engine';

/** A trava desta prova: recusa qualquer config que não seja de teste. */
export function assertSandbox(config: LiveConfig | { off: string }): LiveConfig {
  if ('off' in config) throw new Error(config.off);
  if (config.sandbox !== true) throw new Error('A prova só roda com "sandbox": true em live.json. Dinheiro real não passa por aqui.');
  return config;
}

interface Ticker {
  bid?: number;
  ask?: number;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force-fail');
  const dir = dirname(configPath());
  const config = assertSandbox(loadLiveConfig(join(dir, 'live.json'), process.env));
  const route = config.routes[0];
  const creds = loadCredentials(join(dir, 'exchange-keys.json'), process.env, console.log);
  const clients = new Map<string, CcxtLiveClient>();
  const exes = new Map<string, ReturnType<typeof createExchange>>();
  for (const id of route.exchanges) {
    const c = creds.get(id);
    if (!c) throw new Error(`Falta a chave de teste de ${id} em exchange-keys.json.`);
    const ex = createExchange(id, c, true);
    await ex.loadMarkets();
    clients.set(id, new CcxtLiveClient(id, ex, c));
    exes.set(id, ex);
    console.log(`${id}: mercados carregados`);
  }
  const assets = new Set(route.pair.split('/'));
  for (const [id, c] of clients) console.log(`${id}: saldo`, await c.freeBalance(assets));
  const [buyOn, sellOn] = route.exchanges;
  const ticker = async (id: string) => (exes.get(id) as unknown as { fetchTicker(s: string): Promise<Ticker> }).fetchTicker(route.pair);
  const [a, b] = await Promise.all([ticker(buyOn), ticker(sellOn)]);
  if (!a.ask || !b.bid) throw new Error('Sem cotação no ambiente de teste.');
  console.log(`cotação: compra em ${buyOn} a ${a.ask}, venda em ${sellOn} a ${b.bid}`);
  // Os livros de teste têm preços próprios. Aqui importa o caminho da ordem, não o resultado.
  const req: LiveRequest = {
    pair: route.pair,
    buyOn,
    sellOn,
    sizeUsd: config.maxTradeUsd,
    quotedAsk: a.ask,
    // --force-fail: venda muito acima do mercado expira sem execução, e a compra sobra como exposição.
    quotedBid: force ? b.bid * 1.5 : b.bid,
    buyFee: 0.001,
    sellFee: 0.001,
    maxSlippagePct: config.maxSlippagePct,
    ref: `${Date.now().toString(16)}${'0'.repeat(32)}`,
  };
  const result = await new LiveEngine(clients).execute(req);
  console.log('resultado:', JSON.stringify(result, null, 2));
  console.log(force ? 'Esperado: imbalanced, com a exposição na corretora de compra.' : 'Confira o resultado com o histórico de ordens de teste das corretoras.');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/live/probe.ts') || process.env.OPENSPREAD_PROBE === '1') {
  main().catch((e: unknown) => {
    console.error(`Prova interrompida: ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 200)}`);
    process.exitCode = 1;
  });
}
