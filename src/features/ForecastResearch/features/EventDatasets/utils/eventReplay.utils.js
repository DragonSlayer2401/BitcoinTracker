import {
  createKalshiBookState,
  normalizeKalshiRestBook,
} from '@/services/kalshi/ingestion/kalshiBook.utils';
import { createCoinbaseSpotNormalizer } from '@/services/coinbase/recording/coinbaseSpotNormalizer.utils';
import { parseDecimalUnits } from '@/utils/fixedPoint.utils';

const isTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const copy = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map((entry) => JSON.parse(canonical(entry)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, JSON.parse(canonical(value[key]))]),
          )
      : value,
  );
const lexical = (first, second) => (first < second ? -1 : first > second ? 1 : 0);
const receiptBoundary = (record) =>
  Math.max(
    isTime(record.availableAt) ? record.availableAt : Infinity,
    isTime(record.receivedAt) ? record.receivedAt : Infinity,
  );
const compareRecords = (first, second) =>
  receiptBoundary(first) - receiptBoundary(second) ||
  lexical(String(first.sourceId), String(second.sourceId)) ||
  first.captureSequence - second.captureSequence ||
  first.ordinal - second.ordinal ||
  lexical(String(first.id), String(second.id)) ||
  lexical(canonical(first), canonical(second));
const provenance = (record) => ({
  sourceRecordId: record.id,
  captureSourceId: record.sourceId,
  provenance: record.provenance,
  availableAt: record.availableAt,
  receivedAt: record.receivedAt,
  originalAvailability:
    record.provenance === 'retrospective-history'
      ? 'unknown'
      : record.provenance === 'synthetic-fixture'
        ? 'synthetic-receipt'
        : 'recorded-receipt',
});
const pick = (value, names) =>
  Object.fromEntries(
    names.filter((name) => value?.[name] !== undefined).map((name) => [name, copy(value[name])]),
  );
const safeSpecification = (specification) =>
  specification
    ? {
        ...pick(specification, [
          'version',
          'marketTicker',
          'eventTicker',
          'seriesTicker',
          'currency',
          'timestampUnit',
          'priceScale',
          'quantityScale',
          'moneyScale',
          'target',
          'referenceSource',
          'referenceWindow',
          'closingWindow',
          'comparison',
          'tieResult',
          'rounding',
          'expirationRule',
          'canCloseEarly',
          'settlementTimerSeconds',
          'priceGrid',
          'priceLevelStructure',
          'quantityRules',
          'contingency',
          'outcomeRulesVerified',
          'verification',
          'actionable',
          'sources',
          'ruleText',
        ]),
        timestamps: pick(specification.timestamps, [
          'opensAt',
          'closesAt',
          'expectedExpirationAt',
          'expirationAt',
          'latestExpirationAt',
        ]),
      }
    : null;
const safeContract = (market, record, referenceHistory) => {
  const value = market.reference?.openingLevel ?? null;
  const units = typeof value === 'string' ? parseDecimalUnits(value, 2) : null;
  const openingLevel = units !== null && units > 0n ? value : null;
  if (openingLevel !== null && parseDecimalUnits(referenceHistory.at(-1)?.value, 2) !== units)
    referenceHistory.push({
      value: openingLevel,
      revision: referenceHistory.length + 1,
      firstSeenAt: record.availableAt,
      ...provenance(record),
    });
  const knownReference = openingLevel === null ? null : referenceHistory.at(-1);
  return {
    ...pick(market, [
      'ticker',
      'eventTicker',
      'seriesTicker',
      'exchangeIndex',
      'ruleVersion',
      'ruleVersionKind',
    ]),
    specification: safeSpecification(market.specification),
    reference: {
      sourceId: 'cf-brti',
      sourceKind: 'official',
      instrument: 'BRTI',
      currency: 'USD',
      openingLevel,
      availableAt: knownReference?.availableAt ?? null,
      firstSeenAt: knownReference?.firstSeenAt ?? null,
      revision: knownReference?.revision ?? null,
      history: copy(referenceHistory),
    },
    lifecycle: pick(market.lifecycle, [
      'state',
      'opensAt',
      'tradingClosesAt',
      'expiresAt',
      'expectedExpirationAt',
      'providerUpdatedAt',
      'observedAt',
    ]),
    ...provenance(record),
  };
};

/** Receipt-time replay only. Labels and eventual dataset quality never enter these snapshots. */
export const createEventReplay = ({
  records = [],
  freshnessMs = 5000,
  lookbackMs = 900_000,
} = {}) => {
  if (
    !Array.isArray(records) ||
    !Number.isSafeInteger(freshnessMs) ||
    freshnessMs <= 0 ||
    !Number.isSafeInteger(lookbackMs) ||
    lookbackMs <= 0
  )
    throw new TypeError(
      'Replay requires records and positive millisecond freshness/lookback limits.',
    );
  const ordered = records.map((record) => copy(record)).sort(compareRecords);
  let cursor = 0;
  let processedAt = 0;
  let clockAt = 0;
  let contracts;
  let openingLevels;
  let references;
  let bookSources;
  let spotSources;
  let feedStatuses;
  let issues;
  let seenIds;
  let retrospectiveRecordsSeen;
  const reset = () => {
    cursor = 0;
    processedAt = 0;
    contracts = new Map();
    openingLevels = new Map();
    references = new Map();
    bookSources = new Map();
    spotSources = new Map();
    feedStatuses = new Map();
    issues = [];
    seenIds = new Map();
    retrospectiveRecordsSeen = 0;
  };
  reset();
  const addIssue = (record, reason) =>
    issues.push({
      reason,
      availableAt: record.availableAt,
      sourceRecordId: record.id,
      sourceId: record.sourceId,
    });
  const getBookSource = (record) => {
    if (!bookSources.has(record.sourceId))
      bookSources.set(record.sourceId, {
        tickers: [],
        engine: createKalshiBookState({ tickers: [], freshnessMs }),
        metadata: new Map(),
        rest: new Map(),
        connected: false,
      });
    return bookSources.get(record.sourceId);
  };
  const apply = (record) => {
    if (
      record.schemaVersion !== 'event-source-record-v1' ||
      !isTime(record.receivedAt) ||
      !isTime(record.availableAt) ||
      record.availableAt < record.receivedAt ||
      !['kalshi', 'coinbase', 'historical'].includes(record.sourceKind) ||
      !['original-recording', 'retrospective-history', 'synthetic-fixture'].includes(
        record.provenance,
      )
    ) {
      addIssue(record, 'invalid_source_envelope');
      return;
    }
    if (seenIds.has(record.id)) {
      const previous = seenIds.get(record.id);
      const reason =
        canonical(previous) === canonical(record)
          ? 'duplicate_source_record'
          : 'conflicting_source_record';
      addIssue(record, reason);
      if (reason === 'conflicting_source_record') {
        for (const sourceId of new Set([previous.sourceId, record.sourceId])) {
          const bookSource = bookSources.get(sourceId);
          bookSource?.engine.invalidate(reason, record.receivedAt);
          bookSource?.rest.clear();
          const spotSource = spotSources.get(sourceId);
          if (spotSource) {
            spotSource.engine = createCoinbaseSpotNormalizer({ freshnessMs });
            spotSource.observations = spotSource.observations.filter(
              (observation) => observation.sourceRecordId !== record.id,
            );
          }
        }
        for (const [time, observation] of references)
          if (observation.sourceRecordId === record.id) references.delete(time);
        for (const [ticker, contract] of contracts)
          if (contract.sourceRecordId === record.id) {
            contracts.delete(ticker);
            openingLevels.set(
              ticker,
              (openingLevels.get(ticker) ?? []).filter(
                (level) => level.sourceRecordId !== record.id,
              ),
            );
          }
      }
      return;
    }
    seenIds.set(record.id, record);
    if (record.provenance === 'retrospective-history') retrospectiveRecordsSeen += 1;
    const input = record.input ?? {};
    const normalized = record.normalized ?? {};
    if (record.sourceKind === 'coinbase') {
      let source = spotSources.get(record.sourceId);
      if (!source || source.captureSequence !== record.captureSequence) {
        source = {
          captureSequence: record.captureSequence,
          engine: createCoinbaseSpotNormalizer({ freshnessMs }),
          observations: source?.observations ?? [],
          record,
        };
        spotSources.set(record.sourceId, source);
      }
      const output = source.engine.apply(input);
      source.record = record;
      if (
        output.observation &&
        (output.observation.time > record.receivedAt ||
          (output.observation.eventTimeNanoseconds !== null &&
            BigInt(output.observation.eventTimeNanoseconds) >
              BigInt(record.receivedAt) * 1_000_000n))
      ) {
        source.engine = createCoinbaseSpotNormalizer({ freshnessMs });
        addIssue(record, 'future_spot_observation');
        return;
      }
      if (output.observation)
        source.observations.push({ ...copy(output.observation), ...provenance(record) });
      if (['invalid', 'out_of_order'].includes(output.disposition) || output.gaps?.length)
        addIssue(record, 'spot_invalid_or_gap');
      return;
    }
    if (normalized.disposition === 'invalid') addIssue(record, 'invalid_normalized_observation');
    const marketRows = normalized.market
      ? [{ market: normalized.market }]
      : (normalized.records ?? []);
    for (const { market } of marketRows) {
      if (
        !market?.ticker ||
        (isTime(market.receivedAt) && market.receivedAt > record.receivedAt) ||
        (isTime(market.lifecycle?.observedAt) && market.lifecycle.observedAt > record.receivedAt) ||
        (isTime(market.lifecycle?.providerUpdatedAt) &&
          market.lifecycle.providerUpdatedAt > record.receivedAt)
      ) {
        addIssue(record, 'invalid_or_future_market_metadata');
        continue;
      }
      const history = openingLevels.get(market.ticker) ?? [];
      const contract = safeContract(market, record, history);
      openingLevels.set(market.ticker, history);
      contracts.set(market.ticker, contract);
    }
    for (const observation of normalized.observations ?? []) {
      const calculatedAt = observation.sourceCalculatedAt;
      if (
        observation.source?.id !== 'cf-brti' ||
        observation.indexId !== 'BRTI' ||
        !isTime(calculatedAt) ||
        calculatedAt > record.receivedAt ||
        !isTime(observation.receivedAt) ||
        observation.receivedAt > record.receivedAt ||
        [
          'firstSeenAt',
          'sourceAmendedAt',
          'sourcePublishedAt',
          'providerReceivedAt',
          'providerSentAt',
        ].some((field) => isTime(observation[field]) && observation[field] > record.receivedAt)
      ) {
        addIssue(record, 'invalid_or_future_reference_observation');
        continue;
      }
      references.set(calculatedAt, { ...copy(observation), ...provenance(record) });
    }
    if (input.kind === 'reference-status')
      feedStatuses.set(record.sourceId, {
        status: input.status,
        availableAt: record.availableAt,
      });
    if (input.kind === 'capture-stopped')
      feedStatuses.set(record.sourceId, {
        status: 'stopped',
        availableAt: record.availableAt,
      });
    if (!input.kind?.startsWith('book-') && input.kind !== 'capture-stopped') return;
    const source = getBookSource(record);
    try {
      if (input.kind === 'book-reset') {
        source.tickers = input.tickers;
        source.engine = createKalshiBookState({ tickers: source.tickers, freshnessMs });
        source.metadata.clear();
      } else if (input.kind === 'book-connection') {
        source.connected = input.state === 'connected';
        if (source.connected)
          source.engine = createKalshiBookState({ tickers: source.tickers, freshnessMs });
        else source.engine.invalidate(input.reason ?? input.state, record.receivedAt);
      } else if (input.kind === 'capture-stopped') {
        source.connected = false;
        source.engine.invalidate('capture_stopped', record.receivedAt);
      } else if (input.kind === 'book-rest') {
        const book = normalizeKalshiRestBook(input.rawPayload, input.ticker, record.receivedAt);
        source.rest.set(input.ticker, {
          ...book,
          ...provenance(record),
          evidenceKind: 'independent-rest-snapshot',
        });
      } else if (input.kind === 'book-frame') {
        const frame = JSON.parse(input.rawPayload);
        const output = source.engine.accept(frame, record.receivedAt);
        if (output.disposition === 'accepted' && frame.msg?.market_ticker)
          source.metadata.set(frame.msg.market_ticker, provenance(record));
        if (output.requiresResync) addIssue(record, 'kalshi_book_gap_or_invalid');
      }
    } catch {
      source.engine.invalidate('invalid_source_book', record.receivedAt);
      addIssue(record, 'invalid_source_book');
    }
  };
  const advanceTo = (at) => {
    if (!isTime(at))
      throw new TypeError('Replay decisions require UTC Unix millisecond timestamps.');
    if (at < processedAt) reset();
    while (cursor < ordered.length && receiptBoundary(ordered[cursor]) <= at) {
      apply(ordered[cursor]);
      cursor += 1;
    }
    processedAt = at;
  };
  const asOf = (ticker, at = clockAt) => {
    if (typeof ticker !== 'string' || !ticker)
      throw new TypeError('Replay needs a contract ticker.');
    advanceTo(at);
    const startsAt = at - lookbackMs;
    const observations = [...references.values()]
      .filter(
        (observation) =>
          observation.sourceCalculatedAt > startsAt &&
          observation.sourceCalculatedAt <= at &&
          observation.canonicalSecond === true &&
          observation.repeatOfPreviousValue === false,
      )
      .sort((first, second) => first.sourceCalculatedAt - second.sourceCalculatedAt);
    const latest = observations.at(-1) ?? null;
    const referenceStatus = latest ? feedStatuses.get(latest.captureSourceId) : null;
    const statusBlocks =
      referenceStatus &&
      referenceStatus.availableAt >= latest.availableAt &&
      ['stopped', 'unauthorized', 'unavailable', 'not-configured', 'stale'].includes(
        referenceStatus.status,
      );
    const referenceAvailable = Boolean(
      latest &&
      at - latest.sourceCalculatedAt <= freshnessMs &&
      at - latest.receivedAt <= freshnessMs &&
      !statusBlocks,
    );
    const spotObservations = [];
    const spotStates = [];
    for (const source of spotSources.values()) {
      const health = source.engine.getSnapshot(at);
      spotStates.push({ ...health, ...provenance(source.record) });
      spotObservations.push(
        ...source.observations.filter(
          (observation) =>
            (observation.time ?? observation.receivedAt) > startsAt &&
            (observation.time === null || observation.time <= at),
        ),
      );
    }
    spotObservations.sort(
      (first, second) =>
        (first.time ?? first.receivedAt) - (second.time ?? second.receivedAt) ||
        first.availableAt - second.availableAt ||
        lexical(first.sourceRecordId, second.sourceRecordId),
    );
    spotStates.sort(
      (first, second) =>
        second.availableAt - first.availableAt ||
        lexical(first.captureSourceId, second.captureSourceId),
    );
    const spotState = spotStates.find((state) => state.available) ?? spotStates[0] ?? null;
    const spotLatest =
      spotObservations.findLast((observation) => observation.price != null) ?? null;
    const candidates = [];
    const independentSnapshots = [];
    for (const source of bookSources.values()) {
      const book = source.engine.getSnapshot(at).books[ticker];
      if (book)
        candidates.push({
          ...book,
          ...source.metadata.get(ticker),
          available: source.connected && book.available,
          evidenceKind: 'reconstructed-websocket',
        });
      const rest = source.rest.get(ticker);
      if (rest)
        independentSnapshots.push({
          ...rest,
          available: rest.available && at >= rest.receivedAt && at - rest.receivedAt <= freshnessMs,
          sourceTime: null,
          sourceSequenceBoundaryAvailable: false,
          depthLimit: 100,
          fullDepthVerified: false,
        });
    }
    const orderBooks = (first, second) =>
      (second.receivedAt ?? 0) - (first.receivedAt ?? 0) ||
      lexical(first.captureSourceId ?? '', second.captureSourceId ?? '');
    candidates.sort(orderBooks);
    independentSnapshots.sort(orderBooks);
    const kalshiBook =
      candidates.find((book) => book.available) ??
      independentSnapshots.find(
        (book) =>
          book.available &&
          book.provenance !== 'retrospective-history' &&
          book.receivedAt >= (candidates[0]?.receivedAt ?? 0),
      ) ??
      candidates[0] ??
      null;
    const contract = contracts.get(ticker) ?? null;
    const expectedSamples = Math.floor(at / 1000) - Math.floor(startsAt / 1000);
    const reasons = [];
    if (!contract) reasons.push('contract_not_available_as_of');
    if (contract && contract.reference.openingLevel === null)
      reasons.push('opening_reference_not_available_as_of');
    if (!referenceAvailable) reasons.push('official_reference_missing_or_stale');
    if (observations.length < expectedSamples) reasons.push('missing_reference_samples');
    if (contract && contract.specification?.outcomeRulesVerified !== true)
      reasons.push('outcome_rules_not_verified');
    return copy({
      schemaVersion: 'event-asof-v1',
      ticker,
      decisionAt: at,
      contract,
      modelInputs: {
        reference: {
          sourceId: 'cf-brti',
          sourceKind: 'official',
          observations,
          latest,
          available: referenceAvailable,
          sourceAgeMs: latest ? at - latest.sourceCalculatedAt : null,
          provenance: latest?.provenance ?? null,
          sourceAgencyOutage: null,
        },
        spot: {
          sourceId: 'coinbase-btc-usd',
          sourceKind: 'proxy',
          observations: spotObservations,
          latest: spotLatest,
          available: spotState?.available === true,
          reason: spotState?.reason ?? 'spot_not_recorded',
          health: spotState,
          provenance: spotLatest?.provenance ?? null,
        },
      },
      tradingInputs: { kalshiBook, independentRestBooks: independentSnapshots },
      quality: {
        reasons,
        referenceCoverage: {
          windowStartExclusive: startsAt,
          windowEndInclusive: at,
          expectedSamples,
          availableSamples: observations.length,
          missingSamples: expectedSamples - observations.length,
        },
        observedIssues: issues,
        orderbookDepthAvailable: kalshiBook?.available === true,
        orderbookReasons: kalshiBook?.available ? [] : ['historical_orderbook_depth_unavailable'],
        retrospectiveRecordsSeen,
      },
    });
  };
  const clock = {
    now: () => clockAt,
    set: (at) => {
      advanceTo(at);
      clockAt = at;
      return clockAt;
    },
    advance: (milliseconds) => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new TypeError('Replay clock advances by nonnegative integer milliseconds.');
      return clock.set(clockAt + milliseconds);
    },
  };
  return { clock, asOf };
};
