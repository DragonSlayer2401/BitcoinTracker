import {
  getKalshiContract,
  isSameKalshiContract,
  isVerifiedKalshiOutcome,
} from '../../../utils/kalshi/contract.utils';
import { scoreProbabilities } from '../../../utils/learning/statistics.utils';
import { getAdvisorBookQuote } from './advisorForecast.utils';

const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const variants = [
  'saved-intention',
  'refreshed-production',
  'execution-midpoint',
  'raw-market-blend',
  'calibrated-market-blend',
];
const contractKey = (contract) => JSON.stringify(getKalshiContract(contract));

function getScores(rows, directionalRows = rows.filter((row) => row.probability !== 0.5)) {
  const score = scoreProbabilities(rows);
  return {
    windows: rows.length,
    brier: score.brier,
    directionCalls: directionalRows.length,
    directionAccuracy: directionalRows.length
      ? directionalRows.filter((row) => Number(row.probability > 0.5) === row.outcome).length /
        directionalRows.length
      : null,
    calibrationBins: score.calibrationBins,
  };
}

function getIdentity(variant, source = {}, role = null) {
  return {
    variant,
    role,
    modelId: source.modelId ?? null,
    modelVersion: source.modelVersion ?? null,
    policyVersion: source.policyVersion ?? null,
    calibrationVersion: source.calibrationVersion ?? null,
    calibrationStatus: source.calibrationStatus ?? null,
  };
}

function getRecordedPredictions(entry) {
  const reconciliation = entry.forecastReconciliation;
  const savedProbability = probability(entry.probability)
    ? entry.side === 'yes'
      ? entry.probability
      : 1 - entry.probability
    : null;
  const values = {
    'saved-intention': probability(savedProbability)
      ? [
          {
            identity: getIdentity('saved-intention', reconciliation?.originalForecast),
            probability: savedProbability,
          },
        ]
      : [],
  };
  const matchingReconciliation = Boolean(
    reconciliation?.version === 'advisor-forecast-reconciliation-v1' &&
    reconciliation.mode === 'shadow-only' &&
    isSameKalshiContract(reconciliation.contract, entry.contract) &&
    timestamp(reconciliation.observedAt) &&
    reconciliation.observedAt === entry.recordedAt,
  );
  if (!matchingReconciliation) return { values, savedProbability };
  const current = reconciliation.currentForecast;
  if (
    reconciliation.recomputed === true &&
    reconciliation.sameExecutionBook === true &&
    current?.available === true &&
    probability(current.aboveProbability) &&
    timestamp(current.capturedAt) &&
    current.capturedAt === entry.recordedAt &&
    isSameKalshiContract(current.contract, entry.contract)
  )
    values['refreshed-production'] = [
      {
        identity: getIdentity('refreshed-production', current),
        probability: current.aboveProbability,
      },
    ];

  const quote = getAdvisorBookQuote({
    contract: entry.contract,
    book: entry.book,
    now: entry.recordedAt,
  });
  const hasMatchingBook = Boolean(
    quote &&
    quote.receivedAt === reconciliation.executionBookReceivedAt &&
    quote.requestedAt === reconciliation.executionBookRequestedAt,
  );
  const midpoint = hasMatchingBook ? (quote.yesAsk + quote.yesBid) / 2 : null;
  if (
    !probability(midpoint) ||
    !probability(reconciliation.executionBookProbability) ||
    Math.abs(midpoint - reconciliation.executionBookProbability) > 1e-9
  ) {
    delete values['refreshed-production'];
    return { values, savedProbability };
  }
  values['execution-midpoint'] = [
    {
      identity: getIdentity('execution-midpoint', { policyVersion: 'kalshi-market-midpoint-v1' }),
      probability: midpoint,
    },
  ];

  const matchingBlends = ['marketBlend', 'activeMarketBlend'].flatMap((field) => {
    const blend = reconciliation[field];
    return values['refreshed-production']?.length === 1 &&
      blend?.available === true &&
      blend.appliedMarket === true &&
      probability(blend.marketProbability) &&
      Math.abs(blend.marketProbability - midpoint) <= 1e-9
      ? [{ blend, role: field === 'activeMarketBlend' ? 'active' : 'candidate' }]
      : [];
  });
  const raw = matchingBlends.find(({ blend }) => probability(blend.rawAboveProbability));
  if (raw)
    values['raw-market-blend'] = [
      {
        identity: getIdentity('raw-market-blend', {
          modelVersion: raw.blend.rawModelVersion,
          policyVersion: raw.blend.policyVersion,
        }),
        probability: raw.blend.rawAboveProbability,
      },
    ];
  values['calibrated-market-blend'] = matchingBlends.flatMap(({ blend, role }) =>
    typeof blend.modelId === 'string' &&
    blend.modelId &&
    blend.calibrationStatus === 'fitted' &&
    probability(blend.aboveProbability)
      ? [
          {
            identity: getIdentity('calibrated-market-blend', blend, role),
            probability: blend.aboveProbability,
          },
        ]
      : [],
  );
  return { values, savedProbability };
}

/** Score frozen entry-time observations; this comparison never trains or activates a model. */
export function getAdvisorForecastEvaluation(events) {
  const entries = new Map();
  const outcomes = new Map();
  let invalidEntryCount = 0;
  let invalidOutcomeCount = 0;
  let entryCount = 0;
  for (const event of events) {
    if (event?.kind === 'fill' && event.action === 'buy') {
      const contract = getKalshiContract(event.contract);
      if (
        !contract ||
        !['yes', 'no'].includes(event.side) ||
        !timestamp(event.recordedAt) ||
        event.recordedAt < contract.startsAt ||
        event.recordedAt >= contract.expiresAt
      ) {
        invalidEntryCount++;
        continue;
      }
      entryCount++;
      const key = contractKey(contract);
      const previous = entries.get(key);
      if (
        !previous ||
        event.recordedAt < previous.recordedAt ||
        (event.recordedAt === previous.recordedAt && String(event.id) < String(previous.id))
      )
        entries.set(key, event);
    }
    if (['settlement', 'comparison'].includes(event?.kind)) {
      if (!isVerifiedKalshiOutcome(event.outcome, event.contract, event.recordedAt)) {
        invalidOutcomeCount++;
        continue;
      }
      const key = contractKey(event.contract);
      const results = outcomes.get(key) ?? new Set();
      results.add(event.outcome.result);
      outcomes.set(key, results);
    }
  }

  const coverage = Object.fromEntries(
    variants.map((variant) => [
      variant,
      { availableWindows: 0, settledAvailableWindows: 0, missingWindows: 0, unavailableWindows: 0 },
    ]),
  );
  const groups = new Map();
  let settledWindows = 0;
  let conflictingOutcomeWindows = 0;
  let missingReconciliationWindows = 0;
  for (const [key, entry] of entries) {
    const results = outcomes.get(key);
    const outcome = results?.size === 1 ? Number(results.has('yes')) : null;
    if (outcome !== null) settledWindows++;
    if (results?.size > 1) conflictingOutcomeWindows++;
    if (!entry.forecastReconciliation) missingReconciliationWindows++;
    const { values, savedProbability } = getRecordedPredictions(entry);
    for (const variant of variants) {
      const predictions = values[variant] ?? [];
      if (!predictions.length) {
        const isMissing =
          variant === 'saved-intention' ? entry.probability == null : !entry.forecastReconciliation;
        coverage[variant][isMissing ? 'missingWindows' : 'unavailableWindows']++;
        continue;
      }
      coverage[variant].availableWindows++;
      if (outcome !== null) coverage[variant].settledAvailableWindows++;
      for (const prediction of predictions) {
        const groupKey = JSON.stringify(prediction.identity);
        const group = groups.get(groupKey) ?? {
          ...prediction.identity,
          availableWindows: 0,
          unpairedSettledWindows: 0,
          rows: [],
        };
        group.availableWindows++;
        if (outcome !== null && probability(savedProbability))
          group.rows.push({
            probability: prediction.probability,
            outcome,
            savedProbability,
            windowStart: entry.contract.startsAt,
          });
        else if (outcome !== null) group.unpairedSettledWindows++;
        groups.set(groupKey, group);
      }
    }
  }
  return {
    version: 'advisor-forecast-evaluation-v1',
    mode: 'exploratory-observational',
    automaticActivation: false,
    entryCount,
    independentWindows: entries.size,
    repeatedEntryCount: entryCount - entries.size,
    settledWindows,
    pendingWindows: entries.size - settledWindows - conflictingOutcomeWindows,
    conflictingOutcomeWindows,
    missingReconciliationWindows,
    invalidEntryCount,
    invalidOutcomeCount,
    coverage: Object.entries(coverage).map(([variant, counts]) => ({
      variant,
      ...counts,
      coverage: entries.size ? counts.availableWindows / entries.size : null,
    })),
    comparisons: [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, { rows, ...identity }]) => {
        const directionalRows = rows.filter(
          (row) => row.probability !== 0.5 && row.savedProbability !== 0.5,
        );
        const scores = getScores(rows, directionalRows);
        const savedIntentionScores = getScores(
          rows.map((row) => ({ ...row, probability: row.savedProbability })),
          directionalRows.map((row) => ({ ...row, probability: row.savedProbability })),
        );
        return {
          ...identity,
          pairedWindows: rows.length,
          scores,
          savedIntentionScores,
          brierDifference: rows.length > 0 ? scores.brier - savedIntentionScores.brier : null,
          directionAccuracyDifference:
            scores.directionAccuracy !== null && savedIntentionScores.directionAccuracy !== null
              ? scores.directionAccuracy - savedIntentionScores.directionAccuracy
              : null,
        };
      }),
  };
}
