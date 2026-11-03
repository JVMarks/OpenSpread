// Formato de endereço por rede. Confere o que dá para conferir sem rede: Solana = base58 de 32 bytes; EVM = 0x + 40
// hex; Bitcoin = bech32/bech32m (bc1…) ou base58check (1…, 3…) com o checksum. Endereço de testnet é recusado.
import { createHash } from 'node:crypto';
import type { WalletChain } from '../types';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodifica base58 (sem checksum); null se tiver caractere fora do alfabeto. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();

function isBase58Check(s: string, versions: readonly number[]): boolean {
  const b = base58Decode(s);
  if (!b || b.length !== 25 || !versions.includes(b[0])) return false;
  const sum = sha256(sha256(b.subarray(0, 21)));
  return sum.subarray(0, 4).equals(Buffer.from(b.subarray(21)));
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** Segwit de mainnet (bc1): checksum bech32 para a versão 0 e bech32m para as outras (BIP 173 e 350). */
function isSegwit(s: string): boolean {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
  const a = s.toLowerCase();
  const sep = a.lastIndexOf('1');
  if (a.slice(0, sep) !== 'bc' || a.length > 90) return false;
  const data: number[] = [];
  for (const ch of a.slice(sep + 1)) {
    const i = BECH32.indexOf(ch);
    if (i < 0) return false;
    data.push(i);
  }
  if (data.length < 7) return false;
  const hrp = [...'bc'].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data];
  const version = data[0];
  const want = version === 0 ? 1 : 0x2bc830a3;
  if (polymod(expanded) !== want || version > 16) return false;
  // tamanho do programa: 5 bits → bytes
  const bits = (data.length - 1 - 6) * 5;
  const bytes = Math.floor(bits / 8);
  if (bytes < 2 || bytes > 40) return false;
  if (version === 0 && bytes !== 20 && bytes !== 32) return false;
  return true;
}

/** Rede deduzida só pelo formato. EVM vale para Ethereum e Base: devolve 'evm' e quem chama escolhe. */
export function detectChain(raw: string): 'solana' | 'evm' | 'bitcoin' | null {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return 'evm';
  if (/^(bc1|BC1)/.test(s) ? isSegwit(s) : /^[13]/.test(s) && isBase58Check(s, [0x00, 0x05])) return 'bitcoin';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Decode(s)?.length === 32) return 'solana';
  return null;
}

/** Endereço normalizado para a rede, ou null se não for dessa rede. */
export function normalizeAddress(chain: WalletChain, raw: string): string | null {
  const s = raw.trim();
  const kind = detectChain(s);
  if (chain === 'solana') return kind === 'solana' ? s : null;
  if (chain === 'ethereum' || chain === 'base') return kind === 'evm' ? s.toLowerCase() : null;
  if (chain === 'bitcoin') return kind === 'bitcoin' ? (/^bc1/i.test(s) ? s.toLowerCase() : s) : null;
  return null;
}

/** `7xKX…9fQ`: o endereço encurtado que aparece na tela. */
export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
