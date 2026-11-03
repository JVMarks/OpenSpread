// Agenda e radar: datas oficiais + eventos do usuário, e as manchetes dos feeds escolhidos (lidas a cada 15 min, um feed
// por vez). As manchetes ficam em cache (~/.openspread/cache/radar.json) para o "novo desde a última olhada" sobreviver
// a um reinício. Nada aqui manda aviso: o Bullroom mostra e acende o alarme da sala perto de um evento de alto impacto.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getText, pause, type FetchLike } from '../wallets/http';
import { officialEvents, upcoming, userEvents } from './calendar';
import { mergeItems, pairsFor, parseFeed } from './rss';
import type { AgendaState, CoreConfig, RadarItem } from '../types';

export class Agenda {
  private items: RadarItem[] = [];
  private feeds = new Map<string, { ok: boolean; error?: string; lastAt?: number }>();
  rev = 0;

  constructor(
    private fetchFn: FetchLike,
    private opts: { cacheFile?: string; log?: (msg: string) => void; gapMs?: number } = {},
  ) {}

  /** Lê cada feed uma vez; um feed com erro não impede os outros. */
  async refresh(config: CoreConfig, now = Date.now()): Promise<void> {
    const radar = config.radar;
    if (!radar?.feeds.length) return;
    let fresh: RadarItem[] = [];
    for (const url of radar.feeds) {
      const host = new URL(url).host;
      try {
        const xml = await getText(this.fetchFn, url);
        const parsed = parseFeed(xml, host).map((i) => ({ ...i, pairs: pairsFor(i.title, config.pairs, radar.keywords) }));
        fresh = fresh.concat(parsed);
        this.setFeed(url, { ok: true, lastAt: now });
      } catch (e) {
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 160);
        this.setFeed(url, { ok: false, error, lastAt: this.feeds.get(url)?.lastAt });
      }
      await pause(this.opts.gapMs ?? 500);
    }
    const before = this.items.length ? this.items[0].id : '';
    this.items = mergeItems(this.items, fresh, now);
    if (this.items.length && this.items[0].id !== before) this.save();
    this.rev++;
  }

  state(config: CoreConfig, now = Date.now()): AgendaState {
    const feeds = config.radar?.feeds ?? [];
    for (const k of [...this.feeds.keys()]) if (!feeds.includes(k)) this.feeds.delete(k);
    return {
      at: now,
      events: upcoming([...officialEvents(), ...userEvents(config.events ?? [])], now),
      radar: this.items.filter((i) => feeds.some((f) => new URL(f).host === i.source)),
      feeds: feeds.map((url) => ({ url, ...(this.feeds.get(url) ?? { ok: true }) })),
    };
  }

  private setFeed(url: string, next: { ok: boolean; error?: string; lastAt?: number }): void {
    const prev = this.feeds.get(url);
    if (!prev || prev.ok !== next.ok || prev.error !== next.error) this.opts.log?.(next.ok ? `radar: lendo ${url}` : `radar: ${url} sem dados (${next.error})`);
    this.feeds.set(url, next);
  }

  load(): void {
    const f = this.opts.cacheFile;
    if (!f || !existsSync(f)) return;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as { version: number; items: RadarItem[] };
      if (raw.version === 1 && Array.isArray(raw.items)) this.items = raw.items.filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string' && Number.isFinite(i.at));
    } catch {
      // cache quebrado: começa vazio
    }
  }

  private save(): void {
    const f = this.opts.cacheFile;
    if (!f) return;
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify({ version: 1, items: this.items }), 'utf8');
      renameSync(`${f}.tmp`, f);
    } catch (e) {
      this.opts.log?.(`não consegui gravar o cache do radar em ${f}: ${(e as Error).message}`);
    }
  }
}
