import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG, LIMITS, loadConfig, saveConfig, validateConfig } from './config';

const KNOWN = ['binance', 'okx', 'kraken', 'kucoin'];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'openspread-'));
  dirs.push(d);
  return join(d, 'sub', 'config.json');
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('validateConfig', () => {
  it('normaliza: ids em minúsculas, pares em maiúsculas, sem repetição; pollMs ausente = padrão', () => {
    const v = validateConfig({ exchanges: [' Binance', 'okx', 'binance'], pairs: ['btc/usdt', 'BTC/USDT', 'eth/usdt'] }, KNOWN);
    expect(v).toEqual({ ok: true, config: { exchanges: ['binance', 'okx'], pairs: ['BTC/USDT', 'ETH/USDT'], pollMs: DEFAULT_CONFIG.pollMs, alerts: [] } });
  });

  it('recusa corretora desconhecida, par fora do formato e moeda repetida', () => {
    const v = validateConfig({ exchanges: ['binance', 'fakex'], pairs: ['BTCUSDT', 'USDT/USDT', 'B/USDT'] }, KNOWN);
    expect(v.ok).toBe(false);
    const errors = (v as { errors: string[] }).errors.join('\n');
    expect(errors).toContain('fakex');
    expect(errors).toContain('BTCUSDT');
    expect(errors).toContain('USDT/USDT');
    expect(errors).toContain('B/USDT');
  });

  it('recusa campo desconhecido (nada de chave de API por aqui)', () => {
    const v = validateConfig({ exchanges: ['binance', 'okx'], pairs: ['BTC/USDT'], apiKey: 'x' }, KNOWN);
    expect(v.ok).toBe(false);
    expect((v as { errors: string[] }).errors.join()).toContain('apiKey');
  });

  it('limites: pelo menos 2 corretoras, pelo menos 1 par, intervalo dentro da faixa', () => {
    expect(validateConfig({ exchanges: ['binance'], pairs: ['BTC/USDT'] }, KNOWN).ok).toBe(false);
    expect(validateConfig({ exchanges: ['binance', 'okx'], pairs: [] }, KNOWN).ok).toBe(false);
    expect(validateConfig({ exchanges: ['binance', 'okx'], pairs: ['BTC/USDT'], pollMs: LIMITS.minPollMs - 1 }, KNOWN).ok).toBe(false);
    expect(validateConfig({ exchanges: ['binance', 'okx'], pairs: ['BTC/USDT'], pollMs: 1.5e4 + 0.5 }, KNOWN).ok).toBe(false);
    const many = Array.from({ length: LIMITS.maxPairs + 1 }, (_, i) => `C${i}X/USDT`);
    expect(validateConfig({ exchanges: ['binance', 'okx'], pairs: many }, KNOWN).ok).toBe(false);
  });

  it('alertas: normaliza o par, um por par, só pares da lista, nível na faixa, sem campo extra', () => {
    const base = { exchanges: ['binance', 'okx'], pairs: ['BTC/USDT', 'USDC/USDT'] };
    expect(validateConfig({ ...base, alerts: [{ pair: 'btc/usdt', abovePct: 0.05 }] }, KNOWN)).toMatchObject({ ok: true, config: { alerts: [{ pair: 'BTC/USDT', abovePct: 0.05 }] } });
    const bad = (alerts: unknown) => (validateConfig({ ...base, alerts }, KNOWN) as { ok: boolean; errors?: string[] });
    expect(bad([{ pair: 'ETH/USDT', abovePct: 0.1 }]).errors!.join()).toContain('fora da lista');
    expect(bad([{ pair: 'BTC/USDT', abovePct: 0.1 }, { pair: 'BTC/USDT', abovePct: 0.2 }]).errors!.join()).toContain('um alerta por par');
    expect(bad([{ pair: 'BTC/USDT', abovePct: 50 }]).ok).toBe(false);
    expect(bad([{ pair: 'BTC/USDT', abovePct: '0.1' }]).ok).toBe(false);
    expect(bad([{ pair: 'BTC/USDT', abovePct: 0.1, apiKey: 'x' }]).errors!.join()).toContain('apiKey');
    expect(bad('x').ok).toBe(false);
  });

  it('recusa o que não é objeto ou lista de textos', () => {
    expect(validateConfig(null, KNOWN).ok).toBe(false);
    expect(validateConfig([], KNOWN).ok).toBe(false);
    expect(validateConfig({ exchanges: 'binance', pairs: ['BTC/USDT'] }, KNOWN).ok).toBe(false);
    expect(validateConfig({ exchanges: ['binance', 2], pairs: ['BTC/USDT'] }, KNOWN).ok).toBe(false);
  });
});

describe('arquivo de configuração', () => {
  it('OPENSPREAD_CONFIG muda o caminho; sem ela, fica na pasta do usuário', () => {
    expect(configPath({ OPENSPREAD_CONFIG: '/x/y.json' })).toBe('/x/y.json');
    expect(configPath({})).toMatch(/\.openspread[\\/]config\.json$/);
  });

  it('sem arquivo: cria com o padrão (inclusive a pasta)', () => {
    const file = tmp();
    const logs: string[] = [];
    const c = loadConfig(file, [...DEFAULT_CONFIG.exchanges], (m) => logs.push(m));
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_CONFIG);
    expect(logs.join()).toContain('criada');
  });

  it('salva e lê de volta; não sobra temporário', () => {
    const file = tmp();
    saveConfig(file, { exchanges: ['binance', 'kucoin'], pairs: ['BTC/USDT'], pollMs: 15_000, alerts: [{ pair: 'BTC/USDT', abovePct: 0.05 }] });
    expect(loadConfig(file, KNOWN)).toEqual({ exchanges: ['binance', 'kucoin'], pairs: ['BTC/USDT'], pollMs: 15_000, alerts: [{ pair: 'BTC/USDT', abovePct: 0.05 }] });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('JSON quebrado ou inválido: avisa e usa o padrão, sem sobrescrever o arquivo', () => {
    const file = tmp();
    saveConfig(file, DEFAULT_CONFIG);
    writeFileSync(file, '{ "exchanges": [', 'utf8');
    const logs: string[] = [];
    expect(loadConfig(file, KNOWN, (m) => logs.push(m))).toEqual(DEFAULT_CONFIG);
    expect(readFileSync(file, 'utf8')).toBe('{ "exchanges": [');
    writeFileSync(file, JSON.stringify({ exchanges: ['fakex', 'okx'], pairs: ['BTC/USDT'] }), 'utf8');
    logs.length = 0;
    expect(loadConfig(file, KNOWN, (m) => logs.push(m))).toEqual(DEFAULT_CONFIG);
    expect(logs.join()).toContain('fakex');
  });
});
