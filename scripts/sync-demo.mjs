// Compila a demo do Bullroom (simulada, roda só no navegador) e copia para docs/demo/, servida pelo GitHub Pages em
// /OpenSpread/demo/. Espera o repositório do Bullroom clonado ao lado deste (../bullroom) com `npm install` feito.
// Uso: node scripts/sync-demo.mjs [caminho-do-bullroom]
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bullroom = resolve(process.argv[2] ?? join(root, '..', 'bullroom'));
const built = join(bullroom, 'dist', 'demo');
const target = join(root, 'docs', 'demo');

if (!existsSync(join(bullroom, 'package.json'))) {
  console.error(`Bullroom não encontrado em ${bullroom}. Clone github.com/JVMarks/bullroom ao lado deste repositório.`);
  process.exit(1);
}
console.log(`Compilando a demo em ${bullroom} …`);
execSync('npm run build:demo', { cwd: bullroom, stdio: 'inherit' });
if (!existsSync(join(built, 'index.html'))) {
  console.error(`O build não gerou ${join(built, 'index.html')}.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(built, target, { recursive: true });
console.log(`Demo copiada para ${target}`);
