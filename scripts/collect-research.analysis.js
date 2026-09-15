import { evaluateResearchExperiments } from '../src/features/BitcoinTracker/utils/researchEvaluation.utils';
import { replayResearchInputSnapshot } from '../src/features/BitcoinTracker/utils/researchExperiments.utils';
import { getForwardResearchLabels } from '../src/features/BitcoinTracker/utils/researchForwardLabels.utils';
import { readFile } from 'node:fs/promises';
import { writeCollectorState } from './collect-research.storage';

/** Future labels are stored separately and cannot enter an earlier forecast's replay input. */
export async function collectForwardResearchLabels({ repository, benchmark, now, statePath }) {
  const outboxPath = statePath ? `${statePath}.forward-labels.json` : null;
  let pending = [];
  if (outboxPath) {
    try {
      const saved = JSON.parse(await readFile(outboxPath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.pending) || saved.pending.length > 300)
        throw new Error('The forward-label outbox is invalid; original observations retained.');
      pending = saved.pending;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function flush(labels) {
    let inserted = 0;
    for (let index = 0; index < labels.length; index += 100) {
      const result = await repository.persistForwardLabels(labels.slice(index, index + 100));
      inserted += result.inserted;
    }
    if (outboxPath && labels.length)
      await writeCollectorState(outboxPath, { version: 1, pending: [] });
    return inserted;
  }
  let inserted = await flush(pending);
  const captures = await repository.getPendingForwardCaptures({ now });
  const labels = getForwardResearchLabels(captures, benchmark, now);
  if (outboxPath && labels.length)
    await writeCollectorState(outboxPath, { version: 1, pending: labels });
  inserted += await flush(labels);
  return inserted;
}

/** Local analysis only: it neither submits orders nor promotes an experimental variant. */
export async function getCollectorAnalysis({ repository, now, replayLimit = 10 }) {
  const [evidence, labels] = await Promise.all([
    repository.getLearningEvidenceRows(),
    repository.getForwardResearchLabels(),
  ]);
  const replay = { checked: 0, matched: 0, failed: 0, skipped: 0, failures: [] };
  const decisions = evidence
    .filter((row) => row.event === 'decision' && row.researchReplay?.snapshotId)
    .sort((left, right) => right.featureCutoffAt - left.featureCutoffAt)
    .slice(0, replayLimit);
  for (const decision of decisions) {
    try {
      const stored = await repository.readResearchInputSnapshot(decision.researchReplay.snapshotId);
      if (!stored) throw new Error('The original input snapshot is missing.');
      if (stored.contentHash !== decision.researchReplay.contentHash)
        throw new Error('The decision and input hashes do not match.');
      if (stored.snapshot.timing?.replayable !== true) {
        replay.skipped++;
        continue;
      }
      replay.checked++;
      replayResearchInputSnapshot(stored.snapshot);
      replay.matched++;
    } catch (error) {
      replay.failed++;
      replay.failures.push({
        snapshotId: decision.researchReplay.snapshotId,
        reason: error.message,
      });
    }
  }
  return {
    generatedAt: now,
    comparison: evaluateResearchExperiments(evidence, { now }),
    forwardLabels: {
      total: labels.length,
      observed: labels.filter((label) => label.status === 'observed').length,
      missing: labels.filter((label) => label.status === 'missing').length,
    },
    replay,
  };
}
