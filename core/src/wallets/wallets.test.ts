import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChain, normalizeAddress, shortAddress } from './address';
import { bitcoinOp, MempoolReader, type MempoolTx } from './bitcoin';
import { parseTopTraders } from './birdeye';
import { BlockscoutReader, evmOps, type BsInternal, type BsTransfer, type BsTx } from './ethereum';
import { RateLimited, type FetchLike } from './http';
import { rank, summarize } from './ranking';
import type { ChainReader } from './reader';
import { solanaOp, SolanaReader, type SolanaTx } from './solana';
import { WalletWatcher } from './watcher';
import { validateConfig } from '../config';
import type { WalletOp } from '../types';

// Respostas reais gravadas em 03/11/2026 (aparadas aos campos que usamos): fixtures/*.json.
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const SOL_TXS = fx('solana-transactions.json') as Record<string, SolanaTx>;
const signer = (t: SolanaTx) => (t.transaction.message.accountKeys[0] as { pubkey: string }).pubkey;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** fetch falso: responde pela URL (ou pelo método do RPC) com o que a tabela mandar. */
function fakeFetch(route: (url: string, body: { method?: string; params?: unknown[] } | null) => { status?: number; body: unknown; headers?: Record<string, string> }): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push(body?.method ? `${url}#${body.method}` : url);
    const r = route(url, body);
    return { status: r.status ?? 200, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, json: async () => r.body };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('endereços', () => {
  it('reconhece Solana, EVM e Bitcoin pelo formato e pelo checksum', () => {
    expect(detectChain('DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F')).toBe('solana');
    expect(detectChain('0x28C6c06298d514Db089934071355E5743bf21d60')).toBe('evm');
    expect(detectChain('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo')).toBe('bitcoin');
    expect(detectChain('bc1qwk9qmeqm3fwc5q29yu945z0tuvn2yqwvf3wt9cayt5s886lcuhssejj98j')).toBe('bitcoin');
    expect(detectChain('bc1p04l2nvyevzj3t6weszly9cz2g7nu7u658mv9mu7rpdvh3kqnz22s4vawjf')).toBe('bitcoin');
    // checksum errado (última letra trocada), testnet e lixo
    expect(detectChain('bc1qwk9qmeqm3fwc5q29yu945z0tuvn2yqwvf3wt9cayt5s886lcuhssejj98k')).toBeNull();
    expect(detectChain('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twsep')).toBeNull();
    expect(detectChain('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBeNull();
    expect(detectChain('0x123')).toBeNull();
    expect(detectChain('não é endereço')).toBeNull();
  });

  it('normaliza por rede: EVM em minúsculas; formato de outra rede é recusado', () => {
    expect(normalizeAddress('base', '0x28C6c06298d514Db089934071355E5743bf21d60')).toBe('0x28c6c06298d514db089934071355e5743bf21d60');
    expect(normalizeAddress('solana', '0x28C6c06298d514Db089934071355E5743bf21d60')).toBeNull();
    expect(normalizeAddress('bitcoin', 'DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F')).toBeNull();
    expect(shortAddress('DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F')).toBe('DPDM…Ny7F');
  });

  it('config: aceita carteiras válidas, recusa endereço errado, repetido, campo a mais e acima do limite', () => {
    const base = { exchanges: ['binance', 'okx'], pairs: ['USDC/USDT'] };
    const ok = validateConfig({ ...base, wallets: [{ chain: 'Ethereum', address: '0x28C6c06298d514Db089934071355E5743bf21d60' }] }, ['binance', 'okx']);
    expect(ok).toMatchObject({ ok: true, config: { wallets: [{ chain: 'ethereum', address: '0x28c6c06298d514db089934071355e5743bf21d60' }] } });
    const bad = validateConfig(
      {
        ...base,
        wallets: [
          { chain: 'solana', address: '0xabc' },
          { chain: 'dogecoin', address: 'x' },
          { chain: 'bitcoin', address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', label: 'fulano' },
          { chain: 'ethereum', address: '0x28C6c06298d514Db089934071355E5743bf21d60' },
          { chain: 'ethereum', address: '0x28c6c06298d514db089934071355e5743bf21d60' },
        ],
      },
      ['binance', 'okx'],
    );
    const errors = (bad as { errors: string[] }).errors.join('\n');
    expect(errors).toContain('endereço inválido para solana');
    expect(errors).toContain('rede desconhecida');
    expect(errors).toContain('label');
    expect(errors).toContain('repetida');
    const many = Array.from({ length: 31 }, (_, i) => ({ chain: 'ethereum', address: `0x${i.toString(16).padStart(40, '0')}` }));
    expect((validateConfig({ ...base, wallets: many }, ['binance', 'okx']) as { errors: string[] }).errors.join()).toContain('no máximo 30');
  });

  it('config: descoberta só com token de rede que tem token', () => {
    const base = { exchanges: ['binance', 'okx'], pairs: ['USDC/USDT'] };
    const ok = validateConfig({ ...base, discovery: { tokens: [{ chain: 'solana', address: 'So11111111111111111111111111111111111111112' }], perToken: 3 } }, ['binance', 'okx']);
    expect(ok).toMatchObject({ ok: true, config: { discovery: { perToken: 3 } } });
    const bad = validateConfig({ ...base, discovery: { tokens: [{ chain: 'bitcoin', address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo' }], perToken: 99 } }, ['binance', 'okx']);
    expect((bad as { errors: string[] }).errors.join()).toMatch(/rede sem token.*perToken|perToken.*rede sem token/s);
  });
});

describe('Solana: classificação pela variação de saldo (transações reais)', () => {
  it('venda de token por SOL', () => {
    const t = SOL_TXS.sell_for_sol;
    const op = solanaOp(t, signer(t))!;
    expect(op).toMatchObject({ kind: 'sell', assetId: '6FhVPctYg363pQbs4iSvqyHe2cJzfsvFD96gePy6pump', asset: '6FhV…pump', quote: 'SOL' });
    expect(op.amount).toBeCloseTo(4204.706955, 6);
    expect(op.quoteAmount).toBeCloseTo(0.103762221, 9);
    expect(op.url).toBe(`https://solscan.io/tx/${t.transaction.signatures[0]}`);
    expect(op.at).toBe(t.blockTime! * 1000);
  });

  it('venda por USDC: a taxa em SOL não vira cotação', () => {
    const t = SOL_TXS.sell_for_usdc;
    expect(solanaOp(t, signer(t))).toMatchObject({ kind: 'sell', quote: 'USD', assetId: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' });
    expect(solanaOp(t, signer(t))!.quoteAmount).toBeCloseTo(144.948449, 6);
  });

  it('compra com SOL', () => {
    const t = SOL_TXS.buy_with_sol;
    const op = solanaOp(t, signer(t))!;
    expect(op).toMatchObject({ kind: 'buy', quote: 'SOL', assetId: '8xH5RFEkSyneYBhCZh5gi2svgdyrDCREW9SxCfKuYgFd' });
    expect(op.quoteAmount).toBeCloseTo(0.900015197, 9);
  });

  it('só a taxa mudou: fica não classificada (não some)', () => {
    const t = SOL_TXS.no_change;
    expect(solanaOp(t, signer(t))).toMatchObject({ kind: 'unclassified', asset: null });
  });

  it('transação com erro não vira operação', () => {
    const t = { ...SOL_TXS.buy_with_sol, meta: { ...SOL_TXS.buy_with_sol.meta!, err: { InstructionError: [0, 'x'] } } };
    expect(solanaOp(t, signer(t))).toBeNull();
  });

  it('leitor: pula assinaturas com erro e já lidas; erro de limite do RPC vira RateLimited', async () => {
    const sigs = fx('solana-signatures.json');
    const okSigs = sigs.result.filter((s: { err: unknown }) => !s.err).map((s: { signature: string }) => s.signature);
    const f = fakeFetch((_, body) => (body?.method === 'getSignaturesForAddress' ? { body: sigs } : { body: { jsonrpc: '2.0', id: 1, result: SOL_TXS.buy_with_sol } }));
    const r = await new SolanaReader(f, undefined, { gapMs: 0 }).read(signer(SOL_TXS.buy_with_sol), new Set([okSigs[0]]));
    expect(f.calls.filter((c) => c.endsWith('#getTransaction'))).toHaveLength(okSigs.length - 1);
    expect(r.ops.every((o) => o.kind === 'buy')).toBe(true);
    const limited = fakeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests for a specific RPC call' } } }));
    await expect(new SolanaReader(limited, undefined, { gapMs: 0 }).read('x', new Set())).rejects.toBeInstanceOf(RateLimited);
    const http429 = fakeFetch(() => ({ status: 429, body: {}, headers: { 'retry-after': '30' } }));
    await expect(new SolanaReader(http429, undefined, { gapMs: 0 }).read('x', new Set())).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });
});

describe('Ethereum/Base pelo Blockscout', () => {
  const W = '0x1111111111111111111111111111111111111111';
  const ROUTER = { hash: '0x2222222222222222222222222222222222222222' };
  const ME = { hash: '0x1111111111111111111111111111111111111111' };
  const USDC = { address_hash: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', type: 'ERC-20' };
  const PEPE = { address_hash: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', type: 'ERC-20' };
  const page = <T>(items: T[]) => ({ items, next_page_params: null });
  const tr = (hash: string, ts: string, from: { hash: string }, to: { hash: string }, token: typeof USDC, value: string, decimals: string): BsTransfer => ({ transaction_hash: hash, timestamp: ts, from, to, token, total: { decimals, value } });
  const tx = (hash: string, ts: string, value: string, status = 'ok'): BsTx => ({ hash, timestamp: ts, from: ME, to: ROUTER, value, fee: { value: '1000000000000000' }, status });

  it('compra com ETH (valor da transação), venda por ETH (interna), venda por USDC, transação falha fora', () => {
    const transfers = page([
      tr('0xa', '2026-11-01T10:00:00Z', ROUTER, ME, PEPE, '1000000000000000000000', '18'),
      tr('0xb', '2026-11-02T10:00:00Z', ME, ROUTER, PEPE, '400000000000000000000', '18'),
      tr('0xc', '2026-11-02T12:00:00Z', ME, ROUTER, PEPE, '600000000000000000000', '18'),
      tr('0xc', '2026-11-02T12:00:00Z', ROUTER, ME, USDC, '900000000', '6'),
      tr('0xd', '2026-11-02T13:00:00Z', ROUTER, ME, PEPE, '5', '18'),
    ]);
    const txs = page([tx('0xa', '2026-11-01T10:00:00Z', '500000000000000000'), tx('0xb', '2026-11-02T10:00:00Z', '0'), tx('0xc', '2026-11-02T12:00:00Z', '0'), tx('0xd', '2026-11-02T13:00:00Z', '0', 'error')]);
    const internals = page<BsInternal>([{ transaction_hash: '0xb', timestamp: '2026-11-02T10:00:00Z', from: ROUTER, to: ME, value: '300000000000000000', success: true }]);
    const ops = evmOps('ethereum', W, { transfers, txs, internals }, new Set());
    expect(ops.map((o) => [o.tx, o.kind, o.asset, o.quote])).toEqual([
      ['0xc', 'sell', 'PEPE', 'USD'],
      ['0xb', 'sell', 'PEPE', 'ETH'],
      ['0xa', 'buy', 'PEPE', 'ETH'],
    ]);
    expect(ops[2].quoteAmount).toBeCloseTo(0.501, 9); // 0,5 ETH + 0,001 de gás
    expect(ops[1].quoteAmount).toBeCloseTo(0.299, 9);
    expect(ops[0].quoteAmount).toBe(900);
    expect(ops[0].url).toBe('https://etherscan.io/tx/0xc');
  });

  it('só considera o intervalo que as três listas cobrem', () => {
    const transfers = { items: [tr('0xold', '2026-10-01T00:00:00Z', ROUTER, ME, PEPE, '1', '0'), tr('0xnew', '2026-11-02T00:00:00Z', ROUTER, ME, PEPE, '1', '0')], next_page_params: { index: 1 } };
    const txs = { items: [tx('0xnew', '2026-11-02T00:00:00Z', '0'), tx('0xmid', '2026-11-01T00:00:00Z', '0')], next_page_params: { index: 2 } };
    const ops = evmOps('ethereum', W, { transfers, txs, internals: page([]) }, new Set());
    expect(ops.map((o) => o.tx)).toEqual(['0xnew', '0xmid']);
  });

  it('resposta real do Blockscout (entrada de token numa carteira de corretora) e Base sem chave', async () => {
    const real = fx('blockscout-token-transfers.json');
    const realTxs = fx('blockscout-transactions.json');
    const to = real.items[0].to.hash as string;
    const ops = evmOps('ethereum', to, { transfers: { items: real.items, next_page_params: null }, txs: { items: [], next_page_params: null }, internals: page([]) }, new Set());
    expect(ops.find((o) => o.tx === real.items[0].transaction_hash)).toMatchObject({ kind: 'in', asset: 'SAFEX' });
    expect(evmOps('ethereum', realTxs.items[0].from.hash, { transfers: page([]), txs: { items: realTxs.items, next_page_params: null }, internals: page([]) }, new Set()).length).toBeGreaterThan(0);
    const base = new BlockscoutReader('base', fakeFetch(() => ({ body: {} })));
    expect(base.unavailable()).toContain('chave');
    const withKey = fakeFetch(() => ({ body: { items: [], next_page_params: null } }));
    await new BlockscoutReader('base', withKey, 'proapi_test_key', { gapMs: 0, retryMs: 0 }).read(W, new Set());
    expect(withKey.calls[0]).toBe(`https://api.blockscout.com/8453/api/v2/addresses/${W}/token-transfers?type=ERC-20&apikey=proapi_test_key`);
  });
});

describe('Blockscout instável', () => {
  it('tenta de novo uma vez; se falhar de novo, a leitura falha (nada classificado pela metade)', async () => {
    let n = 0;
    const flaky = fakeFetch(() => (++n === 1 ? { status: 500, body: {} } : { body: { items: [], next_page_params: null } }));
    await new BlockscoutReader('ethereum', flaky, null, { gapMs: 0, retryMs: 0 }).read('0x1111111111111111111111111111111111111111', new Set());
    expect(flaky.calls).toHaveLength(4);
    const down = fakeFetch((url) => (url.includes('internal') ? { status: 500, body: {} } : { body: { items: [], next_page_params: null } }));
    await expect(new BlockscoutReader('ethereum', down, null, { gapMs: 0, retryMs: 0 }).read('0x1111111111111111111111111111111111111111', new Set())).rejects.toThrow('HTTP 500');
  });
});

describe('Bitcoin pelo mempool.space (resposta real)', () => {
  it('entrada e saldo; sem troca', async () => {
    const txs = fx('mempool-txs.json') as MempoolTx[];
    const A = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
    expect(bitcoinOp(txs[0], A)).toMatchObject({ kind: 'in', asset: 'BTC', amount: 540 / 1e8, quote: null, url: `https://mempool.space/tx/${txs[0].txid}` });
    const f = fakeFetch((url) => (url.endsWith('/txs/chain') ? { body: txs } : { body: { chain_stats: { funded_txo_sum: 300_000_000, spent_txo_sum: 100_000_000 } } }));
    const r = await new MempoolReader(f).read(A, new Set([txs[1].txid]));
    expect(r.balance).toEqual({ asset: 'BTC', amount: 2 });
    expect(r.ops.map((o) => o.tx)).toEqual([txs[0].txid]);
  });
});

describe('FIFO e ranking', () => {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const H = 3_600_000;
  const op = (tx: string, hoursAgo: number, kind: WalletOp['kind'], amount: number, quoteAmount: number, asset = 'TOK', quote = 'SOL'): WalletOp => ({ tx, at: NOW - hoursAgo * H, kind, asset, assetId: asset, amount, quote, quoteAmount, url: '' });

  it('casa a venda com as compras mais antigas e conta acerto e erro', () => {
    const s = summarize([op('b1', 10, 'buy', 100, 1), op('b2', 9, 'buy', 100, 2), op('s1', 8, 'sell', 150, 3), op('s2', 7, 'sell', 50, 0.5)], NOW);
    // s1: 100 a 0,01 + 50 a 0,02 = 2 de custo; recebeu 3 → +1. s2: 50 a 0,02 = 1; recebeu 0,5 → −0,5.
    expect(s.ops.find((o) => o.tx === 's1')!.pnl).toBeCloseTo(1, 9);
    expect(s.ops.find((o) => o.tx === 's2')!.pnl).toBeCloseTo(-0.5, 9);
    expect(s).toMatchObject({ trades: 2, wins: 1, losses: 1, open: false });
    expect(s.results).toEqual([{ quote: 'SOL', amount: 0.5 }]);
    expect(s.ops[0].tx).toBe('s2');
  });

  it('venda sem compra conhecida não tem resultado; moedas de cotação não se misturam; período conta', () => {
    const s = summarize([op('old', 24 * 10, 'buy', 10, 1), op('sold-old', 24 * 9, 'sell', 10, 5), op('b', 5, 'buy', 10, 100, 'TOK', 'USD'), op('s', 4, 'sell', 10, 2), op('s-usd', 3, 'sell', 5, 60, 'TOK', 'USD')], NOW);
    expect(s.ops.find((o) => o.tx === 's')!.pnl).toBeUndefined();
    expect(s.ops.find((o) => o.tx === 'sold-old')!.pnl).toBeCloseTo(4, 9); // fechou, mas fora dos 7 dias
    expect(s.results).toEqual([{ quote: 'USD', amount: 10 }]);
    expect(s).toMatchObject({ trades: 1, open: true });
  });

  it('ranking por rede e moeda: melhores com resultado positivo, piores separados', () => {
    const w = (address: string, amount: number, trades = 1) => ({ chain: 'solana' as const, address, results: [{ quote: 'SOL', amount }], trades });
    const r = rank([w('a', 5), w('b', -2), w('c', 1), w('d', 0), w('e', 9, 0)], 2);
    expect(r).toEqual([{ chain: 'solana', quote: 'SOL', best: ['a', 'c'], worst: ['b', 'd'] }]);
  });
});

describe('vigia de carteiras', () => {
  const W1 = { chain: 'solana' as const, address: 'DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F', source: 'curated' as const };
  const W2 = { chain: 'solana' as const, address: 'JBWKHLUAFDzYR3A3qgun3EtDe6MZEzYyMCQWZf9G1tmx', source: 'curated' as const };
  const BTC = { chain: 'bitcoin' as const, address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', source: 'curated' as const };
  const buy: WalletOp = { tx: 't1', at: Date.parse('2026-11-03T10:00:00Z'), kind: 'buy', asset: 'X', assetId: 'X', amount: 1, quote: 'SOL', quoteAmount: 1, url: '' };

  function reader(chain: ChainReader['chain'], impl: ChainReader['read']): ChainReader & { seen: Array<ReadonlySet<string>> } {
    const seen: Array<ReadonlySet<string>> = [];
    return { chain, source: `${chain}.test`, native: 'SOL', seen, read: (a, s) => (seen.push(s), impl(a, s)) };
  }

  it('429 para a rede (as outras seguem), recua e volta; cache não repete o que já leu', async () => {
    const d = mkdtempSync(join(tmpdir(), 'openspread-w-'));
    dirs.push(d);
    let limited = true;
    const sol = reader('solana', async () => {
      if (limited) throw new RateLimited(null);
      return { ops: [buy] };
    });
    const btc = reader('bitcoin', async () => ({ ops: [], balance: { asset: 'BTC', amount: 1 } }));
    const cacheFile = join(d, 'cache', 'wallets.json');
    const w = new WalletWatcher([sol, btc], { cacheFile });
    w.setList([W1, W2, BTC]);
    const t0 = Date.parse('2026-11-03T11:00:00Z');
    await w.round(t0);
    expect(sol.seen).toHaveLength(1); // parou na primeira carteira da rede
    let st = w.state(t0);
    expect(st.sources.find((s) => s.chain === 'solana')).toMatchObject({ ok: false, backoffUntil: t0 + 60_000 });
    expect(st.wallets.find((x) => x.chain === 'bitcoin')).toMatchObject({ ok: true, balance: { asset: 'BTC', amount: 1 }, url: 'https://mempool.space/address/34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo' });
    await w.round(t0 + 30_000);
    expect(sol.seen).toHaveLength(1); // ainda recuando
    limited = false;
    await w.round(t0 + 61_000);
    expect(sol.seen).toHaveLength(3);
    st = w.state(t0 + 61_000);
    expect(st.sources.find((s) => s.chain === 'solana')).toMatchObject({ ok: true });
    expect(st.wallets.find((x) => x.address === W1.address)).toMatchObject({ ok: true, open: true, trades: 0, ops: [{ tx: 't1' }] });

    const again = new WalletWatcher([sol], { cacheFile });
    again.loadCache();
    again.setList([W1]);
    await again.round(t0 + 120_000);
    expect([...sol.seen[sol.seen.length - 1]]).toEqual(['t1']);
  });

  it('limite no meio da leitura: guarda o que leu e recua', async () => {
    const sol = reader('solana', async () => ({ ops: [buy], limited: { retryAfterMs: 120_000 } }));
    const w = new WalletWatcher([sol]);
    w.setList([W1, W2]);
    const t0 = Date.parse('2026-11-03T11:00:00Z');
    await w.round(t0);
    const st = w.state(t0);
    expect(sol.seen).toHaveLength(1);
    expect(st.wallets[0]).toMatchObject({ ok: true, ops: [{ tx: 't1' }] });
    expect(st.wallets[1]).toMatchObject({ ok: false, error: expect.stringContaining('limite') });
    expect(st.sources[0]).toMatchObject({ backoffUntil: t0 + 120_000 });
  });

  it('a mesma carteira curada e descoberta aparece uma vez, como curada; erro de uma não derruba a outra', async () => {
    const sol = reader('solana', async (a) => {
      if (a === W2.address) throw new Error('RPC: falhou');
      return { ops: [] };
    });
    const w = new WalletWatcher([sol]);
    w.setList([{ ...W1, source: 'birdeye', external: { source: 'birdeye', token: 'T' } }, W1, W2]);
    await w.round(Date.parse('2026-11-03T11:00:00Z'));
    const st = w.state(Date.parse('2026-11-03T11:00:00Z'));
    expect(st.wallets.map((x) => [x.address, x.source, x.ok])).toEqual([
      [W1.address, 'curated', true],
      [W2.address, 'curated', false],
    ]);
    expect(st.wallets[1].error).toBe('RPC: falhou');
  });
});

describe('descoberta (Birdeye)', () => {
  it('lê os top traders, tira robôs marcados, endereços inválidos e repetidos, respeita o limite', () => {
    const raw = {
      success: true,
      data: {
        items: [
          { owner: 'DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F', volume: 1200.5, trade: 14, tags: [] },
          { owner: 'JBWKHLUAFDzYR3A3qgun3EtDe6MZEzYyMCQWZf9G1tmx', volume: 900, trade: 3, tags: ['sniper bot'] },
          { owner: 'invalido', volume: 5 },
          { owner: 'DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F', volume: 1 },
          { owner: 'DYuiLfTJ6zLFkQdshidfTWhSTh4pSoA2xFP6acbEdgD', volume: 10, realizedPnl: -3 },
          { owner: 'gasBidSWW5zmwXs3gn8TG2ijzKkrwpyM7ucwjgDQst6', volume: 9 },
        ],
      },
    };
    const out = parseTopTraders(raw, 'solana', 'TOKEN', 2);
    expect(out).toEqual([
      { chain: 'solana', address: 'DPDMHjJHmod2qURf69mV1pe4nSaSFhXv1TSUxtQrNy7F', source: 'birdeye', external: { source: 'birdeye', token: 'TOKEN', volumeUsd: 1200.5, trades: 14 } },
      { chain: 'solana', address: 'DYuiLfTJ6zLFkQdshidfTWhSTh4pSoA2xFP6acbEdgD', source: 'birdeye', external: { source: 'birdeye', token: 'TOKEN', volumeUsd: 10, pnlUsd: -3 } },
    ]);
    expect(parseTopTraders({ success: false }, 'solana', 'T', 5)).toEqual([]);
  });
});
