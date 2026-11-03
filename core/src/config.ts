// Configuração do núcleo: quais corretoras, quais pares e de quanto em quanto tempo ler. Fica em
// ~/.openspread/config.json (ou no caminho de OPENSPREAD_CONFIG). Nunca guarda chave: campo desconhecido é recusado.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeAddress } from './wallets/address';
import type { AgendaImpact, ConfigLimits, CoreConfig, DiscoveryConfig, RadarConfig, SpreadAlert, TransferConfig, UserEvent, WalletChain, WalletRef } from './types';

export const DEFAULT_CONFIG: Readonly<CoreConfig> = Object.freeze({
  exchanges: ['binance', 'okx', 'bybit', 'kraken', 'coinbaseexchange'],
  pairs: ['USDC/USDT', 'USDE/USDT', 'DAI/USDT', 'FDUSD/USDT'],
  pollMs: 10_000,
  alerts: [],
  transfer: { sizeUsd: 1_000, withdrawFees: {} },
  wallets: [],
});

export const LIMITS: Readonly<ConfigLimits> = Object.freeze({
  minExchanges: 2,
  maxExchanges: 20,
  maxPairs: 20,
  minPollMs: 5_000,
  maxPollMs: 300_000,
  maxAlerts: 20,
  minAlertPct: -1,
  maxAlertPct: 10,
  minSizeUsd: 10,
  maxSizeUsd: 10_000_000,
  maxWallets: 30,
  maxDiscoveryTokens: 5,
  maxPerToken: 10,
  maxEvents: 50,
  maxFeeds: 10,
});

const MAX_FEE = 1_000_000;
const MAX_FEE_ENTRIES = 200;
const ASSET = /^[A-Z0-9]{2,12}$/;

const FIELDS = new Set(['exchanges', 'pairs', 'pollMs', 'alerts', 'transfer', 'wallets', 'discovery', 'events', 'radar']);
const EVENT_FIELDS = new Set(['title', 'at', 'impact', 'pairs']);
const RADAR_FIELDS = new Set(['feeds', 'keywords']);
const IMPACTS: readonly AgendaImpact[] = ['high', 'medium', 'low'];
/** Data e hora com fuso explícito (Z ou ±hh:mm): sem fuso, a hora mudaria com o computador. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const WALLET_FIELDS = new Set(['chain', 'address']);
const DISCOVERY_FIELDS = new Set(['tokens', 'perToken']);
const CHAINS: readonly WalletChain[] = ['solana', 'ethereum', 'base', 'bitcoin'];
const TRANSFER_FIELDS = new Set(['sizeUsd', 'withdrawFees']);
const ALERT_FIELDS = new Set(['pair', 'abovePct']);
const PAIR = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;

export type Validation = { ok: true; config: CoreConfig } | { ok: false; errors: string[] };

/** Confere e normaliza (ids em minúsculas, pares em maiúsculas, sem repetição). `pollMs` ausente = padrão; `alerts` ausente = nenhum. */
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

  const alerts: SpreadAlert[] = [];
  if (r.alerts !== undefined) {
    if (!Array.isArray(r.alerts)) errors.push('"alerts" precisa ser uma lista');
    else {
      if (r.alerts.length > LIMITS.maxAlerts) errors.push(`no máximo ${LIMITS.maxAlerts} alertas`);
      for (const item of r.alerts) {
        const a = item as Record<string, unknown> | null;
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          errors.push('cada alerta precisa ser um objeto { pair, abovePct }');
          continue;
        }
        const extraA = Object.keys(a).filter((k) => !ALERT_FIELDS.has(k));
        if (extraA.length) errors.push(`campo desconhecido no alerta: ${extraA.join(', ')}`);
        const pair = typeof a.pair === 'string' ? a.pair.trim().toUpperCase() : '';
        const pct = a.abovePct;
        if (!pairs.includes(pair)) errors.push(`alerta para um par fora da lista: ${pair || '(vazio)'}`);
        else if (alerts.some((x) => x.pair === pair)) errors.push(`só um alerta por par: ${pair}`);
        if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < LIMITS.minAlertPct || pct > LIMITS.maxAlertPct) {
          errors.push(`nível do alerta precisa ser um número entre ${LIMITS.minAlertPct} e ${LIMITS.maxAlertPct} (%)`);
        } else if (pair) alerts.push({ pair, abovePct: pct });
      }
    }
  }

  const transfer = validateTransfer(r.transfer, known, errors);
  const wallets = validateWallets(r.wallets, errors);
  const discovery = validateDiscovery(r.discovery, errors);
  const events = validateEvents(r.events, pairs, errors);
  const radar = validateRadar(r.radar, errors);

  return errors.length
    ? { ok: false, errors }
    : { ok: true, config: { exchanges, pairs, pollMs, alerts, transfer, wallets, ...(discovery ? { discovery } : {}), ...(events ? { events } : {}), ...(radar ? { radar } : {}) } };
}

/** `transfer` ausente = padrão (US$ 1.000, nenhuma taxa). Corretora precisa existir na CCXT; moeda em maiúsculas. */
function validateTransfer(raw: unknown, known: readonly string[], errors: string[]): TransferConfig {
  const out: TransferConfig = { sizeUsd: DEFAULT_CONFIG.transfer.sizeUsd, withdrawFees: {} };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"transfer" precisa ser um objeto { sizeUsd, withdrawFees }');
    return out;
  }
  const t = raw as Record<string, unknown>;
  const extra = Object.keys(t).filter((k) => !TRANSFER_FIELDS.has(k));
  if (extra.length) errors.push(`campo desconhecido em transfer: ${extra.join(', ')}`);
  if (t.sizeUsd !== undefined) {
    const v = t.sizeUsd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < LIMITS.minSizeUsd || v > LIMITS.maxSizeUsd) {
      errors.push(`"transfer.sizeUsd" precisa ser um número entre ${LIMITS.minSizeUsd} e ${LIMITS.maxSizeUsd}`);
    } else out.sizeUsd = v;
  }
  if (t.withdrawFees !== undefined) {
    const fees = t.withdrawFees;
    if (!fees || typeof fees !== 'object' || Array.isArray(fees)) {
      errors.push('"transfer.withdrawFees" precisa ser { corretora: { moeda: taxa } }');
      return out;
    }
    const knownSet = new Set(known);
    let count = 0;
    for (const [rawId, assets] of Object.entries(fees as Record<string, unknown>)) {
      const id = rawId.trim().toLowerCase();
      if (!knownSet.has(id)) errors.push(`corretora desconhecida na CCXT em transfer: ${rawId}`);
      if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
        errors.push(`taxas de ${rawId} precisam ser { moeda: taxa }`);
        continue;
      }
      for (const [rawAsset, fee] of Object.entries(assets as Record<string, unknown>)) {
        const asset = rawAsset.trim().toUpperCase();
        if (!ASSET.test(asset)) errors.push(`moeda inválida em transfer: ${rawAsset}`);
        else if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) errors.push(`taxa de saque inválida para ${rawId} ${rawAsset}: use um número entre 0 e ${MAX_FEE}`);
        else {
          (out.withdrawFees[id] ??= {})[asset] = fee;
          count++;
        }
      }
    }
    if (count > MAX_FEE_ENTRIES) errors.push(`no máximo ${MAX_FEE_ENTRIES} taxas de saque`);
  }
  return out;
}

/** `wallets` ausente = nenhuma. Endereço conferido pelo formato da rede; repetido é recusado. */
function validateWallets(raw: unknown, errors: string[]): WalletRef[] {
  const out: WalletRef[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) {
    errors.push('"wallets" precisa ser uma lista de { chain, address }');
    return out;
  }
  if (raw.length > LIMITS.maxWallets!) errors.push(`no máximo ${LIMITS.maxWallets} carteiras`);
  for (const item of raw) {
    const w = item as Record<string, unknown> | null;
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      errors.push('cada carteira precisa ser um objeto { chain, address }');
      continue;
    }
    const extra = Object.keys(w).filter((k) => !WALLET_FIELDS.has(k));
    if (extra.length) errors.push(`campo desconhecido na carteira: ${extra.join(', ')}`);
    const chain = typeof w.chain === 'string' ? (w.chain.trim().toLowerCase() as WalletChain) : null;
    if (!chain || !CHAINS.includes(chain)) {
      errors.push(`rede desconhecida: ${String(w.chain)} (use ${CHAINS.join(', ')})`);
      continue;
    }
    const address = typeof w.address === 'string' ? normalizeAddress(chain, w.address) : null;
    if (!address) {
      errors.push(`endereço inválido para ${chain}: ${String(w.address).slice(0, 64)}`);
      continue;
    }
    if (out.some((x) => x.chain === chain && x.address === address)) errors.push(`carteira repetida: ${chain} ${address}`);
    else out.push({ chain, address });
  }
  return out;
}

/** `discovery` ausente = desligada. Tokens de Solana, Ethereum ou Base (Bitcoin não tem token). */
function validateDiscovery(raw: unknown, errors: string[]): DiscoveryConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"discovery" precisa ser um objeto { tokens, perToken }');
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => !DISCOVERY_FIELDS.has(k));
  if (extra.length) errors.push(`campo desconhecido em discovery: ${extra.join(', ')}`);
  const perToken = d.perToken ?? 5;
  if (typeof perToken !== 'number' || !Number.isInteger(perToken) || perToken < 1 || perToken > LIMITS.maxPerToken!) {
    errors.push(`"discovery.perToken" precisa ser um inteiro entre 1 e ${LIMITS.maxPerToken}`);
  }
  const tokens: DiscoveryConfig['tokens'] = [];
  if (!Array.isArray(d.tokens)) errors.push('"discovery.tokens" precisa ser uma lista de { chain, address }');
  else {
    if (d.tokens.length > LIMITS.maxDiscoveryTokens!) errors.push(`no máximo ${LIMITS.maxDiscoveryTokens} tokens na descoberta`);
    for (const item of d.tokens) {
      const t = item as Record<string, unknown> | null;
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push('cada token da descoberta precisa ser { chain, address }');
        continue;
      }
      const extraT = Object.keys(t).filter((k) => !WALLET_FIELDS.has(k));
      if (extraT.length) errors.push(`campo desconhecido no token: ${extraT.join(', ')}`);
      const chain = typeof t.chain === 'string' ? t.chain.trim().toLowerCase() : '';
      if (chain !== 'solana' && chain !== 'ethereum' && chain !== 'base') {
        errors.push(`rede sem token para descoberta: ${chain || '(vazio)'}`);
        continue;
      }
      const address = typeof t.address === 'string' ? normalizeAddress(chain, t.address) : null;
      if (!address) errors.push(`endereço de token inválido para ${chain}: ${String(t.address).slice(0, 64)}`);
      else if (!tokens.some((x) => x.chain === chain && x.address === address)) tokens.push({ chain, address });
    }
  }
  return { tokens, perToken: typeof perToken === 'number' ? perToken : 5 };
}

/** `events` ausente = nenhum. Título curto, hora com fuso, impacto e pares da lista (ausente = todas as salas). */
function validateEvents(raw: unknown, pairs: readonly string[], errors: string[]): UserEvent[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push('"events" precisa ser uma lista de { title, at, impact, pairs? }');
    return undefined;
  }
  if (raw.length > LIMITS.maxEvents!) errors.push(`no máximo ${LIMITS.maxEvents} eventos`);
  const out: UserEvent[] = [];
  for (const item of raw) {
    const e = item as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push('cada evento precisa ser um objeto { title, at, impact, pairs? }');
      continue;
    }
    const extra = Object.keys(e).filter((k) => !EVENT_FIELDS.has(k));
    if (extra.length) errors.push(`campo desconhecido no evento: ${extra.join(', ')}`);
    const title = typeof e.title === 'string' ? e.title.replace(/\s+/g, ' ').trim() : '';
    if (title.length < 2 || title.length > 80) errors.push('título do evento precisa ter de 2 a 80 caracteres');
    const at = typeof e.at === 'string' ? e.at.trim() : '';
    if (!ISO_WITH_ZONE.test(at) || !Number.isFinite(Date.parse(at))) errors.push(`hora do evento precisa ser ISO com fuso (ex.: 2026-11-20T14:00:00-03:00): ${String(e.at).slice(0, 40)}`);
    const impact = e.impact as AgendaImpact;
    if (!IMPACTS.includes(impact)) errors.push(`impacto do evento precisa ser ${IMPACTS.join(', ')}`);
    let evPairs: string[] | undefined;
    if (e.pairs !== undefined) {
      if (!Array.isArray(e.pairs) || !e.pairs.every((p) => typeof p === 'string')) errors.push('"pairs" do evento precisa ser uma lista de pares');
      else {
        evPairs = [...new Set(e.pairs.map((p) => p.trim().toUpperCase()))];
        const off = evPairs.filter((p) => !pairs.includes(p));
        if (off.length) errors.push(`evento para um par fora da lista: ${off.join(', ')}`);
      }
    }
    out.push({ title, at, impact, ...(evPairs && evPairs.length ? { pairs: evPairs } : {}) });
  }
  return out;
}

/** Só http(s) e nada da rede local (o núcleo é quem busca: não vira ponte para o roteador ou outra máquina). */
export function feedUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || !host.includes('.') && !host.includes(':')) return null;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1' || /^f[cd]/.test(host) || /^fe80:/.test(host)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** `radar` ausente = desligado. Até 10 feeds e 20 palavras. */
function validateRadar(raw: unknown, errors: string[]): RadarConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"radar" precisa ser um objeto { feeds, keywords }');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !RADAR_FIELDS.has(k));
  if (extra.length) errors.push(`campo desconhecido em radar: ${extra.join(', ')}`);
  const feeds: string[] = [];
  if (!Array.isArray(r.feeds) || !r.feeds.every((x) => typeof x === 'string')) errors.push('"radar.feeds" precisa ser uma lista de endereços');
  else {
    if (r.feeds.length > LIMITS.maxFeeds!) errors.push(`no máximo ${LIMITS.maxFeeds} feeds`);
    for (const f of r.feeds) {
      const u = feedUrl(f);
      if (!u) errors.push(`feed inválido (use um endereço http ou https público): ${f.slice(0, 80)}`);
      else if (!feeds.includes(u)) feeds.push(u);
    }
  }
  const keywords: string[] = [];
  if (r.keywords !== undefined) {
    if (!Array.isArray(r.keywords) || !r.keywords.every((x) => typeof x === 'string')) errors.push('"radar.keywords" precisa ser uma lista de palavras');
    else {
      if (r.keywords.length > 20) errors.push('no máximo 20 palavras no radar');
      for (const k of r.keywords) {
        const w = k.trim().toLowerCase();
        if (w.length < 2 || w.length > 30) errors.push(`palavra do radar precisa ter de 2 a 30 caracteres: ${k.slice(0, 40)}`);
        else if (!keywords.includes(w)) keywords.push(w);
      }
    }
  }
  return { feeds, keywords };
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
  const fallback = (): CoreConfig => ({ ...DEFAULT_CONFIG, exchanges: [...DEFAULT_CONFIG.exchanges], pairs: [...DEFAULT_CONFIG.pairs], alerts: [], transfer: { sizeUsd: DEFAULT_CONFIG.transfer.sizeUsd, withdrawFees: {} }, wallets: [] });
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
