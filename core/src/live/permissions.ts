// Chave com permissão de saque é recusada, e permissão que não dá para ler também. Campos conferidos em 05/11/2026 na
// documentação de cada corretora: Binance account/apiRestrictions, OKX account/config (perm), Bybit v5/user/query-api.
export type PermissionResult = { ok: true } | { ok: false; reason: string };

const WITHDRAW = (id: string): PermissionResult => ({ ok: false, reason: `A chave de ${id} tem permissão de saque. Crie uma chave só de negociação, sem saque.` });
const UNKNOWN = (id: string): PermissionResult => ({ ok: false, reason: `Não consegui confirmar que a chave de ${id} não tem saque.` });
const NO_TRADE = (id: string): PermissionResult => ({ ok: false, reason: `A chave de ${id} não pode negociar à vista.` });

export function readPermission(exchange: string, raw: unknown): PermissionResult {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r !== 'object') return UNKNOWN(exchange);
  if (exchange === 'binance') {
    if (r.enableWithdrawals === true) return WITHDRAW(exchange);
    if (r.enableWithdrawals !== false) return UNKNOWN(exchange);
    return r.enableSpotAndMarginTrading === true ? { ok: true } : NO_TRADE(exchange);
  }
  if (exchange === 'okx') {
    const perm = Array.isArray(r.data) ? r.data[0]?.perm : undefined;
    if (typeof perm !== 'string') return UNKNOWN(exchange);
    const list = perm.split(',').map((p) => p.trim());
    if (list.includes('withdraw')) return WITHDRAW(exchange);
    return list.includes('trade') ? { ok: true } : NO_TRADE(exchange);
  }
  if (exchange === 'bybit') {
    const result = r.result as { readOnly?: unknown; permissions?: { Wallet?: unknown; Spot?: unknown } } | undefined;
    const wallet = result?.permissions?.Wallet;
    if (!Array.isArray(wallet)) return UNKNOWN(exchange);
    if (wallet.includes('Withdraw')) return WITHDRAW(exchange);
    if (result?.readOnly !== 0 && result?.readOnly !== '0') return NO_TRADE(exchange);
    return { ok: true };
  }
  return UNKNOWN(exchange);
}

/** `sandbox`: não consulta, porque a Binance Testnet não tem essa rota e ali não há dinheiro. Dinheiro real sempre consulta. */
export async function checkPermissions(exchange: string, read: () => Promise<unknown>, sandbox: boolean): Promise<PermissionResult> {
  if (sandbox) return { ok: true };
  try {
    return readPermission(exchange, await read());
  } catch {
    return UNKNOWN(exchange);
  }
}
