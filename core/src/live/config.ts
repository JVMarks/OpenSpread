// Chave geral do modo real. Precisa de OPENSPREAD_LIVE=1 no ambiente E de live.json editado à mão: nenhuma rota lê ou
// grava este arquivo, e o MCP não fala com ele. Qualquer dúvida desliga: nunca assume que está tudo bem.
import { existsSync, readFileSync } from 'node:fs';
import { HARD_LIMITS, LIVE_EXCHANGES } from './limits';

export interface LiveRoute {
  pair: string;
  exchanges: [string, string];
}

export interface LiveConfig {
  /** true = ambiente de teste das corretoras; false = dinheiro real. Precisa ser dito. */
  sandbox: boolean;
  routes: LiveRoute[];
  maxTradeUsd: number;
  minNetPct: number;
  maxQuoteAgeMs: number;
  dailyLossLimitUsd: number;
  tradesPerDay: number;
  maxSlippagePct: number;
}

const FIELDS = new Set(['sandbox', 'routes', 'maxTradeUsd', 'minNetPct', 'maxQuoteAgeMs', 'dailyLossLimitUsd', 'tradesPerDay', 'maxSlippagePct']);
const PAIR = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateLive(raw: unknown): { ok: true; config: LiveConfig } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['live.json precisa ser um objeto'] };
  const r = raw as Record<string, unknown>;
  const errors = Object.keys(r).filter((k) => !FIELDS.has(k)).map((k) => `campo desconhecido "${k}"`);
  if (typeof r.sandbox !== 'boolean') errors.push('"sandbox" precisa ser true (ambiente de teste) ou false (dinheiro real)');
  const capped = (name: string, cap: number) => {
    const v = r[name];
    if (!isNumber(v) || v <= 0 || v > cap) errors.push(`"${name}" precisa ficar entre 0 e ${cap} (teto do código)`);
  };
  capped('maxTradeUsd', HARD_LIMITS.maxTradeUsd);
  capped('dailyLossLimitUsd', HARD_LIMITS.dailyLossLimitUsd);
  capped('maxSlippagePct', HARD_LIMITS.maxSlippagePct);
  if (!Number.isInteger(r.tradesPerDay) || (r.tradesPerDay as number) < 1 || (r.tradesPerDay as number) > HARD_LIMITS.tradesPerDay) errors.push(`"tradesPerDay" precisa ser um inteiro de 1 a ${HARD_LIMITS.tradesPerDay} (teto do código)`);
  if (!isNumber(r.minNetPct) || r.minNetPct < 0) errors.push('"minNetPct" não pode ser negativo');
  if (!isNumber(r.maxQuoteAgeMs) || r.maxQuoteAgeMs <= 0) errors.push('"maxQuoteAgeMs" precisa ser positivo');

  if (!Array.isArray(r.routes) || !r.routes.length) errors.push('"routes" precisa de ao menos uma rota');
  else {
    for (const route of r.routes as Array<{ pair?: unknown; exchanges?: unknown }>) {
      const pair = route?.pair;
      if (typeof pair !== 'string' || !PAIR.test(pair)) errors.push(`rota com par inválido: ${String(pair)}`);
      const ex = route?.exchanges;
      if (!Array.isArray(ex) || ex.length !== 2) {
        errors.push(`rota ${String(pair)}: precisa de duas corretoras`);
        continue;
      }
      for (const id of ex) if (!LIVE_EXCHANGES.includes(id as string)) errors.push(`rota ${String(pair)}: "${String(id)}" não é aceita (use ${LIVE_EXCHANGES.join(', ')})`);
      if (ex[0] === ex[1]) errors.push(`rota ${String(pair)}: as corretoras precisam ser diferentes`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: r as unknown as LiveConfig };
}

export function loadLiveConfig(file: string, env: NodeJS.ProcessEnv): LiveConfig | { off: string } {
  if (env.OPENSPREAD_LIVE !== '1') return { off: 'Modo real desligado: falta OPENSPREAD_LIVE=1 no ambiente.' };
  if (!existsSync(file)) return { off: `Modo real desligado: falta o arquivo ${file} (live.json), editado à mão.` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { off: `Modo real desligado: live.json não é um JSON válido (${(e as Error).message}).` };
  }
  const v = validateLive(raw);
  return v.ok ? v.config : { off: `Modo real desligado: ${v.errors.join('; ')}.` };
}
