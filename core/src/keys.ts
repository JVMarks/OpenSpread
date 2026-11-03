// Chaves de dados (nunca de corretora): Birdeye (descoberta de carteiras) e Blockscout PRO (Base). Ficam só na
// máquina do usuário: variáveis de ambiente ou ~/.openspread/keys.json ({ "birdeye": "...", "blockscout": "..." }).
// Nunca vão para o config.json, para as rotas ou para o navegador: o núcleo só diz se cada uma existe.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DataKeys {
  birdeye: string | null;
  blockscout: string | null;
}

const clean = (v: unknown): string | null => (typeof v === 'string' && /^[\w.-]{8,200}$/.test(v.trim()) ? v.trim() : null);

/** O ambiente vence o arquivo. Arquivo ausente ou quebrado = sem chave (o log diz o motivo, sem mostrar a chave). */
export function loadKeys(configFile: string, env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = () => {}): DataKeys {
  const file = join(dirname(configFile), 'keys.json');
  let fromFile: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      log(`${file} não é um JSON válido (${(e as Error).message}); seguindo sem as chaves dele`);
    }
  }
  return {
    birdeye: clean(env.OPENSPREAD_BIRDEYE_KEY) ?? clean(fromFile.birdeye),
    blockscout: clean(env.OPENSPREAD_BLOCKSCOUT_KEY) ?? clean(fromFile.blockscout),
  };
}
