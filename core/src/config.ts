// Configuração do núcleo: quais corretoras, quais pares e de quanto em quanto tempo ler. Fica em
// ~/.openspread/config.json (ou no caminho de OPENSPREAD_CONFIG). Nunca guarda chave: campo desconhecido é recusado.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigLimits, CoreConfig } from './types';

export const DEFAULT_CONFIG: Readonly<CoreConfig> = Object.freeze({
  exchanges: ['binance', 'okx', 'bybit', 'kraken', 'coinbaseexchange'],
  pairs: ['USDC/USDT', 'USDE/USDT', 'DAI/USDT', 'FDUSD/USDT'],
  pollMs: 10_000,
});

export const LIMITS: Readonly<ConfigLimits> = Object.freeze({
  minExchanges: 2,
  maxExchanges: 20,
  maxPairs: 20,
  minPollMs: 5_000,
  maxPollMs: 300_000,
});

const FIELDS = new Set(['exchanges', 'pairs', 'pollMs']);
const PAIR = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;

export type Validation = { ok: true; config: CoreConfig } | { ok: false; errors: string[] };

/** Confere e normaliza (ids em minúsculas, pares em maiúsculas, sem repetição). `pollMs` ausente = padrão. */
export function validateConfig(raw: unknown, known: readonly string[]): Validation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['a configuração precisa ser um objeto JSON'] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  const extra = Object.keys(r).filter((k) => !FIELDS.has(k));
  if (extra.length) errors.push(`campo desconhecido: ${extra.join(', ')}`);

  const list = (field: string): string[] | null => {
    const v = r[field];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      errors.push(`"${field}" precisa ser uma lista de textos`);
      return null;
    }
    return v;
  };

  const knownSet = new Set(known);
  const exchanges = [...new Set((list('exchanges') ?? []).map((x) => x.trim().toLowerCase()))];
  const unknown = exchanges.filter((id) => !knownSet.has(id));
  if (unknown.length) errors.push(`corretora desconhecida na CCXT: ${unknown.join(', ')}`);
  if (exchanges.length < LIMITS.minExchanges) errors.push(`escolha pelo menos ${LIMITS.minExchanges} corretoras para comparar`);
  if (exchanges.length > LIMITS.maxExchanges) errors.push(`no máximo ${LIMITS.maxExchanges} corretoras`);

  const pairs = [...new Set((list('pairs') ?? []).map((x) => x.trim().toUpperCase()))];
  const bad = pairs.filter((p) => !PAIR.test(p) || p.split('/')[0] === p.split('/')[1]);
  if (bad.length) errors.push(`par inválido (use o formato BTC/USDT): ${bad.join(', ')}`);
  if (pairs.length < 1) errors.push('escolha pelo menos 1 par');
  if (pairs.length > LIMITS.maxPairs) errors.push(`no máximo ${LIMITS.maxPairs} pares`);

  let pollMs = DEFAULT_CONFIG.pollMs;
  if (r.pollMs !== undefined) {
    const v = r.pollMs;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < LIMITS.minPollMs || v > LIMITS.maxPollMs) {
      errors.push(`"pollMs" precisa ser um inteiro entre ${LIMITS.minPollMs} e ${LIMITS.maxPollMs}`);
    } else pollMs = v;
  }

  return errors.length ? { ok: false, errors } : { ok: true, config: { exchanges, pairs, pollMs } };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSPREAD_CONFIG || join(homedir(), '.openspread', 'config.json');
}

/** Grava num temporário e renomeia, para nunca deixar o arquivo pela metade. */
export function saveConfig(file: string, config: CoreConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Lê o arquivo. Se não existe, cria com o padrão. Se está quebrado ou inválido, registra o motivo e segue com o
 * padrão, sem sobrescrever (o usuário corrige à mão ou pela tela).
 */
export function loadConfig(file: string, known: readonly string[], log: (msg: string) => void = () => {}): CoreConfig {
  const fallback = (): CoreConfig => ({ ...DEFAULT_CONFIG, exchanges: [...DEFAULT_CONFIG.exchanges], pairs: [...DEFAULT_CONFIG.pairs] });
  if (!existsSync(file)) {
    const config = fallback();
    try {
      saveConfig(file, config);
      log(`configuração criada em ${file}`);
    } catch (e) {
      log(`não consegui criar ${file} (${(e as Error).message}); usando o padrão`);
    }
    return config;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log(`${file} não é um JSON válido (${(e as Error).message}); usando o padrão`);
    return fallback();
  }
  const v = validateConfig(raw, known);
  if (!v.ok) {
    for (const err of v.errors) log(`${file}: ${err}`);
    log('usando a configuração padrão até o arquivo ser corrigido');
    return fallback();
  }
  return v.config;
}
