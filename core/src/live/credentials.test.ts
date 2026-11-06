import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials } from './credentials';

const SECRET = 'segredo-plantado-123456';
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keys-'));
  file = join(dir, 'exchange-keys.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const log = () => {
  const lines: string[] = [];
  return { lines, fn: (m: string) => lines.push(m) };
};

describe('loadCredentials', () => {
  it('arquivo ausente: nenhuma chave', () => {
    expect(loadCredentials(file, {}).size).toBe(0);
  });
  it('lê do arquivo e devolve os valores só por reveal()', () => {
    writeFileSync(file, JSON.stringify({ binance: { apiKey: 'chave-publica', secret: SECRET } }));
    const c = loadCredentials(file, {}).get('binance');
    expect(c?.reveal()).toEqual({ apiKey: 'chave-publica', secret: SECRET });
  });
  it('o ambiente vence o arquivo', () => {
    writeFileSync(file, JSON.stringify({ okx: { apiKey: 'a', secret: 'b', password: 'c' } }));
    const c = loadCredentials(file, { OPENSPREAD_OKX_API_KEY: 'x', OPENSPREAD_OKX_SECRET: 'y', OPENSPREAD_OKX_PASSWORD: 'z' }).get('okx');
    expect(c?.reveal()).toEqual({ apiKey: 'x', secret: 'y', password: 'z' });
  });
  it('a chave não aparece em JSON, String, inspect nem no objeto', () => {
    writeFileSync(file, JSON.stringify({ binance: { apiKey: 'k', secret: SECRET } }));
    const c = loadCredentials(file, {}).get('binance');
    for (const text of [JSON.stringify(c), String(c), inspect(c, { depth: 5, showHidden: true }), JSON.stringify({ c }), `${c}`]) expect(text).not.toContain(SECRET);
    expect(Object.values(c as object).join()).not.toContain(SECRET);
  });
  it('JSON quebrado: nada carregado, e o log não repete o conteúdo', () => {
    writeFileSync(file, `{ "binance": { "secret": "${SECRET}" `);
    const l = log();
    expect(loadCredentials(file, {}, l.fn).size).toBe(0);
    expect(l.lines.join()).toContain('exchange-keys.json');
    expect(l.lines.join()).not.toContain(SECRET);
  });
  it('corretora fora da lista e chave incompleta são ignoradas, com aviso sem o valor', () => {
    writeFileSync(file, JSON.stringify({ kraken: { apiKey: 'k', secret: SECRET }, bybit: { apiKey: 'k' } }));
    const l = log();
    expect(loadCredentials(file, {}, l.fn).size).toBe(0);
    expect(l.lines.join()).toContain('kraken');
    expect(l.lines.join()).toContain('bybit');
    expect(l.lines.join()).not.toContain(SECRET);
  });
  it('OKX exige a senha da chave', () => {
    writeFileSync(file, JSON.stringify({ okx: { apiKey: 'k', secret: SECRET } }));
    expect(loadCredentials(file, {}).has('okx')).toBe(false);
  });
});
