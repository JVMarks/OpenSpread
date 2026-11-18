import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64url, registerPasskey, verifyAssertion, type StoredPasskey } from './passkey';

const ORIGIN = 'http://localhost:5173';
const RP = 'localhost';
const CHALLENGE = 'desafio-da-ficha';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const json = (o: object) => Buffer.from(JSON.stringify(o));

function assertion(over: { challenge?: string; origin?: string; type?: string; rp?: string; flags?: number; counter?: number; key?: typeof privateKey; id?: string } = {}) {
  const clientData = json({ type: over.type ?? 'webauthn.get', challenge: b64url(Buffer.from(over.challenge ?? CHALLENGE)), origin: over.origin ?? ORIGIN });
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(over.counter ?? 5);
  const authData = Buffer.concat([sha(over.rp ?? RP), Buffer.from([over.flags ?? 0x05]), counter]);
  const signature = createSign('sha256').update(authData).update(sha(clientData)).sign(over.key ?? privateKey);
  return { credentialId: over.id ?? 'cred', clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature) };
}
const stored = (counter = 1): StoredPasskey => ({ credentialId: 'cred', publicKey: b64url(spki), counter });
const reason = (r: ReturnType<typeof verifyAssertion>) => (r.ok ? 'ok' : r.reason);
const opts = { challenge: CHALLENGE, origins: [ORIGIN], rpId: RP };

describe('verifyAssertion', () => {
  it('assinatura válida passa e devolve o contador novo', () => {
    expect(verifyAssertion(stored(), assertion(), opts)).toEqual({ ok: true, counter: 5 });
  });
  it('outro desafio recusa: aprovação de uma ficha não serve para outra', () => {
    expect(reason(verifyAssertion(stored(), assertion({ challenge: 'outra' }), opts))).toBe('challenge');
  });
  it('origem errada recusa', () => {
    expect(reason(verifyAssertion(stored(), assertion({ origin: 'https://evil.example' }), opts))).toBe('origin');
  });
  it('tipo errado recusa', () => {
    expect(reason(verifyAssertion(stored(), assertion({ type: 'webauthn.create' }), opts))).toBe('type');
  });
  it('rpId errado recusa', () => {
    expect(reason(verifyAssertion(stored(), assertion({ rp: 'evil.example' }), opts))).toBe('rpId');
  });
  it('sem presença ou sem verificação do usuário recusa', () => {
    expect(reason(verifyAssertion(stored(), assertion({ flags: 0x01 }), opts))).toBe('userVerified');
    expect(reason(verifyAssertion(stored(), assertion({ flags: 0x04 }), opts))).toBe('userVerified');
  });
  it('contador que volta ou repete recusa; contador 0 nos dois lados é aceito (há autenticadores sem contador)', () => {
    expect(reason(verifyAssertion(stored(5), assertion({ counter: 5 }), opts))).toBe('counter');
    expect(reason(verifyAssertion(stored(9), assertion({ counter: 5 }), opts))).toBe('counter');
    expect(verifyAssertion(stored(0), assertion({ counter: 0 }), opts).ok).toBe(true);
  });
  it('outra chave recusa', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(reason(verifyAssertion(stored(), assertion({ key: other }), opts))).toBe('signature');
  });
  it('credencial errada recusa', () => {
    expect(reason(verifyAssertion(stored(), assertion({ id: 'outra' }), opts))).toBe('credential');
  });
  it('entrada quebrada recusa, sem exceção', () => {
    for (const raw of [null, {}, 'x', { credentialId: 'cred', clientDataJSON: '###', authenticatorData: 'a', signature: 'b' }]) expect(verifyAssertion(stored(), raw, opts).ok).toBe(false);
  });
});

describe('registerPasskey', () => {
  const reg = (over: { challenge?: string; origin?: string; type?: string; alg?: number; key?: string } = {}) => ({
    credentialId: 'cred',
    publicKey: over.key ?? b64url(spki),
    algorithm: over.alg ?? -7,
    clientDataJSON: b64url(json({ type: over.type ?? 'webauthn.create', challenge: b64url(Buffer.from(over.challenge ?? 'reg')), origin: over.origin ?? ORIGIN })),
  });
  const rOpts = { challenge: 'reg', origins: [ORIGIN] };
  it('registra uma chave ES256', () => {
    expect(registerPasskey(reg(), rOpts)).toEqual({ ok: true, passkey: { credentialId: 'cred', publicKey: b64url(spki), counter: 0 } });
  });
  it('recusa desafio, origem, tipo e algoritmo errados, e chave que não é chave', () => {
    expect(registerPasskey(reg({ challenge: 'x' }), rOpts).ok).toBe(false);
    expect(registerPasskey(reg({ origin: 'https://evil.example' }), rOpts).ok).toBe(false);
    expect(registerPasskey(reg({ type: 'webauthn.get' }), rOpts).ok).toBe(false);
    expect(registerPasskey(reg({ alg: -257 }), rOpts).ok).toBe(false);
    expect(registerPasskey(reg({ key: 'AAAA' }), rOpts).ok).toBe(false);
    expect(registerPasskey(null, rOpts).ok).toBe(false);
  });
});
