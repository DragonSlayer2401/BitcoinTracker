import { evaluateResearchExperiments } from '../../../utils/researchEvaluation.utils';
import { replayResearchInputSnapshot } from '../../../utils/researchExperiments.utils';
import { createChallengerService } from '@/services/research/challenger.service';
import { createCollectorHealthService } from '@/services/research/collectorHealth.service';
import { evaluatePatternChallengers } from '../../PatternStudies/utils/patternEvaluation.utils';

/** Local analysis only: it neither submits orders nor promotes an experimental variant. */
export async function getCollectorAnalysis({ repository, now, replayLimit = 10 }) {
  const [evidence, labels, paperObservations, patternSuites] = await Promise.all([
    repository.getLearningEvidenceRows(),
    repository.getForwardResearchLabels(),
    repository.getPatternPaperObservations?.() ?? [],
    repository.readPatternSuiteRegistrations?.() ?? [],
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
    patterns: evaluatePatternChallengers(evidence, { now, paperObservations, patternSuites }),
    collectorHealth: await createCollectorHealthService(repository)
      .getCollectorHealth({ now, events: evidence, labels })
      .catch(() => null),
    challengers: await createChallengerService(repository).getChallengerStatus({
      now,
      events: evidence,
      labels,
    }),
    forwardLabels: {
      total: labels.length,
      observed: labels.filter((label) => label.status === 'observed').length,
      missing: labels.filter((label) => label.status === 'missing').length,
    },
    replay,
  };
}
