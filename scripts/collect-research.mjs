import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
for (const filename of ['.env.local', '.env']) {
  try {
    loadEnvFile(path.join(projectRoot, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await import('tsx');
const { runCollectorCommand } = await import('./collect-research.runtime.js');
await runCollectorCommand(process.argv.slice(2));
