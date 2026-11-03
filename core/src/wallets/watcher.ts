// Vigia das carteiras: uma rodada a cada 60 s, uma rede por vez e uma carteira por vez; recuo quando a fonte pede
// (429), sem derrubar as outras redes. As operações já lidas ficam em cache (~/.openspread/cache/wallets.json), então
// cada rodada só busca o que é novo. Nada aqui avisa o usuário: o estado só muda e a sala se mexe.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addressUrl } from './explorer';
import { RateLimited } from './http';
import { PERIOD_MS, rank, summarize } from './ranking';
import type { ChainReader } from './reader';
import type { WalletChain, WalletOp, WalletRef, WalletSource, WalletState, WalletsState } from '../types';

export const ROUND_MS = 60_000;
/** Quanto guardar de cada carteira (mais que o período, para casar vendas com compras anteriores). */
const KEEP_MS = 30 * 86_400_000;
const KEEP_OPS = 400;
/** Quantas operações vão no estado por carteira. */
const SHOW_OPS = 20;
const MIN_BACKOFF = 60_000;
const MAX_BACKOFF = 10 * 60_000;
const ORDER: WalletChain[] = ['solana', 'ethereum', 'base', 'bitcoin'];

/** Uma carteira a vigiar: da lista do usuário ou descoberta (com o número da fonte ao lado). */
export interface WatchEntry extends WalletRef {
  source: WalletState['source'];
  external?: WalletState['external'];
}

interface Entry {
  ops: WalletOp[];
  balance?: { asset: string; amount: number };
  lastAt?: number;
  error?: string;
}

const key = (r: WalletRef) => `${r.chain}:${r.address}`;

export class WalletWatcher {
  private list: WatchEntry[] = [];
  private data = new Map<string, Entry>();
  private chains = new Map<WalletChain, { ok: boolean; error?: string; backoffUntil?: number; backoffMs: number }>();
  private dirty = false;
  rev = 0;

  constructor(
    private readers: readonly ChainReader[],
    private opts: { cacheFile?: string; log?: (msg: string) => void; periodMs?: number } = {},
  ) {}

  /** Troca a lista (curada + descoberta). A mesma carteira nas duas fica uma vez, como curada. */
  setList(entries: readonly WatchEntry[]): void {
    const seen = new Set<string>();
    const sorted = [...entries].sort((a, b) => (a.source === b.source ? 0 : a.source === 'curated' ? -1 : 1));
    this.list = sorted.filter((e) => !seen.has(key(e)) && seen.add(key(e)));
    this.rev++;
  }

  hasWallets(): boolean {
    return this.list.length > 0;
  }

  /** Uma rodada: redes em sequência; dentro da rede, carteiras em sequência; 429 para a rede até o recuo passar. */
  async round(now = Date.now()): Promise<void> {
    for (const chain of ORDER) {
      const reader = this.readers.find((r) => r.chain === chain);
      const wallets = this.list.filter((w) => w.chain === chain);
      if (!reader || !wallets.length) continue;
      const st = this.chains.get(chain) ?? { ok: true, backoffMs: 0 };
      this.chains.set(chain, st);
      const missing = reader.unavailable?.() ?? null;
      if (missing) {
        this.setChain(chain, st, false, missing);
        continue;
      }
      if (st.backoffUntil && now < st.backoffUntil) continue;
      for (const w of wallets) {
        const e = this.data.get(key(w)) ?? { ops: [] };
        try {
          const r = await reader.read(w.address, new Set(e.ops.map((o) => o.tx)));
          const ops = [...r.ops, ...e.ops].filter((o) => now - o.at <= KEEP_MS).sort((a, b) => b.at - a.at).slice(0, KEEP_OPS);
          this.data.set(key(w), { ops, balance: r.balance ?? e.balance, lastAt: now });
          if (r.ops.length || e.error) this.dirty = true;
          if (r.limited) {
            this.rev++;
            throw new RateLimited(r.limited.retryAfterMs);
          }
          st.backoffMs = 0;
          st.backoffUntil = undefined;
          this.setChain(chain, st, true);
        } catch (err) {
          if (err instanceof RateLimited) {
            st.backoffMs = Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, err.retryAfterMs ?? 0, st.backoffMs * 2));
            st.backoffUntil = now + st.backoffMs;
            this.setChain(chain, st, false, `limite de pedidos; tentando de novo em ${Math.round(st.backoffMs / 1000)} s`);
            break;
          }
          const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
          if (e.error !== msg) this.opts.log?.(`carteira ${chain} ${w.address.slice(0, 6)}…: ${msg}`);
          this.data.set(key(w), { ...e, error: msg });
        }
        this.rev++;
      }
    }
    if (this.dirty) this.saveCache();
  }

  state(now = Date.now()): WalletsState {
    const periodMs = this.opts.periodMs ?? PERIOD_MS;
    const wallets: WalletState[] = this.list.map((w) => {
      const stored = this.data.get(key(w)) ?? { ops: [] };
      // Rede parada (sem chave, recuando) e carteira ainda sem leitura: o motivo é o da rede.
      const chainError = this.chains.get(w.chain)?.error;
      const e = !stored.error && stored.lastAt === undefined && chainError ? { ...stored, error: chainError } : stored;
      const s = summarize(e.ops, now, periodMs);
      const since = e.ops.length ? e.ops[e.ops.length - 1].at : null;
      return {
        chain: w.chain,
        address: w.address,
        source: w.source,
        ok: !e.error && e.lastAt !== undefined,
        ...(e.error ? { error: e.error } : e.lastAt === undefined ? { error: 'aguardando a primeira leitura' } : {}),
        ...(e.lastAt !== undefined ? { lastAt: e.lastAt } : {}),
        since,
        results: s.results,
        trades: s.trades,
        wins: s.wins,
        losses: s.losses,
        open: s.open,
        ...(e.balance ? { balance: e.balance } : {}),
        ops: s.ops.slice(0, SHOW_OPS),
        ...(w.external ? { external: w.external } : {}),
        url: addressUrl(w.chain, w.address),
      };
    });
    const sources: WalletSource[] = ORDER.filter((c) => this.list.some((w) => w.chain === c)).map((chain) => {
      const reader = this.readers.find((r) => r.chain === chain);
      const st = this.chains.get(chain);
      return {
        chain,
        source: reader?.source ?? '—',
        ok: st?.ok ?? true,
        ...(st?.error ? { error: st.error } : {}),
        ...(st?.backoffUntil && st.backoffUntil > now ? { backoffUntil: st.backoffUntil } : {}),
      };
    });
    return { at: now, periodMs, wallets, ranking: rank(wallets), sources };
  }

  private setChain(chain: WalletChain, st: { ok: boolean; error?: string }, ok: boolean, error?: string): void {
    if (st.ok !== ok || st.error !== error) this.opts.log?.(ok ? `carteiras ${chain}: lendo` : `carteiras ${chain}: ${error}`);
    st.ok = ok;
    st.error = error;
  }

  /** Lê o cache; ausente ou quebrado = começa vazio (é só para não repetir pedidos). */
  loadCache(): void {
    const file = this.opts.cacheFile;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; wallets: Record<string, Entry> };
      if (raw.version !== 1 || !raw.wallets) return;
      for (const [k, e] of Object.entries(raw.wallets)) {
        if (!Array.isArray(e.ops)) continue;
        this.data.set(k, { ops: e.ops.filter((o) => o && typeof o.tx === 'string' && Number.isFinite(o.at)), ...(e.balance ? { balance: e.balance } : {}), ...(Number.isFinite(e.lastAt) ? { lastAt: e.lastAt } : {}) });
      }
    } catch {
      // cache quebrado: começa do zero
    }
  }

  /** Grava num temporário e renomeia. Guarda só o que está na lista. */
  saveCache(): void {
    const file = this.opts.cacheFile;
    this.dirty = false;
    if (!file) return;
    const wallets: Record<string, Entry> = {};
    for (const w of this.list) {
      const e = this.data.get(key(w));
      if (e) wallets[key(w)] = { ops: e.ops, ...(e.balance ? { balance: e.balance } : {}), ...(e.lastAt !== undefined ? { lastAt: e.lastAt } : {}) };
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, wallets }), 'utf8');
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.opts.log?.(`não consegui gravar o cache de carteiras em ${file}: ${(e as Error).message}`);
    }
  }
}
