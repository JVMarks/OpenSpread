// Placar com método público: acerto só com amostra, calibração (Brier) contra o chute de 50% e retorno com custos.
import type { AnalysisHorizon, AnalysisResult, CalibrationBin, ScoreLine, Scoreboard } from '../types';

/** Abaixo disto o percentual de acerto não é mostrado. */
export const MIN_SAMPLE = 30;
/** Brier de quem diz 50% em tudo. */
const BASELINE_BRIER = 0.25;
const BINS: ReadonlyArray<[number, number]> = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];

export interface OpenRef {
  model: string;
  horizon: AnalysisHorizon;
}

const mean = (v: number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function line(results: AnalysisResult[], open: number, id: { model?: string; horizon?: AnalysisHorizon } = {}): ScoreLine {
  const done = results.filter((r) => r.status === 'resolved');
  const hits = done.filter((r) => r.hit).length;
  const brier = mean(done.map((r) => (r.conviction / 100 - (r.hit ? 1 : 0)) ** 2));
  const calibration: CalibrationBin[] = BINS.map(([from, to]) => {
    const inBin = done.filter((r) => r.conviction >= from && r.conviction <= to);
    return {
      from,
      to,
      n: inBin.length,
      meanConviction: mean(inBin.map((r) => r.conviction)),
      hitPct: inBin.length ? (inBin.filter((r) => r.hit).length / inBin.length) * 100 : null,
    };
  });
  const nets = results.flatMap((r) => r.plans).flatMap((p) => (p.netPct === undefined ? [] : [p.netPct]));
  return {
    ...id,
    submitted: results.length + open,
    open,
    resolved: done.length,
    voids: results.length - done.length,
    hits,
    hitPct: done.length >= MIN_SAMPLE ? (hits / done.length) * 100 : null,
    brier,
    baselineBrier: BASELINE_BRIER,
    skill: brier === null ? null : 1 - brier / BASELINE_BRIER,
    calibration,
    plans: { triggered: nets.length, avgNetPct: mean(nets), worstNetPct: nets.length ? Math.min(...nets) : null },
  };
}

export function scoreboard(results: AnalysisResult[], open: OpenRef[]): Scoreboard {
  const keyOf = (r: OpenRef) => `${r.model}\u0000${r.horizon}`;
  const groups = new Map<string, { id: OpenRef; results: AnalysisResult[]; open: number }>();
  const group = (r: OpenRef) => {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = { id: { model: r.model, horizon: r.horizon }, results: [], open: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of results) group(r).results.push(r);
  for (const o of open) group(o).open += 1;
  return {
    minSample: MIN_SAMPLE,
    total: line(results, open.length),
    byModel: [...groups.values()].map((g) => line(g.results, g.open, g.id)),
  };
}
