import { describe, expect, it } from 'vitest';
import { RECENT_MAX, REARM_GAP_PCT, SpreadAlerts } from './alerts';
import type { PairState } from './types';

/** Estado de um par com o melhor spread líquido dado (ou sem dados). */
const pair = (name: string, netPct: number | null): PairState => ({
  pair: name,
  quotes: [],
  best: netPct === null ? null : { pair: name, buyOn: 'okx', sellOn: 'binance', grossPct: netPct + 0.2, netPct },
});
const ALERT = [{ pair: 'BTC/USDT', abovePct: 0.05 }];

describe('alertas de spread', () => {
  it('toca uma vez ao chegar ao nível e não repete enquanto o spread continua acima', () => {
    const a = new SpreadAlerts();
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.01)], 1)).toEqual([]);
    const hit = a.evaluate(ALERT, [pair('BTC/USDT', 0.05)], 2);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ pair: 'BTC/USDT', abovePct: 0.05, netPct: 0.05, buyOn: 'okx', sellOn: 'binance', at: 2 });
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.09)], 3)).toEqual([]);
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.04)], 4)).toEqual([]);
  });

  it('rearma só depois de cair abaixo do nível menos a folga', () => {
    const a = new SpreadAlerts();
    a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 1);
    // recuo pequeno (dentro da folga) não rearma
    a.evaluate(ALERT, [pair('BTC/USDT', 0.05 - REARM_GAP_PCT / 2)], 2);
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 3)).toEqual([]);
    // recuo além da folga rearma, e a próxima subida toca de novo
    a.evaluate(ALERT, [pair('BTC/USDT', 0.05 - REARM_GAP_PCT - 0.001)], 4);
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 5)).toHaveLength(1);
  });

  it('par sem dados não toca nem rearma', () => {
    const a = new SpreadAlerts();
    expect(a.evaluate(ALERT, [pair('BTC/USDT', null)], 1)).toEqual([]);
    expect(a.evaluate(ALERT, [], 2)).toEqual([]);
    a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 3);
    a.evaluate(ALERT, [pair('BTC/USDT', null)], 4);
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 5)).toEqual([]);
  });

  it('alerta removido ou com nível novo começa armado', () => {
    const a = new SpreadAlerts();
    a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 1);
    expect(a.evaluate([{ pair: 'BTC/USDT', abovePct: 0.06 }], [pair('BTC/USDT', 0.06)], 2)).toHaveLength(1);
    a.evaluate([], [pair('BTC/USDT', 0.06)], 3);
    expect(a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], 4)).toHaveLength(1);
  });

  it('guarda só os eventos recentes, com ids únicos', () => {
    const a = new SpreadAlerts();
    for (let i = 0; i < RECENT_MAX + 5; i++) {
      a.evaluate(ALERT, [pair('BTC/USDT', 0.06)], i * 2);
      a.evaluate(ALERT, [pair('BTC/USDT', -1)], i * 2 + 1);
    }
    const ev = a.events();
    expect(ev).toHaveLength(RECENT_MAX);
    expect(new Set(ev.map((e) => e.id)).size).toBe(RECENT_MAX);
    expect(ev[ev.length - 1].at).toBe((RECENT_MAX + 4) * 2);
  });
});
