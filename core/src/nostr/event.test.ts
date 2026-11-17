import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { containsSecret, eventId, hexOfNpub, isHexKey, noteOf, npubOf, verifyEvent } from './event';
import type { NostrEvent, UnsignedEvent } from '../types';

/** O que a extensão faria: assina com a chave dela. Só nos testes. */
export function signForTest(e: UnsignedEvent, sk = schnorr.utils.randomSecretKey()): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = eventId({ ...e, pubkey });
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
const NOTE: UnsignedEvent = { kind: 1, created_at: 1_763_000_000, tags: [['t', 'openspread']], content: 'olá, "relay" \n ✓' };

describe('eventId', () => {
  it('é o sha256 da serialização do NIP-01, sem espaços', () => {
    const pubkey = 'a'.repeat(64);
    const expected = bytesToHex(sha256(new TextEncoder().encode(`[0,"${pubkey}",1763000000,1,[["t","openspread"]],"olá, \\"relay\\" \\n ✓"]`)));
    expect(eventId({ ...NOTE, pubkey })).toBe(expected);
  });
});

describe('verifyEvent', () => {
  it('evento assinado passa', () => {
    expect(verifyEvent(signForTest(NOTE))).toBe(true);
  });
  it('conteúdo, tag, data ou autor trocados depois de assinar recusam', () => {
    const e = signForTest(NOTE);
    expect(verifyEvent({ ...e, content: `${e.content}!` })).toBe(false);
    expect(verifyEvent({ ...e, tags: [] })).toBe(false);
    expect(verifyEvent({ ...e, created_at: e.created_at + 1 })).toBe(false);
    expect(verifyEvent({ ...e, pubkey: signForTest(NOTE).pubkey })).toBe(false);
  });
  it('id certo com assinatura de outra chave recusa', () => {
    const e = signForTest(NOTE);
    const other = signForTest({ ...NOTE, content: 'x' });
    expect(verifyEvent({ ...e, sig: other.sig })).toBe(false);
  });
  it('forma estranha recusa sem exceção', () => {
    for (const raw of [null, 'x', 1, {}, { ...signForTest(NOTE), tags: [[1]] }, { ...signForTest(NOTE), sig: 'zz' }, { ...signForTest(NOTE), kind: 1.5 }]) expect(verifyEvent(raw)).toBe(false);
  });
});

describe('npub e note', () => {
  it('npub vai e volta', () => {
    const hex = signForTest(NOTE).pubkey;
    const npub = npubOf(hex);
    expect(npub.startsWith('npub1')).toBe(true);
    expect(hexOfNpub(npub)).toBe(hex);
  });
  it('vetor do NIP-19', () => {
    expect(npubOf('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')).toBe('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');
    expect(noteOf('a'.repeat(64)).startsWith('note1')).toBe(true);
  });
  it('nsec nunca vira chave pública', () => {
    expect(hexOfNpub('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')).toBeNull();
    expect(hexOfNpub('qualquer coisa')).toBeNull();
  });
  it('nsec em qualquer entrada é detectado', () => {
    expect(containsSecret({ pubkey: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5' })).toBe(true);
    expect(containsSecret('minha chave NSEC1VL029MGPSPEDVA04G90VLTKH6FVH240ZQTV9K0T9AF8935KE9LAQSNLFE5')).toBe(true);
    expect(containsSecret({ pubkey: 'a'.repeat(64) })).toBe(false);
  });
  it('isHexKey só aceita 64 hex minúsculos', () => {
    expect(isHexKey('a'.repeat(64))).toBe(true);
    expect(isHexKey('A'.repeat(64))).toBe(false);
    expect(isHexKey('a'.repeat(63))).toBe(false);
  });
});
