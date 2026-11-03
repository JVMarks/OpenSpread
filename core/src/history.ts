// Histórico do melhor spread líquido por par (item 9: "painel de spread por par em janelas de tempo", ideia do Forex
// Factory). Uma amostra por minuto (a última leitura do minuto), 25 h guardadas, salvas em disco para sobreviver a um
// reinício. Calcula, para 5 min, 1 h e 24 h, quanto o líquido mudou e o mínimo e o máximo na janela. Puro, exceto
// load/save (arquivo).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectiveNet } from './transfer';
import type { PairState, SpreadWindowId, SpreadWindows } from './types';

export const WINDOWS: Readonly<Record<SpreadWindowId, number>> = { '5m': 5 * 60_000, '1h': 3_600_000, '24h': 86_400_000 };
/** Quanto guardar (um pouco mais que a maior janela). */
export const KEEP_MS = 25 * 3_600_000;
const MINUTE = 60_000;
/** Uma janela só vale se a amostra mais antiga cobrir pelo menos esta fração dela (evita "24 h" com 10 min de dados). */
const MIN_COVER = 0.9;

type Sample = { at: number; net: number };

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export class SpreadHistory {
  private series = new Map<string, Sample[]>();

  /** Guarda o líquido efetivo de cada par (uma amostra por minuto: a última leitura do minuto vale). */
  record(pairs: readonly PairState[], at: number): void {
    for (const p of pairs) {
      if (!p.best) continue;
      const net = effectiveNet(p.best);
      const list = this.series.get(p.pair) ?? [];
      const last = list[list.length - 1];
      if (last && Math.floor(last.at / MINUTE) === Math.floor(at / MINUTE)) list[list.length - 1] = { at, net };
      else list.push({ at, net });
      while (list.length && at - list[0].at > KEEP_MS) list.shift();
      this.series.set(p.pair, list);
    }
  }

  /** Janelas de um par no instante `at`, comparando o líquido de agora com o de `w` atrás. */
  windows(pair: string, at: number): SpreadWindows {
    const list = this.series.get(pair) ?? [];
    const now = list[list.length - 1];
    const out = {} as SpreadWindows;
    for (const [id, ms] of Object.entries(WINDOWS) as Array<[SpreadWindowId, number]>) {
      if (!now || !list.length || at - list[0].at < ms * MIN_COVER) {
        out[id] = null;
        continue;
      }
      // amostra mais próxima de `at - ms` (sem passar para depois dela, se houver uma antes)
      const target = at - ms;
      let past = list[0];
      for (const s of list) {
        if (s.at > target) break;
        past = s;
      }
      let min = Infinity;
      let max = -Infinity;
      for (const s of list) {
        if (s.at < target) continue;
        min = Math.min(min, s.net);
        max = Math.max(max, s.net);
      }
      out[id] = { changePp: round4(now.net - past.net), min: round4(Math.min(min, past.net)), max: round4(Math.max(max, past.net)) };
    }
    return out;
  }

  /** Os pares com `windows` preenchido (não muda o resto do estado). */
  apply(pairs: readonly PairState[], at: number): PairState[] {
    return pairs.map((p) => ({ ...p, windows: this.windows(p.pair, at) }));
  }

  /** Lê o histórico salvo; arquivo ausente ou quebrado = começa vazio. Descarta o que passou de KEEP_MS. */
  load(file: string, now: number): void {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Sample[]>;
      for (const [pair, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        const ok = list.filter((s) => s && Number.isFinite(s.at) && Number.isFinite(s.net) && now - s.at <= KEEP_MS).sort((a, b) => a.at - b.at);
        if (ok.length) this.series.set(pair, ok);
      }
    } catch {
      // histórico é só conveniência: arquivo quebrado não impede o núcleo de subir
    }
  }

  /** Grava num temporário e renomeia (nunca deixa o arquivo pela metade). */
  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.series)), 'utf8');
    renameSync(tmp, file);
  }
}
