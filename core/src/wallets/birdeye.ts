// Descoberta (entrega 3): para os tokens que o usuário escolheu, os top traders do Birdeye
// (GET /defi/v2/tokens/top_traders, cabeçalhos X-API-KEY e x-chain). Só trazemos o endereço e os números do próprio
// Birdeye; o resultado mostrado é o calculado por nós com a mesma regra das outras carteiras.
// Lê de hora em hora (o ranking de um token não muda a cada minuto e o plano grátis tem poucos pedidos).
import { getJson, pause, type FetchLike } from './http';
import { normalizeAddress } from './address';
import type { DiscoveryConfig } from '../types';
import type { WatchEntry } from './watcher';

export const DISCOVERY_MS = 60 * 60_000;
const API = 'https://public-api.birdeye.so/defi/v2/tokens/top_traders';

/** Item de top_traders: aceitamos os nomes que a documentação mostra e ignoramos o resto. */
interface TopTrader {
  owner?: string;
  volume?: number;
  volumeUsd?: number;
  trade?: number;
  totalPnl?: number;
  realizedPnl?: number;
  tags?: string[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseTopTraders(raw: unknown, chain: 'solana' | 'ethereum' | 'base', token: string, limit: number): WatchEntry[] {
  const items = (raw as { data?: { items?: TopTrader[] } })?.data?.items;
  if (!Array.isArray(items)) return [];
  const out: WatchEntry[] = [];
  for (const it of items) {
    // Robôs marcados pelo próprio Birdeye (MEV, sniper) não são "traders a acompanhar".
    if (Array.isArray(it.tags) && it.tags.some((t) => /bot|mev|sniper|arbitrage/i.test(String(t)))) continue;
    const address = typeof it.owner === 'string' ? normalizeAddress(chain, it.owner) : null;
    if (!address || out.some((o) => o.address === address)) continue;
    const pnlUsd = num(it.realizedPnl) ?? num(it.totalPnl);
    out.push({
      chain,
      address,
      source: 'birdeye',
      external: { source: 'birdeye', token, ...(num(it.volumeUsd) ?? num(it.volume) ? { volumeUsd: num(it.volumeUsd) ?? num(it.volume) } : {}), ...(num(it.trade) ? { trades: num(it.trade) } : {}), ...(pnlUsd !== undefined ? { pnlUsd } : {}) },
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function discover(fetchFn: FetchLike, key: string, cfg: DiscoveryConfig): Promise<WatchEntry[]> {
  const out: WatchEntry[] = [];
  for (const t of cfg.tokens) {
    const url = `${API}?address=${encodeURIComponent(t.address)}&time_frame=24h&sort_by=volume&sort_type=desc&offset=0&limit=${Math.min(10, cfg.perToken * 2)}`;
    const raw = await getJson(fetchFn, url, { headers: { 'X-API-KEY': key, 'x-chain': t.chain } });
    out.push(...parseTopTraders(raw, t.chain, t.address, cfg.perToken));
    await pause(1_100);
  }
  return out;
}
