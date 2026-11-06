// Livro de análises: journal.jsonl só de acréscimo (enviadas e resolvidas) e open.json com a trajetória das abertas.
// Não existe editar, apagar nem retirar: análise ruim continua no placar.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlFile } from '../jsonl';
import type { AnalysesBrief, AnalysesState, Analysis, AnalysisResult, PairState } from '../types';
import { scoreboard } from './board';
import { referenceOf } from './reference';
import { checkSides, HORIZON_MS, parseAnalysis } from './schema';
import { observe, openOf, resolve, type OpenAnalysis } from './score';

export const NOTICE = 'Registro do próprio usuário. Não é ordem nem recomendação.';
const KEEP_RECENT = 50;
const KEEP_BRIEF = 12;

type JournalEntry = { at: number; kind: 'submitted'; analysis: Analysis } | { at: number; kind: 'resolved'; result: AnalysisResult };

const isEntry = (v: unknown): v is JournalEntry => {
  const e = v as { at?: unknown; kind?: unknown; analysis?: { id?: unknown }; result?: { id?: unknown } } | null;
  if (!e || typeof e.at !== 'number') return false;
  if (e.kind === 'submitted') return typeof e.analysis?.id === 'string';
  return e.kind === 'resolved' && typeof e.result?.id === 'string';
};

export type SubmitResult =
  | { ok: true; analysis: Analysis }
  | { ok: false; code: 'invalid' | 'pair_not_read' | 'already_open' | 'stop_wrong_side'; errors: string[] };

export interface BookOptions {
  /** Pasta analyses/, ao lado do config. */
  dir: string;
  log?: (msg: string) => void;
}

export class AnalysisBook {
  /** Sobe só quando uma análise entra ou resolve: a sala fica calma entre uma coisa e outra. */
  rev = 0;
  private open: OpenAnalysis[] = [];
  private readonly analyses = new Map<string, Analysis>();
  private results: AnalysisResult[] = [];
  private readonly journal: JsonlFile<JournalEntry>;
  private readonly openFile: string;
  private readonly log: (msg: string) => void;

  constructor(opts: BookOptions) {
    this.log = opts.log ?? (() => {});
    this.openFile = join(opts.dir, 'open.json');
    this.journal = new JsonlFile(join(opts.dir, 'journal.jsonl'), isEntry, (bad, f) => this.log(`análises: ignorei ${bad} linha(s) ilegível(is) em ${f}`));
    mkdirSync(opts.dir, { recursive: true });
  }

  /** O registro manda: o que foi enviado e não resolveu está aberto, com a trajetória salva quando houver. */
  load(): void {
    for (const e of this.journal.readAll()) {
      if (e.kind === 'submitted') this.analyses.set(e.analysis.id, e.analysis);
      else this.results.push(e.result);
    }
    const done = new Set(this.results.map((r) => r.id));
    const saved = this.readOpen();
    this.open = [...this.analyses.values()].filter((a) => !done.has(a.id)).map((a) => saved.get(a.id) ?? openOf(a));
    if (this.analyses.size) this.log(`análises: ${this.open.length} aberta(s), ${this.results.length} resolvida(s)`);
  }

  private readOpen(): Map<string, OpenAnalysis> {
    if (!existsSync(this.openFile)) return new Map();
    try {
      const list = JSON.parse(readFileSync(this.openFile, 'utf8')) as OpenAnalysis[];
      if (!Array.isArray(list)) throw new Error('formato inesperado');
      return new Map(list.map((o) => [o.analysis.id, o]));
    } catch (e) {
      const bad = `${this.openFile}.bad`;
      this.log(`análises: ${this.openFile} ilegível (${(e as Error).message}); guardado em ${bad}`);
      renameSync(this.openFile, bad);
      return new Map();
    }
  }

  /** Grava num temporário e renomeia. Falha só avisa: o registro continua valendo. */
  save(): void {
    try {
      const tmp = `${this.openFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.open), 'utf8');
      renameSync(tmp, this.openFile);
    } catch (e) {
      this.log(`análises: não consegui salvar ${this.openFile}: ${(e as Error).message}`);
    }
  }

  submit(raw: unknown, pairs: PairState[], now: number): SubmitResult {
    const parsed = parseAnalysis(raw);
    if (!parsed.ok) return { ok: false, code: 'invalid', errors: parsed.errors };
    const { input } = parsed;
    const pair = pairs.find((p) => p.pair === input.pair);
    const reference = pair && referenceOf(pair);
    if (!reference) {
      return { ok: false, code: 'pair_not_read', errors: [`${input.pair} não está sendo lido agora. O usuário pode adicionar o par no painel Mercados do Bullroom; depois disso, envie de novo.`] };
    }
    if (this.open.some((o) => o.analysis.model === input.model && o.analysis.pair === input.pair && o.analysis.horizon === input.horizon)) {
      return { ok: false, code: 'already_open', errors: [`Já existe uma análise aberta de ${input.model} para ${input.pair} em ${input.horizon}. Espere ela vencer: análises não podem ser retiradas.`] };
    }
    const sides = checkSides(input, reference.price);
    if (sides.length) return { ok: false, code: 'stop_wrong_side', errors: sides };

    const analysis: Analysis = {
      ...input,
      id: `a_${createHash('sha256').update(JSON.stringify(input)).update(String(now)).digest('hex').slice(0, 16)}`,
      submittedAt: now,
      expiresAt: now + HORIZON_MS[input.horizon],
      referencePrice: reference.price,
      costPct: reference.costPct,
      exchanges: reference.exchanges,
    };
    // Primeiro o disco: se a escrita falhar, nada entra no placar.
    this.journal.append({ at: now, kind: 'submitted', analysis });
    this.analyses.set(analysis.id, analysis);
    this.open.push(openOf(analysis));
    this.rev += 1;
    this.save();
    return { ok: true, analysis };
  }

  /** Chamado a cada leitura do núcleo. */
  tick(pairs: PairState[], now: number): void {
    if (!this.open.length) return;
    const still: OpenAnalysis[] = [];
    let resolved = false;
    for (const item of this.open) {
      const pair = pairs.find((p) => p.pair === item.analysis.pair);
      const reference = pair && referenceOf(pair);
      const next = reference ? observe(item, reference.price, now) : item;
      const result = resolve(next, now);
      if (!result) {
        still.push(next);
        continue;
      }
      this.journal.append({ at: now, kind: 'resolved', result });
      this.results.push(result);
      resolved = true;
    }
    this.open = still;
    if (resolved) {
      this.rev += 1;
      this.save();
    }
  }

  private board() {
    return scoreboard(this.results, this.open.map((o) => ({ model: o.analysis.model, horizon: o.analysis.horizon })));
  }

  state(now: number): AnalysesState {
    return {
      at: now,
      scoreboard: this.board(),
      open: this.open.map((o) => o.analysis),
      recent: this.results.slice(-KEEP_RECENT).reverse().flatMap((result) => {
        const analysis = this.analyses.get(result.id);
        return analysis ? [{ analysis, result }] : [];
      }),
      notice: NOTICE,
    };
  }

  /** O que vai em todo estado do núcleo: pequeno, sem raciocínio nem fatores. */
  brief(): AnalysesBrief {
    const item = (a: Analysis, r?: AnalysisResult): AnalysesBrief['items'][number] => ({
      id: a.id,
      pair: a.pair,
      model: a.model,
      horizon: a.horizon,
      direction: a.direction,
      conviction: a.conviction,
      submittedAt: a.submittedAt,
      expiresAt: a.expiresAt,
      referencePrice: a.referencePrice,
      ...(r ? { result: { status: r.status, hit: r.hit, movePct: r.movePct, resolvedAt: r.resolvedAt, plans: r.plans } } : {}),
    });
    const open = this.open.map((o) => item(o.analysis));
    const done = this.results.slice(-KEEP_BRIEF).reverse().flatMap((r) => {
      const a = this.analyses.get(r.id);
      return a ? [item(a, r)] : [];
    });
    return { scoreboard: this.board(), items: [...open, ...done].slice(0, KEEP_BRIEF) };
  }
}
