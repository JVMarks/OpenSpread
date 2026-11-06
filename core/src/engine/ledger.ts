// Registro do motor, só de acréscimo: proposta, veredito, ligar e parar, operação, ejeção. Um JSON por linha, ao lado
// do config. Nunca grava chave nem senha. Ideia do trader-broker (github.com/Jakeschincariol/trader-skill, MIT).
import { JsonlFile } from '../jsonl';

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
  private readonly jsonl: JsonlFile<LedgerEntry>;

  constructor(file: string, log: (msg: string) => void = () => {}) {
    this.jsonl = new JsonlFile(file, isEntry, (bad, f) => log(`registro do motor: ignorei ${bad} linha(s) ilegível(is) em ${f}`));
  }

  append(entry: LedgerEntry): void {
    this.jsonl.append(entry);
  }

  /** Últimas `limit` entradas, da mais antiga para a mais nova. Linha ilegível é pulada, com aviso. */
  read(limit: number): LedgerEntry[] {
    return this.jsonl.readAll().slice(-limit);
  }
}
