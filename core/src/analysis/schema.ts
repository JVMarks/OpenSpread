// Formato da análise que o Claude/Codex do usuário registra. Campo desconhecido é recusado: em especial, o cliente
// não manda preço de referência (quem define é o núcleo). Mensagens em português, para o modelo poder corrigir.
import type { AnalysisDirection, AnalysisFactor, AnalysisHorizon, AnalysisInput, AnalysisPlan } from '../types';

export const HORIZON_MS: Record<AnalysisHorizon, number> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

const PAIR = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;
const FIELDS = new Set(['pair', 'horizon', 'direction', 'conviction', 'factors', 'plans', 'reasoning', 'model', 'usedChart']);
const FACTOR_FIELDS = new Set(['name', 'category', 'effect', 'note']);
const PLAN_FIELDS = new Set(['label', 'kind', 'entry', 'stop', 'targets']);
const CATEGORIES = new Set(['technical', 'derivatives', 'macro', 'sentiment', 'onchain', 'spread']);
const EFFECTS = new Set(['supports', 'neutral', 'weakens']);
const MAX_REASONING = 4000;
const MAX_MODEL = 64;
const MAX_NAME = 80;
const MAX_NOTE = 300;
const MAX_FACTORS = 12;
const MAX_PLANS = 2;
const MAX_TARGETS = 3;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const unknownFields = (o: Record<string, unknown>, known: Set<string>, where: string): string[] =>
  Object.keys(o).filter((k) => !known.has(k)).map((k) => `${where}: campo desconhecido "${k}".`);

function parseFactor(raw: unknown, i: number, errors: string[]): AnalysisFactor | undefined {
  const where = `factors[${i}]`;
  if (!isObject(raw)) {
    errors.push(`${where}: precisa ser um objeto.`);
    return undefined;
  }
  const before = errors.length;
  errors.push(...unknownFields(raw, FACTOR_FIELDS, where));
  if (!isText(raw.name, MAX_NAME)) errors.push(`${where}.name: texto de até ${MAX_NAME} caracteres.`);
  if (!CATEGORIES.has(raw.category as string)) errors.push(`${where}.category: use ${[...CATEGORIES].join(', ')}.`);
  if (!EFFECTS.has(raw.effect as string)) errors.push(`${where}.effect: use ${[...EFFECTS].join(', ')}.`);
  if (raw.note !== undefined && !isText(raw.note, MAX_NOTE)) errors.push(`${where}.note: texto de até ${MAX_NOTE} caracteres.`);
  return errors.length === before ? (raw as unknown as AnalysisFactor) : undefined;
}

function parsePlan(raw: unknown, i: number, errors: string[]): AnalysisPlan | undefined {
  const where = `plans[${i}]`;
  if (!isObject(raw)) {
    errors.push(`${where}: precisa ser um objeto.`);
    return undefined;
  }
  const before = errors.length;
  errors.push(...unknownFields(raw, PLAN_FIELDS, where));
  if (raw.label !== 'A' && raw.label !== 'B') errors.push(`${where}.label: use A ou B.`);
  if (raw.kind !== 'market' && raw.kind !== 'confirmation') errors.push(`${where}.kind: use market ou confirmation.`);
  if (raw.kind === 'confirmation' && !isPrice(raw.entry)) errors.push(`${where}.entry: obrigatório em confirmation, preço positivo.`);
  if (raw.kind === 'market' && raw.entry !== undefined) errors.push(`${where}.entry: não use em market; a entrada é o preço de referência do núcleo.`);
  if (!isPrice(raw.stop)) errors.push(`${where}.stop: preço positivo.`);
  const targets = raw.targets;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TARGETS || !targets.every(isPrice)) {
    errors.push(`${where}.targets: de 1 a ${MAX_TARGETS} preços positivos.`);
  }
  return errors.length === before ? (raw as unknown as AnalysisPlan) : undefined;
}

export type ParseResult = { ok: true; input: AnalysisInput } | { ok: false; errors: string[] };

/** Confere o corpo de POST /v1/analyses. */
export function parseAnalysis(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, errors: ['A análise precisa ser um objeto JSON.'] };
  const errors = unknownFields(raw, FIELDS, 'análise');
  const pair = typeof raw.pair === 'string' ? raw.pair.trim().toUpperCase() : '';
  if (!PAIR.test(pair)) errors.push('pair: use o formato BASE/COTAÇÃO, como BTC/USDT.');
  if (typeof raw.horizon !== 'string' || !Object.hasOwn(HORIZON_MS, raw.horizon)) errors.push(`horizon: use ${Object.keys(HORIZON_MS).join(', ')}.`);
  if (raw.direction !== 'up' && raw.direction !== 'down') errors.push('direction: use up ou down. Sem opinião de direção, não registre análise.');
  if (!Number.isInteger(raw.conviction) || (raw.conviction as number) < 50 || (raw.conviction as number) > 100) {
    errors.push('conviction: inteiro de 50 a 100, a probabilidade de a direção acertar.');
  }
  if (!isText(raw.reasoning, MAX_REASONING)) errors.push(`reasoning: texto de até ${MAX_REASONING} caracteres.`);
  if (!isText(raw.model, MAX_MODEL)) errors.push(`model: texto de até ${MAX_MODEL} caracteres.`);
  if (typeof raw.usedChart !== 'boolean') errors.push('usedChart: true ou false.');

  if (!Array.isArray(raw.factors) || raw.factors.length < 1 || raw.factors.length > MAX_FACTORS) {
    errors.push(`factors: de 1 a ${MAX_FACTORS} fatores.`);
  } else raw.factors.forEach((f, i) => parseFactor(f, i, errors));

  if (!Array.isArray(raw.plans) || raw.plans.length > MAX_PLANS) {
    errors.push(`plans: no máximo ${MAX_PLANS} planos.`);
  } else {
    raw.plans.forEach((p, i) => parsePlan(p, i, errors));
    const labels = raw.plans.map((p) => (p as { label?: unknown } | null)?.label);
    if (new Set(labels).size !== labels.length) errors.push('plans: cada plano precisa de um rótulo próprio.');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      pair,
      horizon: raw.horizon as AnalysisHorizon,
      direction: raw.direction as AnalysisDirection,
      conviction: raw.conviction as number,
      factors: raw.factors as AnalysisFactor[],
      plans: raw.plans as AnalysisPlan[],
      reasoning: raw.reasoning as string,
      model: (raw.model as string).trim(),
      usedChart: raw.usedChart as boolean,
    },
  };
}

/** Stop e alvos do lado certo da entrada, considerando a referência em planos `market`. */
export function checkSides(input: AnalysisInput, reference: number): string[] {
  const errors: string[] = [];
  const up = input.direction === 'up';
  for (const plan of input.plans) {
    const base = plan.kind === 'market' ? reference : (plan.entry as number);
    const name = `Plano ${plan.label}`;
    if (up ? plan.stop >= base : plan.stop <= base) errors.push(`${name}: em ${up ? 'alta' : 'baixa'}, o stop fica ${up ? 'abaixo' : 'acima'} da entrada (${base}).`);
    if (plan.targets.some((t) => (up ? t <= base : t >= base))) errors.push(`${name}: em ${up ? 'alta' : 'baixa'}, os alvos ficam ${up ? 'acima' : 'abaixo'} da entrada (${base}).`);
  }
  return errors;
}
