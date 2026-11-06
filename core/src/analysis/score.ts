// Conta pura de uma análise: acompanha as amostras de preço e resolve no vencimento. Em toda dúvida, a regra escolhe o
// pior caso para quem analisou: empate é erro, stop vence o alvo, alvo nunca sai melhor que o alvo. Faltou dado, é void.
import type { Analysis, AnalysisPlan, AnalysisResult, PlanResult } from '../types';

/** Maior intervalo entre amostras aceito para confiar na trajetória, e tolerância depois do vencimento. */
export const MAX_GAP_MS = 15 * 60_000;

interface OpenPlan {
  label: AnalysisPlan['label'];
  state: 'waiting' | 'in' | 'stop' | 'target' | 'void';
  entryPrice?: number;
  exitPrice?: number;
}

export interface OpenAnalysis {
  analysis: Analysis;
  lastAt: number;
  lastPrice: number;
  /** Primeira amostra em ou depois do vencimento. */
  closePrice?: number;
  plans: OpenPlan[];
}

export function openOf(analysis: Analysis): OpenAnalysis {
  return {
    analysis,
    lastAt: analysis.submittedAt,
    lastPrice: analysis.referencePrice,
    plans: analysis.plans.map((p) => (p.kind === 'market'
      ? { label: p.label, state: 'in', entryPrice: analysis.referencePrice }
      : { label: p.label, state: 'waiting' })),
  };
}

function stepPlan(plan: OpenPlan, spec: AnalysisPlan, up: boolean, last: number, price: number): OpenPlan {
  if (plan.state !== 'waiting' && plan.state !== 'in') return plan;
  const lo = Math.min(last, price);
  const hi = Math.max(last, price);
  let next = plan;
  const entering = plan.state === 'waiting';
  if (entering) {
    const entry = spec.entry as number;
    if (entry < lo || entry > hi) return plan;
    next = { ...plan, state: 'in', entryPrice: entry };
  }
  const target = spec.targets[0];
  const touchedTarget = up ? hi >= target : lo <= target;
  // Na amostra da entrada a ordem é desconhecida: se o caminho cobre o stop e o alvo, vale o stop.
  const crossedStop = entering && touchedTarget && (up ? lo <= spec.stop : hi >= spec.stop);
  const beyondStop = up ? price <= spec.stop : price >= spec.stop;
  if (beyondStop) return { ...next, state: 'stop', exitPrice: price };
  if (crossedStop) return { ...next, state: 'stop', exitPrice: spec.stop };
  if (touchedTarget) return { ...next, state: 'target', exitPrice: target };
  return next;
}

/** Registra uma amostra. Amostra fora de ordem é ignorada. */
export function observe(open: OpenAnalysis, price: number, at: number): OpenAnalysis {
  if (at <= open.lastAt) return open;
  const { analysis } = open;
  const up = analysis.direction === 'up';
  const gap = at - open.lastAt > MAX_GAP_MS;
  const expired = at >= analysis.expiresAt;
  const plans = open.plans.map((plan, i) => {
    if (gap && (plan.state === 'waiting' || plan.state === 'in')) return { ...plan, state: 'void' as const };
    return expired ? plan : stepPlan(plan, analysis.plans[i], up, open.lastPrice, price);
  });
  const closes = expired && open.closePrice === undefined && at <= analysis.expiresAt + MAX_GAP_MS;
  return { ...open, lastAt: at, lastPrice: price, plans, ...(closes ? { closePrice: price } : {}) };
}

function finishPlan(plan: OpenPlan, analysis: Analysis, closePrice: number | undefined): PlanResult {
  const { label } = plan;
  const net = (entry: number, exit: number) => ((analysis.direction === 'up' ? exit - entry : entry - exit) / entry) * 100 - analysis.costPct;
  if (plan.state === 'void') return { label, status: 'void' };
  if (plan.state === 'stop' || plan.state === 'target') {
    return { label, status: plan.state, entryPrice: plan.entryPrice, exitPrice: plan.exitPrice, netPct: net(plan.entryPrice as number, plan.exitPrice as number) };
  }
  if (closePrice === undefined) return { label, status: 'void' };
  if (plan.state === 'waiting') return { label, status: 'not_triggered' };
  return { label, status: 'closed', entryPrice: plan.entryPrice, exitPrice: closePrice, netPct: net(plan.entryPrice as number, closePrice) };
}

/** Resultado final, ou null se ainda não venceu. */
export function resolve(open: OpenAnalysis, at: number): AnalysisResult | null {
  const { analysis, closePrice } = open;
  if (closePrice === undefined && at <= analysis.expiresAt + MAX_GAP_MS) return null;
  const base = {
    id: analysis.id,
    pair: analysis.pair,
    model: analysis.model,
    horizon: analysis.horizon,
    direction: analysis.direction,
    conviction: analysis.conviction,
    resolvedAt: at,
    plans: open.plans.map((p) => finishPlan(p, analysis, closePrice)),
  };
  if (closePrice === undefined) return { ...base, status: 'void', reason: 'no_data' };
  const ref = analysis.referencePrice;
  return {
    ...base,
    status: 'resolved',
    hit: analysis.direction === 'up' ? closePrice > ref : closePrice < ref,
    closePrice,
    movePct: ((closePrice - ref) / ref) * 100,
  };
}
