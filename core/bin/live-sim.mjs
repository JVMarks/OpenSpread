#!/usr/bin/env node
// Simulação das ordens do modo real: livros públicos reais, saldos de mentira, nenhuma chave e nenhuma ordem de verdade.
import { register } from 'tsx/esm/api';

register();
process.env.OPENSPREAD_SIM = '1';
await import('../src/live/sim.ts');
