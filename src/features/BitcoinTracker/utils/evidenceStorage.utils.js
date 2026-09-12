import { getKalshiReferenceQuote } from './kalshi/marketConditions.utils';

const DATABASE_NAME = 'bitcoin-tracker-evidence';
const STORE_NAME = 'events';
export const MAXIMUM_EVIDENCE_ROWS = 25_000;

export function openEvidenceDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('Research recording is unavailable in this browser.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 2);
    let settled = false;
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
        store.createIndex('recordedAt', 'recordedAt');
      }
      if (!request.result.objectStoreNames.contains('forecast-outbox')) {
        request.result.createObjectStore('forecast-outbox', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      if (settled) return request.result.close();
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      settled = true;
      reject(new Error('Research data could not be opened.'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('Another tab is blocking research storage.'));
    };
  });
}

export async function appendEvidenceRows(rows) {
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.eventId !== 'string' ||
        !row.eventId ||
        !Number.isSafeInteger(row.recordedAt) ||
        row.recordedAt <= 0,
    )
  ) {
    throw new Error('Research evidence contains an invalid event.');
  }
  if (!rows.length) return;
  const unique = new Map();
  for (const row of rows) if (!unique.has(row.eventId)) unique.set(row.eventId, row);
  const uniqueRows = [...unique.values()];
  const database = await openEvidenceDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const count = store.count();
      let limitReached = false;
      count.onsuccess = () => {
        const additions = [];
        let remaining = uniqueRows.length;
        for (const row of uniqueRows) {
          const exists = store.getKey(row.eventId);
          exists.onsuccess = () => {
            if (exists.result === undefined) additions.push(row);
            remaining -= 1;
            if (remaining !== 0) return;
            if (count.result + additions.length > MAXIMUM_EVIDENCE_ROWS) {
              limitReached = true;
              return;
            }
            // Count and inserts share one read/write transaction, including across browser tabs.
            for (const addition of additions) {
              const request = store.add(addition);
              request.onerror = (event) => {
                if (request.error?.name === 'ConstraintError') {
                  event.preventDefault();
                  event.stopPropagation();
                }
              };
            }
          };
        }
      };
      transaction.oncomplete = () =>
        limitReached
          ? reject(
              new Error('Research storage is full. Recording paused; existing data is retained.'),
            )
          : resolve();
      transaction.onerror = () =>
        reject(new Error('Research recording failed. Existing data is retained.'));
      transaction.onabort = () => reject(new Error('Research recording was interrupted.'));
    });
  } finally {
    database.close();
  }
}

export async function readEvidenceRows() {
  const database = await openEvidenceDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).index('recordedAt').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Research data could not be exported.'));
    });
  } finally {
    database.close();
  }
}

export function getEvidenceRow({
  entry,
  event,
  now,
  ticker,
  estimate,
  conditions,
  stream,
  reason,
  inputObservedAt,
  sessionOrigin = 'new',
  outcomeStatus,
  cohort = 'manual',
  recordingSessionId,
  learningFeatures,
  shadowPrediction,
  earlyShadowPrediction,
}) {
  const timestamp = event === 'observation' ? Math.floor(now / 5000) * 5000 : now;
  const canHaveInputs =
    ['observation', 'decision'].includes(event) &&
    Number.isSafeInteger(inputObservedAt) &&
    inputObservedAt > 0 &&
    inputObservedAt <= now;
  const inputTicker = canHaveInputs ? ticker : null;
  const inputEstimate = canHaveInputs ? estimate : null;
  const inputConditions = canHaveInputs ? conditions : null;
  const inputStream = canHaveInputs ? stream : null;
  const reference = getKalshiReferenceQuote(inputEstimate, inputTicker);
  const hasIssuedCall = entry.aboveProbability !== null && Number.isFinite(entry.aboveProbability);
  const row = {
    schemaVersion: 1,
    eventId: `${entry.id}:${event}:${event === 'observation' ? `${timestamp}${recordingSessionId ? `:${recordingSessionId}` : ''}` : event === 'restored' ? `${entry.status}:${now}` : entry.status}`,
    event,
    forecastId: entry.id,
    recordedAt: now,
    sessionOrigin,
    cohort,
    inputObservedAt: canHaveInputs ? inputObservedAt : null,
    featureCutoffAt: canHaveInputs ? inputObservedAt : null,
    inputStatus: canHaveInputs
      ? 'captured'
      : event === 'restored'
        ? 'restored-without-inputs'
        : event === 'outcome'
          ? 'outcome-only'
          : 'decision-inputs-unavailable',
    windowStartAt: entry.startsAt ?? entry.createdAt,
    capturedAt: hasIssuedCall ? entry.createdAt : null,
    decisionAt: event === 'decision' && canHaveInputs ? inputObservedAt : null,
    expiresAt: entry.expiresAt,
    target: entry.target,
    source: entry.kalshiMarket ? 'Kalshi KXBTC15M / CF Benchmarks BRTI' : 'Coinbase BTC-USD',
    ...(entry.kalshiMarket
      ? {
          kalshiMarket: entry.kalshiMarket,
          kalshi: inputEstimate?.kalshi ?? entry.kalshi ?? null,
          kalshiOutcome: entry.kalshiOutcome ?? null,
          checkpointMinutes: entry.checkpointMinutes ?? null,
          kalshiQuote: inputEstimate?.kalshiQuote ?? null,
        }
      : {}),
    outcomeDefinition: entry.outcomeDefinition ?? 'legacy-first-post-deadline-sample',
    modelVersion:
      event === 'observation'
        ? (inputEstimate?.modelVersion ?? entry.modelVersion)
        : entry.modelVersion,
    policyVersion: entry.analysis?.policyVersion ?? 'immediate-legacy',
    calibrationVersion:
      inputEstimate?.learning?.calibrationVersion ?? entry.learning?.calibrationVersion ?? null,
    learningFeatures: canHaveInputs
      ? (learningFeatures ?? inputEstimate?.learningFeatures ?? null)
      : null,
    shadowPrediction: canHaveInputs
      ? (shadowPrediction ?? inputEstimate?.shadowPrediction ?? null)
      : null,
    earlyShadowPrediction: canHaveInputs
      ? (earlyShadowPrediction ?? inputEstimate?.earlyShadowPrediction ?? null)
      : null,
    learning: inputEstimate?.learning ?? entry.learning ?? null,
    calculationMode: entry.calculationMode ?? null,
    quoteTime: reference?.time ?? null,
    receivedAt: reference?.receivedAt ?? null,
    spot: reference?.price ?? null,
    referenceSource: inputEstimate?.kalshi?.referenceSource ?? null,
    currentSide: !reference
      ? null
      : reference.price > entry.target
        ? 'above'
        : reference.price < entry.target
          ? 'below'
          : 'equal',
    aboveProbability:
      event === 'observation' ? (inputEstimate?.aboveProbability ?? null) : entry.aboveProbability,
    belowProbability:
      event === 'observation' ? (inputEstimate?.belowProbability ?? null) : entry.belowProbability,
    modelAboveProbability: inputEstimate?.aboveProbability ?? null,
    modelBelowProbability: inputEstimate?.belowProbability ?? null,
    pressure: inputEstimate?.pressure ?? null,
    intervalLow: inputEstimate?.lowerBound ?? null,
    intervalHigh: inputEstimate?.upperBound ?? null,
    intervalCoverage:
      inputEstimate?.lowerBound != null && inputEstimate?.upperBound != null ? 0.8 : null,
    horizonMinutes: canHaveInputs ? (entry.expiresAt - inputObservedAt) / 60_000 : null,
    decision: entry.status,
    reason: reason ?? entry.withholdingReason ?? null,
    features: inputConditions?.features ?? null,
    riskFlags: inputConditions?.riskFlags ?? [],
    tradeFlow: inputStream?.flow ?? null,
    liquidity: inputStream?.liquidity ?? null,
    streamQuality: inputStream?.quality ?? null,
    outcomeStatus:
      event === 'outcome'
        ? (outcomeStatus ?? (entry.observedAt != null ? 'observed' : 'unobserved'))
        : null,
    observedAt: entry.observedAt ?? null,
    observedPrice: entry.observedPrice ?? null,
    observedTradeId: entry.observedTradeId ?? null,
    confirmedThrough: entry.confirmedThrough ?? null,
    completeSince: entry.completeSince ?? null,
    outcome: entry.outcome ?? null,
  };
  // Evidence contains only explicit JSON values; functions and non-finite values cannot leak in.
  return JSON.parse(JSON.stringify(row));
}
