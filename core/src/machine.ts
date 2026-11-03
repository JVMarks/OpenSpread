// Sala de máquinas (item 15): saúde do núcleo (CPU e memória do processo, memória do computador) e uso de cada fonte
// (pedidos no último minuto contra o limite conhecido, latência do último pedido, estado). Só números locais: nada sai
// do computador por causa disto.
import os from 'node:os';
import type { ExchangeStatus, MachineSource, MachineState, WalletSource } from './types';

const MINUTE = 60_000;

/** Pedidos por fonte numa janela de 1 minuto, e a latência do último. */
export class Usage {
  private hits = new Map<string, number[]>();
  private latency = new Map<string, number>();

  record(id: string, now: number, latencyMs?: number): void {
    const list = this.hits.get(id) ?? [];
    list.push(now);
    while (list.length && now - list[0] > MINUTE) list.shift();
    this.hits.set(id, list);
    if (latencyMs !== undefined && Number.isFinite(latencyMs)) this.latency.set(id, Math.round(latencyMs));
  }

  perMinute(id: string, now: number): number {
    return (this.hits.get(id) ?? []).filter((t) => now - t <= MINUTE).length;
  }

  lastLatency(id: string): number | undefined {
    return this.latency.get(id);
  }
}

/**
 * Limites conhecidos (pedidos por minuto). Corretoras: o ritmo que a CCXT respeita (`rateLimit` em ms entre pedidos),
 * mais conservador que o da corretora. RPC público da Solana: 100 pedidos a cada 10 s por IP (documentação da Solana).
 * Fonte sem limite publicado: null.
 */
export const CHAIN_LIMITS: Readonly<Record<string, number>> = { 'api.mainnet-beta.solana.com': 600 };
export const ccxtLimitPerMin = (rateLimitMs: number | undefined): number | null => (rateLimitMs && rateLimitMs > 0 ? Math.floor(MINUTE / rateLimitMs) : null);

/** Uso de CPU do processo entre duas leituras, em % de um núcleo. */
export class CpuSampler {
  private last = process.cpuUsage();
  private lastAt = performance.now();
  private pct = 0;

  sample(): number {
    const now = performance.now();
    const d = process.cpuUsage(this.last);
    const ms = now - this.lastAt;
    if (ms >= 500) {
      this.pct = Math.round(((d.user + d.system) / 1000 / ms) * 1000) / 10;
      this.last = process.cpuUsage();
      this.lastAt = now;
    }
    return this.pct;
  }
}

export interface MachineInputs {
  now: number;
  cpuPct: number;
  exchanges: readonly ExchangeStatus[];
  /** rateLimit da CCXT por corretora (ms entre pedidos). */
  rateLimits: Readonly<Record<string, number | undefined>>;
  chains: readonly WalletSource[];
  /** Feeds do radar (url, estado). */
  feeds?: ReadonlyArray<{ url: string; ok: boolean; error?: string }>;
  usage: Usage;
  mem?: { rss: number; heapUsed: number };
  sys?: { total: number; free: number };
  uptimeS?: number;
}

/** Estado da sala de máquinas. Puro (as leituras do sistema entram por `inputs`). */
export function machineState(i: MachineInputs): MachineState {
  const mem = i.mem ?? process.memoryUsage();
  const sys = i.sys ?? { total: os.totalmem(), free: os.freemem() };
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const sources: MachineSource[] = [
    ...i.exchanges.map((e): MachineSource => {
      const latency = i.usage.lastLatency(e.id);
      return {
        id: e.id,
        kind: 'exchange',
        ok: e.ok,
        ...(e.error ? { error: e.error } : {}),
        ...(latency !== undefined ? { latencyMs: latency } : {}),
        perMin: i.usage.perMinute(e.id, i.now),
        limitPerMin: ccxtLimitPerMin(i.rateLimits[e.id]),
      };
    }),
    ...i.chains.map((c): MachineSource => {
      const latency = i.usage.lastLatency(c.source);
      return {
        id: c.source,
        kind: 'chain',
        chain: c.chain,
        ok: c.ok,
        ...(c.error ? { error: c.error } : {}),
        ...(latency !== undefined ? { latencyMs: latency } : {}),
        perMin: i.usage.perMinute(c.source, i.now),
        limitPerMin: CHAIN_LIMITS[c.source] ?? null,
        ...(c.backoffUntil ? { backoffUntil: c.backoffUntil } : {}),
      };
    }),
    ...(i.feeds ?? []).map((f): MachineSource => {
      const host = new URL(f.url).host;
      const latency = i.usage.lastLatency(host);
      return { id: host, kind: 'feed', ok: f.ok, ...(f.error ? { error: f.error } : {}), ...(latency !== undefined ? { latencyMs: latency } : {}), perMin: i.usage.perMinute(host, i.now), limitPerMin: null };
    }),
  ];
  return {
    at: i.now,
    cpuPct: i.cpuPct,
    rssMb: mb(mem.rss),
    heapMb: mb(mem.heapUsed),
    sysMemPct: sys.total > 0 ? Math.round(((sys.total - sys.free) / sys.total) * 100) : 0,
    uptimeS: Math.round(i.uptimeS ?? process.uptime()),
    sources,
  };
}

/** Nível de uma fonte para o LED do rack: fora, recuando/quase no limite, ou ok. */
export function sourceLevel(s: MachineSource, now: number): 'ok' | 'warn' | 'down' {
  if (s.backoffUntil && s.backoffUntil > now) return 'warn';
  if (!s.ok) return 'down';
  if (s.limitPerMin && s.perMin >= s.limitPerMin * 0.8) return 'warn';
  return 'ok';
}
