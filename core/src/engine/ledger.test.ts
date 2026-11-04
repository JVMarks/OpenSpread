import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type LedgerEntry } from './ledger';

const entry = (at: number, kind: LedgerEntry['kind'] = 'proposal'): LedgerEntry => ({ at, kind, botId: 'bot-1', data: { n: at } });

describe('registro do motor', () => {
  let dir: string;
  let file: string;
  let logs: string[];
  const open = () => new Ledger(file, (m) => logs.push(m));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openspread-ledger-'));
    file = join(dir, 'engine', 'ledger.jsonl');
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cria a pasta que faltar e sem arquivo lê vazio', () => {
    const l = open();
    expect(l.read(5)).toEqual([]);
    l.append(entry(1));
    expect(l.read(5)).toEqual([entry(1)]);
  });

  it('só acrescenta: o que já estava continua igual', () => {
    const l = open();
    l.append(entry(1));
    const first = readFileSync(file, 'utf8');
    l.append(entry(2, 'verdict'));
    const all = readFileSync(file, 'utf8');
    expect(all.startsWith(first)).toBe(true);
    expect(all.trim().split('\n')).toHaveLength(2);
  });

  it('read(n) traz as últimas n, da mais antiga para a mais nova', () => {
    const l = open();
    for (const at of [1, 2, 3]) l.append(entry(at));
    expect(l.read(2).map((e) => e.at)).toEqual([2, 3]);
  });

  it('sobrevive a reabrir o arquivo', () => {
    open().append(entry(1));
    open().append(entry(2));
    expect(open().read(5).map((e) => e.at)).toEqual([1, 2]);
  });

  it('ignora a última linha cortada, com aviso', () => {
    const l = open();
    l.append(entry(1));
    appendFileSync(file, '{"at":2,"kind":"prop');
    expect(l.read(5).map((e) => e.at)).toEqual([1]);
    expect(logs.join()).toContain('1 linha');
  });

  it('depois de uma linha cortada, a próxima entrada não se perde', () => {
    open().append(entry(1));
    appendFileSync(file, '{"at":2,"kind":"prop');
    const reopened = open();
    reopened.append(entry(3));
    expect(reopened.read(5).map((e) => e.at)).toEqual([1, 3]);
  });

  it('ignora linha com formato errado no meio', () => {
    const l = open();
    l.append(entry(1));
    appendFileSync(file, '{"foo":1}\n');
    l.append(entry(2));
    expect(l.read(5).map((e) => e.at)).toEqual([1, 2]);
  });

  it('não falha com arquivo vazio', () => {
    open().append(entry(1));
    writeFileSync(file, '');
    expect(open().read(5)).toEqual([]);
  });
});
