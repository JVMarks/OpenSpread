// Registro do motor, só de acréscimo: proposta, veredito, ligar e parar, operação, ejeção. Um JSON por linha, ao lado
// do config. Nunca grava chave nem senha. Ideia do trader-broker (github.com/Jakeschincariol/trader-skill, MIT).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const KINDS = ['proposal', 'verdict', 'start', 'stop', 'fill', 'eject'] as const;

export interface LedgerEntry {
  /** Epoch ms. */
  at: number;
  kind: (typeof KINDS)[number];
  botId: string;
  data: unknown;
}

const isEntry = (v: unknown): v is LedgerEntry => {
  const e = v as Partial<LedgerEntry> | null;
  return !!e && typeof e.at === 'number' && typeof e.botId === 'string' && KINDS.includes(e.kind as LedgerEntry['kind']);
};

export class Ledger {
  private checkedTail = false;

  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  append(entry: LedgerEntry): void {
    const prefix = this.needsNewline() ? '\n' : '';
    appendFileSync(this.file, `${prefix}${JSON.stringify(entry)}\n`);
  }

  /** Últimas `limit` entradas, da mais antiga para a mais nova. Linha ilegível é pulada, com aviso. */
  read(limit: number): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    const entries: LedgerEntry[] = [];
    let bad = 0;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) entries.push(parsed);
        else bad += 1;
      } catch {
        bad += 1;
      }
    }
    if (bad) this.log(`registro do motor: ignorei ${bad} linha(s) ilegível(is) em ${this.file}`);
    return entries.slice(-limit);
  }

  /** Na primeira escrita: cria a pasta e vê se uma queda deixou a última linha cortada (a próxima colaria nela). */
  private needsNewline(): boolean {
    if (this.checkedTail) return false;
    this.checkedTail = true;
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) return false;
    const size = statSync(this.file).size;
    if (!size) return false;
    const fd = openSync(this.file, 'r');
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }
}
