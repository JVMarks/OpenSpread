// Trava de risco do motor: PASS ou BLOCK, com o motivo e a correção. Toda operação passa por aqui antes de chegar ao
// motor, e os limites só vêm do config do usuário (a IA nunca muda um limite). Puro: sem rede, disco ou relógio próprio.
// Ideia do trader-risk (github.com/Jakeschincariol/trader-skill, MIT), reescrita aqui e somada às regras de
// arbitragem: as duas pernas, saldo em cada corretora, cotação velha, corretora com erro e spread líquido mínimo.
import { createHash } from 'node:crypto';
import type { RiskPolicy, RiskReason, RiskVerdict } from '../types';

/** Uma arbitragem proposta: comprar em `buyOn` e vender em `sellOn`, no mesmo instante. */
export interface ProposedTrade {
  botId: string;
  /** Par no sentido do OpenSpread (ex.: "BTC/USDT"). */
  pair: string;
  buyOn: string;
  sellOn: string;
  sizeUsd: number;
  /** Spread líquido estimado, em % (0,05 = 0,05%). */
  netPct: number;
  /** Etapa 3: só paper. Conferido também em execução, porque a operação pode vir de JSON. */
  mode: 'paper';
}

/** O que a trava precisa saber do mundo agora. Faltou um dado: a regra bloqueia, nunca assume que está tudo bem. */
export interface RiskContext {
  now: number;
  /** Saldos: { corretora: { moeda: quantidade } }. */
  balances: Record<string, Record<string, number>>;
  /** Preço em dólar de cada moeda, para comparar saldo e tamanho. */
  priceUsd: Record<string, number>;
  /** Epoch ms do recebimento da última cotação de cada corretora. */
  quoteAt: Record<string, number>;
  exchangeOk: Record<string, boolean>;
  /** Ordem mínima de cada corretora em dólar; corretora fora da lista = mínimo não informado. */
  minOrderUsd: Record<string, number>;
  /** PL do robô hoje. */
  pnlTodayUsd: number;
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** sha256 da operação exata + dia UTC: operação editada ou veredito de ontem exigem nova checagem. */
export function fingerprint(t: ProposedTrade, day: string): string {
  const exact = [t.botId, t.pair, t.buyOn, t.sellOn, t.sizeUsd, t.netPct, t.mode, day];
  return createHash('sha256').update(JSON.stringify(exact)).digest('hex');
}

const usableSize = (t: ProposedTrade): boolean => Number.isFinite(t.sizeUsd) && t.sizeUsd > 0;

export function checkTrade(t: ProposedTrade, ctx: RiskContext, policy: RiskPolicy): RiskVerdict {
  const reasons: RiskReason[] = [];
  const block = (code: string, message: string, fix: string) => reasons.push({ code, message, fix });
  const [base, quote] = t.pair.split('/');
  const exchanges = t.buyOn === t.sellOn ? [t.buyOn] : [t.buyOn, t.sellOn];

  if (t.mode !== 'paper') block('mode_not_paper', `Modo "${String(t.mode)}" recusado: esta etapa só opera em paper.`, 'Use o modo paper.');
  if (!policy.allowedPairs.includes(t.pair)) block('pair_not_allowed', `${t.pair} não está na lista de pares permitidos.`, 'Inclua o par na política de risco, se quiser operá-lo.');
  if (!Number.isFinite(t.netPct) || t.netPct < policy.minNetPct) block('net_below_min', `Líquido de ${t.netPct}% abaixo do mínimo de ${policy.minNetPct}%.`, 'Espere um spread maior ou revise o mínimo na política.');
  if (ctx.pnlTodayUsd <= -policy.dailyLossLimitUsd) block('daily_loss_hit', `Perda de hoje (US$ ${ctx.pnlTodayUsd}) chegou ao limite de US$ ${policy.dailyLossLimitUsd}.`, 'O robô volta a operar só amanhã.');
  if (t.buyOn === t.sellOn) block('same_exchange', `As duas pernas estão em ${t.buyOn}.`, 'Escolha duas corretoras diferentes.');

  for (const exchange of exchanges) {
    const at = ctx.quoteAt[exchange];
    if (at === undefined || ctx.now - at > policy.maxQuoteAgeMs) block('stale_quote', `Cotação de ${exchange} velha ou ausente.`, 'Espere uma cotação nova da corretora.');
    if (ctx.exchangeOk[exchange] !== true) block('exchange_down', `${exchange} está com erro.`, 'Espere a corretora voltar.');
  }

  if (!usableSize(t)) {
    block('invalid_size', `Tamanho inválido: ${t.sizeUsd}.`, 'Informe um tamanho maior que zero.');
  } else {
    if (t.sizeUsd > policy.maxTradeUsd) block('trade_too_large', `US$ ${t.sizeUsd} passa do máximo de US$ ${policy.maxTradeUsd} por operação.`, 'Reduza o tamanho da operação.');
    for (const exchange of exchanges) {
      const min = ctx.minOrderUsd[exchange];
      if (min !== undefined && t.sizeUsd < min) block('below_exchange_min', `US$ ${t.sizeUsd} abaixo do mínimo de US$ ${min} em ${exchange}.`, 'Aumente o tamanho ou troque de corretora.');
    }
    // Compra gasta a moeda de cotação em buyOn; venda gasta a moeda-base em sellOn.
    const leg = (asset: string | undefined, exchange: string, code: string) => {
      const price = asset === undefined ? undefined : ctx.priceUsd[asset];
      if (price === undefined || !(price > 0)) {
        block('no_price', `Sem preço em dólar para ${asset ?? t.pair}.`, 'Espere uma cotação da moeda.');
        return;
      }
      const have = ctx.balances[exchange]?.[asset as string] ?? 0;
      if (have * price < t.sizeUsd) block(code, `Saldo de ${asset} em ${exchange} (${Number(have.toPrecision(4))}) não cobre US$ ${Math.round(t.sizeUsd * 100) / 100}.`, 'Robô parado até haver saldo nessa corretora.');
    };
    leg(quote, t.buyOn, 'no_balance_buy');
    leg(base, t.sellOn, 'no_balance_sell');
  }

  return { result: reasons.length ? 'BLOCK' : 'PASS', reasons, fingerprint: fingerprint(t, utcDay(ctx.now)), checkedAt: ctx.now };
}

/**
 * Confere em sequência, como se cada operação aprovada já tivesse saído: desconta o que ela gasta. Não soma o que ela
 * renderia, porque uma perna pode falhar e aí esse saldo não existe. Não muda o contexto recebido.
 */
export function checkBatch(ts: readonly ProposedTrade[], ctx: RiskContext, policy: RiskPolicy): RiskVerdict[] {
  const balances: RiskContext['balances'] = Object.fromEntries(Object.entries(ctx.balances).map(([e, b]) => [e, { ...b }]));
  const spend = (exchange: string, asset: string | undefined, usd: number) => {
    if (asset === undefined) return;
    const price = ctx.priceUsd[asset];
    const wallet = balances[exchange];
    if (wallet && price > 0) wallet[asset] = (wallet[asset] ?? 0) - usd / price;
  };
  return ts.map((t) => {
    const verdict = checkTrade(t, { ...ctx, balances }, policy);
    if (verdict.result === 'PASS') {
      const [base, quote] = t.pair.split('/');
      spend(t.buyOn, quote, t.sizeUsd);
      spend(t.sellOn, base, t.sizeUsd);
    }
    return verdict;
  });
}
