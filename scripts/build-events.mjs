import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
try {
  if (process.argv[2] === 'history')
    for (const filename of ['.env.local', '.env']) {
      try {
        loadEnvFile(path.join(projectRoot, filename));
      } catch (error) {
        if (error.code !== 'ENOENT')
          throw new Error('Unable to load historical access configuration.');
      }
    }
  await import('tsx');
  const { runEventDatasetCommand } = await import('./build-events.runtime.js');
  await runEventDatasetCommand(process.argv.slice(2));
} catch {
  console.error(
    'Event dataset command failed. Check --help, source integrity and the output path. Existing artifacts are never overwritten.',
  );
  process.exitCode = 1;
}
