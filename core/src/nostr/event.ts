// Eventos Nostr (NIP-01): id, conferência de assinatura (BIP-340) e npub/note (NIP-19). O núcleo nunca assina:
// quem assina é a extensão do navegador (NIP-07). Chave privada (nsec) é recusada em qualquer entrada.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import type { NostrEvent, UnsignedEvent } from '../types';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Serialização do NIP-01: [0, pubkey, created_at, kind, tags, content], JSON sem espaços. */
export function eventId(e: UnsignedEvent & { pubkey: string }): string {
  const data = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

/** Forma, id e assinatura. Qualquer coisa estranha: false, sem exceção. */
export function verifyEvent(raw: unknown): raw is NostrEvent {
  const e = raw as Partial<NostrEvent> | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.id !== 'string' || !HEX64.test(e.id) || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey) || typeof e.sig !== 'string' || !HEX128.test(e.sig)) return false;
  if (!Number.isInteger(e.created_at) || !Number.isInteger(e.kind) || typeof e.content !== 'string') return false;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  try {
    if (eventId(e as NostrEvent) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

export const isHexKey = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

/** Chave privada colada por engano em qualquer campo: recusa a entrada inteira. */
export function containsSecret(raw: unknown): boolean {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return /nsec1[02-9ac-hj-np-z]{20,}/i.test(text);
}

const encode = (prefix: string, hex: string) => bech32.encode(prefix, bech32.toWords(hexToBytes(hex)), 1000);

export const npubOf = (hex: string): string => encode('npub', hex);
export const noteOf = (id: string): string => encode('note', id);

/** npub → hex. Qualquer outro prefixo (inclusive nsec) dá null. */
export function hexOfNpub(npub: string): string | null {
  try {
    const { prefix, words } = bech32.decode(npub as `${string}1${string}`, 1000);
    if (prefix !== 'npub') return null;
    const hex = bytesToHex(bech32.fromWords(words));
    return HEX64.test(hex) ? hex : null;
  } catch {
    return null;
  }
}
