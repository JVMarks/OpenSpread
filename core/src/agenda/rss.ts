// Radar (item 16): lê os feeds RSS/Atom que o usuário escolheu e guarda só manchete, link e hora. Sem resumo, sem
// previsão: manchete é pista, não fato. Uma leitura a cada 15 min; cada manchete é ligada às salas pelas palavras do par
// (USDT → Tether, USDC → Circle…) e pelas palavras do usuário. Parser pequeno e tolerante (sem dependência).
import type { RadarItem } from '../types';

export const RADAR_MS = 15 * 60_000;
const KEEP_MS = 7 * 86_400_000;
const MAX_ITEMS = 120;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Tira CDATA, tags e entidades; espaços colapsados; no máximo 200 caracteres. */
export function cleanText(raw: string): string {
  const s = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
};

/** Só http(s); qualquer outra coisa (javascript:, data:) é descartada. */
export function safeLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(cleanText(raw));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Itens de um feed RSS 2.0 ou Atom. Item sem título, sem link válido ou sem data legível fica de fora. */
export function parseFeed(xml: string, source: string): Array<Omit<RadarItem, 'pairs'>> {
  const out: Array<Omit<RadarItem, 'pairs'>> = [];
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi), ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  for (const b of blocks) {
    const title = cleanText(tag(b, 'title') ?? '');
    const atomHref = b.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const link = safeLink(tag(b, 'link') ?? atomHref);
    const when = Date.parse(cleanText(tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date') ?? ''));
    if (!title || !link || !Number.isFinite(when)) continue;
    out.push({ id: link, title, url: link, at: when, source });
  }
  return out;
}

/** Palavras que ligam uma manchete a cada moeda dos pares. */
export const ASSET_WORDS: Readonly<Record<string, readonly string[]>> = {
  USDT: ['usdt', 'tether'],
  USDC: ['usdc', 'circle'],
  DAI: ['dai', 'makerdao', 'sky protocol'],
  USDE: ['usde', 'ethena'],
  FDUSD: ['fdusd', 'first digital'],
  PYUSD: ['pyusd', 'paypal'],
  TUSD: ['tusd', 'trueusd'],
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
};

/** Pares cuja moeda (ou palavra do usuário) aparece na manchete, como palavra inteira. */
export function pairsFor(title: string, pairs: readonly string[], extra: readonly string[] = []): string[] {
  const t = ` ${title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const has = (w: string) => t.includes(` ${w.toLowerCase()} `);
  const generic = extra.some(has);
  return pairs.filter((p) => generic || p.split('/').some((a) => (ASSET_WORDS[a] ?? [a.toLowerCase()]).some(has)));
}

/** Junta as manchetes novas às guardadas: sem repetir link, só as de 7 dias, mais novas primeiro, no máximo 120. */
export function mergeItems(kept: readonly RadarItem[], fresh: readonly RadarItem[], now: number): RadarItem[] {
  const byId = new Map<string, RadarItem>();
  for (const i of [...kept, ...fresh]) if (now - i.at <= KEEP_MS && i.at <= now + 3_600_000 && !byId.has(i.id)) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, MAX_ITEMS);
}
