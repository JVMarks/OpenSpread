// Pedido HTTP das fontes on-chain: tempo-limite, JSON, e 429 vira RateLimited (quem chama recua). O `fetch` é
// injetável para os testes rodarem com respostas gravadas, sem rede.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

/** A fonte pediu para esperar (HTTP 429 ou erro de limite do RPC). */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('limite de pedidos da fonte');
  }
}

export class SourceError extends Error {}

const TIMEOUT_MS = 20_000;

/** Avisado a cada pedido respondido (host e duração), para a sala de máquinas contar o uso de cada fonte. */
let onRequest: ((host: string, ms: number) => void) | null = null;
export function setRequestHook(fn: ((host: string, ms: number) => void) | null): void {
  onRequest = fn;
}
const UA = 'OpenSpread-core (read-only; github.com/JVMarks/OpenSpread)';

type Init = { method?: string; headers?: Record<string, string>; body?: string };

export async function getJson(fetchFn: FetchLike, url: string, init: Init = {}): Promise<unknown> {
  const res = await request(fetchFn, url, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  try {
    return await res.json();
  } catch {
    throw new SourceError('a fonte não respondeu JSON');
  }
}

/** Texto (RSS/Atom do radar), no máximo 2 MB. */
export async function getText(fetchFn: FetchLike, url: string, init: Init = {}): Promise<string> {
  const res = await request(fetchFn, url, { ...init, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', ...init.headers } });
  const text = res.text ? await res.text() : String(await res.json());
  if (text.length > 2_000_000) throw new SourceError('a fonte respondeu um arquivo grande demais');
  return text;
}

async function request(fetchFn: FetchLike, url: string, init: Init): Promise<Awaited<ReturnType<FetchLike>>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  const started = performance.now();
  try {
    res = await fetchFn(url, { ...init, headers: { 'User-Agent': UA, ...init.headers }, signal: ctl.signal });
  } catch (e) {
    throw new SourceError(ctl.signal.aborted ? `sem resposta em ${TIMEOUT_MS / 1000} s` : `sem conexão (${(e as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
  try {
    onRequest?.(new URL(url).host, performance.now() - started);
  } catch {
    // contar o uso nunca derruba um pedido
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    throw new RateLimited(Number.isFinite(after) && after > 0 ? after * 1000 : null);
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) throw new SourceError(`a fonte recusou o pedido (HTTP ${res.status}); pode precisar de chave`);
  if (res.status >= 500) throw new SourceError(`a fonte respondeu HTTP ${res.status} (fora do ar, ou endereço com movimento demais para ela)`);
  if (res.status < 200 || res.status >= 300) throw new SourceError(`a fonte respondeu HTTP ${res.status}`);
  return res;
}

/** Uma pausa curta entre pedidos à mesma fonte (o RPC público da Solana limita por segundo). */
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
