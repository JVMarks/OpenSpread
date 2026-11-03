// Bitcoin pelo mempool.space (sem chave): saldo e movimentos. Bitcoin não tem "troca" na própria rede: cada
// transação é entrada ou saída (o que saiu já inclui a taxa).
import { txUrl } from './explorer';
import { getJson, pause, type FetchLike } from './http';
import type { ChainReader, ReadResult } from './reader';
import type { WalletOp } from '../types';

export interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: Array<{ prevout: { scriptpubkey_address?: string; value: number } | null }>;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
}

export function bitcoinOp(tx: MempoolTx, address: string): WalletOp | null {
  if (!tx.status.confirmed) return null;
  let sats = 0;
  for (const v of tx.vout) if (v.scriptpubkey_address === address) sats += v.value;
  for (const v of tx.vin) if (v.prevout?.scriptpubkey_address === address) sats -= v.prevout.value;
  if (sats === 0) return null;
  return { tx: tx.txid, at: (tx.status.block_time ?? 0) * 1000, kind: sats > 0 ? 'in' : 'out', asset: 'BTC', assetId: null, amount: Math.abs(sats) / 1e8, quote: null, quoteAmount: null, url: txUrl('bitcoin', tx.txid) };
}

export class MempoolReader implements ChainReader {
  readonly chain = 'bitcoin' as const;
  readonly native = 'BTC';
  readonly source: string;

  constructor(
    private fetchFn: FetchLike,
    private base = 'https://mempool.space/api',
  ) {
    this.source = new URL(base).host;
  }

  async read(address: string, seen: ReadonlySet<string>): Promise<ReadResult> {
    const a = encodeURIComponent(address);
    const info = (await getJson(this.fetchFn, `${this.base}/address/${a}`)) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number } };
    await pause(300);
    const txs = (await getJson(this.fetchFn, `${this.base}/address/${a}/txs/chain`)) as MempoolTx[];
    const ops = txs.filter((t) => !seen.has(t.txid)).map((t) => bitcoinOp(t, address)).filter((o): o is WalletOp => o !== null);
    return { ops, balance: { asset: 'BTC', amount: (info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum) / 1e8 } };
  }
}
