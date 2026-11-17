import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signForTest } from './event.test';
import { RelayPool } from './relays';
import { NostrService } from './service';
import { TestRelay } from './test-relay';
import type { Analysis, AnalysisResult, NostrConfig, NostrEvent, UnsignedEvent } from '../types';

const T0 = Date.UTC(2026, 10, 17, 12);
const A: Analysis = { id: 'a_1', pair: 'BTC/USDT', horizon: '1h', direction: 'up', conviction: 60, factors: [{ name: 'x', category: 'technical', effect: 'supports' }], plans: [], reasoning: 'r', model: 'm', usedChart: false, submittedAt: T0, expiresAt: T0 + 3_600_000, referencePrice: 100, costPct: 0.2, exchanges: 3 };
const R: AnalysisResult = { id: 'a_1', pair: 'BTC/USDT', model: 'm', horizon: '1h', direction: 'up', conviction: 60, status: 'resolved', hit: true, closePrice: 101, movePct: 1, resolvedAt: T0 + 3_600_000, plans: [] };

const me = schnorr.utils.randomSecretKey();
const myPub = bytesToHex(schnorr.getPublicKey(me));
const sign = (e: UnsignedEvent, sk = me): NostrEvent => signForTest(e, sk);

let dir: string;
let relay: TestRelay;
let config: NostrConfig | undefined;
let result: AnalysisResult | undefined;
const service = (over: Partial<ConstructorParameters<typeof NostrService>[0]> = {}) => {
  const s = new NostrService({
    dir,
    config: () => config,
    analysis: (id) => (id === 'a_1' ? { analysis: A, result } : undefined),
    now: () => T0 + 10_000,
    pool: (relays) => new RelayPool(relays, { allowLocal: true, timeoutMs: 1500 }),
    ...over,
  });
  s.load();
  return s;
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nostr-'));
  relay = new TestRelay();
  await relay.start();
  config = { enabled: true, relays: [relay.url] };
  result = undefined;
});
afterEach(async () => {
  await relay.stop();
  rmSync(dir, { recursive: true, force: true });
});
const body = (r: { body: unknown }) => r.body as Record<string, any>;

describe('identidade', () => {
  it('só aceita chave pública hex, e guarda só ela', () => {
    const s = service();
    expect(s.setIdentity({ pubkey: 'nsec1xyz' }).status).toBe(422);
    expect(s.setIdentity({ pubkey: myPub }).status).toBe(200);
    expect(body({ body: s.state() }).identity.pubkey).toBe(myPub);
    expect(body({ body: service().state() }).identity.npub.startsWith('npub1')).toBe(true);
  });
});

describe('publicar a análise e o resultado', () => {
  it('prepara, a extensão assina, confere e publica; uma vez só', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    const prep = s.prepare({ analysisId: 'a_1' });
    expect(prep.status).toBe(200);
    const signed = sign(body(prep).event);
    const pub = await s.publish({ event: signed });
    expect(pub.status).toBe(201);
    expect(relay.events.map((e) => e.id)).toEqual([signed.id]);
    expect(body({ body: s.state() }).published[0]).toMatchObject({ analysisId: 'a_1', eventId: signed.id, resultEventId: null, resultPending: false });
    expect(s.prepare({ analysisId: 'a_1' }).status).toBe(409);
  });
  it('evento assinado por outra chave é recusado', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    const prep = s.prepare({ analysisId: 'a_1' });
    expect((await s.publish({ event: sign(body(prep).event, schnorr.utils.randomSecretKey()) })).status).toBe(403);
    expect(relay.events).toEqual([]);
  });
  it('evento diferente do preparado é recusado, mesmo assinado por mim', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    const prep = s.prepare({ analysisId: 'a_1' });
    const changed = sign({ ...body(prep).event, content: 'compre agora' });
    expect((await s.publish({ event: changed })).status).toBe(409);
    expect(relay.events).toEqual([]);
  });
  it('assinatura falsa é recusada', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    const signed = sign(body(s.prepare({ analysisId: 'a_1' })).event);
    expect((await s.publish({ event: { ...signed, sig: '0'.repeat(128) } })).status).toBe(422);
  });
  it('resultado: só depois de publicar a análise e do vencimento; fica pendente até sair', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    expect(s.prepare({ analysisId: 'a_1', what: 'result' }).status).toBe(409);
    const root = sign(body(s.prepare({ analysisId: 'a_1' })).event);
    await s.publish({ event: root });
    expect(s.prepare({ analysisId: 'a_1', what: 'result' })).toMatchObject({ status: 409, body: { error: 'not_resolved' } });
    result = R;
    expect(body({ body: s.state() }).published[0].resultPending).toBe(true);
    const reply = sign(body(s.prepare({ analysisId: 'a_1', what: 'result' })).event);
    expect(reply.tags[0]).toEqual(['e', root.id, '', 'root', myPub]);
    expect((await s.publish({ event: reply })).status).toBe(201);
    expect(body({ body: s.state() }).published[0]).toMatchObject({ resultEventId: reply.id, resultPending: false });
  });
  it('nenhum relay aceitou: não registra como publicado', async () => {
    await relay.stop();
    relay = new TestRelay({ rejectWith: 'blocked' });
    await relay.start();
    config = { enabled: true, relays: [relay.url] };
    const s = service();
    s.setIdentity({ pubkey: myPub });
    const r = await s.publish({ event: sign(body(s.prepare({ analysisId: 'a_1' })).event) });
    expect(r.status).toBe(502);
    expect(body({ body: s.state() }).published).toEqual([]);
  });
  it('o registro sobrevive ao reinício', async () => {
    const s = service();
    s.setIdentity({ pubkey: myPub });
    await s.publish({ event: sign(body(s.prepare({ analysisId: 'a_1' })).event) });
    expect(body({ body: service().state() }).published).toHaveLength(1);
  });
  it('desligado ou sem identidade: 409', () => {
    config = { enabled: false, relays: [] };
    expect(service().prepare({ analysisId: 'a_1' }).status).toBe(409);
    config = { enabled: true, relays: [relay.url] };
    expect(service().prepare({ analysisId: 'a_1' })).toMatchObject({ status: 409, body: { error: 'no_identity' } });
  });
});

describe('thread e zaps', () => {
  const walletKey = schnorr.utils.randomSecretKey();
  const walletPub = bytesToHex(schnorr.getPublicKey(walletKey));
  const lnurlUrl = 'https://w.example/.well-known/lnurlp/eu';
  const invoice = (hrp: string, hash: Uint8Array) => {
    const words: number[] = [0, 0, 0, 0, 0, 0, 1];
    const w = bech32.toWords(hash);
    words.push(23, Math.floor(w.length / 32), w.length % 32, ...w);
    for (let i = 0; i < 104; i++) words.push(0);
    return bech32.encode(hrp, words, 10_000);
  };
  const wallet = (url: string) => {
    if (url === lnurlUrl) return Promise.resolve(new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://w.example/cb', minSendable: 1000, maxSendable: 1e9, allowsNostr: true, nostrPubkey: walletPub })));
    const nostr = new URL(url).searchParams.get('nostr') ?? '';
    return Promise.resolve(new Response(JSON.stringify({ pr: invoice('lnbc210n', sha256(new TextEncoder().encode(nostr))) })));
  };
  const opts = { fetch: wallet, resolve: () => Promise.resolve(['93.184.216.34']) };

  it('lê respostas como texto e conta só recibos da carteira certa', async () => {
    const s = service(opts);
    s.setIdentity({ pubkey: myPub });
    relay.events.push(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ lud16: 'eu@w.example' }) }));
    const root = sign(body(s.prepare({ analysisId: 'a_1' })).event);
    await s.publish({ event: root });
    const other = schnorr.utils.randomSecretKey();
    relay.events.push(sign({ kind: 1, created_at: 5, tags: [['e', root.id, '', 'root']], content: '<script>alert(1)</script> discordo' }, other));
    const zapReq = sign({ kind: 9734, created_at: 6, tags: [['p', myPub], ['e', root.id], ['amount', '21000']], content: '' }, other);
    const good = signForTest({ kind: 9735, created_at: 7, tags: [['e', root.id], ['bolt11', invoice('lnbc210n', new Uint8Array(32))], ['description', JSON.stringify(zapReq)]], content: '' }, walletKey);
    const fake = signForTest({ kind: 9735, created_at: 8, tags: [['e', root.id], ['bolt11', invoice('lnbc210n', new Uint8Array(32))], ['description', JSON.stringify(zapReq)]], content: '' }, other);
    relay.events.push(good, fake);
    const t = body(await s.thread(root.id));
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0].content).toBe('<script>alert(1)</script> discordo');
    expect(t.zaps).toEqual({ count: 1, msat: 21000 });
    expect(t.zappable).toBe(true);
  });
  it('zap: prepara o pedido, a extensão assina, e a fatura só sai conferida', async () => {
    const s = service(opts);
    s.setIdentity({ pubkey: myPub });
    const author = schnorr.utils.randomSecretKey();
    const authorPub = bytesToHex(schnorr.getPublicKey(author));
    relay.events.push(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ lud16: 'eu@w.example' }) }, author));
    const target = 'f'.repeat(64);
    const prep = await s.zapPrepare({ eventId: target, author: authorPub, sats: 21 });
    expect(prep.status).toBe(200);
    const signed = sign(body(prep).event);
    const inv = await s.zapInvoice({ event: signed });
    expect(inv.status).toBe(200);
    expect(body(inv)).toMatchObject({ msat: 21000 });
    expect(body(inv).pr.startsWith('lnbc210n1')).toBe(true);
  });
  it('autor sem carteira que aceite zap: recusa', async () => {
    const s = service(opts);
    s.setIdentity({ pubkey: myPub });
    expect((await s.zapPrepare({ eventId: 'f'.repeat(64), author: 'b'.repeat(64), sats: 21 })).status).toBe(409);
  });
  it('valor fora da faixa ou pedido assinado por outra chave: recusa', async () => {
    const s = service(opts);
    s.setIdentity({ pubkey: myPub });
    expect((await s.zapPrepare({ eventId: 'f'.repeat(64), author: myPub, sats: 0 })).status).toBe(422);
    expect((await s.zapInvoice({ event: sign({ kind: 9734, created_at: 1, tags: [['e', 'f'.repeat(64)]], content: '' }, schnorr.utils.randomSecretKey()) })).status).toBe(403);
  });
});
