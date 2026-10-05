import {
  collectLearningEvents,
  getIndependentRows,
  getVerifiedLearningRows,
  hasContemporaneousInputs,
  scoreLearningRows,
} from './learning/evaluation.utils';
import { PATTERN_CANDIDATE_KINDS, getPatternModelSchema } from './learning/patternModel.utils';
import { getPatternContractConflicts } from './learning/patternEvidence.utils';
import {
  getPatternProspectiveCohorts,
  normalizePatternSuiteRegistrations,
  isContractInPatternCohort,
} from './learning/patternCohorts.utils';
import {
  getConflictingPatternForecastIds,
  isPatternLearningFeatureSnapshot,
  PATTERN_FAMILIES,
} from './learning/patternFeatures.utils';
import { getKalshiContract, isVerifiedKalshiOutcome } from './kalshi/contract.utils';
import {
  PAPER_TRADING_POLICY,
  createPaperDecision,
  getPaperPortfolio,
  getPaperTradingReport,
  settlePaperPosition,
  simulatePaperFill,
} from '../features/PaperTrading/utils/paperTrading.utils';

export const PATTERN_EVALUATION_VERSION = 'kalshi-pattern-evaluation-v2';
const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const ratio = (count, total) => (total ? count / total : null);
const increment = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Choose the first captured opportunity before inspecting features, probabilities or outcomes. */
function selectEvidence(events, now) {
  const { decisions, conflicts } = collectLearningEvents(events, now);
  for (const id of getConflictingPatternForecastIds(events, now)) conflicts.add(id);
  const contractConflicts = getPatternContractConflicts(events, now);
  for (const id of contractConflicts.forecastIds) conflicts.add(id);
  const first = new Map();
  for (const decision of [...decisions.values()].sort(
    (left, right) =>
      left.capturedAt - right.capturedAt ||
      left.recordedAt - right.recordedAt ||
      left.forecastId.localeCompare(right.forecastId),
  )) {
    const key = `${decision.cohort ?? 'manual'}:${decision.kalshiMarket.ticker}:${decision.checkpointMinutes ?? 'fixed'}`;
    if (!first.has(key)) first.set(key, decision);
  }
  const selected = [...first.values()].filter((decision) => !conflicts.has(decision.forecastId));
  const selectedIds = new Set(selected.map((decision) => decision.forecastId));
  return {
    decisions: selected,
    paperDecisions: [...first.values()],
    conflictingCaptures: conflicts.size,
    rejectedContracts: contractConflicts.rejectedContracts,
    rejectedCaptures: contractConflicts.rejectedCaptures,
    rejectedContractReasons: contractConflicts.reasons,
    evidence: events.filter(
      (event) => event?.event !== 'decision' || selectedIds.has(event.forecastId),
    ),
  };
}

function getPredictions(decision, registration = null) {
  const production = isProbability(decision.aboveProbability)
    ? {
        aboveProbability: decision.aboveProbability,
        modelUsed: true,
        modelVersion: decision.modelVersion,
      }
    : null;
  const saved = Array.isArray(decision.patternShadowPredictions)
    ? decision.patternShadowPredictions
    : [];
  const validSnapshot = isPatternLearningFeatureSnapshot(decision.patternLearningFeatures, {
    target: decision.kalshiMarket.target,
    expiresAt: decision.kalshiMarket.expiresAt,
    cutoffAt: decision.capturedAt,
    baselineFeatures: decision.learningFeatures,
  });
  // A deterministic, pre-outcome suite selection prevents mixing separately fitted ablations.
  const suite =
    registration?.suiteId ??
    [...saved]
      .filter(
        (entry) =>
          typeof entry?.suiteId === 'string' &&
          Number.isSafeInteger(entry.trainedAt) &&
          entry.trainedAt < decision.windowStartAt,
      )
      .sort(
        (left, right) =>
          right.trainedAt - left.trainedAt || left.suiteId.localeCompare(right.suiteId),
      )[0]?.suiteId;
  const baseline = decision.learningFeatures ?? decision.patternLearningFeatures?.baselineFeatures;
  const predictions = {
    production,
    'raw-baseline':
      baseline?.featureCutoffAt === decision.capturedAt &&
      baseline.target === decision.kalshiMarket.target &&
      baseline.expiresAt === decision.kalshiMarket.expiresAt &&
      isProbability(baseline.baselineAboveProbability)
        ? {
            aboveProbability: baseline.baselineAboveProbability,
            modelUsed: true,
            modelVersion: baseline.baselineModelVersion,
          }
        : null,
  };
  for (const kind of PATTERN_CANDIDATE_KINDS) {
    const entries = saved.filter((entry) => entry?.kind === kind && entry.suiteId === suite);
    const entry = entries[0];
    const schema = getPatternModelSchema(entry?.modelVersion);
    predictions[kind] =
      entries.length === 1 &&
      validSnapshot &&
      schema &&
      decision.patternLearningFeatures.schemaVersion === schema.featureVersion &&
      decision.patternLearningFeatures.patternVersion === schema.patternVersion &&
      (!registration ||
        (entry.modelVersion === registration.modelVersion &&
          entry.trainedAt === registration.trainedAt &&
          schema.featureVersion === registration.featureVersion &&
          schema.patternVersion === registration.patternVersion)) &&
      /^[0-9]+-[a-z0-9]+$/.test(entry.suiteId) &&
      entry.modelId === `${entry.modelVersion}-${kind}-${entry.suiteId}` &&
      entry.featureCutoffAt === decision.capturedAt &&
      Number.isSafeInteger(entry.trainedAt) &&
      entry.trainedAt < decision.windowStartAt &&
      typeof entry.modelUsed === 'boolean' &&
      (!entry.modelUsed || decision.patternLearningFeatures.patternAvailable) &&
      isProbability(entry.aboveProbability)
        ? entry
        : null;
  }
  return predictions;
}

function score(rows, kind) {
  return scoreLearningRows(
    rows.map((row) => ({
      ...row,
      probability: row.predictions[kind].aboveProbability,
    })),
  );
}

const directionScore = (probability, outcome) =>
  probability === 0.5 ? 0.5 : Number(Number(probability > 0.5) === outcome);

/** Paired chronological blocks retain serial dependence; these are sensitivity intervals. */
function getUncertainty(rows, candidate, comparator, blockLength) {
  const blocks = [];
  for (let index = 0; index < rows.length; index += blockLength) {
    blocks.push(
      rows.slice(index, index + blockLength).map((row) => {
        const prediction = row.predictions[candidate].aboveProbability;
        const reference = row.predictions[comparator].aboveProbability;
        return {
          brier: (prediction - row.outcome) ** 2 - (reference - row.outcome) ** 2,
          accuracy:
            directionScore(prediction, row.outcome) - directionScore(reference, row.outcome),
        };
      }),
    );
  }
  const result = {
    method: 'paired-chronological-contract-block-bootstrap',
    blockLength,
    blocks: blocks.length,
    independentWindows: rows.length,
    confidenceLevel: 0.95,
    replicates: 500,
    sensitivityOnly: true,
    intervals: null,
  };
  if (blocks.length < 2) return { ...result, reason: 'At least two blocks are required.' };
  let seed = 0x36a9147;
  const samples = { brier: [], accuracy: [] };
  for (let replicate = 0; replicate < result.replicates; replicate++) {
    const sampled = [];
    for (let index = 0; index < blocks.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sampled.push(...blocks[Math.floor((seed / 4294967296) * blocks.length)]);
    }
    for (const metric of Object.keys(samples))
      samples[metric].push(average(sampled.map((row) => row[metric])));
  }
  return {
    ...result,
    intervals: Object.fromEntries(
      Object.entries(samples).map(([metric, values]) => {
        values.sort((left, right) => left - right);
        return [metric, [values[12], values[487]]];
      }),
    ),
  };
}

function compare(rows, candidate, comparator) {
  const matched = rows.filter((row) => row.predictions[candidate] && row.predictions[comparator]);
  const candidateScore = score(matched, candidate);
  const comparatorScore = score(matched, comparator);
  const modelRows = matched.filter((row) => row.predictions[candidate].modelUsed);
  return {
    candidate,
    comparator,
    examples: matched.length,
    independentWindows: matched.length,
    coverage: ratio(matched.length, rows.length),
    candidateMetrics: candidateScore,
    comparatorMetrics: comparatorScore,
    difference: {
      brier: matched.length ? candidateScore.brier - comparatorScore.brier : null,
      accuracy: matched.length ? candidateScore.callAccuracy - comparatorScore.callAccuracy : null,
    },
    modelUsed: {
      examples: modelRows.length,
      coverage: ratio(modelRows.length, matched.length),
      candidateMetrics: score(modelRows, candidate),
      comparatorMetrics: score(modelRows, comparator),
    },
    fallbackExamples: matched.length - modelRows.length,
    uncertainty: [1, 4, 8].map((length) => getUncertainty(matched, candidate, comparator, length)),
  };
}

function featureCoverage(decisions) {
  const families = Object.fromEntries(
    PATTERN_FAMILIES.map((name) => [name, { available: 0, missing: 0 }]),
  );
  const reasons = {};
  let snapshots = 0;
  let anyPattern = 0;
  for (const decision of decisions) {
    const snapshot = decision.patternLearningFeatures;
    if (
      !isPatternLearningFeatureSnapshot(snapshot, {
        target: decision.kalshiMarket.target,
        expiresAt: decision.kalshiMarket.expiresAt,
        cutoffAt: decision.capturedAt,
        baselineFeatures: decision.learningFeatures,
      })
    ) {
      increment(reasons, snapshot ? 'invalid-snapshot' : 'snapshot-not-recorded');
      for (const name of PATTERN_FAMILIES) families[name].missing++;
      continue;
    }
    snapshots++;
    if (snapshot.patternAvailable) anyPattern++;
    for (const name of PATTERN_FAMILIES) {
      const available = snapshot.familyAvailability?.[name];
      families[name][available === true ? 'available' : 'missing']++;
    }
  }
  return {
    decisions: decisions.length,
    snapshots,
    anyPattern,
    coverage: ratio(anyPattern, decisions.length),
    families,
    reasons,
    historicalBackfill: false,
  };
}

/** Adapt legacy archived books, retaining their production-dependent sampling limitation. */
export function getPatternPaperObservations({
  decisions = [],
  events = [],
  now = Date.now(),
} = {}) {
  return decisions
    .filter((decision) => decision.decidedAt <= now)
    .map((decision) => {
      const execution = events.find(
        (event) =>
          event.decisionId === decision.id &&
          ['fill', 'no-fill'].includes(event.kind) &&
          event.recordedAt <= now,
      );
      return {
        id: decision.id,
        contract: decision.contract,
        capturedAt: decision.forecast?.capturedAt,
        forecast: decision.forecast,
        source: 'legacy-production-selected',
        initial: { observedAt: decision.decidedAt, book: decision.book },
        execution: execution ? { observedAt: execution.recordedAt, book: execution.book } : null,
      };
    });
}

function getPaperOutcome(events, contract, now) {
  const outcomes = events.filter(
    (event) =>
      event?.event === 'outcome' &&
      event.recordedAt <= now &&
      isVerifiedKalshiOutcome(event.kalshiOutcome, contract, event.recordedAt),
  );
  if (
    new Set(
      outcomes.map((event) => `${event.kalshiOutcome.result}:${event.kalshiOutcome.observedPrice}`),
    ).size !== 1
  )
    return null;
  return outcomes.sort((left, right) => left.recordedAt - right.recordedAt)[0] ?? null;
}

function getPaperOpportunities(decisions, observations, now) {
  const policy = PAPER_TRADING_POLICY;
  const opportunities = new Map();
  for (const decision of decisions) {
    if (decision.checkpointMinutes !== policy.checkpointMinutes) continue;
    const ticker = decision.kalshiMarket.ticker;
    const previous = opportunities.get(ticker);
    if (!previous || decision.capturedAt < previous.decision.capturedAt)
      opportunities.set(ticker, { decision });
  }
  for (const observed of [...observations].sort(
    (left, right) => left.capturedAt - right.capturedAt,
  )) {
    const contract = getKalshiContract(observed.contract);
    if (!contract || !Number.isSafeInteger(observed.capturedAt) || observed.capturedAt > now)
      continue;
    const initial = observed.initial?.observedAt <= now ? observed.initial : null;
    const execution = observed.execution?.observedAt <= now ? observed.execution : null;
    const existing = opportunities.get(contract.ticker);
    if (existing?.observed) continue;
    // Independent observation bundles freeze their own contemporaneous forecast before book fetch.
    const decision =
      observed.source === 'legacy-production-selected'
        ? existing?.decision
        : {
            forecastId: observed.id,
            windowStartAt: contract.startsAt,
            capturedAt: observed.capturedAt,
            kalshiMarket: contract,
            modelVersion: observed.forecast?.modelVersion,
            aboveProbability: observed.forecast?.available
              ? observed.forecast.aboveProbability
              : null,
            patternShadowPredictions: observed.patternShadowPredictions,
            patternLearningFeatures: observed.patternLearningFeatures,
          };
    if (decision)
      opportunities.set(contract.ticker, {
        decision,
        observed: { ...observed, initial, execution },
      });
  }
  const ordered = [...opportunities.values()].sort(
    (left, right) =>
      (left.observed?.initial?.observedAt ?? left.decision.capturedAt) -
      (right.observed?.initial?.observedAt ?? right.decision.capturedAt),
  );
  return ordered;
}

function replayPaperAccounts(
  events,
  ordered,
  now,
  registration = null,
  accountKinds = ['production', 'raw-baseline', ...PATTERN_CANDIDATE_KINDS],
) {
  const policy = PAPER_TRADING_POLICY;
  const outcomesByTicker = new Map();
  for (const event of events) {
    if (event?.event !== 'outcome' || !event.kalshiMarket?.ticker) continue;
    const entries = outcomesByTicker.get(event.kalshiMarket.ticker) ?? [];
    entries.push(event);
    outcomesByTicker.set(event.kalshiMarket.ticker, entries);
  }
  const accounts = Object.fromEntries(
    accountKinds.map((kind) => [kind, { decisions: [], events: [], capitalDecisions: [] }]),
  );
  const predictionCoverage = Object.fromEntries(
    accountKinds.map((kind) => [kind, { available: 0, missing: 0, fallback: 0 }]),
  );
  for (const { decision: capture, observed, terminalFailure } of ordered) {
    const contract = capture.kalshiMarket;
    const decisionAt = observed?.initial?.observedAt ?? capture.capturedAt;
    if (!Number.isSafeInteger(decisionAt) || decisionAt > now || decisionAt < capture.capturedAt)
      continue;
    const predictions = terminalFailure ? {} : getPredictions(capture, registration);
    const outcome = getPaperOutcome(outcomesByTicker.get(contract.ticker) ?? [], contract, now);
    for (const [kind, account] of Object.entries(accounts)) {
      const prediction = predictions[kind];
      predictionCoverage[kind][prediction ? 'available' : 'missing']++;
      if (prediction?.modelUsed === false) predictionCoverage[kind].fallback++;
      const decision = createPaperDecision({
        contract,
        now: decisionAt,
        policy,
        portfolio: getPaperPortfolio({
          ...account,
          decisions: account.capitalDecisions,
          policy,
          now: decisionAt,
        }),
        forecast: {
          available: Boolean(prediction),
          capturedAt: capture.capturedAt,
          aboveProbability: prediction?.aboveProbability,
          modelVersion: prediction?.modelVersion ?? 'unavailable',
          modelId: prediction?.modelId ?? null,
        },
        book: observed?.initial?.book ?? null,
      });
      account.decisions.push(decision);
      if (decision.status !== 'intent') continue;
      account.capitalDecisions.push(decision);
      const executionAt =
        observed?.execution?.observedAt ?? decisionAt + policy.maximumFillDelayMs + 1;
      if (executionAt > now) continue;
      let execution = simulatePaperFill({
        decision,
        book: observed?.execution?.book ?? null,
        now: executionAt,
      });
      if (!execution && now > decisionAt + policy.maximumFillDelayMs) {
        execution = simulatePaperFill({
          decision,
          book: null,
          now: decisionAt + policy.maximumFillDelayMs + 1,
        });
      }
      if (!execution) continue;
      account.events.push(execution);
      if (execution.kind !== 'fill' || !outcome) continue;
      const official = outcome.kalshiOutcome;
      const settlement = settlePaperPosition({
        decision,
        fill: execution,
        market: {
          ...contract,
          status: 'settled',
          result: official.result,
          settlementPrice: official.observedPrice,
          receivedAt: official.confirmedThrough,
          settledAt: official.settledAt,
        },
        now: Math.max(executionAt, outcome.recordedAt),
      });
      if (settlement) account.events.push(settlement);
    }
  }
  return {
    mode: 'frozen-probability-observed-book-paper-replay',
    policy: copy(policy),
    opportunities: ordered.length,
    initialBooks: ordered.filter((row) => row.observed?.initial?.book).length,
    delayedBooks: ordered.filter((row) => row.observed?.execution?.book).length,
    independentObservations: ordered.filter(
      (row) => row.observed && row.observed.source !== 'legacy-production-selected',
    ).length,
    predictionCoverage,
    warning:
      'Snapshot fills are simulations. Legacy books were selected by production intent; missing books remain skips/no-fills. Identical bankroll, fee, latency, slippage and risk rules apply to every account. This is not evidence of achievable profit.',
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([kind, account]) => {
        const report = getPaperTradingReport({ ...account, policy, now });
        const skipReasons = {};
        for (const decision of account.decisions)
          if (decision.status === 'skipped') increment(skipReasons, decision.reason);
        for (const event of account.events)
          if (event.kind === 'no-fill') increment(skipReasons, event.reason);
        return [
          kind,
          {
            ...report,
            tradeAttempts: report.intentCount,
            skips: report.skippedCount,
            netProfit: report.actualNetPnl,
            drawdown: report.maxRealizedDrawdown,
            skipReasons,
          },
        ];
      }),
    ),
  };
}

function evaluatePaper(events, decisions, observations, now, patternSuites) {
  const registrations = normalizePatternSuiteRegistrations(patternSuites, now);
  const ordered = getPaperOpportunities(decisions, observations, now);
  const conflicts = getPatternContractConflicts(events, now);
  const capturedConflicts = getConflictingPatternForecastIds(events, now);
  for (const id of collectLearningEvents(events, now).conflicts) capturedConflicts.add(id);
  const conflictingCaptureTickers = new Set(
    events
      .filter(
        (event) =>
          event?.event === 'decision' &&
          Number.isSafeInteger(event.recordedAt) &&
          event.recordedAt <= now &&
          capturedConflicts.has(event.forecastId),
      )
      .map((event) => event.kalshiMarket?.ticker),
  );
  const cohorts = registrations.map((registration) => {
    const enrolled = ordered
      .filter(({ decision }) => isContractInPatternCohort(decision.kalshiMarket, registration))
      .map((row) => ({
        ...row,
        terminalFailure: conflicts.contractTickers.has(row.decision.kalshiMarket.ticker)
          ? 'conflicting-contract'
          : conflictingCaptureTickers.has(row.decision.kalshiMarket.ticker)
            ? 'conflicting-pattern-capture'
            : null,
      }));
    const result = replayPaperAccounts(events, enrolled, now, registration);
    return {
      ...result,
      ...registration,
      enrollment:
        'Complete fitted suite durably registered before contract start; no outcome, feature-availability or trade-intent selection.',
      firstContractStartsAt: enrolled.length
        ? Math.min(...enrolled.map((row) => row.decision.kalshiMarket.startsAt))
        : null,
      lastContractStartsAt: enrolled.length
        ? Math.max(...enrolled.map((row) => row.decision.kalshiMarket.startsAt))
        : null,
      counts: {
        eligibleContracts: enrolled.length,
        rejectedContracts: enrolled.filter((row) => row.terminalFailure === 'conflicting-contract')
          .length,
        invalidCaptures: enrolled.filter((row) => row.terminalFailure).length,
        beforeBoundary: ordered.filter(
          (row) => row.decision.kalshiMarket.startsAt <= registration.registeredAt,
        ).length,
        afterBoundary:
          registration.endsAt === null
            ? 0
            : ordered.filter((row) => row.decision.kalshiMarket.startsAt > registration.endsAt)
                .length,
      },
      coverage: {
        initialBooks: ratio(result.initialBooks, enrolled.length),
        delayedBooks: ratio(result.delayedBooks, enrolled.length),
        independentBooks: ratio(result.independentObservations, enrolled.length),
      },
    };
  });
  return {
    version: 'kalshi-pattern-paper-v2',
    mode: 'matched-prospective-suite-cohorts',
    cohorts,
    totalObservedOpportunities: ordered.length,
    unregisteredOpportunities: ordered.filter(
      (row) =>
        !registrations.some((registration) =>
          isContractInPatternCohort(row.decision.kalshiMarket, registration),
        ),
    ).length,
    productionHistory: {
      ...replayPaperAccounts(events, ordered, now, null, ['production', 'raw-baseline']),
      comparableToCandidates: false,
      reason:
        'Broader historical accounts include opportunities before candidate registration and must not be compared with matched candidate profits.',
    },
    warning:
      'Each matched cohort resets every account to identical capital at its predeclared suite boundary. Missing inputs, baseline fallbacks and no-fills remain enrolled. Snapshot paper profits do not establish achievable execution or profitability.',
  };
}

/** Score only immutable issued probabilities; never recompute a historical pattern prediction. */
export function evaluatePatternChallengers(
  evidenceRows = [],
  { now = Date.now(), paperObservations = [], patternSuites = [] } = {},
) {
  const selected = selectEvidence(evidenceRows, now);
  const verified = getVerifiedLearningRows(selected.evidence, now);
  const rows = getIndependentRows(verified.rows).map((row) => ({
    ...row,
    predictions: getPredictions(row.decision),
  }));
  const comparisons = PATTERN_CANDIDATE_KINDS.map((kind) => compare(rows, kind, 'production'));
  comparisons.push(compare(rows, 'combined', 'raw-baseline'));
  comparisons.push(compare(rows, 'combined', 'baseline-control'));
  for (const kind of PATTERN_CANDIDATE_KINDS.filter((name) => name.startsWith('without-')))
    comparisons.push(compare(rows, 'combined', kind));
  const verifiedById = new Map(verified.rows.map((row) => [row.id, row]));
  const cohorts = getPatternProspectiveCohorts(evidenceRows, { now, patternSuites }).map(
    ({ registration, opportunities, counts }) => {
      const settled = opportunities.flatMap((slot) => {
        const row = verifiedById.get(slot.id);
        return row && !slot.terminalFailure
          ? [{ ...row, predictions: getPredictions(row.decision, registration) }]
          : [];
      });
      return {
        ...registration,
        counts: {
          ...counts,
          verifiedOutcomes: settled.length,
          unresolvedOrRejected: opportunities.length - settled.length,
        },
        comparisons: comparisons.map(({ candidate, comparator }) => ({
          ...compare(settled, candidate, comparator),
          enrolledCoverage: ratio(
            settled.filter((row) => row.predictions[candidate] && row.predictions[comparator])
              .length,
            opportunities.length,
          ),
        })),
      };
    },
  );
  return {
    version: PATTERN_EVALUATION_VERSION,
    mode: 'prospective-frozen-predictions',
    generatedAt: now,
    warning:
      'Only predictions saved before settlement are scored. Historical held-out training scores are exploratory. Calibration, accuracy and paper returns alone do not authorize promotion.',
    selection:
      'First capture per contract/checkpoint; one calendar-selected representative per overlapping contract group before checking pattern availability. Ablations match suite and capture.',
    counts: {
      ...verified.counts,
      conflictingCaptures: selected.conflictingCaptures,
      rejectedContracts: selected.rejectedContracts,
      rejectedCaptures: selected.rejectedCaptures,
      rejectedContractReasons: selected.rejectedContractReasons,
      independentWindows: rows.length,
      uniqueContracts: new Set(verified.rows.map((row) => row.marketTicker)).size,
    },
    featureAvailability: featureCoverage(selected.decisions.filter(hasContemporaneousInputs)),
    comparisons,
    comparisonScope:
      'All frozen captures are descriptive; matched prospective eligibility and profitability use the separate registered suite cohorts.',
    cohorts,
    paper: evaluatePaper(
      evidenceRows,
      selected.paperDecisions,
      paperObservations,
      now,
      patternSuites,
    ),
  };
}
