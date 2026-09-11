import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');

try {
  for (const filename of ['.env.local', '.env']) {
    try {
      loadEnvFile(path.join(projectRoot, filename));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  await import('tsx');
  const { fetchKalshiBenchmark } = await import('../src/services/kalshi/kalshi.service.js');
  const benchmark = await fetchKalshiBenchmark();
  console.log(`Kalshi BRTI: ${benchmark.status}`);

  if (benchmark.status === 'live' && benchmark.available) {
    console.log('Official BRTI access confirmed. Restart the app and any running collector.');
  } else {
    if (benchmark.reason) console.log(benchmark.reason);
    if (benchmark.status === 'not-configured') {
      console.log('Enter KALSHI_API_KEY_ID and the full KALSHI_PRIVATE_KEY in .env.local.');
    } else if (benchmark.status === 'unauthorized') {
      console.log(
        'Use a matching production Key ID and private key. If correct, ask Kalshi about BRTI entitlement.',
      );
    }
    process.exitCode = 1;
  }
} catch {
  // Never print raw errors: environment parsing and transport errors can contain secrets.
  console.error('Unable to check Kalshi. Check .env.local syntax and use Node.js 24 or later.');
  process.exitCode = 1;
}
