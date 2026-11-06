#!/usr/bin/env node
// Prova do ambiente de teste das corretoras. Recusa qualquer config que não seja "sandbox": true.
import { register } from 'tsx/esm/api';

register();
process.env.OPENSPREAD_PROBE = '1';
await import('../src/live/probe.ts');
