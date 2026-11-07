import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
await import('tsx');

const { runSpotCaptureCommand } = await import('./capture-spot.runtime.js');
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await runSpotCaptureCommand(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
  console.error(`Spot capture failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
