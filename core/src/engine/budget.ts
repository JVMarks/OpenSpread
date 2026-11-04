// Divisão do capital entre os robôs: a reserva sai primeiro, os pesos são normalizados, o teto vale sobre o total e o
// excesso vai para quem está abaixo dele; fatia abaixo do mínimo é descartada e o valor volta para os outros. O que não
// couber em ninguém aparece como parado, nunca some. Tudo em centavos inteiros, para a soma fechar. Puro.
// Ideia do trader-budget (github.com/Jakeschincariol/trader-skill, MIT), reescrita aqui.

export interface AllocateOptions {
  /** % do total guardada antes de dividir (0 a 100). */
  reservePct: number;
  /** Teto de cada robô, em % do total (acima de 0 até 100). */
  capPct: number;
  /** Fatia mínima para o robô operar, em dólar. */
  minUsd: number;
}

export interface Allocation {
  perBot: Record<string, number>;
  reserveUsd: number;
  /** Capital sem robô que caiba nele (todos no teto, ou nenhum alcançou o mínimo). */
  idleUsd: number;
  dropped: string[];
}

type Bot = { id: string; weight: number };

/** Maior peso primeiro; empate pelo id, para a ordem das chaves não mudar o resultado. */
const byWeight = (a: Bot, b: Bot) => b.weight - a.weight || a.id.localeCompare(b.id);

/** Divide `available` pelos pesos sem ninguém passar de `cap`: quem bateu o teto sai e o resto é redividido. */
function fill(bots: readonly Bot[], available: number, cap: number): Map<string, number> {
  const out = new Map<string, number>();
  let open = [...bots];
  let rest = available;
  for (;;) {
    const weights = open.reduce((s, b) => s + b.weight, 0);
    const capped = open.filter((b) => (rest * b.weight) / weights >= cap);
    if (!capped.length) break;
    for (const b of capped) {
      out.set(b.id, cap);
      rest -= cap;
    }
    open = open.filter((b) => !capped.includes(b));
  }
  const weights = open.reduce((s, b) => s + b.weight, 0);
  for (const b of open) out.set(b.id, Math.floor((rest * b.weight) / weights));
  // Os centavos que o arredondamento deixou vão, um a um, para o maior robô fora do teto.
  let left = rest - open.reduce((s, b) => s + (out.get(b.id) as number), 0);
  for (const b of open) {
    if (left <= 0) break;
    if ((out.get(b.id) as number) < cap) {
      out.set(b.id, (out.get(b.id) as number) + 1);
      left -= 1;
    }
  }
  return out;
}

export function allocate(totalUsd: number, opts: AllocateOptions, weights: Record<string, number>): Allocation {
  const { reservePct, capPct, minUsd } = opts;
  if (!Number.isFinite(totalUsd) || totalUsd < 0) throw new RangeError(`capital inválido: ${totalUsd}`);
  if (!(reservePct >= 0 && reservePct <= 100)) throw new RangeError(`reserva inválida: ${reservePct}`);
  if (!(capPct > 0 && capPct <= 100)) throw new RangeError(`teto inválido: ${capPct}`);
  if (!(minUsd >= 0)) throw new RangeError(`mínimo inválido: ${minUsd}`);

  const total = Math.round(totalUsd * 100);
  const reserve = Math.round((total * reservePct) / 100);
  const available = total - reserve;
  const cap = Math.floor((total * capPct) / 100);
  const min = Math.round(minUsd * 100);

  const entries = Object.entries(weights).map(([id, weight]): Bot => ({ id, weight }));
  const valid = entries.filter((b) => Number.isFinite(b.weight) && b.weight > 0).sort(byWeight);
  const dropped = entries.filter((b) => !valid.includes(b)).map((b) => b.id);

  let bots = valid;
  let cents = fill(bots, available, cap);
  // Descarta um de cada vez, o menor primeiro: o valor dele pode salvar o próximo.
  for (;;) {
    const below = bots.filter((b) => (cents.get(b.id) as number) < min);
    if (!below.length) break;
    const smallest = below.reduce((a, b) => {
      const diff = (cents.get(b.id) as number) - (cents.get(a.id) as number);
      return diff < 0 || (diff === 0 && b.id.localeCompare(a.id) > 0) ? b : a;
    });
    dropped.push(smallest.id);
    bots = bots.filter((b) => b !== smallest);
    cents = fill(bots, available, cap);
  }

  const used = bots.reduce((s, b) => s + (cents.get(b.id) as number), 0);
  return {
    perBot: Object.fromEntries(bots.map((b) => [b.id, (cents.get(b.id) as number) / 100])),
    reserveUsd: reserve / 100,
    idleUsd: (available - used) / 100,
    dropped,
  };
}
