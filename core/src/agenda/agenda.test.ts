import { describe, expect, it } from 'vitest';
import { feedUrl, validateConfig } from '../config';
import { Agenda } from './agenda';
import { newYorkTime, officialEvents, upcoming, userEvents } from './calendar';
import { cleanText, mergeItems, pairsFor, parseFeed, safeLink } from './rss';
import type { CoreConfig, RadarItem } from '../types';
import type { FetchLike } from '../wallets/http';

const iso = (ms: number) => new Date(ms).toISOString();

describe('calendário', () => {
  it('hora de Nova York com e sem horário de verão (inclusive nas viradas)', () => {
    expect(iso(newYorkTime(2026, 12, 9, 14))).toBe('2026-12-09T19:00:00.000Z'); // FOMC, EST
    expect(iso(newYorkTime(2026, 6, 17, 14))).toBe('2026-06-17T18:00:00.000Z'); // FOMC, EDT
    expect(iso(newYorkTime(2026, 11, 10, 8, 30))).toBe('2026-11-10T13:30:00.000Z'); // CPI, 9 dias depois da virada (1/11)
    expect(iso(newYorkTime(2027, 3, 10, 8, 30))).toBe('2027-03-10T13:30:00.000Z'); // antes de 14/03/2027
    expect(iso(newYorkTime(2027, 3, 17, 14))).toBe('2027-03-17T18:00:00.000Z'); // depois de 14/03/2027
  });

  it('datas oficiais com fonte e link; próximos 14 dias em ordem; eventos do usuário', () => {
    const all = officialEvents();
    expect(all.filter((e) => e.kind === 'fomc')).toHaveLength(16);
    expect(all.filter((e) => e.kind === 'cpi')).toHaveLength(14);
    expect(all.every((e) => e.impact === 'high' && e.url?.startsWith('https://www.') && e.pairs.length === 0)).toBe(true);
    const now = Date.parse('2026-11-03T12:00:00Z');
    const mine = userEvents([{ title: 'Desbloqueio de token', at: '2026-11-05T09:00:00-03:00', impact: 'medium', pairs: ['USDE/USDT'] }]);
    expect(mine[0]).toMatchObject({ kind: 'user', at: Date.parse('2026-11-05T12:00:00Z'), source: 'config', origin: 'user', pairs: ['USDE/USDT'] });
    expect(upcoming([...all, ...mine], now).map((e) => [e.title, iso(e.at)])).toEqual([
      ['Desbloqueio de token', '2026-11-05T12:00:00.000Z'],
      ['CPI', '2026-11-10T13:30:00.000Z'],
    ]);
  });
});

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title><![CDATA[Tether &amp; Circle: <b>USDC</b> supply hits record]]></title><link>https://news.example.com/a</link><pubDate>Tue, 03 Nov 2026 11:00:00 GMT</pubDate></item>
<item><title>Bitcoin ETF flows</title><link>https://news.example.com/b</link><pubDate>Tue, 03 Nov 2026 10:00:00 +0000</pubDate></item>
<item><title>sem link</title><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>link perigoso</title><link>javascript:alert(1)</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Ethena&#39;s USDe grows</title><link rel="alternate" href="https://blog.example.org/usde"/><updated>2026-11-03T09:30:00Z</updated></entry></feed>`;

describe('radar', () => {
  it('lê RSS e Atom: tira CDATA, tags e entidades; só link http(s); item sem data ou link fica de fora', () => {
    expect(parseFeed(RSS, 'news.example.com')).toEqual([
      { id: 'https://news.example.com/a', title: 'Tether & Circle: USDC supply hits record', url: 'https://news.example.com/a', at: Date.parse('2026-11-03T11:00:00Z'), source: 'news.example.com' },
      { id: 'https://news.example.com/b', title: 'Bitcoin ETF flows', url: 'https://news.example.com/b', at: Date.parse('2026-11-03T10:00:00Z'), source: 'news.example.com' },
    ]);
    expect(parseFeed(ATOM, 'blog.example.org')).toEqual([{ id: 'https://blog.example.org/usde', title: "Ethena's USDe grows", url: 'https://blog.example.org/usde', at: Date.parse('2026-11-03T09:30:00Z'), source: 'blog.example.org' }]);
    expect(safeLink('data:text/html,x')).toBeNull();
    expect(cleanText('a'.repeat(300))).toHaveLength(200);
  });

  it('liga a manchete às salas pelas moedas do par (palavra inteira) e pelas palavras do usuário', () => {
    const pairs = ['USDC/USDT', 'USDE/USDT', 'FDUSD/USDT'];
    expect(pairsFor('Tether mints 1B USDT', pairs)).toEqual(['USDC/USDT', 'USDE/USDT', 'FDUSD/USDT']);
    expect(pairsFor("Ethena's USDe grows", pairs)).toEqual(['USDE/USDT']);
    expect(pairsFor('Tetherball championship', pairs)).toEqual([]);
    expect(pairsFor('SEC sues an exchange', pairs, ['sec'])).toEqual(pairs);
  });

  it('junta sem repetir, só 7 dias, mais novas primeiro', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const it = (id: string, h: number): RadarItem => ({ id, title: id, url: `https://x/${id}`, at: now - h * 3_600_000, source: 'x', pairs: [] });
    expect(mergeItems([it('a', 1), it('old', 24 * 7 + 1)], [it('b', 0.5), it('a', 1)], now).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('serviço: um feed com erro não impede o outro; estado com eventos, manchetes e feeds', async () => {
    const fetchFn = (async (url: string) =>
      url.includes('quebrado')
        ? { status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }
        : { status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => RSS }) as FetchLike;
    const config: CoreConfig = { exchanges: ['binance', 'okx'], pairs: ['USDC/USDT'], pollMs: 10_000, alerts: [], transfer: { sizeUsd: 1000, withdrawFees: {} }, radar: { feeds: ['https://news.example.com/rss', 'https://quebrado.example.com/rss'], keywords: [] } };
    const a = new Agenda(fetchFn, { gapMs: 0 });
    const now = Date.parse('2026-11-03T12:00:00Z');
    await a.refresh(config, now);
    const st = a.state(config, now);
    expect(st.radar.map((i) => [i.title, i.pairs])).toEqual([
      ['Tether & Circle: USDC supply hits record', ['USDC/USDT']],
      ['Bitcoin ETF flows', []],
    ]);
    expect(st.feeds.map((f) => [f.url, f.ok])).toEqual([
      ['https://news.example.com/rss', true],
      ['https://quebrado.example.com/rss', false],
    ]);
    expect(st.events[0].title).toBe('CPI');
    expect(a.state({ ...config, radar: undefined }, now).radar).toEqual([]);
  });
});

describe('config: eventos e radar', () => {
  const base = { exchanges: ['binance', 'okx'], pairs: ['USDC/USDT'] };
  it('aceita evento com fuso e feed público; recusa hora sem fuso, impacto errado, par fora, feed local', () => {
    const ok = validateConfig({ ...base, events: [{ title: ' Listagem  X ', at: '2026-11-20T14:00:00-03:00', impact: 'low' }], radar: { feeds: ['https://news.example.com/rss'], keywords: ['SEC'] } }, ['binance', 'okx']);
    expect(ok).toMatchObject({ ok: true, config: { events: [{ title: 'Listagem X', at: '2026-11-20T14:00:00-03:00', impact: 'low' }], radar: { feeds: ['https://news.example.com/rss'], keywords: ['sec'] } } });
    const bad = validateConfig(
      { ...base, events: [{ title: 'x', at: '2026-11-20 14:00', impact: 'huge', pairs: ['BTC/USDT'] }], radar: { feeds: ['http://192.168.0.1/rss', 'file:///etc/passwd', 'http://localhost:8080/x'] } },
      ['binance', 'okx'],
    );
    const errors = (bad as { errors: string[] }).errors.join('\n');
    for (const t of ['título', 'ISO com fuso', 'impacto', 'par fora', '192.168.0.1', 'file:', 'localhost']) expect(errors).toContain(t);
    expect(feedUrl('https://user:pw@news.example.com/')).toBeNull();
    expect(feedUrl('http://10.0.0.5/')).toBeNull();
    expect(feedUrl('https://feeds.example.com/x?y=1')).toBe('https://feeds.example.com/x?y=1');
  });
});
