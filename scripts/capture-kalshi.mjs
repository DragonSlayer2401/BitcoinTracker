import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  // Only the network capture needs credentials; local inspection never reads environment files.
  if (process.argv[2] === 'record') {
    for (const filename of ['.env.local', '.env']) {
      try {
        loadEnvFile(path.join(projectRoot, filename));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Unable to load capture environment.');
      }
    }
  }
  await import('tsx');
  const { runKalshiCaptureCommand } = await import('./capture-kalshi.runtime.js');
  await runKalshiCaptureCommand(process.argv.slice(2), { signal: controller.signal });
} catch {
  // Never expose environment parser, authorization headers or raw transport errors.
  console.error(
    'Kalshi capture failed. Check the reported capture state, archive integrity and configuration.',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
