// Tetos do modo real. Ficam no código de propósito: nenhum config passa deles, e subir exige mudar o código.
export const HARD_LIMITS = Object.freeze({
  maxTradeUsd: 50,
  dailyLossLimitUsd: 25,
  tradesPerDay: 20,
  openTickets: 1,
  /** Validade de uma ficha, em ms. */
  ticketMs: 20_000,
  /** Idade máxima do saldo lido na corretora, em ms. */
  balanceAgeMs: 30_000,
  /** Maior desvio aceito sobre a cotação da ficha, em %. */
  maxSlippagePct: 0.5,
});

/** Só onde há ambiente de teste no CCXT e rota para conferir a permissão da chave. */
export const LIVE_EXCHANGES: readonly string[] = ['binance', 'okx', 'bybit'];
