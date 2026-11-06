// Chaves de corretora: só em exchange-keys.json (ao lado do config, fora de qualquer repositório) ou no ambiente. Nunca
// passam por rota, log, estado ou navegador. O valor fica fora do objeto, em #campo privado: só reveal() devolve.
import { existsSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { LIVE_EXCHANGES } from './limits';

export interface CredentialValues {
  apiKey: string;
  secret: string;
  password?: string;
}

export class Credential {
  readonly #values: CredentialValues;

  constructor(values: CredentialValues) {
    this.#values = values;
  }

  /** Só para entregar à corretora. */
  reveal(): CredentialValues {
    return { ...this.#values };
  }

  toJSON(): string {
    return '[chave oculta]';
  }

  toString(): string {
    return '[chave oculta]';
  }

  [inspect.custom](): string {
    return '[chave oculta]';
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function readFile(file: string, log: (m: string) => void): Record<string, Record<string, unknown>> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, Record<string, unknown>>;
  } catch {
    // A mensagem do JSON.parse pode citar um pedaço do arquivo: não repete.
  }
  log(`modo real: ${file} (exchange-keys.json) não é um JSON válido; seguindo sem chaves`);
  return {};
}

export function loadCredentials(file: string, env: NodeJS.ProcessEnv, log: (m: string) => void = () => {}): Map<string, Credential> {
  const fromFile = readFile(file, log);
  const out = new Map<string, Credential>();
  for (const id of Object.keys(fromFile)) if (!LIVE_EXCHANGES.includes(id)) log(`modo real: corretora "${id}" não é aceita nas chaves; ignorada`);
  for (const id of LIVE_EXCHANGES) {
    const prefix = `OPENSPREAD_${id.toUpperCase()}_`;
    const f = fromFile[id] ?? {};
    const apiKey = text(env[`${prefix}API_KEY`]) ?? text(f.apiKey);
    const secret = text(env[`${prefix}SECRET`]) ?? text(f.secret);
    const password = text(env[`${prefix}PASSWORD`]) ?? text(f.password);
    if (!apiKey && !secret && !password) continue;
    if (!apiKey || !secret || (id === 'okx' && !password)) {
      log(`modo real: chave incompleta de ${id}; ignorada`);
      continue;
    }
    out.set(id, new Credential({ apiKey, secret, ...(password ? { password } : {}) }));
  }
  return out;
}
