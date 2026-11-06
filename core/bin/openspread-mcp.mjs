#!/usr/bin/env node
// Abre o MCP de qualquer pasta: o cliente de IA não roda na pasta do núcleo, então `node --import tsx` não acharia o tsx.
import { register } from 'tsx/esm/api';

register();
await import('../src/mcp/main.ts');
