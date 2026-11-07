import { KALSHI_RESEARCH_CHECKPOINTS } from '../../EvidenceCollection/utils/kalshi/researchRecorder.utils';
import { createEventReplay } from './eventReplay.utils';

const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const metadataRows = (record) =>
  record.normalized?.market
    ? [record.normalized.market]
    : (record.normalized?.records ?? []).map((entry) => entry.market).filter(Boolean);
const ordered = (records) =>
  [...records].sort(
    (left, right) =>
      left.availableAt - right.availableAt ||
      compare(left.sourceId, right.sourceId) ||
      left.captureSequence - right.captureSequence ||
      left.ordinal - right.ordinal ||
      compare(left.id, right.id),
  );
const validTicker = (ticker) =>
  typeof ticker === 'string' && /^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/.test(ticker);

const referenceCoverage = (records, end, knownBy = Infinity) => {
  if (!isTime(end)) return { expectedSamples: 60, observedSamples: 0, missingSamples: 60 };
  const latestBySecond = new Map();
  for (const record of records) {
    if (record.availableAt > knownBy) continue;
    for (const observation of record.normalized?.observations ?? []) {
      if (
        observation.source?.id === 'cf-brti' &&
        observation.sourceCalculatedAt > end - 60_000 &&
        observation.sourceCalculatedAt <= end &&
        observation.receivedAt <= knownBy
      )
        latestBySecond.set(observation.sourceCalculatedAt, observation);
    }
  }
  const count = [...latestBySecond.values()].filter(
    (sample) => sample.canonicalSecond && !sample.repeatOfPreviousValue,
  ).length;
  return {
    expectedSamples: 60,
    observedSamples: count,
    missingSamples: Math.max(0, 60 - count),
  };
};

/** Build data only. Outcome labels never enter the replay engine's prediction inputs. */
export const buildEventDataset = ({
  records = [],
  sources = [],
  issues = [],
  freshnessMs = 5000,
  lookbackMs = 900_000,
} = {}) => {
  const sorted = ordered(records);
  const contracts = new Map();
  const labels = [];
  const latestLabels = new Map();
  const ensure = (ticker) => {
    if (!contracts.has(ticker)) contracts.set(ticker, { ticker, metadata: [], reasons: [] });
    return contracts.get(ticker);
  };
  for (const record of sorted) {
    for (const market of metadataRows(record)) {
      if (!validTicker(market.ticker)) continue;
      const event = ensure(market.ticker);
      event.metadata.push({ record, market });
      const outcome = market.finalOutcome;
      if (!outcome?.authoritative || !['YES', 'NO'].includes(outcome.result)) continue;
      const semantic = JSON.stringify([
        outcome.result,
        outcome.settlementIndexValue,
        outcome.payoutDollars,
        outcome.settlementAt,
      ]);
      const previous = latestLabels.get(market.ticker);
      if (previous?.semantic === semantic) continue;
      const label = {
        schemaVersion: 'event-outcome-label-v1',
        ticker: market.ticker,
        result: outcome.result,
        settlementIndexValue: outcome.settlementIndexValue,
        payoutDollars: outcome.payoutDollars,
        settlementAt: outcome.settlementAt,
        availableAt: record.availableAt,
        receivedAt: record.receivedAt,
        sourceId: record.sourceId,
        sourceRecordId: record.id,
        provenance: record.provenance,
        revision: (previous?.label.revision ?? 0) + 1,
        supersedesRevision: previous?.label.revision ?? null,
      };
      latestLabels.set(market.ticker, { semantic, label });
      labels.push(label);
    }
    // Malformed or unsupported market evidence remains an excluded contract when identifiable.
    const rawMarkets =
      record.input?.kind === 'market-page'
        ? record.input.rawPayload?.markets
        : record.input?.kind === 'market'
          ? [record.input.rawPayload?.market ?? record.input.rawPayload]
          : [];
    for (const raw of rawMarkets ?? [])
      if (validTicker(raw?.ticker) && !contracts.has(raw.ticker)) {
        const closesAt = Date.parse(raw.close_time);
        const outsideHorizon =
          record.input.kind === 'market-page' &&
          Number.isFinite(closesAt) &&
          (closesAt <= record.receivedAt || closesAt > record.receivedAt + record.input.horizonMs);
        ensure(raw.ticker).reasons.push(
          outsideHorizon ? 'outside_recorded_discovery_horizon' : 'market_metadata_not_normalized',
        );
      }
  }
  for (const issue of issues)
    if (validTicker(issue.ticker)) {
      const event = ensure(issue.ticker);
      // A resolved current-to-historical fallback is diagnostic, not an event exclusion.
      if (!event.metadata.length) event.reasons.push(issue.code);
    }
  for (const source of sources)
    for (const ticker of source.coverage?.requestedTickers ?? []) {
      if (validTicker(ticker) && !contracts.has(ticker))
        ensure(ticker).reasons.push('historical_market_unavailable');
    }
  if (contracts.size > 2500)
    throw new Error(
      'Dataset exceeds the local 2500-contract build limit. Use a bounded source selection.',
    );
  const replay = createEventReplay({ records: sorted, freshnessMs, lookbackMs });
  const requests = [];
  for (const event of contracts.values()) {
    // Freeze the first observed schedule; a later close correction is reported, never backdated.
    const first = event.metadata.find(
      ({ market }) =>
        isTime(market.lifecycle?.opensAt) && isTime(market.lifecycle?.tradingClosesAt),
    );
    event.schedule = first
      ? {
          opensAt: first.market.lifecycle.opensAt,
          closesAt: first.market.lifecycle.tradingClosesAt,
          availableAt: first.record.availableAt,
        }
      : null;
    if (event.schedule)
      for (const horizonMinutes of KALSHI_RESEARCH_CHECKPOINTS)
        requests.push({
          ticker: event.ticker,
          horizonMinutes,
          decisionAt: event.schedule.closesAt - horizonMinutes * 60_000,
        });
  }
  requests.sort(
    (left, right) => left.decisionAt - right.decisionAt || compare(left.ticker, right.ticker),
  );
  const snapshots = requests.map(({ ticker, horizonMinutes, decisionAt }) => {
    const observed = replay.asOf(ticker, decisionAt);
    const reasons = [...observed.quality.reasons];
    if (!observed.contract) reasons.push('contract_not_known_at_horizon');
    if (observed.contract && observed.contract.specification?.outcomeRulesVerified !== true)
      reasons.push('outcome_rules_unverified');
    if (observed.contract?.reference?.openingLevel == null)
      reasons.push('opening_reference_not_available');
    if (
      observed.contract &&
      observed.contract.lifecycle.tradingClosesAt !== decisionAt + horizonMinutes * 60_000
    )
      reasons.push('as_of_close_no_longer_matches_horizon');
    if (observed.quality.referenceCoverage.missingSamples > 0)
      reasons.push('reference_history_incomplete');
    return {
      ...observed,
      schemaVersion: 'event-feature-snapshot-v1',
      snapshotId: `${ticker}:${decisionAt}:${horizonMinutes}m`,
      horizonMinutes,
      eligibility: { featureReady: reasons.length === 0, reasons: [...new Set(reasons)].sort() },
    };
  });
  const events = [...contracts.values()]
    .sort((left, right) => compare(left.ticker, right.ticker))
    .map((event) => {
      const horizons = snapshots.filter((snapshot) => snapshot.ticker === event.ticker);
      const reasons = [...event.reasons];
      if (!event.metadata.length) reasons.push('market_metadata_unavailable');
      if (!event.schedule) reasons.push('contract_schedule_unavailable');
      if (
        event.metadata.length &&
        !event.metadata.some(({ market }) => market.specification?.outcomeRulesVerified === true)
      )
        reasons.push('outcome_rules_unverified');
      if (
        event.schedule &&
        event.metadata.some(
          ({ market }) => market.lifecycle?.tradingClosesAt !== event.schedule.closesAt,
        )
      )
        reasons.push('contract_close_revision_requires_review');
      if (!horizons.some((snapshot) => snapshot.eligibility.featureReady))
        reasons.push('no_feature_ready_horizons');
      const latestLabel = latestLabels.get(event.ticker)?.label;
      return {
        schemaVersion: 'event-dataset-contract-v1',
        ticker: event.ticker,
        schedule: event.schedule,
        firstObservedAt: event.metadata[0]?.record.availableAt ?? null,
        status: reasons.length ? 'excluded' : latestLabel ? 'ready' : 'unresolved',
        resolutionStatus: latestLabel ? 'resolved' : 'unresolved',
        reasons: [
          ...new Set([...reasons, ...(!latestLabel ? ['official_outcome_unavailable'] : [])]),
        ].sort(),
        metadataRecordIds: event.metadata.map(({ record }) => record.id),
        outcomeLabelRevision: latestLabel?.revision ?? null,
        horizons: horizons.map((snapshot) => ({
          minutes: snapshot.horizonMinutes,
          decisionAt: snapshot.decisionAt,
          featureReady: snapshot.eligibility.featureReady,
          reasons: snapshot.eligibility.reasons,
        })),
        referenceCoverage: {
          opening: referenceCoverage(sorted, event.schedule?.opensAt),
          closing: referenceCoverage(sorted, event.schedule?.closesAt),
          closingKnownAtClose: referenceCoverage(
            sorted,
            event.schedule?.closesAt,
            event.schedule?.closesAt ?? 0,
          ),
        },
      };
    });
  const depthGaps = snapshots
    .filter((snapshot) => !snapshot.tradingInputs.kalshiBook?.available)
    .map((snapshot) => ({
      ticker: snapshot.ticker,
      horizonMinutes: snapshot.horizonMinutes,
      decisionAt: snapshot.decisionAt,
      reason: snapshot.tradingInputs.kalshiBook?.reason ?? 'order_book_unavailable',
    }));
  const missingReferences = snapshots
    .filter((snapshot) => snapshot.quality.referenceCoverage.missingSamples > 0)
    .map((snapshot) => ({
      ticker: snapshot.ticker,
      horizonMinutes: snapshot.horizonMinutes,
      ...snapshot.quality.referenceCoverage,
    }));
  const provenanceCounts = {};
  for (const record of sorted)
    provenanceCounts[record.provenance] = (provenanceCounts[record.provenance] ?? 0) + 1;
  return {
    schemaVersion: 'event-dataset-v1',
    configuration: { horizonsMinutes: [...KALSHI_RESEARCH_CHECKPOINTS], freshnessMs, lookbackMs },
    events,
    snapshots,
    labels,
    quality: {
      schemaVersion: 'event-data-quality-v1',
      eventCount: events.length,
      expectedHorizonSlots: events.length * KALSHI_RESEARCH_CHECKPOINTS.length,
      eventsWithoutKnownSchedule: events
        .filter((event) => event.schedule === null)
        .map((event) => event.ticker),
      snapshotCount: snapshots.length,
      featureReadySnapshots: snapshots.filter((snapshot) => snapshot.eligibility.featureReady)
        .length,
      provenanceCounts,
      sources: [...sources].sort((left, right) => compare(left.sourceId, right.sourceId)),
      sourceIssues: [...issues].sort((left, right) =>
        compare(JSON.stringify(left), JSON.stringify(right)),
      ),
      excludedEvents: events
        .filter((event) => event.status === 'excluded')
        .map(({ ticker, reasons }) => ({ ticker, reasons })),
      unresolvedEvents: events
        .filter((event) => event.resolutionStatus === 'unresolved')
        .map(({ ticker }) => ({ ticker, reason: 'official_outcome_unavailable' })),
      missingReferenceSamples: missingReferences,
      inadequateHistoricalDepth: depthGaps,
      historicalOrderBookCoverage:
        'Only original recorded snapshots/updates provide depth. Candles and results are never converted into books.',
      sourceAgencyOutageEstablished: false,
    },
  };
};
