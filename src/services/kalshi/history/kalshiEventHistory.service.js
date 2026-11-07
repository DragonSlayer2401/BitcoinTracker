import 'server-only';
import { randomUUID } from 'node:crypto';
import { fetchKalshiResource } from '../kalshi.transport';
import { assertKalshiTicker, parseKalshiSeries } from '../kalshi.validation';
import { createKalshiReferenceNormalizer } from '../ingestion/kalshiReference.utils';

const hourMs = 60 * 60_000;
const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const failure = (status) => {
  if (status === 404)
    return { status: 'missing', reason: 'Requested historical resource was not found.' };
  if ([401, 403].includes(status))
    return {
      status: 'unauthorized',
      reason: 'Credentials or historical-data entitlement were denied.',
    };
  if (status === 429)
    return { status: 'rate-limited', reason: 'The shared Kalshi read allowance requires a retry.' };
  return { status: 'unavailable', reason: 'Requested historical resource could not be read.' };
};

/**
 * Retrospective evidence only. Source times never become historical availability times.
 * Kalshi Trade API v2 / CF API v1; official documentation reviewed 2026-11-07 UTC:
 * https://docs.kalshi.com/getting_started/historical_data
 * https://docs.kalshi.com/api-reference/historical/get-historical-market
 * https://docs.kalshi.com/cfbenchmarks/rest-passthrough
 * https://docs.cfbenchmarks.com/api/rest/historical-values/
 */
export const fetchKalshiEventHistory = async ({
  tickers,
  referenceHours = [],
  request = fetchKalshiResource,
  now = Date.now,
} = {}) => {
  const capturedAt = now();
  if (!isTime(capturedAt))
    throw new TypeError('Historical capture requires a UTC millisecond clock.');
  // These are bounded local operation limits, not exchange capabilities.
  if (!Array.isArray(tickers) || tickers.length > 100 || new Set(tickers).size !== tickers.length)
    throw new TypeError('Choose at most 100 unique KXBTC15M tickers.');
  tickers.forEach(assertKalshiTicker);
  if (
    !Array.isArray(referenceHours) ||
    referenceHours.length > 24 ||
    new Set(referenceHours).size !== referenceHours.length ||
    referenceHours.some(
      (startsAt) => !isTime(startsAt) || startsAt % hourMs !== 0 || startsAt + hourMs > capturedAt,
    )
  )
    throw new TypeError(
      'Choose at most 24 unique completed UTC-hour start timestamps in milliseconds.',
    );
  if (tickers.length === 0 && referenceHours.length === 0)
    throw new TypeError('Choose at least one ticker or completed reference hour.');

  const supplementId = randomUUID();
  const captures = [];
  const requests = [];
  const coverage = {
    requestedTickers: [...tickers],
    receivedTickers: [],
    missingMarkets: [],
    requestedReferenceHours: [...referenceHours],
    referenceHours: [],
    seriesReceived: false,
    historicalOrderBooks: 'unavailable',
    originalAvailability: 'unknown',
  };
  const read = async (kind, resourcePath, { ticker = null, hourStartsAt = null } = {}) => {
    let rawPayload;
    let receivedAt;
    try {
      rawPayload = await request(resourcePath);
      receivedAt = now();
      if (!isTime(receivedAt)) throw new Error('Invalid receive clock.');
    } catch (error) {
      receivedAt = now();
      if (!isTime(receivedAt))
        throw new TypeError('Historical capture requires a UTC millisecond clock.');
      const httpStatus = Number.isSafeInteger(error?.status) ? error.status : null;
      const report = {
        kind,
        resourcePath,
        ticker,
        hourStartsAt,
        receivedAt,
        httpStatus,
        ...failure(httpStatus),
      };
      requests.push(report);
      return { capture: null, report };
    }
    const report = {
      kind,
      resourcePath,
      ticker,
      hourStartsAt,
      receivedAt,
      httpStatus: 200,
      status: 'available',
      reason: null,
    };
    requests.push(report);
    let capture;
    try {
      // Preserve the parsed source body, including malformed semantic responses, for audit.
      const text = JSON.stringify(rawPayload);
      if (text === undefined) throw new Error('No source payload.');
      capture = {
        id: `${supplementId}:${captures.length + 1}`,
        kind,
        resourcePath,
        receivedAt,
        rawPayload: kind === 'benchmark-rest' ? text : JSON.parse(text),
        provenance: 'retrospective-history',
        originalAvailability: 'unknown',
      };
      captures.push(capture);
    } catch {
      report.status = 'invalid';
      report.reason = 'Historical response was not a supported JSON payload.';
      return { capture: null, report };
    }
    return { capture, report };
  };

  const series = await read('series', '/series/KXBTC15M');
  if (series.capture) {
    try {
      parseKalshiSeries(series.capture.rawPayload);
      coverage.seriesReceived = true;
    } catch {
      series.report.status = 'invalid';
      series.report.reason =
        'Series metadata failed validation; historical rule coverage is incomplete.';
    }
  }
  for (const ticker of tickers) {
    let market = await read('market', `/markets/${ticker}`, { ticker });
    if (market.report.httpStatus === 404)
      market = await read('market', `/historical/markets/${ticker}`, { ticker });
    const returned = market.capture?.rawPayload?.market ?? market.capture?.rawPayload;
    if (market.capture && returned?.ticker === ticker) coverage.receivedTickers.push(ticker);
    else {
      if (market.capture) {
        market.report.status = 'invalid';
        market.report.reason =
          'Historical market identity is absent or differs from the requested contract.';
      }
      coverage.missingMarkets.push({ ticker, reason: market.report.reason });
    }
  }
  for (const startsAt of referenceHours) {
    const query = new URLSearchParams({
      id: 'BRTI',
      timespan: 'HOUR',
      timestamp: new Date(startsAt).toISOString(),
      maxResolution: 'PER_SECOND',
    });
    const result = await read('benchmark-rest', `/cfbenchmarks/history/values?${query}`, {
      hourStartsAt: startsAt,
    });
    let observations = [];
    let invalidRows = 0;
    let validationIssues = [];
    if (result.capture) {
      const batch = createKalshiReferenceNormalizer().apply(result.capture);
      observations = batch.observations;
      validationIssues = batch.issues;
      invalidRows = batch.issues.filter((issue) => issue.rowIndex !== null).length;
      if (['invalid', 'partial'].includes(batch.disposition)) {
        result.report.status = 'invalid';
        result.report.reason =
          'Some historical reference values failed validation; inspect raw evidence.';
      }
    }
    const seconds = new Set(
      observations
        .filter(
          (observation) =>
            observation.canonicalSecond &&
            !observation.repeatOfPreviousValue &&
            observation.sourceCalculatedAt >= startsAt &&
            observation.sourceCalculatedAt < startsAt + hourMs,
        )
        .map((observation) => observation.sourceCalculatedAt),
    );
    const expectedCanonicalSeconds = hourMs / 1000;
    const missingSeconds = expectedCanonicalSeconds - seconds.size;
    coverage.referenceHours.push({
      startsAt,
      endsAt: startsAt + hourMs,
      status:
        result.report.status === 'available' && missingSeconds > 0
          ? 'partial'
          : result.report.status,
      canonicalSeconds: seconds.size,
      expectedCanonicalSeconds,
      missingSeconds,
      invalidRows,
      validationIssues,
      reason:
        result.report.reason ??
        (missingSeconds > 0
          ? 'Canonical reference seconds are missing; recent history may not yet be published.'
          : null),
    });
  }
  return {
    schemaVersion: 'event-historical-supplement-v1',
    supplementId,
    capturedAt,
    captures,
    requests,
    coverage,
  };
};
