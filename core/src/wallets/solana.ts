// Solana pelo RPC público (sem chave): getSignaturesForAddress + getTransaction (jsonParsed). Compra e venda saem da
// variação de saldo da carteira na transação: SOL nativo (lamports) e tokens cujo dono é a carteira.
import { classify, tokenSymbol, type Delta } from './classify';
import { txUrl } from './explorer';
import { getJson, pause, RateLimited, SourceError, type FetchLike } from './http';
import type { ChainReader, ReadResult } from './reader';
import type { WalletOp } from '../types';

export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const WSOL = 'So11111111111111111111111111111111111111112';
/** Stablecoins que contam como cotação em USD. */
const USD_MINTS: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCLqfPfNAN: 'USDT',
};

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** A parte da resposta de getTransaction (jsonParsed) que usamos. */
export interface SolanaTx {
  blockTime: number | null;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { signatures: string[]; message: { accountKeys: Array<{ pubkey: string } | string> } };
}

const units = (b: TokenBalance) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/** Quanto cada ativo mudou na carteira (SOL com wSOL juntos; tokens pelo dono da conta de token). */
export function solanaDeltas(tx: SolanaTx, wallet: string): Delta[] {
  const meta = tx.meta!;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const out: Delta[] = [];
  const i = keys.indexOf(wallet);
  let sol = i >= 0 ? (meta.postBalances[i] - meta.preBalances[i]) / 1e9 : 0;
  const tokens = new Map<string, number>();
  for (const [list, sign] of [[meta.preTokenBalances ?? [], -1], [meta.postTokenBalances ?? [], 1]] as const) {
    for (const b of list) if (b.owner === wallet) tokens.set(b.mint, (tokens.get(b.mint) ?? 0) + sign * units(b));
  }
  for (const [mint, amount] of tokens) {
    const v = Math.round(amount * 1e9) / 1e9;
    if (mint === WSOL) sol += v;
    else if (v !== 0) out.push({ id: mint, symbol: USD_MINTS[mint] ?? tokenSymbol(null, mint), amount: v, quote: USD_MINTS[mint] ? 'USD' : null });
  }
  out.push({ id: null, symbol: 'SOL', amount: Math.round(sol * 1e9) / 1e9, quote: 'SOL' });
  return out;
}

/** Operação de uma transação; null se a transação falhou (não mexeu em nada além da taxa). */
export function solanaOp(tx: SolanaTx, wallet: string): WalletOp | null {
  if (!tx.meta || tx.meta.err) return null;
  const sig = tx.transaction.signatures[0];
  return classify(solanaDeltas(tx, wallet), sig, (tx.blockTime ?? 0) * 1000, txUrl('solana', sig), 'SOL');
}

interface RpcReply<T> {
  result?: T;
  error?: { code: number; message: string };
}

export class SolanaReader implements ChainReader {
  readonly chain = 'solana' as const;
  readonly native = 'SOL';
  readonly source: string;

  constructor(
    private fetchFn: FetchLike,
    private rpc = SOLANA_RPC,
    /** Quantas transações novas ler por carteira por rodada, e a pausa entre pedidos. */
    private opts: { perRead?: number; gapMs?: number } = {},
  ) {
    this.source = new URL(rpc).host;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = (await getJson(this.fetchFn, this.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })) as RpcReply<T>;
    if (r.error) {
      if (r.error.code === 429 || /too many requests|rate limit/i.test(r.error.message)) throw new RateLimited(null);
      throw new SourceError(`RPC: ${r.error.message.slice(0, 120)}`);
    }
    return r.result as T;
  }

  async read(address: string, seen: ReadonlySet<string>): Promise<ReadResult> {
    const gap = this.opts.gapMs ?? 1_000;
    const sigs = await this.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [address, { limit: 50 }]);
    const fresh = sigs.filter((s) => !s.err && !seen.has(s.signature)).slice(0, this.opts.perRead ?? 8);
    const ops: WalletOp[] = [];
    for (const s of fresh) {
      await pause(gap);
      let tx: SolanaTx | null;
      try {
        tx = await this.call<SolanaTx | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
      } catch (e) {
        // Limite no meio: guarda o que já leu (o resto vem na próxima rodada).
        if (e instanceof RateLimited && ops.length) return { ops, limited: { retryAfterMs: e.retryAfterMs } };
        throw e;
      }
      const op = tx && solanaOp(tx, address);
      if (op) ops.push(op);
    }
    return { ops };
  }
}
