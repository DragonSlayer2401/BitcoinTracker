import { createKalshiMarketHistory } from './kalshiMarket.utils';
import { createKalshiBookState, normalizeKalshiRestBook } from './kalshiBook.utils';
import { createKalshiReferenceNormalizer } from './kalshiReference.utils';

export const createKalshiIngestionState = ({ freshnessMs = 5000 } = {}) => {
  const marketHistory = createKalshiMarketHistory();
  const reference = createKalshiReferenceNormalizer();
  let seriesPayload = null;
  let tickers = [];
  let books = createKalshiBookState({ tickers, freshnessMs });
  let referenceStatus = {
    status: 'not-checked',
    reason: 'Official reference access has not been checked.',
  };
  let connection = 'stopped';
  let lastReceivedAt = null;
  const restBooks = new Map();
  const issues = [];

  const apply = (input) => {
    if (!Number.isSafeInteger(input?.receivedAt) || input.receivedAt <= 0)
      throw new Error('Capture requires a UTC Unix millisecond receive timestamp.');
    lastReceivedAt = input.receivedAt;
    try {
      if (input.kind === 'series') {
        seriesPayload = input.rawPayload;
        return { disposition: 'series-recorded' };
      }
      if (input.kind === 'market') return marketHistory.apply(input, seriesPayload);
      if (input.kind === 'market-page') {
        if (!Array.isArray(input.rawPayload?.markets)) throw new Error('Invalid market page.');
        const records = input.rawPayload.markets
          .filter((market) => {
            const closesAt = Date.parse(market.close_time);
            return closesAt > input.receivedAt && closesAt <= input.receivedAt + input.horizonMs;
          })
          .map((rawPayload) => marketHistory.apply({ ...input, rawPayload }, seriesPayload));
        return { disposition: 'markets-recorded', records };
      }
      if (input.kind === 'book-reset') {
        tickers = input.tickers;
        books = createKalshiBookState({ tickers, freshnessMs });
        return { disposition: 'book-subscription-reset', tickers };
      }
      if (input.kind === 'book-connection') {
        connection = input.state;
        // Every new socket starts a new subscription sequence space.
        if (input.state === 'connected') books = createKalshiBookState({ tickers, freshnessMs });
        else books.invalidate(input.reason ?? input.state, input.receivedAt);
        return { disposition: 'connection-recorded', state: connection };
      }
      if (input.kind === 'book-frame') {
        const result = books.accept(JSON.parse(input.rawPayload), input.receivedAt);
        return {
          disposition: result.disposition,
          requiresResync: books.requiresResync(),
          reason: result.reason ?? null,
        };
      }
      if (input.kind === 'book-rest') {
        const book = normalizeKalshiRestBook(input.rawPayload, input.ticker, input.receivedAt);
        restBooks.set(input.ticker, book);
        return { disposition: 'independent-rest-book', book };
      }
      if (['benchmark-frame', 'benchmark-rest'].includes(input.kind)) return reference.apply(input);
      if (input.kind === 'reference-status') {
        referenceStatus = {
          status: input.status,
          reason: input.reason ?? null,
          checkedAt: input.receivedAt,
        };
        return referenceStatus;
      }
      if (input.kind === 'read-error') {
        const issue = {
          resourcePath: input.resourcePath,
          status: input.status,
          receivedAt: input.receivedAt,
        };
        issues.push(issue);
        if (issues.length > 20) issues.shift();
        return { disposition: 'read-unavailable', ...issue };
      }
      if (input.kind === 'capture-stopped') {
        connection = 'stopped';
        books.invalidate(
          'Capture is stopped; saved quotes are historical evidence.',
          input.receivedAt,
        );
        referenceStatus = { ...referenceStatus, status: 'stopped' };
        return { disposition: 'capture-stopped' };
      }
      throw new Error('Unsupported capture kind.');
    } catch {
      if (input.kind.startsWith('book-'))
        books.invalidate('Invalid book evidence.', input.receivedAt);
      // Preserve malformed input as evidence without trusting it or leaking transport errors.
      return {
        disposition: 'invalid',
        kind: input.kind,
        reason: 'Source evidence failed validation.',
      };
    }
  };
  const getReport = (now, { recording = false } = {}) => {
    const referenceEvidence = reference.getStatus(now);
    const latest = referenceEvidence.latest;
    const sourceAgeMs = latest ? now - latest.sourceCalculatedAt : null;
    const fresh = sourceAgeMs !== null && sourceAgeMs >= 0 && sourceAgeMs <= freshnessMs;
    const liveBooks = books.getSnapshot(now);
    const reportedBooks = Object.fromEntries(
      Object.entries(liveBooks.books).map(([ticker, book]) => [
        ticker,
        recording
          ? { ...book, receiveAgeMs: book.receivedAt === null ? null : now - book.receivedAt }
          : {
              ...book,
              available: false,
              reason: 'capture_not_live',
              yesBids: [],
              noBids: [],
              yesAsks: [],
              noAsks: [],
            },
      ]),
    );
    return {
      schemaVersion: 'kalshi-ingestion-report-v1',
      observedThrough: lastReceivedAt,
      markets: marketHistory.getMarkets(),
      orderBooks: {
        ...liveBooks,
        available: recording && liveBooks.available,
        books: reportedBooks,
        connection,
        liveCapture: recording,
      },
      independentRestBooks: [...restBooks.values()].map((book) => ({
        ...book,
        available: false,
        reason: 'independent_historical_snapshot',
        ageMs: now - book.receivedAt,
        freshAtInspection: now >= book.receivedAt && now - book.receivedAt <= freshnessMs,
      })),
      referenceFeed: {
        sourceId: 'cf-brti',
        sourceKind: 'official',
        via: 'kalshi',
        ...referenceStatus,
        ...referenceEvidence,
        sourceAgeMs,
        available:
          recording &&
          fresh &&
          latest?.canonicalSecond === true &&
          latest?.repeatOfPreviousValue === false &&
          ['live', 'rest-access-confirmed'].includes(referenceStatus.status),
        freshnessMs,
        sourceAgencyOutage: null,
        publicationTimeLimitation:
          'Original publication time is not supplied; calculation, amendment, provider and local receive clocks are separate.',
        revisionLimitation:
          'Only delivered revisions are recorded. The standard Kalshi BRTI stream suppresses some repeated/out-of-order upstream timestamps.',
      },
      exchangeProxy: {
        sourceId: 'coinbase-exchange',
        sourceKind: 'proxy',
        instrument: 'BTC-USD',
        quoteCurrency: 'USD',
        usableForOfficialSettlement: false,
        status: 'separate-spot-recorder',
        reason:
          'Inspect the Phase 3 spot recording separately; no exchange price is substituted for BRTI.',
      },
      recentReadIssues: [...issues],
      orderSubmissionEnabled: false,
    };
  };
  return {
    apply,
    getReport,
    getMarkets: marketHistory.getMarkets,
    requiresResync: () => books.requiresResync(),
  };
};
