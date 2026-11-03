// Calendário (item 16): datas oficiais embutidas, com o link da fonte, mais os eventos do usuário (config.events).
// Conferido em 03/11/2026:
// - FOMC: federalreserve.gov/monetarypolicy/fomccalendars.htm (2027 provisório até a reunião anterior confirmar).
//   O comunicado sai às 14:00 de Nova York no segundo dia.
// - CPI: bls.gov/schedule/news_release/cpi.htm, sempre às 08:30 de Nova York.
// Revisar uma vez por ano (as listas acabam em dez/2027): depois disso só os eventos do usuário aparecem.
import type { AgendaEvent, UserEvent } from '../types';

export const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export const CPI_URL = 'https://www.bls.gov/schedule/news_release/cpi.htm';

/** Segundo dia de cada reunião (dia do comunicado), [ano, mês 1–12, dia]. */
const FOMC: ReadonlyArray<readonly [number, number, number]> = [
  [2026, 1, 28], [2026, 3, 18], [2026, 4, 29], [2026, 6, 17], [2026, 7, 29], [2026, 9, 16], [2026, 10, 28], [2026, 12, 9],
  [2027, 1, 27], [2027, 3, 17], [2027, 4, 28], [2027, 6, 9], [2027, 7, 28], [2027, 9, 15], [2027, 10, 27], [2027, 12, 8],
];
/** Divulgação do CPI, [ano, mês, dia] (mês de referência = o anterior). */
const CPI: ReadonlyArray<readonly [number, number, number]> = [
  [2026, 11, 10], [2026, 12, 10], [2027, 1, 13], [2027, 2, 11], [2027, 3, 10], [2027, 4, 13], [2027, 5, 12],
  [2027, 6, 10], [2027, 7, 14], [2027, 8, 11], [2027, 9, 14], [2027, 10, 14], [2027, 11, 10], [2027, 12, 10],
];

/** n-ésimo domingo do mês (1 = primeiro), em dia do mês. */
function nthSunday(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

/** Hora de Nova York → epoch ms. Horário de verão dos EUA: 2º domingo de março às 2h até o 1º domingo de novembro às 2h. */
export function newYorkTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  const dstStart = Date.UTC(year, 2, nthSunday(year, 3, 2), 7); // 2h EST = 7h UTC
  const dstEnd = Date.UTC(year, 10, nthSunday(year, 11, 1), 6); // 2h EDT = 6h UTC
  const asEst = Date.UTC(year, month - 1, day, hour + 5, minute);
  const asEdt = asEst - 3_600_000;
  return asEdt >= dstStart && asEdt < dstEnd ? asEdt : asEst;
}

/** As datas oficiais como eventos (alto impacto; valem para todas as salas: as stablecoins são em dólar). */
export function officialEvents(): AgendaEvent[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    ...FOMC.map(([y, m, d]): AgendaEvent => ({ id: `fomc-${y}-${pad(m)}-${pad(d)}`, title: 'FOMC', kind: 'fomc', at: newYorkTime(y, m, d, 14), impact: 'high', source: 'federalreserve.gov', url: FOMC_URL, origin: 'official', pairs: [] })),
    ...CPI.map(([y, m, d]): AgendaEvent => ({ id: `cpi-${y}-${pad(m)}-${pad(d)}`, title: 'CPI', kind: 'cpi', at: newYorkTime(y, m, d, 8, 30), impact: 'high', source: 'bls.gov', url: CPI_URL, origin: 'official', pairs: [] })),
  ];
}

/** Eventos do usuário (já validados no config) no mesmo formato. */
export function userEvents(list: readonly UserEvent[]): AgendaEvent[] {
  return list.map((e, i): AgendaEvent => ({ id: `user-${i}-${Date.parse(e.at)}`, title: e.title, kind: 'user', at: Date.parse(e.at), impact: e.impact, source: 'config', origin: 'user', pairs: e.pairs ?? [] }));
}

/** Do último dia até `daysAhead` à frente, em ordem de hora. */
export function upcoming(events: readonly AgendaEvent[], now: number, daysAhead = 14): AgendaEvent[] {
  return events.filter((e) => e.at >= now - 86_400_000 && e.at <= now + daysAhead * 86_400_000).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
