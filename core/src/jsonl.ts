// Arquivo JSONL só de acréscimo. Uma queda pode deixar a última linha cortada: a próxima escrita começa em linha nova,
// e a leitura pula o que não consegue entender.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlFile<T> {
  private checkedTail = false;

  constructor(
    private readonly file: string,
    private readonly isValid: (v: unknown) => v is T,
    private readonly onBad: (count: number, file: string) => void = () => {},
  ) {}

  append(entry: T): void {
    const prefix = this.needsNewline() ? '\n' : '';
    appendFileSync(this.file, `${prefix}${JSON.stringify(entry)}\n`);
  }

  readAll(): T[] {
    if (!existsSync(this.file)) return [];
    const entries: T[] = [];
    let bad = 0;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (this.isValid(parsed)) entries.push(parsed);
        else bad += 1;
      } catch {
        bad += 1;
      }
    }
    if (bad) this.onBad(bad, this.file);
    return entries;
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
