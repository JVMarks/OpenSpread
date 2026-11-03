// Ethereum e Base pelo Blockscout. Ethereum: eth.blockscout.com sem chave. Base: o Blockscout público cai no
// Cloudflare sem chave, então só com a chave PRO (grátis em dev.blockscout.com), em api.blockscout.com/8453.
// Por transação somamos o que entrou e saiu da carteira: ETH da própria transação e das internas, e os tokens ERC-20.
import { classify, tokenSymbol, type Delta } from './classify';
import { txUrl } from './explorer';
import { getJson, pause, SourceError, type FetchLike } from './http';
import type { ChainReader, ReadResult } from './reader';
import type { WalletOp } from '../types';

type EvmChain = 'ethereum' | 'base';

/** WETH conta como ETH; stablecoins em dólar contam como USD. Endereços em minúsculas. */
const QUOTES: Readonly<Record<EvmChain, Record<string, 'ETH' | 'USD'>>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USD',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USD',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'USD',
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'ETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USD',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USD',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'USD',
  },
};

interface Addr {
  hash: string;
}
interface Page<T> {
  items: T[];
  next_page_params: unknown;
}
export interface BsTransfer {
  transaction_hash: string;
  timestamp: string;
  from: Addr;
  to: Addr;
  token: { address_hash: string; symbol: string | null; type: string };
  total: { decimals: string | null; value: string } | null;
}
export interface BsTx {
  hash: string;
  timestamp: string;
  from: Addr;
  to: Addr | null;
  value: string;
  fee: { value: string } | null;
  status: string | null;
}
export interface BsInternal {
  transaction_hash: string;
  timestamp: string;
  from: Addr;
  to: Addr | null;
  value: string;
  success?: boolean;
}

const lc = (a: Addr | null | undefined) => (a?.hash ?? '').toLowerCase();
const wei = (v: string | null | undefined) => Number(BigInt(v ?? '0')) / 1e18;

/**
 * Agrupa as três listas por transação e classifica. Só entra o intervalo que as três cobrem (a primeira página de
 * cada uma pode alcançar datas diferentes; fora dele faltaria uma perna da troca).
 */
export function evmOps(chain: EvmChain, wallet: string, lists: { transfers: Page<BsTransfer>; txs: Page<BsTx>; internals: Page<BsInternal> }, seen: ReadonlySet<string>): WalletOp[] {
  const w = wallet.toLowerCase();
  const oldest = (p: Page<{ timestamp: string }>) => (p.next_page_params && p.items.length ? Math.min(...p.items.map((i) => Date.parse(i.timestamp))) : -Infinity);
  const floor = Math.max(oldest(lists.transfers), oldest(lists.txs), oldest(lists.internals));
  const groups = new Map<string, { at: number; deltas: Map<string, Delta>; failed: boolean }>();
  const group = (hash: string, ts: string) => {
    let g = groups.get(hash);
    if (!g) groups.set(hash, (g = { at: Date.parse(ts), deltas: new Map(), failed: false }));
    return g;
  };
  const add = (g: { deltas: Map<string, Delta> }, key: string, d: Omit<Delta, 'amount'>, amount: number) => {
    const cur = g.deltas.get(key);
    if (cur) cur.amount += amount;
    else g.deltas.set(key, { ...d, amount });
  };
  const eth = { id: null, symbol: 'ETH', quote: 'ETH' } as const;
  const sign = (from: Addr | null, to: Addr | null) => (lc(to) === w ? 1 : 0) - (lc(from) === w ? 1 : 0);

  for (const t of lists.txs.items) {
    const g = group(t.hash, t.timestamp);
    if (t.status === 'error') g.failed = true;
    const s = sign(t.from, t.to);
    if (s) add(g, 'ETH', eth, s * wei(t.value));
    if (lc(t.from) === w) add(g, 'ETH', eth, -wei(t.fee?.value));
  }
  for (const t of lists.internals.items) {
    if (t.success === false) continue;
    const s = sign(t.from, t.to);
    if (s) add(group(t.transaction_hash, t.timestamp), 'ETH', eth, s * wei(t.value));
  }
  for (const t of lists.transfers.items) {
    if (t.token.type !== 'ERC-20' || !t.total) continue;
    const s = sign(t.from, t.to);
    if (!s) continue;
    const id = t.token.address_hash.toLowerCase();
    const amount = (s * Number(BigInt(t.total.value))) / 10 ** Number(t.total.decimals ?? 18);
    const quote = QUOTES[chain][id] ?? null;
    if (quote === 'ETH') add(group(t.transaction_hash, t.timestamp), 'ETH', eth, amount);
    else add(group(t.transaction_hash, t.timestamp), id, { id, symbol: quote === 'USD' ? (t.token.symbol ?? 'USD') : tokenSymbol(t.token.symbol, id), quote }, amount);
  }

  const ops: WalletOp[] = [];
  for (const [hash, g] of groups) {
    if (g.failed || seen.has(hash) || g.at < floor) continue;
    const deltas = [...g.deltas.values()].map((d) => ({ ...d, amount: Math.round(d.amount * 1e12) / 1e12 }));
    ops.push(classify(deltas, hash, g.at, txUrl(chain, hash), 'ETH'));
  }
  return ops.sort((a, b) => b.at - a.at);
}

export class BlockscoutReader implements ChainReader {
  readonly native = 'ETH';
  readonly source: string;
  private base: string;

  constructor(
    readonly chain: EvmChain,
    private fetchFn: FetchLike,
    /** Chave PRO do Blockscout (obrigatória na Base). Vai só na URL do pedido ao Blockscout. */
    private key: string | null = null,
    private opts: { gapMs?: number; retryMs?: number } = {},
  ) {
    this.base = chain === 'ethereum' && !key ? 'https://eth.blockscout.com/api/v2' : `https://api.blockscout.com/${chain === 'ethereum' ? 1 : 8453}/api/v2`;
    this.source = new URL(this.base).host;
  }

  unavailable(): string | null {
    return this.chain === 'base' && !this.key ? 'a Base precisa da chave grátis do Blockscout (OPENSPREAD_BLOCKSCOUT_KEY)' : null;
  }

  /**
   * Um pedido, com uma segunda tentativa quando a fonte falha (o Blockscout público dá 500 e estoura o tempo de vez em
   * quando). Se falhar de novo, a leitura inteira falha: sem uma das três listas a troca sairia classificada errada.
   */
  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}${this.key ? `${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(this.key)}` : ''}`;
    try {
      return (await getJson(this.fetchFn, url)) as T;
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      await pause(this.opts.retryMs ?? 3_000);
      return (await getJson(this.fetchFn, url)) as T;
    }
  }

  async read(address: string, seen: ReadonlySet<string>): Promise<ReadResult> {
    const gap = this.opts.gapMs ?? 300;
    const a = encodeURIComponent(address);
    const transfers = await this.get<Page<BsTransfer>>(`/addresses/${a}/token-transfers?type=ERC-20`);
    await pause(gap);
    const txs = await this.get<Page<BsTx>>(`/addresses/${a}/transactions`);
    await pause(gap);
    const internals = await this.get<Page<BsInternal>>(`/addresses/${a}/internal-transactions`);
    return { ops: evmOps(this.chain, address, { transfers, txs, internals }, seen) };
  }
}
