import 'server-only';
import {
  isPatternModelArtifact,
  PATTERN_CANDIDATE_KINDS,
  PATTERN_MODEL_VERSION,
} from '@/features/BitcoinTracker/utils/learning/patternModel.utils';
import { trainPatternCandidates } from '@/features/BitcoinTracker/utils/learning/patternTraining.utils';

/** Serve only complete frozen suites. A partial write resumes with the same training timestamp. */
export function selectPatternCandidates(artifacts = []) {
  const valid = artifacts.filter(
    (artifact) =>
      isPatternModelArtifact(artifact) &&
      artifact.version === PATTERN_MODEL_VERSION &&
      !artifact.retirement,
  );
  const suites = new Map();
  for (const artifact of valid) {
    const suite = suites.get(artifact.suiteId) ?? [];
    suite.push(artifact);
    suites.set(artifact.suiteId, suite);
  }
  const sharedFields = [
    'trainedAt',
    'trainingCutoffAt',
    'calibrationCutoffAt',
    'evaluationCutoffAt',
    'baselineFeatureVersion',
    'datasetFingerprint',
    'applicability',
    'patternAvailabilityPatterns',
  ];
  const coherent = [...suites.values()]
    .filter(
      (suite) =>
        suite.length === PATTERN_CANDIDATE_KINDS.length &&
        PATTERN_CANDIDATE_KINDS.every(
          (kind) => suite.filter((artifact) => artifact.kind === kind).length === 1,
        ) &&
        suite.every((artifact) =>
          sharedFields.every(
            (field) => JSON.stringify(artifact[field]) === JSON.stringify(suite[0][field]),
          ),
        ),
    )
    .sort(
      (left, right) =>
        right[0].trainedAt - left[0].trainedAt || left[0].suiteId.localeCompare(right[0].suiteId),
    );
  const selected = coherent[0] ?? [];
  return PATTERN_CANDIDATE_KINDS.flatMap((kind) =>
    selected.filter((artifact) => artifact.kind === kind),
  );
}

/** The existing lease owns shadow fitting. Promotion requires a separate deliberate activation. */
export async function advancePatternLearning(repository, events, artifacts, now) {
  const candidates = selectPatternCandidates(artifacts);
  if (candidates.length) return { status: 'shadow', candidates };
  if (
    artifacts.some(
      (artifact) =>
        isPatternModelArtifact(artifact) &&
        artifact.version === PATTERN_MODEL_VERSION &&
        artifact.kind === 'combined' &&
        artifact.retirement,
    )
  )
    return {
      status: 'retired',
      candidates: [],
      reason:
        'The fixed pattern experiment was retired. No replacement is activated or fitted automatically.',
    };
  const incomplete = artifacts.find(
    (artifact) =>
      isPatternModelArtifact(artifact) &&
      artifact.version === PATTERN_MODEL_VERSION &&
      !artifact.retirement,
  );
  const result = trainPatternCandidates(events, { now: incomplete?.trainedAt ?? now });
  if (incomplete && result.artifacts?.some((artifact) => artifact.suiteId !== incomplete.suiteId))
    return {
      status: 'incomplete-suite',
      candidates: [],
      reason:
        'The original partial suite cannot be reconstructed from the same frozen data. No replacement was fitted into this experiment.',
    };
  for (const artifact of result.artifacts ?? []) await repository.writeModelArtifact(artifact);
  return { ...result, candidates: result.artifacts ?? [] };
}
