// Aprovação com passkey (WebAuthn, ES256), só com node:crypto. O desafio assinado é o da ficha: a aprovação de uma ordem
// não serve para outra. Registro: chave pública SPKI vinda de getPublicKey(), sem atestado (o dono é quem registra).
// Limite: isto impede aprovar com um simples pedido HTTP. Um agente com shell livre ainda pode ler o arquivo de chaves.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export interface StoredPasskey {
  credentialId: string;
  /** SPKI em base64url. */
  publicKey: string;
  counter: number;
}

export const b64url = (b: Buffer): string => b.toString('base64url');
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
/** rpIdHash (32) + flags (1) + contador (4). */
const MIN_AUTH_DATA = 37;
const ES256 = -7;

export type VerifyResult = { ok: true; counter: number } | { ok: false; reason: string };

function clientData(raw: unknown): { type?: unknown; challenge?: unknown; origin?: unknown } | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as { type?: unknown }) : null;
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** O texto que o navegador recebeu como desafio (antes do base64url). */
  challenge: string;
  origins: readonly string[];
  rpId: string;
}

export function verifyAssertion(stored: StoredPasskey, raw: unknown, opts: VerifyOptions): VerifyResult {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (typeof a !== 'object') return { ok: false, reason: 'format' };
  if (a.credentialId !== stored.credentialId) return { ok: false, reason: 'credential' };
  const client = clientData(a.clientDataJSON);
  if (!client || typeof a.authenticatorData !== 'string' || typeof a.signature !== 'string') return { ok: false, reason: 'format' };
  if (client.type !== 'webauthn.get') return { ok: false, reason: 'type' };
  if (client.challenge !== b64url(Buffer.from(opts.challenge))) return { ok: false, reason: 'challenge' };
  if (typeof client.origin !== 'string' || !opts.origins.includes(client.origin)) return { ok: false, reason: 'origin' };

  const auth = Buffer.from(a.authenticatorData, 'base64url');
  if (auth.length < MIN_AUTH_DATA) return { ok: false, reason: 'format' };
  if (!auth.subarray(0, 32).equals(sha256(opts.rpId))) return { ok: false, reason: 'rpId' };
  const flags = auth[32];
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) return { ok: false, reason: 'userVerified' };
  const counter = auth.readUInt32BE(33);
  // Há autenticadores sem contador (sempre 0). Com contador, ele só sobe: repetir é sinal de cópia.
  if ((counter !== 0 || stored.counter !== 0) && counter <= stored.counter) return { ok: false, reason: 'counter' };

  try {
    const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' });
    const signed = Buffer.concat([auth, sha256(Buffer.from(a.clientDataJSON as string, 'base64url'))]);
    if (!cryptoVerify('sha256', signed, key, Buffer.from(a.signature, 'base64url'))) return { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, counter };
}

export function registerPasskey(raw: unknown, opts: { challenge: string; origins: readonly string[] }): { ok: true; passkey: StoredPasskey } | { ok: false; reason: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r !== 'object' || typeof r.credentialId !== 'string' || !r.credentialId || typeof r.publicKey !== 'string') return { ok: false, reason: 'format' };
  if (r.algorithm !== ES256) return { ok: false, reason: 'algorithm' };
  const client = clientData(r.clientDataJSON);
  if (!client || client.type !== 'webauthn.create') return { ok: false, reason: 'type' };
  if (client.challenge !== b64url(Buffer.from(opts.challenge))) return { ok: false, reason: 'challenge' };
  if (typeof client.origin !== 'string' || !opts.origins.includes(client.origin)) return { ok: false, reason: 'origin' };
  try {
    createPublicKey({ key: Buffer.from(r.publicKey, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: 'key' };
  }
  return { ok: true, passkey: { credentialId: r.credentialId, publicKey: r.publicKey, counter: 0 } };
}
