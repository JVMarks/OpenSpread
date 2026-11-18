// Simulação das ordens do modo real (etapa 5): o motor real (LiveEngine) contra corretoras simuladas que usam os
// mercados e o livro de ofertas públicos de verdade. Sem chave, sem conta, sem ordem de verdade: nada sai daqui além
// de leituras públicas. Saldos são de mentira.
// Uso: npm run live:sim [-- --pair BTC/USDT --buy okx --sell bybit --usd 50]
import ccxt from 'ccxt';
import { LiveEngine, type LiveExecution, type LiveRequest } from './engine';
import { HARD_LIMITS } from './limits';
import { SimLiveClient, type PublicExchange } from './sim-client';

interface Ticker {
  bid?: number;
  ask?: number;
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function line(title: string, r: LiveExecution, clients: SimLiveClient[]): string {
  const out = [`## ${title}`, `resultado: ${r.status}`];
  if (r.status === 'filled') out.push(`  ${r.base} executado nas duas pernas · compra média ${r.buyAvg} · venda média ${r.sellAvg} · taxas US$ ${r.feesUsd.toFixed(4)} · resultado US$ ${r.pnlUsd.toFixed(4)} (${r.realizedNetPct.toFixed(3)}%)`);
  if (r.status === 'no_fill') out.push(`  motivos: ${r.reasons.join(' · ')}`);
  if (r.status === 'imbalanced' || r.status === 'unknown') {
    for (const e of r.exposures) out.push(`  exposição: ${e.side} ${e.amount ?? 'desconhecida'} ${e.asset} na ${e.exchange} (preço visto ${e.price})`);
    if (r.matched) out.push(`  casado antes da falha: ${r.matched.base}`);
    if (r.status === 'unknown') out.push(`  mensagem: ${r.message}`);
  }
  for (const c of clients) for (const f of c.fills.splice(0)) out.push(`  ${c.id}: ${f.side} ${f.amount} limite ${f.limit} → executou ${f.filled} a ${f.average.toFixed(6)} (${f.levels} nível(is) do livro)`);
  return out.join('\n');
}

async function main(): Promise<void> {
  const pair = arg('pair', 'BTC/USDT');
  const buyOn = arg('buy', 'okx');
  const sellOn = arg('sell', 'bybit');
  const sizeUsd = Number(arg('usd', String(HARD_LIMITS.maxTradeUsd)));
  if (!(sizeUsd > 0) || sizeUsd > HARD_LIMITS.maxTradeUsd) throw new Error(`--usd entre 0 e ${HARD_LIMITS.maxTradeUsd} (o teto do código).`);
  const [base, quote] = pair.split('/');

  const pub = async (id: string): Promise<PublicExchange & { fetchTicker(s: string): Promise<Ticker> }> => {
    const Ex = (ccxt as unknown as Record<string, new (o: object) => PublicExchange & { loadMarkets(): Promise<unknown>; fetchTicker(s: string): Promise<Ticker> }>)[id];
    if (!Ex) throw new Error(`corretora desconhecida: ${id}`);
    const ex = new Ex({ enableRateLimit: true, options: { defaultType: 'spot' } });
    await ex.loadMarkets();
    if (!ex.markets[pair]) throw new Error(`${id} não lista ${pair}`);
    return ex;
  };
  const [exA, exB] = await Promise.all([pub(buyOn), pub(sellOn)]);
  const quoteNow = async (): Promise<{ ask: number; bid: number }> => {
    const [a, b] = await Promise.all([exA.fetchTicker(pair), exB.fetchTicker(pair)]);
    if (!a.ask || !b.bid) throw new Error('sem cotação pública agora');
    return { ask: a.ask, bid: b.bid };
  };
  const fresh = (balanceUsd = 1000) => {
    const a = new SimLiveClient(buyOn, exA, { balances: { [quote]: balanceUsd, [base]: 0 } });
    const b = new SimLiveClient(sellOn, exB, { balances: { [quote]: 0, [base]: (balanceUsd / 1000) * (2 * sizeUsd) / (1) } });
    return { a, b, engine: new LiveEngine(new Map([[buyOn, a], [sellOn, b]]), { settleDelayMs: 200 }) };
  };
  let n = 0;
  const request = async (over: Partial<LiveRequest> = {}): Promise<LiveRequest> => {
    const q = await quoteNow();
    n += 1;
    return { pair, buyOn, sellOn, sizeUsd, quotedAsk: q.ask, quotedBid: q.bid, buyFee: exA.markets[pair]?.taker ?? 0.001, sellFee: exB.markets[pair]?.taker ?? 0.001, maxSlippagePct: 0.1, ref: `sim${Date.now().toString(16)}${n}${'0'.repeat(20)}`, ...over };
  };

  const report: string[] = [`# Simulação das ordens do modo real · ${new Date().toISOString()}`, `${pair} · compra na ${buyOn}, venda na ${sellOn} · US$ ${sizeUsd} por operação · livros públicos reais, saldos de mentira, nenhuma ordem de verdade`, ''];
  const q0 = await quoteNow();
  report.push(`cotação agora: ask ${buyOn} ${q0.ask} · bid ${sellOn} ${q0.bid} · spread bruto ${(((q0.bid - q0.ask) / q0.ask) * 100).toFixed(4)}%`, '');

  // 1. Caminho normal: as duas pernas executam no livro real. Com spread negativo, o resultado é prejuízo, e aparece.
  {
    const { a, b, engine } = fresh();
    // O vendedor precisa ter a moeda base: dá a ele o equivalente a 2 operações.
    (b as unknown as { balances: Record<string, number> }).balances[base] = (2 * sizeUsd) / q0.bid;
    report.push(line('1. Duas pernas no livro real', await engine.execute(await request()), [a, b]), '');
  }
  // 2. Uma perna fora da faixa: sobra exposição; depois desfaz na mesma corretora.
  {
    const { a, b, engine } = fresh();
    (b as unknown as { balances: Record<string, number> }).balances[base] = (2 * sizeUsd) / q0.bid;
    const req = await request();
    const r = await engine.execute({ ...req, quotedBid: req.quotedBid * 1.5 });
    report.push(line('2. Venda fora da faixa (forçada): a compra sobra como exposição', r, [a, b]));
    if (r.status === 'imbalanced') {
      const e = r.exposures[0];
      const q = await quoteNow();
      const tick = await exA.fetchTicker(pair);
      const u = await engine.unwind({ exchange: e.exchange, pair, side: 'sell', amount: e.amount ?? 0, limitPrice: (tick.bid ?? q.bid) * 0.999, ref: `simu${Date.now().toString(16)}${'0'.repeat(20)}` });
      report.push(`  desfazer na ${e.exchange}: ${u.status}${u.status === 'done' ? ` · vendeu ${u.filled} a ${u.average.toFixed(6)}` : ''}`);
      for (const f of a.fills.splice(0)) report.push(`  ${a.id}: ${f.side} ${f.amount} limite ${f.limit} → executou ${f.filled} a ${f.average.toFixed(6)}`);
    }
    report.push('');
  }
  // 3. Saldo curto na compra: a corretora recusa antes; a venda sozinha vira exposição vendida.
  {
    const { a, b, engine } = fresh(5);
    (b as unknown as { balances: Record<string, number> }).balances[base] = (2 * sizeUsd) / q0.bid;
    report.push(line('3. Saldo curto na compra (US$ 5): recusada pela corretora', await engine.execute(await request()), [a, b]), '');
  }
  // 4. Resposta perdida: a ordem saiu, a resposta não chegou. O motor acha pela consulta e não reenvia.
  {
    const { a, b, engine } = fresh();
    (b as unknown as { balances: Record<string, number> }).balances[base] = (2 * sizeUsd) / q0.bid;
    a.failNext('lost_reply');
    report.push(line('4. Resposta perdida na compra: achada pela consulta, sem reenviar', await engine.execute(await request()), [a, b]), '');
  }
  // 5. Corretora fora do ar: o motor não inventa resultado; exposição desconhecida, o gerente para tudo.
  {
    const { a, b, engine } = fresh();
    (b as unknown as { balances: Record<string, number> }).balances[base] = (2 * sizeUsd) / q0.bid;
    a.failNext('offline');
    report.push(line('5. Compra sem resposta nenhuma: unknown, nada inventado', await engine.execute(await request()), [a, b]), '');
  }
  console.log(report.join('\n'));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/live/sim.ts') || process.env.OPENSPREAD_SIM === '1') {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`Simulação interrompida: ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 200)}`);
      process.exit(1);
    },
  );
}
