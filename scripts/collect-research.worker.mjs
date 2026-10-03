import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
await import('tsx');

let client;
try {
  const { createClient } = await import('@libsql/client');
  const { createResearchRepository, getResearchDatabaseConfiguration } =
    await import('../src/services/research/research.repository.js');
  const configuration = getResearchDatabaseConfiguration();
  client = createClient(configuration);
  const repository = createResearchRepository({ client, mode: configuration.mode });
  let result;
  if (workerData.task === 'analysis') {
    const { getCollectorAnalysis } = await import('./collect-research.analysis.js');
    result = await getCollectorAnalysis({ repository, now: Date.now() });
  } else if (workerData.task === 'learning') {
    const { createLearningService } = await import('../src/services/research/learning.service.js');
    const report = await createLearningService(repository).runLearningCycle({ now: Date.now() });
    result = {
      active: report.active,
      candidate: report.candidate,
      earlyCandidate: report.earlyCandidate,
      challengers: {
        active: report.challengers?.active ?? null,
        candidates: report.challengers?.candidates ?? [],
      },
    };
  } else throw new Error('Unknown collector task.');
  parentPort.postMessage({ ok: true, result });
} catch {
  // Error paths can contain archive URLs or authentication details. The parent logs safe context.
  parentPort.postMessage({ ok: false });
} finally {
  client?.close();
  parentPort.close();
}
