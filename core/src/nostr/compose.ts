// A nota pública de uma análise e a resposta com o resultado (NIP-10). Decisão do diretor (17/11/2026): sem entrada,
// stop e alvos, que leem como ordem operacional; sempre com o aviso. Texto legível em qualquer cliente Nostr (kind 1).
import type { Analysis, AnalysisResult, UnsignedEvent } from '../types';

export type NoteLocale = 'pt-BR' | 'en';
export const MAX_CONTENT = 4_000;

const TEXT = {
  'pt-BR': {
    analysis: 'Análise',
    up: 'alta',
    down: 'baixa',
    direction: 'Direção',
    conviction: 'convicção',
    factors: 'Fatores',
    categories: { technical: 'técnico', derivatives: 'derivativos', macro: 'macro', sentiment: 'sentimento', onchain: 'on-chain', spread: 'spread' },
    reasoning: 'Raciocínio',
    registered: (when: string, ref: string, ends: string) => `Registrada no OpenSpread em ${when} UTC, referência ${ref}. Resultado em ${ends} UTC.`,
    chart: 'Usou print de gráfico.',
    notice: 'Registro pessoal, não é recomendação.',
    cut: '(cortado)',
    result: 'Resultado',
    hit: 'acertou',
    miss: 'errou',
    void: 'sem dados: sem preço até 15 min depois do vencimento',
    closed: (price: string, move: string) => `fechou em ${price} (${move} sobre a referência)`,
    checked: 'Conferido pelo OpenSpread com a mediana das corretoras. Empate conta como erro.',
  },
  en: {
    analysis: 'Analysis',
    up: 'up',
    down: 'down',
    direction: 'Direction',
    conviction: 'conviction',
    factors: 'Factors',
    categories: { technical: 'technical', derivatives: 'derivatives', macro: 'macro', sentiment: 'sentiment', onchain: 'on-chain', spread: 'spread' },
    reasoning: 'Reasoning',
    registered: (when: string, ref: string, ends: string) => `Recorded in OpenSpread at ${when} UTC, reference ${ref}. Result at ${ends} UTC.`,
    chart: 'Used a chart screenshot.',
    notice: 'Personal record, not a recommendation.',
    cut: '(cut)',
    result: 'Result',
    hit: 'right',
    miss: 'wrong',
    void: 'no data: no price within 15 min of expiry',
    closed: (price: string, move: string) => `closed at ${price} (${move} from the reference)`,
    checked: 'Checked by OpenSpread against the median of the exchanges. A tie counts as a miss.',
  },
} as const;

const EFFECT = { supports: '+', neutral: '=', weakens: '−' } as const;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const hashtag = (pair: string) => pair.replace('/', '').toLowerCase();
const price = (n: number, locale: NoteLocale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(n);
const pct = (n: number, locale: NoteLocale) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))}%`;

/** Corta o raciocínio, nunca o aviso nem as linhas fixas. */
function fit(head: string, reasoning: string, tail: string, cut: string): string {
  const room = MAX_CONTENT - head.length - tail.length;
  const body = reasoning.length <= room ? reasoning : `${reasoning.slice(0, Math.max(0, room - cut.length - 2))}… ${cut}`;
  return `${head}${body}${tail}`;
}

export function analysisNote(a: Analysis, locale: NoteLocale, now: number): UnsignedEvent {
  const t = TEXT[locale];
  const factors = a.factors.map((f) => `${EFFECT[f.effect]} ${f.name} (${t.categories[f.category]})`).join('\n');
  const head = [
    `${t.analysis} ${a.pair} · ${a.horizon}`,
    `${t.direction}: ${a.direction === 'up' ? t.up : t.down} · ${t.conviction} ${a.conviction}%`,
    '',
    `${t.factors}:`,
    factors,
    '',
    `${t.reasoning}: `,
  ].join('\n');
  const tail = [
    '',
    '',
    t.registered(utc(a.submittedAt), price(a.referencePrice, locale), utc(a.expiresAt)),
    ...(a.usedChart ? [t.chart] : []),
    t.notice,
    `#openspread #${hashtag(a.pair)}`,
  ].join('\n');
  return {
    kind: 1,
    created_at: Math.floor(now / 1000),
    tags: [['t', 'openspread'], ['t', hashtag(a.pair)], ['openspread', 'analysis', a.id]],
    content: fit(head, a.reasoning, tail, t.cut),
  };
}

/** Resposta na thread da análise publicada. Análise sem resultado não tem resposta. */
export function resultReply(a: Analysis, r: AnalysisResult | undefined, rootId: string, rootPubkey: string, locale: NoteLocale, now: number): UnsignedEvent | null {
  if (!r || r.id !== a.id) return null;
  const t = TEXT[locale];
  const verdict = r.status === 'void' ? t.void : `${r.hit ? t.hit : t.miss}, ${t.closed(price(r.closePrice ?? 0, locale), pct(r.movePct ?? 0, locale))}`;
  return {
    kind: 1,
    created_at: Math.floor(now / 1000),
    tags: [['e', rootId, '', 'root', rootPubkey], ['p', rootPubkey], ['t', 'openspread'], ['openspread', 'result', a.id]],
    content: [`${t.result} ${a.pair} · ${a.horizon}: ${verdict}.`, t.checked, t.notice].join('\n'),
  };
}
