// O MCP fala com o núcleo só por HTTP local. Ele não abre arquivo nem lê chave: o que o núcleo não expõe, ele não vê.
export class CoreDownError extends Error {
  constructor() {
    super('núcleo desligado');
  }
}

export interface CoreReply {
  status: number;
  body: unknown;
}

export interface CoreClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<CoreReply>;
}

const TIMEOUT_MS = 10_000;

export function httpCoreClient(port: number): CoreClient {
  const base = `http://127.0.0.1:${port}`;
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new CoreDownError();
    }
  };
  return {
    async get(path) {
      const res = await request(path, { method: 'GET' });
      if (!res.ok) throw new Error(`${path} respondeu ${res.status}. O núcleo pode estar desatualizado.`);
      return (await res.json()) as unknown;
    },
    async post(path, body) {
      const res = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
  };
}
