// Nostr no núcleo: identidade (só a chave pública), preparar eventos para a extensão assinar, conferir e publicar,
// ler threads e zaps. Registro só de acréscimo em nostr/published.jsonl. Nada de chave privada, nunca.
// Threads não ficam em disco: são lidas na hora (menos dados de terceiros guardados).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlFile } from '../jsonl';
import type { Analysis, AnalysisResult, NostrConfig, NostrEvent, UnsignedEvent } from '../types';
import { analysisNote, resultReply, type NoteLocale } from './compose';
import { isHexKey, noteOf, npubOf, verifyEvent } from './event';
import { RelayPool, type RelayResult } from './relays';
import { fetchPayInfo, readReceipt, requestInvoice, zapRequest, type FetchLike, type PayInfo, type Resolver } from './zaps';

export interface PublishedEntry {
  at: number;
  kind: 'analysis' | 'result';
  analysisId: string;
  eventId: string;
  pubkey: string;
  relays: RelayResult[];
}

const isEntry = (v: unknown): v is PublishedEntry => {
  const e = v as Partial<PublishedEntry> | null;
  return !!e && typeof e.at === 'number' && (e.kind === 'analysis' || e.kind === 'result') && typeof e.analysisId === 'string' && typeof e.eventId === 'string' && typeof e.pubkey === 'string';
};

export interface ThreadReply {
  id: string;
  npub: string;
  pubkey: string;
  at: number;
  /** Texto de terceiros: só texto, cortado. */
  content: string;
}

export interface Thread {
  replies: ThreadReply[];
  /** Zaps com recibo válido da carteira do autor. Recibo não é prova de pagamento. */
  zaps: { count: number; msat: number };
  /** O autor tem endereço Lightning que aceita zap. */
  zappable: boolean;
}

export interface NostrServiceOptions {
  dir: string;
  config: () => NostrConfig | undefined;
  /** A análise e o resultado, do livro de análises. */
  analysis: (id: string) => { analysis: Analysis; result?: AnalysisResult } | undefined;
  now?: () => number;
  pool?: (relays: string[]) => RelayPool;
  fetch?: FetchLike;
  resolve?: Resolver;
  log?: (m: string) => void;
}

export type Reply = { status: number; body: unknown };
const MAX_REPLY_TEXT = 2_000;

export class NostrService {
  rev = 0;
  private identity: string | null = null;
  private entries: PublishedEntry[] = [];
  /** O que foi preparado para assinar: só isso pode ser publicado. */
  private prepared = new Map<string, { event: UnsignedEvent; kind: PublishedEntry['kind']; analysisId: string }>();
  private zapPrepared = new Map<string, { info: PayInfo }>();
  private readonly payCache = new Map<string, { info: PayInfo | null; at: number }>();
  private readonly ledger: JsonlFile<PublishedEntry>;
  private readonly identityFile: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: NostrServiceOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.identityFile = join(opts.dir, 'identity.json');
    this.ledger = new JsonlFile(join(opts.dir, 'published.jsonl'), isEntry, (bad, f) => this.log(`nostr: ignorei ${bad} linha(s) ilegível(is) em ${f}`));
  }

  load(): void {
    this.entries = this.ledger.readAll();
    if (existsSync(this.identityFile)) {
      try {
        const pubkey = (JSON.parse(readFileSync(this.identityFile, 'utf8')) as { pubkey?: unknown }).pubkey;
        if (isHexKey(pubkey)) this.identity = pubkey;
      } catch {
        this.log('nostr: identity.json ilegível; escolha a identidade de novo');
      }
    }
  }

  private get enabled(): NostrConfig | null {
    const c = this.opts.config();
    return c?.enabled && c.relays.length ? c : null;
  }

  private pool(): RelayPool {
    const relays = this.enabled?.relays ?? [];
    return this.opts.pool ? this.opts.pool(relays) : new RelayPool(relays);
  }

  state(): unknown {
    const c = this.opts.config();
    const byAnalysis = new Map<string, { analysis?: PublishedEntry; result?: PublishedEntry }>();
    for (const e of this.entries) {
      const slot = byAnalysis.get(e.analysisId) ?? {};
      slot[e.kind] = e;
      byAnalysis.set(e.analysisId, slot);
    }
    const published = [...byAnalysis.entries()].flatMap(([analysisId, s]) => {
      if (!s.analysis) return [];
      const found = this.opts.analysis(analysisId);
      return [{
        analysisId,
        eventId: s.analysis.eventId,
        note: noteOf(s.analysis.eventId),
        at: s.analysis.at,
        pair: found?.analysis.pair ?? '',
        horizon: found?.analysis.horizon ?? '',
        resultEventId: s.result?.eventId ?? null,
        /** Venceu e o resultado não foi publicado: fica na tela até sair. */
        resultPending: !s.result && !!found?.result,
      }];
    });
    return {
      enabled: !!this.enabled,
      relays: c?.relays ?? [],
      identity: this.identity ? { pubkey: this.identity, npub: npubOf(this.identity) } : null,
      published: published.reverse(),
      notice: 'A assinatura prova quem publicou, não que a análise acertou.',
    };
  }

  setIdentity(raw: unknown): Reply {
    const pubkey = (raw as { pubkey?: unknown } | null)?.pubkey;
    if (!isHexKey(pubkey)) return { status: 422, body: { error: 'invalid', details: ['Chave pública hex de 64 caracteres, vinda da extensão.'] } };
    this.identity = pubkey;
    const tmp = `${this.identityFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pubkey }), 'utf8');
    renameSync(tmp, this.identityFile);
    this.rev += 1;
    return { status: 200, body: { pubkey, npub: npubOf(pubkey) } };
  }

  /** Evento a assinar: a nota da análise ou a resposta com o resultado. */
  prepare(raw: unknown): Reply {
    if (!this.enabled) return { status: 409, body: { error: 'disabled', details: ['Nostr está desligado. Ligue e escolha relays em Mercados.'] } };
    if (!this.identity) return { status: 409, body: { error: 'no_identity', details: ['Escolha a identidade pela extensão primeiro.'] } };
    const r = (raw ?? {}) as { analysisId?: unknown; what?: unknown; locale?: unknown };
    const locale: NoteLocale = r.locale === 'en' ? 'en' : 'pt-BR';
    const found = typeof r.analysisId === 'string' ? this.opts.analysis(r.analysisId) : undefined;
    if (!found) return { status: 404, body: { error: 'not_found', details: ['Análise não encontrada.'] } };
    const id = found.analysis.id;
    const root = this.entries.find((e) => e.kind === 'analysis' && e.analysisId === id);
    let event: UnsignedEvent | null;
    let kind: PublishedEntry['kind'];
    if (r.what === 'result') {
      if (!root) return { status: 409, body: { error: 'not_published', details: ['Publique a análise antes do resultado.'] } };
      if (this.entries.some((e) => e.kind === 'result' && e.analysisId === id)) return { status: 409, body: { error: 'already_published', details: ['O resultado já foi publicado.'] } };
      event = resultReply(found.analysis, found.result, root.eventId, root.pubkey, locale, this.now());
      if (!event) return { status: 409, body: { error: 'not_resolved', details: ['A análise ainda não venceu.'] } };
      kind = 'result';
    } else {
      if (root) return { status: 409, body: { error: 'already_published', details: ['Esta análise já foi publicada.'] } };
      event = analysisNote(found.analysis, locale, this.now());
      kind = 'analysis';
    }
    this.prepared.set(this.identity, { event, kind, analysisId: id });
    return { status: 200, body: { event } };
  }

  /** Confere que é o evento preparado, assinado pela identidade escolhida, e publica. */
  async publish(raw: unknown): Promise<Reply> {
    if (!this.enabled || !this.identity) return { status: 409, body: { error: 'disabled' } };
    const event = (raw as { event?: unknown } | null)?.event;
    if (!verifyEvent(event)) return { status: 422, body: { error: 'invalid_signature', details: ['Evento sem assinatura válida.'] } };
    if (event.pubkey !== this.identity) return { status: 403, body: { error: 'wrong_identity', details: ['Assinado por outra chave, diferente da identidade escolhida.'] } };
    const p = this.prepared.get(this.identity);
    const same = p && p.event.kind === event.kind && p.event.created_at === event.created_at && p.event.content === event.content && JSON.stringify(p.event.tags) === JSON.stringify(event.tags);
    if (!p || !same) return { status: 409, body: { error: 'not_prepared', details: ['Este não é o evento preparado. Prepare de novo.'] } };
    const relays = await this.pool().publish(event);
    const accepted = relays.filter((x) => x.accepted).length;
    if (!accepted) return { status: 502, body: { error: 'no_relay', details: relays.map((x) => `${x.relay}: ${x.message}`) } };
    this.prepared.delete(this.identity);
    const entry: PublishedEntry = { at: this.now(), kind: p.kind, analysisId: p.analysisId, eventId: event.id, pubkey: event.pubkey, relays };
    this.ledger.append(entry);
    this.entries.push(entry);
    this.rev += 1;
    return { status: 201, body: { eventId: event.id, note: noteOf(event.id), relays } };
  }

  private async lud16Of(pubkey: string): Promise<string | null> {
    const [profile] = (await this.pool().query({ kinds: [0], authors: [pubkey], limit: 1 })).sort((a, b) => b.created_at - a.created_at);
    if (!profile) return null;
    try {
      const lud16 = (JSON.parse(profile.content) as { lud16?: unknown }).lud16;
      return typeof lud16 === 'string' ? lud16 : null;
    } catch {
      return null;
    }
  }

  /** Informação de pagamento do autor, guardada 10 min em memória. */
  private async payInfoOf(pubkey: string): Promise<PayInfo | null> {
    const hit = this.payCache.get(pubkey);
    if (hit && this.now() - hit.at < 600_000) return hit.info;
    let info: PayInfo | null = null;
    try {
      const lud16 = await this.lud16Of(pubkey);
      info = lud16 ? await fetchPayInfo(lud16, this.opts.fetch, this.opts.resolve) : null;
    } catch (e) {
      this.log(`nostr: carteira de ${pubkey.slice(0, 8)} não respondeu: ${(e as Error).message}`);
    }
    this.payCache.set(pubkey, { info, at: this.now() });
    return info;
  }

  async thread(eventId: string): Promise<Reply> {
    if (!this.enabled) return { status: 409, body: { error: 'disabled' } };
    if (!/^[0-9a-f]{64}$/.test(eventId)) return { status: 422, body: { error: 'invalid' } };
    const pool = this.pool();
    const [root] = await pool.query({ ids: [eventId], limit: 1 });
    const events = await pool.query({ '#e': [eventId], kinds: [1, 9735] });
    const info = root ? await this.payInfoOf(root.pubkey) : null;
    let count = 0;
    let msat = 0;
    if (info?.nostrPubkey) {
      for (const e of events.filter((x) => x.kind === 9735)) {
        const r = readReceipt(e, info.nostrPubkey, eventId);
        if (r.ok) {
          count += 1;
          msat += r.msat;
        }
      }
    }
    const replies: ThreadReply[] = events
      .filter((e) => e.kind === 1)
      .map((e) => ({ id: e.id, pubkey: e.pubkey, npub: npubOf(e.pubkey), at: e.created_at, content: e.content.slice(0, MAX_REPLY_TEXT) }));
    return { status: 200, body: { replies, zaps: { count, msat }, zappable: !!info?.allowsNostr } satisfies Thread };
  }

  /** Pedido de zap a assinar: zap num evento, para o autor dele. */
  async zapPrepare(raw: unknown): Promise<Reply> {
    if (!this.enabled || !this.identity) return { status: 409, body: { error: 'disabled' } };
    const r = (raw ?? {}) as { eventId?: unknown; author?: unknown; sats?: unknown; comment?: unknown };
    if (typeof r.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(r.eventId) || !isHexKey(r.author)) return { status: 422, body: { error: 'invalid' } };
    if (!Number.isInteger(r.sats) || (r.sats as number) < 1 || (r.sats as number) > 1_000_000) return { status: 422, body: { error: 'invalid', details: ['Valor em sats, de 1 a 1.000.000.'] } };
    const info = await this.payInfoOf(r.author);
    if (!info?.allowsNostr) return { status: 409, body: { error: 'not_zappable', details: ['O autor não tem carteira que aceite zap no perfil.'] } };
    const event = zapRequest({ recipient: r.author, eventId: r.eventId, amountMsat: (r.sats as number) * 1000, relays: this.enabled.relays, lnurl: info.lnurl, content: typeof r.comment === 'string' ? r.comment : '', now: this.now() });
    this.zapPrepared.set(r.eventId, { info });
    return { status: 200, body: { event } };
  }

  /** Fatura do zap. Quem paga é a carteira da pessoa: o núcleo só mostra a fatura conferida. */
  async zapInvoice(raw: unknown): Promise<Reply> {
    const event = (raw as { event?: unknown } | null)?.event;
    if (!verifyEvent(event) || event.kind !== 9734) return { status: 422, body: { error: 'invalid_signature' } };
    if (event.pubkey !== this.identity) return { status: 403, body: { error: 'wrong_identity' } };
    const target = event.tags.find((t) => t[0] === 'e')?.[1] ?? '';
    const p = this.zapPrepared.get(target);
    if (!p) return { status: 409, body: { error: 'not_prepared' } };
    try {
      const invoice = await requestInvoice(p.info, event as NostrEvent, this.opts.fetch, this.opts.resolve);
      this.zapPrepared.delete(target);
      return { status: 200, body: invoice };
    } catch (e) {
      return { status: 502, body: { error: 'invoice', details: [(e as Error).message] } };
    }
  }
}
