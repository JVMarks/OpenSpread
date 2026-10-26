// Alertas de spread: "spread líquido do par ≥ X%". Cada um toca uma vez ao chegar ao nível e só rearma depois que o
// spread recua abaixo do nível menos uma folga (não pisca em volta do nível). Ideia do trader-alerts
// (github.com/Jakeschincariol/trader-skill, MIT), reescrita aqui. Puro: sem rede e sem relógio próprio.
import type { AlertEvent, PairState, SpreadAlert } from './types';

/** Folga do rearme, em pontos percentuais (0,02 = o spread precisa cair 0,02 p.p. abaixo do nível). */
export const REARM_GAP_PCT = 0.02;
/** Quantos eventos recentes o estado do núcleo carrega. */
export const RECENT_MAX = 20;

const key = (a: SpreadAlert) => `${a.pair}|${a.abovePct}`;

export class SpreadAlerts {
  /** Alertas que já tocaram e esperam o recuo para rearmar. */
  private fired = new Set<string>();
  private recent: AlertEvent[] = [];
  private seq = 0;

  /** Confere os alertas contra os pares atuais e devolve só os eventos que tocaram agora. */
  evaluate(alerts: readonly SpreadAlert[], pairs: readonly PairState[], now: number): AlertEvent[] {
    const live = new Set(alerts.map(key));
    for (const k of [...this.fired]) if (!live.has(k)) this.fired.delete(k);
    const out: AlertEvent[] = [];
    for (const a of alerts) {
      const best = pairs.find((p) => p.pair === a.pair)?.best;
      if (!best) continue;
      const k = key(a);
      if (this.fired.has(k)) {
        if (best.netPct < a.abovePct - REARM_GAP_PCT) this.fired.delete(k);
        continue;
      }
      if (best.netPct >= a.abovePct) {
        this.fired.add(k);
        out.push({ id: `${now}-${++this.seq}`, pair: a.pair, abovePct: a.abovePct, netPct: best.netPct, buyOn: best.buyOn, sellOn: best.sellOn, at: now });
      }
    }
    if (out.length) this.recent = [...this.recent, ...out].slice(-RECENT_MAX);
    return out;
  }

  /** Últimos eventos, do mais antigo para o mais recente. */
  events(): AlertEvent[] {
    return [...this.recent];
  }
}
