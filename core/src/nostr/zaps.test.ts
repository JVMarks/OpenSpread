import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { signForTest } from './event.test';
import { encodeLnurl, fetchPayInfo, isPrivateIp, lnurlpUrl, parseBolt11, readReceipt, requestInvoice, safeJson, zapRequest, type PayInfo } from './zaps';

/** Fatura bolt11 de teste com valor e hash da descrição, checksum válido. Assinatura de enchimento (não conferida aqui). */
function invoice(hrp: string, descriptionHash?: Uint8Array): string {
  const words: number[] = [0, 0, 0, 0, 0, 0, 1];
  const field = (type: number, bytes: Uint8Array) => {
    const w = bech32.toWords(bytes);
    words.push(type, Math.floor(w.length / 32), w.length % 32, ...w);
  };
  field(1, new Uint8Array(32).fill(7));
  if (descriptionHash) field(23, descriptionHash);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode(hrp, words, 10_000);
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const publicIp = () => Promise.resolve(['93.184.216.34']);

describe('isPrivateIp', () => {
  it('recusa o que não é internet pública', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'nada']) expect(isPrivateIp(ip), ip).toBe(true);
  });
  it('aceita internet pública', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe('safeJson', () => {
  const ok = () => Promise.resolve(json({ a: 1 }));
  it('só https, sem porta estranha nem usuário', async () => {
    await expect(safeJson('http://x.example/a', ok, publicIp)).rejects.toThrow('https');
    await expect(safeJson('https://x.example:8443/a', ok, publicIp)).rejects.toThrow('https');
    await expect(safeJson('https://u:p@x.example/a', ok, publicIp)).rejects.toThrow('https');
    await expect(safeJson('https://x.example/a', ok, publicIp)).resolves.toEqual({ a: 1 });
  });
  it('recusa localhost, IP privado e nome que resolve para IP privado', async () => {
    await expect(safeJson('https://localhost/a', ok, publicIp)).rejects.toThrow('local');
    await expect(safeJson('https://127.0.0.1/a', ok, publicIp)).rejects.toThrow('privado');
    await expect(safeJson('https://[::1]/a', ok, publicIp)).rejects.toThrow('privado');
    await expect(safeJson('https://mal.example/a', ok, () => Promise.resolve(['93.184.216.34', '10.0.0.5']))).rejects.toThrow('privado');
    await expect(safeJson('https://some.example/a', ok, () => Promise.reject(new Error('dns')))).rejects.toThrow('privado');
  });
  it('não segue redirecionamento e não aceita resposta gigante', async () => {
    await expect(safeJson('https://x.example/a', () => Promise.resolve(new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/' } })), publicIp)).rejects.toThrow('redirecionamento');
    await expect(safeJson('https://x.example/a', () => Promise.resolve(json({ a: 'x'.repeat(70 * 1024) })), publicIp)).rejects.toThrow('grande');
    await expect(safeJson('https://x.example/a', () => Promise.resolve(new Response('{}', { headers: { 'content-length': '999999' } })), publicIp)).rejects.toThrow('grande');
  });
  it('pede sem seguir redirecionamento e com tempo limite', async () => {
    let init: RequestInit | undefined;
    await safeJson('https://x.example/a', (_u, i) => {
      init = i;
      return Promise.resolve(json({}));
    }, publicIp);
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeDefined();
  });
});

describe('LNURL', () => {
  it('endereço Lightning vira a URL do LUD-16', () => {
    expect(lnurlpUrl('sickfog79@walletofsatoshi.com')).toBe('https://walletofsatoshi.com/.well-known/lnurlp/sickfog79');
    expect(lnurlpUrl('Nome@Exemplo.COM')).toBe('https://exemplo.com/.well-known/lnurlp/nome');
    for (const bad of ['semarroba', 'a@b', 'a b@c.com', 'a@127.0.0.1', '../x@c.com/']) expect(lnurlpUrl(bad), bad).toBeNull();
  });
  it('pay info: zap só com allowsNostr e nostrPubkey válida', async () => {
    const base = { tag: 'payRequest', callback: 'https://w.example/cb', minSendable: 1000, maxSendable: 1e11 };
    const zap = await fetchPayInfo('a@w.example', () => Promise.resolve(json({ ...base, allowsNostr: true, nostrPubkey: 'b'.repeat(64) })), publicIp);
    expect(zap).toMatchObject({ allowsNostr: true, nostrPubkey: 'b'.repeat(64), lnurl: encodeLnurl('https://w.example/.well-known/lnurlp/a') });
    const plain = await fetchPayInfo('a@w.example', () => Promise.resolve(json({ ...base, allowsNostr: true, nostrPubkey: 'xx' })), publicIp);
    expect(plain.allowsNostr).toBe(false);
    await expect(fetchPayInfo('a@w.example', () => Promise.resolve(json({ tag: 'withdrawRequest' })), publicIp)).rejects.toThrow('pagamento');
  });
});

describe('bolt11', () => {
  it('valor em msat pelos multiplicadores', () => {
    expect(parseBolt11(invoice('lnbc2500u')).msat).toBe(250_000_000);
    expect(parseBolt11(invoice('lnbc10n')).msat).toBe(1000);
    expect(parseBolt11(invoice('lnbc1m')).msat).toBe(100_000_000);
    expect(parseBolt11(invoice('lnbc')).msat).toBeNull();
  });
  it('lê o hash da descrição', () => {
    const h = sha256(new TextEncoder().encode('desc'));
    expect(parseBolt11(invoice('lnbc10n', h)).descriptionHash).toBe(bytesToHex(h));
    expect(parseBolt11(invoice('lnbc10n')).descriptionHash).toBeNull();
  });
  it('recusa outra rede e checksum errado', () => {
    expect(() => parseBolt11(invoice('lntb10n'))).toThrow('rede principal');
    const pr = invoice('lnbc10n');
    expect(() => parseBolt11(`${pr.slice(0, -1)}${pr.endsWith('q') ? 'p' : 'q'}`)).toThrow();
  });
});

describe('fatura de zap', () => {
  const sk = schnorr.utils.randomSecretKey();
  const info: PayInfo = { callback: 'https://w.example/cb', minSendable: 1000, maxSendable: 1_000_000, allowsNostr: true, nostrPubkey: 'c'.repeat(64), lnurl: encodeLnurl('https://w.example/.well-known/lnurlp/a') };
  const request = (amount = 21000, lnurl = info.lnurl) => signForTest(zapRequest({ recipient: 'b'.repeat(64), eventId: 'e'.repeat(64), amountMsat: amount, relays: ['wss://r.example'], lnurl, now: Date.UTC(2026, 10, 17) }), sk);
  const wallet = (pr: (desc: string) => string) => (url: string) => Promise.resolve(json({ pr: pr(new URL(url).searchParams.get('nostr') ?? '') }));
  it('pedido de zap no formato do NIP-57', () => {
    expect(zapRequest({ recipient: 'b'.repeat(64), eventId: 'e'.repeat(64), amountMsat: 21000, relays: ['wss://r.example'], lnurl: 'lnurl1x', now: 0 }).tags).toEqual([['relays', 'wss://r.example'], ['amount', '21000'], ['lnurl', 'lnurl1x'], ['p', 'b'.repeat(64)], ['e', 'e'.repeat(64)]]);
  });
  it('fatura certa: valor e hash do pedido', async () => {
    const r = await requestInvoice(info, request(), wallet((d) => invoice('lnbc210n', sha256(new TextEncoder().encode(d)))), publicIp);
    expect(r.msat).toBe(21000);
  });
  it('fatura com outro valor ou sem o hash do pedido é recusada', async () => {
    await expect(requestInvoice(info, request(), wallet((d) => invoice('lnbc2100n', sha256(new TextEncoder().encode(d)))), publicIp)).rejects.toThrow('outro valor');
    await expect(requestInvoice(info, request(), wallet(() => invoice('lnbc210n', sha256(new TextEncoder().encode('outra coisa')))), publicIp)).rejects.toThrow('não corresponde');
  });
  it('pedido sem assinatura, fora da faixa ou para outra carteira é recusado antes de pedir', async () => {
    let called = false;
    const spy = () => {
      called = true;
      return Promise.resolve(json({}));
    };
    await expect(requestInvoice(info, { ...request(), content: 'trocado' }, spy, publicIp)).rejects.toThrow('assinatura');
    await expect(requestInvoice(info, request(500), spy, publicIp)).rejects.toThrow('valor');
    await expect(requestInvoice(info, request(21000, 'lnurl1outra'), spy, publicIp)).rejects.toThrow('outra carteira');
    await expect(requestInvoice({ ...info, allowsNostr: false }, request(), spy, publicIp)).rejects.toThrow('não aceita');
    expect(called).toBe(false);
  });
});

describe('recibo de zap', () => {
  const walletKey = schnorr.utils.randomSecretKey();
  const walletPub = bytesToHex(schnorr.getPublicKey(walletKey));
  const event = 'e'.repeat(64);
  const receipt = (over: { amount?: number; bolt?: string; eventId?: string; key?: ReturnType<typeof schnorr.utils.randomSecretKey> } = {}) => {
    const req = signForTest(zapRequest({ recipient: 'b'.repeat(64), eventId: over.eventId ?? event, amountMsat: over.amount ?? 21000, relays: [], lnurl: 'lnurl1x', now: 0 }));
    return signForTest({ kind: 9735, created_at: 1, tags: [['p', 'b'.repeat(64)], ['e', event], ['bolt11', over.bolt ?? invoice('lnbc210n')], ['description', JSON.stringify(req)]], content: '' }, over.key ?? walletKey);
  };
  it('recibo da carteira certa, para o evento, com o valor pedido', () => {
    expect(readReceipt(receipt(), walletPub, event)).toMatchObject({ ok: true, msat: 21000 });
  });
  it('recibo assinado por outra chave não conta', () => {
    expect(readReceipt(receipt({ key: schnorr.utils.randomSecretKey() }), walletPub, event).ok).toBe(false);
  });
  it('valor diferente do pedido, outro evento ou forma estranha não contam', () => {
    expect(readReceipt(receipt({ amount: 99000 }), walletPub, event).ok).toBe(false);
    expect(readReceipt(receipt({ eventId: 'f'.repeat(64) }), walletPub, event).ok).toBe(false);
    expect(readReceipt({ kind: 9735 }, walletPub, event).ok).toBe(false);
    void hexToBytes;
  });
});
