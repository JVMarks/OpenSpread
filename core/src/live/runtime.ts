// Liga o modo real no núcleo: config, chaves, permissões e gerente. Qualquer falha deixa desligado, com o motivo.
// Sem OPENSPREAD_LIVE=1 nada aqui toca em chave nem abre conexão autenticada.
import { join } from 'node:path';
import type { CoreState, LiveBrief, LiveState } from '../types';
import { CcxtLiveClient, createExchange, permissionReader } from './ccxt-client';
import { loadLiveConfig, type LiveConfig } from './config';
import { loadCredentials } from './credentials';
import { LiveEngine } from './engine';
import { HARD_LIMITS } from './limits';
import { LiveManager, type ApproveResult } from './manager';
import { checkPermissions } from './permissions';

export const BALANCE_MS = 15_000;
const RP_ID = 'localhost';
/** A passkey só existe em `localhost`: 127.0.0.1 não pode ser identificador de WebAuthn. */
export const PASSKEY_ORIGINS = ['http://localhost:5173', 'http://localhost:4747'];

export type LiveReply = { status: number; body: unknown };

const OFF_STATE = (off: string, sandbox = false): LiveState => ({
  armed: false,
  off,
  sandbox,
  halted: null,
  exposures: [],
  ticket: null,
  blocked: [],
  passkey: { registered: false, registerOpen: false },
  releaseChallenge: null,
  today: { pnlUsd: 0, trades: 0, expired: 0, refused: 0 },
  limits: { maxTradeUsd: HARD_LIMITS.maxTradeUsd, dailyLossLimitUsd: HARD_LIMITS.dailyLossLimitUsd, tradesPerDay: HARD_LIMITS.tradesPerDay },
  balances: {},
  balanceAt: null,
  fills: [],
});

export class LiveRuntime {
  private manager: LiveManager | null = null;
  private off: string;
  private sandbox = false;
  private revBase = 0;

  constructor(
    private readonly configDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: (m: string) => void,
  ) {
    this.off = 'Modo real desligado.';
  }

  get rev(): number {
    return this.revBase + (this.manager?.rev ?? 0);
  }

  async start(): Promise<void> {
    const config = loadLiveConfig(join(this.configDir, 'live.json'), this.env);
    if ('off' in config) {
      this.off = config.off;
      return;
    }
    this.sandbox = config.sandbox;
    this.off = 'Conferindo as chaves nas corretoras…';
    this.revBase += 1;
    try {
      await this.arm(config);
    } catch (e) {
      this.off = `Modo real desligado: não consegui preparar as corretoras (${(e as Error).constructor.name}).`;
      this.log(this.off);
    }
    this.revBase += 1;
  }

  private async arm(config: LiveConfig): Promise<void> {
    const credentials = loadCredentials(join(this.configDir, 'exchange-keys.json'), this.env, this.log);
    const needed = [...new Set(config.routes.flatMap((r) => r.exchanges))];
    const missing = needed.filter((id) => !credentials.has(id));
    if (missing.length) {
      this.off = `Modo real desligado: falta a chave de ${missing.join(', ')}.`;
      return;
    }
    const clients = new Map<string, CcxtLiveClient>();
    for (const id of needed) {
      const credential = credentials.get(id);
      if (!credential) continue;
      const ex = createExchange(id, credential, config.sandbox);
      const permission = await checkPermissions(id, permissionReader(id, ex), config.sandbox);
      if (!permission.ok) {
        this.off = `Modo real desligado: ${permission.reason}`;
        return;
      }
      await ex.loadMarkets();
      clients.set(id, new CcxtLiveClient(id, ex, credential));
    }
    const assets = new Set(config.routes.flatMap((r) => r.pair.split('/')));
    const manager = new LiveManager({
      dir: join(this.configDir, 'live'),
      config,
      engine: new LiveEngine(clients),
      origins: PASSKEY_ORIGINS,
      rpId: RP_ID,
      registerOpen: this.env.OPENSPREAD_LIVE_REGISTER === '1',
      readBalances: async () => Object.fromEntries(await Promise.all([...clients].map(async ([id, c]) => [id, await c.freeBalance(assets)] as const))),
      minOrderUsd: (id, pair) => clients.get(id)?.minOrderUsd(pair),
      log: this.log,
    });
    manager.load();
    this.manager = manager;
    await manager.reconcile();
    await manager.refreshBalances();
    setInterval(() => void manager.refreshBalances(), BALANCE_MS).unref();
    this.log(`modo real armado (${config.sandbox ? 'ambiente de teste, sem dinheiro' : 'DINHEIRO REAL'}): ${config.routes.length} rota(s), teto de US$ ${config.maxTradeUsd} por operação`);
  }

  tick(state: CoreState): void {
    this.manager?.tick(state);
  }

  /** Vai em todo estado do núcleo, que qualquer Host pode ler: nada de saldo, ficha ou desafio. */
  brief(): LiveBrief {
    const s = this.manager?.state();
    return { armed: !!this.manager, sandbox: this.sandbox, halted: !!s?.halted, exposures: s?.exposures.length ?? 0, ticketOpen: !!s?.ticket, rev: this.rev };
  }

  /** Só pela rota protegida. */
  state(): LiveState {
    return this.manager?.state() ?? OFF_STATE(this.off, this.sandbox);
  }

  private get armed(): LiveManager | null {
    return this.manager;
  }

  private static notArmed: LiveReply = { status: 409, body: { error: 'not_armed' } };

  approve(id: string, raw: unknown, current: CoreState): Promise<LiveReply> | LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    const proof = (raw as { proof?: unknown } | null)?.proof;
    return m.approve(id, proof, current).then((r: ApproveResult) => (r.ok ? { status: 200, body: r } : { status: r.code === 'proof' ? 403 : 409, body: r }));
  }

  reject(id: string): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    return m.reject(id) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not_found' } };
  }

  stop(): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    m.stop();
    return { status: 200, body: { ok: true } };
  }

  release(raw: unknown): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    const r = m.release((raw as { proof?: unknown } | null)?.proof);
    return { status: r.ok ? 200 : 403, body: r };
  }

  unwind(raw: unknown, current: CoreState): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    const index = (raw as { index?: unknown } | null)?.index;
    if (!Number.isInteger(index)) return { status: 422, body: { error: 'invalid' } };
    const r = m.proposeUnwind(index as number, current);
    return { status: r.ok ? 200 : 409, body: r };
  }

  registrationChallenge(): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    const challenge = m.registrationChallenge();
    return challenge ? { status: 200, body: { challenge, rpId: RP_ID } } : { status: 409, body: { error: 'registration_closed' } };
  }

  register(raw: unknown): LiveReply {
    const m = this.armed;
    if (!m) return LiveRuntime.notArmed;
    const r = m.register(raw);
    return { status: r.ok ? 201 : 403, body: r };
  }
}
