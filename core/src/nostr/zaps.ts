// Zaps (NIP-57). O núcleo só busca a fatura e confere recibos: quem paga é a carteira do usuário, e nada passa por nós.
// O endereço Lightning vem de perfis de terceiros: toda busca é https, sem IP privado, sem redirecionar, com limite.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import type { NostrEvent, UnsignedEvent } from '../types';
import { isHexKey, verifyEvent } from './event';

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 10_000;
const LUD16 = /^([a-z0-9._-]{1,64})@([a-z0-9.-]{1,253}\.[a-z]{2,63})$/i;

export type Resolver = (host: string) => Promise<string[]>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** IPv4 e IPv6 que não são internet pública. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

/** Busca segura de JSON numa URL vinda de terceiros. Qualquer dúvida: exceção com motivo curto. */
export async function safeJson(url: string, fetchImpl: FetchLike = fetch, resolve: Resolver = defaultResolver): Promise<unknown> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('endereço inválido');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('só https, sem porta nem usuário');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('endereço local recusado');
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('endereço privado ou sem resposta');
  const res = await fetchImpl(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (res.status >= 300 && res.status < 400) throw new Error('redirecionamento recusado');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) throw new Error('resposta grande demais');
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('resposta grande demais');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('resposta não é JSON');
  }
}

/** nome@domínio → https://domínio/.well-known/lnurlp/nome (LUD-16). */
export function lnurlpUrl(lud16: string): string | null {
  const m = lud16.trim().match(LUD16);
  return m ? `https://${m[2].toLowerCase()}/.well-known/lnurlp/${m[1].toLowerCase()}` : null;
}

export const encodeLnurl = (url: string): string => bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), 2000);

export interface PayInfo {
  callback: string;
  minSendable: number;
  maxSendable: number;
  allowsNostr: boolean;
  nostrPubkey: string | null;
  lnurl: string;
}

export async function fetchPayInfo(lud16: string, fetchImpl?: FetchLike, resolve?: Resolver): Promise<PayInfo> {
  const url = lnurlpUrl(lud16);
  if (!url) throw new Error('endereço Lightning inválido');
  const r = (await safeJson(url, fetchImpl, resolve)) as Record<string, unknown>;
  if (r?.tag !== 'payRequest' || typeof r.callback !== 'string' || !Number.isInteger(r.minSendable) || !Number.isInteger(r.maxSendable)) throw new Error('a carteira não respondeu um pedido de pagamento válido');
  const allowsNostr = r.allowsNostr === true && isHexKey(r.nostrPubkey);
  return { callback: r.callback, minSendable: r.minSendable as number, maxSendable: r.maxSendable as number, allowsNostr, nostrPubkey: allowsNostr ? (r.nostrPubkey as string) : null, lnurl: encodeLnurl(url) };
}

/** O pedido de zap (kind 9734) que a extensão assina. Não vai para relay: vai para a carteira. */
export function zapRequest(opts: { recipient: string; eventId: string; amountMsat: number; relays: string[]; lnurl: string; content?: string; now: number }): UnsignedEvent {
  return {
    kind: 9734,
    created_at: Math.floor(opts.now / 1000),
    tags: [['relays', ...opts.relays], ['amount', String(opts.amountMsat)], ['lnurl', opts.lnurl], ['p', opts.recipient], ['e', opts.eventId]],
    content: (opts.content ?? '').slice(0, 280),
  };
}

const MULT: Record<string, number> = { m: 1e8, u: 1e5, n: 100, p: 0.1 };

/** Valor (msat) e hash da descrição de uma fatura bolt11 da rede principal. O resto é ignorado. */
export function parseBolt11(pr: string): { msat: number | null; descriptionHash: string | null } {
  const lower = pr.trim().toLowerCase();
  const { prefix, words } = bech32.decode(lower as `${string}1${string}`, 10_000);
  const m = prefix.match(/^lnbc(\d+)?([munp])?$/);
  if (!m) throw new Error('não é uma fatura da rede principal');
  let msat: number | null = null;
  if (m[1]) {
    const amount = Number(m[1]) * (m[2] ? MULT[m[2]] : 1e11);
    if (!Number.isInteger(amount)) throw new Error('valor de fatura inválido');
    msat = amount;
  }
  const data = words.slice(7, words.length - 104);
  let descriptionHash: string | null = null;
  for (let i = 0; i + 3 <= data.length;) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    if (type === 23 && len === 52) descriptionHash = bytesToHex(bech32.fromWords(field));
    i += 3 + len;
  }
  return { msat, descriptionHash };
}

const tag = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name);

/** Pede a fatura à carteira e só devolve se ela tiver o valor pedido e o hash do pedido de zap. */
export async function requestInvoice(info: PayInfo, signed: NostrEvent, fetchImpl?: FetchLike, resolve?: Resolver): Promise<{ pr: string; msat: number }> {
  if (!info.allowsNostr) throw new Error('esta carteira não aceita zaps');
  if (signed.kind !== 9734 || !verifyEvent(signed)) throw new Error('pedido de zap sem assinatura válida');
  const amount = Number(tag(signed, 'amount')?.[1]);
  if (!Number.isInteger(amount) || amount < info.minSendable || amount > info.maxSendable) throw new Error('valor fora do que a carteira aceita');
  if (tag(signed, 'lnurl')?.[1] !== info.lnurl) throw new Error('pedido de zap para outra carteira');
  const description = JSON.stringify(signed);
  const url = new URL(info.callback);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('nostr', description);
  url.searchParams.set('lnurl', info.lnurl);
  const r = (await safeJson(url.toString(), fetchImpl, resolve)) as { pr?: unknown };
  if (typeof r?.pr !== 'string') throw new Error('a carteira não devolveu fatura');
  const parsed = parseBolt11(r.pr);
  if (parsed.msat !== amount) throw new Error('a fatura veio com outro valor');
  if (parsed.descriptionHash !== bytesToHex(sha256(new TextEncoder().encode(description)))) throw new Error('a fatura não corresponde ao pedido de zap');
  return { pr: r.pr, msat: amount };
}

/** Recibo (kind 9735) assinado pela carteira certa, para o evento certo, com o valor do pedido. Não é prova de pagamento. */
export function readReceipt(receipt: unknown, nostrPubkey: string, eventId: string): { ok: true; msat: number; sender: string } | { ok: false } {
  if (!verifyEvent(receipt) || receipt.kind !== 9735 || receipt.pubkey !== nostrPubkey) return { ok: false };
  const bolt11 = tag(receipt, 'bolt11')?.[1];
  const description = tag(receipt, 'description')?.[1];
  if (!bolt11 || !description) return { ok: false };
  let request: unknown;
  try {
    request = JSON.parse(description);
  } catch {
    return { ok: false };
  }
  if (!verifyEvent(request) || request.kind !== 9734 || tag(request, 'e')?.[1] !== eventId) return { ok: false };
  try {
    const { msat } = parseBolt11(bolt11);
    const asked = tag(request, 'amount')?.[1];
    if (msat === null || (asked !== undefined && Number(asked) !== msat)) return { ok: false };
    return { ok: true, msat, sender: request.pubkey };
  } catch {
    return { ok: false };
  }
}
