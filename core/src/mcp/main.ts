// OpenSpread MCP por stdio: o Claude/Codex do usuário abre este processo, e ele fala com o núcleo em 127.0.0.1.
// Porta: OPENSPREAD_PORT. Log só em stderr: stdout é o protocolo.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_PORT } from '../server';
import { httpCoreClient } from './client';
import { createMcpServer } from './server';

const port = Number(process.env.OPENSPREAD_PORT ?? DEFAULT_PORT);
createMcpServer(httpCoreClient(port)).connect(new StdioServerTransport()).catch((e: unknown) => {
  console.error(`OpenSpread MCP não conseguiu iniciar: ${(e as Error).message}`);
  process.exit(1);
});
