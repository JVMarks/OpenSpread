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
  /** Custo de sacar a moeda-base da corretora de compra (presente quando o núcleo tem a configuração de transferência). */
  transfer?: TransferCost;
}

/** Saque da moeda-base de `from` (onde se compra) para a corretora de venda, sobre um tamanho de operação. */
export interface TransferCost {
  asset: string;
  from: string;
  /** Taxa de saque informada pelo usuário (quantidade da moeda); null = não informada. */
  fee: number | null;
  sizeUsd: number;
  /** Custo do saque em % do tamanho; null quando não dá para estimar. */
  costPct: number | null;
  /** Líquido já com o saque, em %; null quando não dá para estimar. */
  netPct: number | null;
  /** Por que não deu para estimar: taxa não informada ou cotação que não é estável. */
  missing?: 'fee' | 'quote';
}

/** Tamanho da operação e taxas de saque informadas: { corretora: { moeda: quantidade } }. */
export interface TransferConfig {
  sizeUsd: number;
  withdrawFees: Record<string, Record<string, number>>;
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
  /** Variação do melhor spread líquido (com saque, quando estimado) em janelas de tempo; ausente em núcleos antigos. */
  windows?: SpreadWindows;
}

export type SpreadWindowId = '5m' | '1h' | '24h';

/** Por janela: quanto o líquido mudou (pontos percentuais) e o mínimo e o máximo nela; null = ainda sem histórico. */
export type SpreadWindows = Record<SpreadWindowId, { changePp: number; min: number; max: number } | null>;

export interface CoreState {
  rev: number;
  at: number;
  exchanges: ExchangeStatus[];
  /** Só pares com 2 ou mais corretoras ativas. */
  pairs: PairState[];
  /** Alertas de spread que tocaram por último (mais antigo primeiro). Ausente em núcleos antigos. */
  alerts?: AlertEvent[];
  /** Carteiras on-chain acompanhadas (resultado, operações, ranking). Ausente em núcleos antigos. */
  wallets?: WalletsState;
  /** Sala de máquinas: saúde do núcleo e uso de cada fonte. Ausente em núcleos antigos. */
  machine?: MachineState;
  /** Agenda (datas oficiais + do usuário) e radar de manchetes. Ausente em núcleos antigos. */
  agenda?: AgendaState;
  /** Motor de paper trading. Ausente quando desligado: tudo aqui é simulado. */
  engine?: EngineState;
  /** Análises registradas e placar. Ausente em núcleos antigos. */
  analyses?: AnalysesBrief;
}

/** "Avise quando o spread líquido do par chegar a X%." Toca uma vez; rearma quando o spread recua. */
export interface SpreadAlert {
  pair: string;
  /** Nível em % (0,05 = 0,05%), comparado ao spread líquido do melhor par de corretoras. */
  abovePct: number;
}

/** Um alerta que tocou. */
export interface AlertEvent {
  /** Único por execução do núcleo. */
  id: string;
  pair: string;
  abovePct: number;
  netPct: number;
  buyOn: string;
  sellOn: string;
  at: number;
}

/** O que o núcleo lê e com que frequência (arquivo ~/.openspread/config.json; GET/PUT /v1/config). Sem chaves. */
export interface CoreConfig {
  /** Ids da CCXT (ex.: "binance", "coinbaseexchange"). */
  exchanges: string[];
  /** Pares no sentido do OpenSpread (ex.: "USDC/USDT"). */
  pairs: string[];
  /** Intervalo entre leituras, em ms. */
  pollMs: number;
  /** Alertas de spread, um por par no máximo. */
  alerts: SpreadAlert[];
  /** Custo de transferência (saque) para o líquido "com transferência". */
  transfer: TransferConfig;
  /** Carteiras públicas on-chain acompanhadas (lista do usuário). Ausente em núcleos antigos = nenhuma. */
  wallets?: WalletRef[];
  /** Descoberta de carteiras pelos top traders de tokens escolhidos (precisa da chave do Birdeye). */
  discovery?: DiscoveryConfig;
  /** Eventos do usuário na agenda. Ausente = nenhum. */
  events?: UserEvent[];
  /** Feeds do radar. Ausente = radar desligado. */
  radar?: RadarConfig;
  /** Motor de paper trading. Ausente = desligado. */
  engine?: EngineConfig;
}

export interface ConfigLimits {
  minExchanges: number;
  maxExchanges: number;
  maxPairs: number;
  minPollMs: number;
  maxPollMs: number;
  maxAlerts: number;
  /** Faixa aceita para o nível do alerta, em %. */
  minAlertPct: number;
  maxAlertPct: number;
  minSizeUsd: number;
  maxSizeUsd: number;
  maxWallets?: number;
  maxDiscoveryTokens?: number;
  maxPerToken?: number;
  maxEvents?: number;
  maxFeeds?: number;
}

/** Resposta de GET /v1/config. */
export interface ConfigInfo {
  config: CoreConfig;
  limits: ConfigLimits;
  /** Todas as corretoras que a CCXT instalada conhece. */
  known: string[];
  /** Quais chaves de dados existem na máquina (só se existem; o valor nunca sai do núcleo). */
  keys?: { birdeye: boolean; blockscout: boolean };
  /** Valores sugeridos para quem ainda não tem `engine` no config. */
  engineDefaults?: EngineConfig;
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

// --- Carteiras on-chain: só dados públicos, só leitura. Nada de aviso de "comprou", nada de copiar. ---

export type WalletChain = 'solana' | 'ethereum' | 'base' | 'bitcoin';

/** Uma carteira acompanhada: só a rede e o endereço (nunca nome de pessoa). */
export interface WalletRef {
  chain: WalletChain;
  /** Solana em base58; EVM em minúsculas; Bitcoin como na rede (bech32 em minúsculas). */
  address: string;
}

/** Tokens cujos top traders entram como carteiras "descoberta · Birdeye", separadas da lista do usuário. */
export interface DiscoveryConfig {
  tokens: Array<{ chain: Exclude<WalletChain, 'bitcoin'>; address: string }>;
  /** Quantas carteiras por token (as de maior volume no período do Birdeye). */
  perToken: number;
}

/**
 * buy/sell = troca de um token pela moeda de cotação (SOL, ETH ou USD em stablecoin); in/out = só entrou ou só saiu;
 * unclassified = mexeu em mais de uma coisa e não deu para dizer o que foi (fica na lista, não some).
 */
export type WalletOpKind = 'buy' | 'sell' | 'in' | 'out' | 'unclassified';

/** Uma operação normalizada de uma carteira. */
export interface WalletOp {
  /** Hash ou assinatura da transação. */
  tx: string;
  /** Epoch ms do bloco. */
  at: number;
  kind: WalletOpKind;
  /** Símbolo curto do ativo (ou o endereço do token encurtado); null em unclassified. */
  asset: string | null;
  /** Endereço do token (mint ou contrato); null na moeda da rede. */
  assetId: string | null;
  /** Quantidade do ativo (positiva). */
  amount: number | null;
  /** Moeda de cotação: 'SOL', 'ETH' ou 'USD' (USDC, USDT e DAI juntos); null fora de compra e venda. */
  quote: string | null;
  /** Quanto da cotação saiu (compra) ou entrou (venda), já com a taxa da rede. */
  quoteAmount: number | null;
  /** Resultado realizado desta venda (FIFO, na moeda de cotação); ausente quando não fecha compra conhecida. */
  pnl?: number;
  /** Link público no explorador da rede. */
  url: string;
}

/** Resultado realizado no período numa moeda de cotação. */
export interface WalletResult {
  quote: string;
  amount: number;
}

export interface WalletState {
  chain: WalletChain;
  address: string;
  /** Lista do usuário ou descoberta pelos top traders. */
  source: 'curated' | 'birdeye';
  ok: boolean;
  error?: string;
  /** Epoch ms da última leitura com sucesso. */
  lastAt?: number;
  /** Hora da operação mais antiga lida (o período pode começar antes dela). */
  since: number | null;
  /** Resultado realizado no período, por moeda de cotação. */
  results: WalletResult[];
  /** Vendas no período que fecharam compra conhecida; acertos (resultado > 0) e erros (< 0) entre elas. */
  trades: number;
  wins: number;
  losses: number;
  /** Tem compra ainda não vendida (posição aberta). */
  open: boolean;
  /** Saldo na moeda da rede quando a fonte dá de graça (Bitcoin). */
  balance?: { asset: string; amount: number };
  /** Últimas operações (mais nova primeiro). */
  ops: WalletOp[];
  /** O número do próprio Birdeye ao lado do nosso (só na descoberta). */
  external?: { source: 'birdeye'; token: string; volumeUsd?: number; trades?: number; pnlUsd?: number };
  /** Link da carteira no explorador. */
  url: string;
}

/** Melhores e piores de uma rede numa moeda de cotação (endereços; só quem fechou operação no período). */
export interface WalletRanking {
  chain: WalletChain;
  quote: string;
  best: string[];
  worst: string[];
}

/** Situação da leitura de uma rede. */
export interface WalletSource {
  chain: WalletChain;
  /** De onde vêm os dados (ex.: "api.mainnet-beta.solana.com"). */
  source: string;
  ok: boolean;
  error?: string;
  /** Esperando por limite de taxa até este epoch ms. */
  backoffUntil?: number;
}

export interface WalletsState {
  at: number;
  /** Período do resultado, em ms (fixo). */
  periodMs: number;
  wallets: WalletState[];
  ranking: WalletRanking[];
  sources: WalletSource[];
}

// --- Sala de máquinas: saúde do núcleo e uso de cada fonte (só números locais) ---

/** Uma fonte de dados do núcleo: corretora (CCXT), rede on-chain ou feed (agenda e radar). */
export interface MachineSource {
  /** Id da corretora na CCXT, ou o host da fonte (ex.: "api.mainnet-beta.solana.com"). */
  id: string;
  kind: 'exchange' | 'chain' | 'feed';
  /** Rede, quando a fonte é on-chain. */
  chain?: WalletChain;
  ok: boolean;
  error?: string;
  /** Duração do último pedido, em ms. */
  latencyMs?: number;
  /** Pedidos no último minuto. */
  perMin: number;
  /** Limite conhecido de pedidos por minuto; null = não publicado. */
  limitPerMin: number | null;
  /** Esperando por limite de taxa até este epoch ms. */
  backoffUntil?: number;
}

export interface MachineState {
  at: number;
  /** CPU do processo do núcleo, em % de um núcleo do processador. */
  cpuPct: number;
  /** Memória do processo (residente e heap do JS), em MB. */
  rssMb: number;
  heapMb: number;
  /** Memória do computador em uso, em %. */
  sysMemPct: number;
  /** Há quanto tempo o núcleo está rodando, em segundos. */
  uptimeS: number;
  sources: MachineSource[];
}

// --- Agenda e radar (calendário com impacto e manchetes "só o que é novo"; manchete é pista, não fato) ---

export type AgendaImpact = 'high' | 'medium' | 'low';

/** Evento cadastrado pelo usuário no config (listagem, desbloqueio de token, atualização de rede…). */
export interface UserEvent {
  title: string;
  /** Data e hora ISO 8601 com fuso (ex.: "2026-11-20T14:00:00-03:00"). */
  at: string;
  impact: AgendaImpact;
  /** Pares afetados; ausente ou vazio = todas as salas. */
  pairs?: string[];
}

/** Feeds RSS/Atom do radar e palavras extras que ligam uma manchete a todas as salas. */
export interface RadarConfig {
  feeds: string[];
  keywords: string[];
}

export interface AgendaEvent {
  id: string;
  title: string;
  kind: 'fomc' | 'cpi' | 'user';
  /** Epoch ms. */
  at: number;
  impact: AgendaImpact;
  /** De onde veio a data ("federalreserve.gov", "bls.gov" ou "config"). */
  source: string;
  url?: string;
  origin: 'official' | 'user';
  /** Pares afetados; vazio = todas as salas. */
  pairs: string[];
}

export interface RadarItem {
  /** O link (único). */
  id: string;
  title: string;
  url: string;
  /** Epoch ms da publicação. */
  at: number;
  /** Host do feed. */
  source: string;
  /** Salas (pares) que a manchete cita. */
  pairs: string[];
}

export interface AgendaState {
  at: number;
  /** Do último dia até 14 dias à frente. */
  events: AgendaEvent[];
  /** Manchetes dos últimos 7 dias, mais novas primeiro. */
  radar: RadarItem[];
  feeds: Array<{ url: string; ok: boolean; error?: string; lastAt?: number }>;
}

// --- Motor (etapa 3: só paper). A trava de risco decide; os limites vêm só do usuário. ---

/** Limites que toda operação precisa respeitar. Valores em dólar; percentuais em % (0,05 = 0,05%). */
export interface RiskPolicy {
  maxTradeUsd: number;
  minNetPct: number;
  maxQuoteAgeMs: number;
  /** Perda diária máxima por robô (positivo). */
  dailyLossLimitUsd: number;
  /** Pares que podem operar; vazio = nada opera. */
  allowedPairs: string[];
}

export interface RiskReason {
  /** Estável, para a interface traduzir (ex.: "no_balance_buy"). */
  code: string;
  message: string;
  /** O que fazer para destravar. */
  fix: string;
}

export interface RiskVerdict {
  result: 'PASS' | 'BLOCK';
  reasons: RiskReason[];
  /** sha256 da operação exata + dia UTC. */
  fingerprint: string;
  checkedAt: number;
}

/** O motor no config: limites e capital simulado. A IA nunca muda estes valores. */
export interface EngineConfig {
  enabled: boolean;
  policy: RiskPolicy;
  /** Capital total simulado, em dólar. */
  totalUsd: number;
  /** % do total guardada, que nenhum robô usa. */
  reservePct: number;
  /** Teto de cada robô, em % do total. */
  capPct: number;
  /** Capital mínimo de um robô, em dólar. */
  minUsd: number;
  /** Espera entre decidir e ler o livro, em ms. */
  latencyMs: number;
  /** Pausa mínima entre operações do mesmo robô, em ms. */
  cooldownMs: number;
}

export type EngineBotStatus = 'running' | 'parked' | 'stopped' | 'ejected';

/** Um robô simulado: arbitragem de um par entre duas corretoras, nos dois sentidos. */
export interface EngineBot {
  id: string;
  /** Quem ligou. Ausente em robôs antigos = usuário. */
  source?: 'user' | 'mcp';
  pair: string;
  exchanges: [string, string];
  capitalUsd: number;
  startedAt: number;
  status: EngineBotStatus;
  /** Por que parou. */
  statusReason?: string;
  /** Resultado desde que ligou, já com as taxas. */
  pnlUsd: number;
  pnlTodayUsd: number;
  feesUsd: number;
  trades: number;
  wins: number;
  losses: number;
  /** Maior queda do resultado acumulado desde um pico (positivo). */
  maxDrawdownUsd: number;
  /** Saldos simulados: { corretora: { moeda: quantidade } }. */
  balances: Record<string, Record<string, number>>;
  /** Leituras do par desde que ligou. */
  samples: number;
  /** Quantas dessas leituras ficaram no líquido mínimo ou acima dele. */
  samplesAbove: number;
  /** Resultado acumulado depois de cada operação (últimas 60). */
  series: number[];
}

/** Uma operação simulada, com as duas pernas. */
export interface EngineFill {
  id: string;
  botId: string;
  at: number;
  pair: string;
  buyOn: string;
  sellOn: string;
  /** Quantidade da moeda-base. */
  base: number;
  buyAvg: number;
  sellAvg: number;
  feesUsd: number;
  pnlUsd: number;
  /** Líquido visto ao decidir, em %. */
  quotedNetPct: number;
  /** Líquido depois de executar, em %. */
  realizedNetPct: number;
  /** O livro não tinha o tamanho pedido. */
  partial: boolean;
}

export interface EngineBlock {
  botId: string;
  at: number;
  reasons: RiskReason[];
}

export interface EngineState {
  at: number;
  engine: { kind: 'paper'; ok: boolean; error?: string };
  mode: 'paper';
  bots: EngineBot[];
  /** Últimas operações, mais nova primeiro. */
  fills: EngineFill[];
  /** Últimos bloqueios da trava, mais novo primeiro. */
  blocks: EngineBlock[];
  latencyMs: number;
  /** Perda diária máxima por robô, da política. */
  dailyLossLimitUsd: number;
}

// --- Análises (etapa 4). A IA do usuário registra; o preço de referência e o resultado vêm só do núcleo. ---

export type AnalysisHorizon = '1h' | '4h' | '24h' | '7d';
export type AnalysisDirection = 'up' | 'down';

export interface AnalysisFactor {
  name: string;
  category: 'technical' | 'derivatives' | 'macro' | 'sentiment' | 'onchain' | 'spread';
  effect: 'supports' | 'neutral' | 'weakens';
  note?: string;
}

export interface AnalysisPlan {
  label: 'A' | 'B';
  /** `market` entra na referência; `confirmation` entra quando o preço toca `entry`. */
  kind: 'market' | 'confirmation';
  entry?: number;
  stop: number;
  /** O primeiro alvo fecha o plano. */
  targets: number[];
}

/** O que o cliente manda. Nenhum campo de preço de referência: esse é do núcleo. */
export interface AnalysisInput {
  pair: string;
  horizon: AnalysisHorizon;
  direction: AnalysisDirection;
  /** Probabilidade declarada de a direção acertar, de 50 a 100. */
  conviction: number;
  factors: AnalysisFactor[];
  plans: AnalysisPlan[];
  reasoning: string;
  /** Rótulo declarado pelo cliente; não é prova de qual modelo escreveu. */
  model: string;
  usedChart: boolean;
}

export interface Analysis extends AnalysisInput {
  id: string;
  submittedAt: number;
  /** submittedAt + horizonte. */
  expiresAt: number;
  referencePrice: number;
  /** Custo de ida e volta (duas taxas taker), em %. */
  costPct: number;
  /** Quantas corretoras formaram a referência. */
  exchanges: number;
}

export interface PlanResult {
  label: 'A' | 'B';
  /** target/stop = tocou; closed = fechou no vencimento; not_triggered = não entrou; void = faltaram dados. */
  status: 'target' | 'stop' | 'closed' | 'not_triggered' | 'void';
  entryPrice?: number;
  exitPrice?: number;
  /** Já com as duas taxas, em %. */
  netPct?: number;
}

export interface AnalysisResult {
  id: string;
  pair: string;
  model: string;
  horizon: AnalysisHorizon;
  direction: AnalysisDirection;
  conviction: number;
  /** void = sem amostra até 15 min depois do vencimento: conta à parte, nunca some. */
  status: 'resolved' | 'void';
  reason?: 'no_data';
  hit?: boolean;
  closePrice?: number;
  /** Variação da referência ao fechamento, em %. */
  movePct?: number;
  resolvedAt: number;
  plans: PlanResult[];
}

export interface CalibrationBin {
  from: number;
  to: number;
  n: number;
  /** Convicção média, em %; null sem amostra. */
  meanConviction: number | null;
  /** Acerto observado, em %; null sem amostra. */
  hitPct: number | null;
}

export interface ScoreLine {
  /** Ausentes na linha do total. */
  model?: string;
  horizon?: AnalysisHorizon;
  submitted: number;
  open: number;
  resolved: number;
  voids: number;
  hits: number;
  /** % de acerto; null abaixo da amostra mínima. */
  hitPct: number | null;
  /** Média de (probabilidade − resultado)²; null sem resolvidas. */
  brier: number | null;
  /** Sempre 0,25: o de quem diz 50% em tudo. */
  baselineBrier: number;
  /** 1 − brier / 0,25: acima de 0 bate o chute. Null sem resolvidas. */
  skill: number | null;
  calibration: CalibrationBin[];
  plans: { triggered: number; avgNetPct: number | null; worstNetPct: number | null };
}

export interface Scoreboard {
  /** Abaixo disto, `hitPct` fica null. */
  minSample: number;
  total: ScoreLine;
  byModel: ScoreLine[];
}

/** Resposta de GET /v1/analyses: completa, com o raciocínio. */
export interface AnalysesState {
  at: number;
  scoreboard: Scoreboard;
  open: Analysis[];
  /** Resolvidas, mais novas primeiro. */
  recent: Array<{ analysis: Analysis; result: AnalysisResult }>;
  notice: string;
}

/** Versão curta que vai em `CoreState.analyses` a cada leitura: sem raciocínio nem fatores. */
export interface AnalysesBrief {
  scoreboard: Scoreboard;
  items: Array<{
    id: string;
    pair: string;
    model: string;
    horizon: AnalysisHorizon;
    direction: AnalysisDirection;
    conviction: number;
    submittedAt: number;
    expiresAt: number;
    referencePrice: number;
    result?: Pick<AnalysisResult, 'status' | 'hit' | 'movePct' | 'resolvedAt' | 'plans'>;
  }>;
}
