// Protocolo do núcleo do OpenSpread (o que o Bullroom recebe). O Bullroom guarda uma cópia exata em
// bullroom/shared/core/types.ts: mudanças aqui só aditivas e copiadas para lá.

/** Cotação normalizada de uma corretora para um par (par invertido já convertido). */
export interface Quote {
  /** Id da corretora na CCXT (ex.: "binance", "coinbaseexchange"). */
  exchange: string;
  /** Par no sentido do OpenSpread (ex.: "USDC/USDT"). */
  pair: string;
  bid: number;
  ask: number;
  /** Taxa taker padrão pública da corretora para o par (fração: 0,001 = 0,1%). Não é a taxa da conta. */
  takerFee: number;
  /** Epoch ms da cotação. */
  at: number;
  /** A corretora lista o par ao contrário (ex.: USDT/USDC) e o preço foi invertido. */
  inverted: boolean;
}

/** Melhor arbitragem entre duas corretoras para um par. Percentuais em % (0,03 = 0,03%). */
export interface SpreadOpportunity {
  pair: string;
  buyOn: string;
  sellOn: string;
  /** (bid de venda − ask de compra) / ask de compra, em %. */
  grossPct: number;
  /** Bruto menos a taxa taker da compra e a da venda, em %. Sem custo de transferência. */
  netPct: number;
}

export interface ExchangeStatus {
  id: string;
  ok: boolean;
  /** Mensagem curta do último erro, quando ok = false. */
  error?: string;
  /** Epoch ms da última cotação recebida. */
  lastAt?: number;
}

export interface PairState {
  pair: string;
  /** Só cotações frescas e válidas. */
  quotes: Quote[];
  best: SpreadOpportunity | null;
}

export interface CoreState {
  rev: number;
  at: number;
  exchanges: ExchangeStatus[];
  /** Só pares com 2 ou mais corretoras ativas. */
  pairs: PairState[];
}

/** O que o núcleo lê e com que frequência (arquivo ~/.openspread/config.json; GET/PUT /v1/config). Sem chaves. */
export interface CoreConfig {
  /** Ids da CCXT (ex.: "binance", "coinbaseexchange"). */
  exchanges: string[];
  /** Pares no sentido do OpenSpread (ex.: "USDC/USDT"). */
  pairs: string[];
  /** Intervalo entre leituras, em ms. */
  pollMs: number;
}

export interface ConfigLimits {
  minExchanges: number;
  maxExchanges: number;
  maxPairs: number;
  minPollMs: number;
  maxPollMs: number;
}

/** Resposta de GET /v1/config. */
export interface ConfigInfo {
  config: CoreConfig;
  limits: ConfigLimits;
  /** Todas as corretoras que a CCXT instalada conhece. */
  known: string[];
}

/** Um par numa corretora, na conferência (POST /v1/check). */
export interface Listing {
  pair: string;
  /** Símbolo na corretora; null = não lista. */
  symbol: string | null;
  inverted: boolean;
  active: boolean;
  /** Taxa taker padrão pública (fração); null quando não lista ou não informa. */
  takerFee: number | null;
}

export interface CheckExchange {
  id: string;
  ok: boolean;
  error?: string;
  listings: Listing[];
}

/** Resposta de POST /v1/check. */
export interface CheckResult {
  at: number;
  exchanges: CheckExchange[];
}
