import { useEffect, useRef, useState } from 'react';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import {
  readBackgroundResearchRecord,
  writeBackgroundResearchRecord,
  flushPendingResearchEvidence,
} from '../utils/backgroundResearchStorage.utils';
import { fetchKalshiMarketClient } from '@/services/kalshi/kalshi.client.service';

export { BACKGROUND_RESEARCH_STORAGE_KEY } from '../utils/backgroundResearchStorage.utils';

const LOCK_NAME = 'bitcoin-tracker-background-research';
const MAXIMUM_SETTLEMENT_REQUESTS = 10;
const SETTLEMENT_RETRY_INTERVAL_MS = 15_000;

function queueSettlementRequests({
  recordedMarkets,
  observedAt,
  outcomeCache,
  pendingRequests,
  isMounted,
}) {
  const expiredMarkets = recordedMarkets.filter(
    (record) => record.contract.expiresAt <= observedAt,
  );
  for (const record of expiredMarkets) {
    const marketTicker = record.contract.ticker;
    const cached = outcomeCache.get(marketTicker);
    const wasCheckedRecently =
      cached && observedAt - cached.checkedAt < SETTLEMENT_RETRY_INTERVAL_MS;
    if (
      pendingRequests.size >= MAXIMUM_SETTLEMENT_REQUESTS ||
      pendingRequests.has(marketTicker) ||
      wasCheckedRecently
    ) {
      continue;
    }

    const controller = new AbortController();
    pendingRequests.set(marketTicker, controller);
    // Settlement retrieval must not block the next live research checkpoint.
    fetchKalshiMarketClient(marketTicker, { signal: controller.signal })
      .then((market) => {
        if (isMounted.current) outcomeCache.set(marketTicker, { market, checkedAt: Date.now() });
      })
      .catch(() => {
        if (isMounted.current)
          outcomeCache.set(marketTicker, { market: null, checkedAt: Date.now() });
      })
      .finally(() => pendingRequests.delete(marketTicker));
  }
}

function removeCompletedMarketOutcomes(recordedMarkets, outcomeCache) {
  const recordedTickers = new Set(recordedMarkets.map((record) => record.contract.ticker));
  for (const ticker of outcomeCache.keys()) {
    if (!recordedTickers.has(ticker)) outcomeCache.delete(ticker);
  }
}

/** One shared browser recorder; independent of user-selected forecasts and their journal. */
export default function useBackgroundResearch({
  now,
  isReady,
  ticker,
  stream,
  getEstimate,
  getConditions,
  markets = [],
  benchmark,
}) {
  const isWriting = useRef(false);
  const isMounted = useRef(true);
  const latestInputs = useRef(null);
  const outcomeCache = useRef(new Map());
  const pendingRequests = useRef(new Map());
  const [warning, setWarning] = useState(null);
  const [status, setStatus] = useState({ phase: 'waiting', expiresAt: null, nextStartAt: null });
  latestInputs.current = { ticker, stream, getEstimate, getConditions, markets, benchmark };

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      for (const request of pendingRequests.current.values()) request.abort();
      pendingRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!isReady || !now || isWriting.current) return;
    if (!globalThis.navigator?.locks?.request) {
      setWarning(
        'Background research requires browser tab coordination, which is unavailable. Manual forecasts still work.',
      );
      return;
    }
    isWriting.current = true;
    async function recordCheckpoint() {
      try {
        await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock || !isMounted.current) return;
          const saved = readBackgroundResearchRecord();
          const recorder = createResearchRecorder({
            recorderId: saved.recorderId,
            state: saved.state,
          });
          // Replay the original persisted rows before any further decisions. IDs make this idempotent.
          if (saved.pendingRows.length) {
            await flushPendingResearchEvidence(saved);
          }

          const observedAt = Date.now();
          const recordedMarkets = recorder.getState().markets ?? [];
          queueSettlementRequests({
            recordedMarkets,
            observedAt,
            outcomeCache: outcomeCache.current,
            pendingRequests: pendingRequests.current,
            isMounted,
          });
          removeCompletedMarketOutcomes(recordedMarkets, outcomeCache.current);
          const knownMarketOutcomes = [...outcomeCache.current.values()].flatMap((cached) =>
            cached.market ? [cached.market] : [],
          );
          const result = recorder.advance({
            now: observedAt,
            ...latestInputs.current,
            markets: [...latestInputs.current.markets, ...knownMarketOutcomes],
          });
          const pendingRecord = {
            recorderId: saved.recorderId,
            state: result.state,
            pendingRows: result.rows,
          };
          // Persist both the immutable target/state and its exact evidence before inserting evidence.
          writeBackgroundResearchRecord(pendingRecord);
          if (result.rows.length) {
            await flushPendingResearchEvidence(pendingRecord);
          }
          if (isMounted.current) {
            setStatus(result.status);
            setWarning(null);
          }
        });
      } catch (error) {
        if (isMounted.current)
          setWarning(
            error?.message || 'Background research could not be saved. Recording is paused.',
          );
      } finally {
        isWriting.current = false;
      }
    }
    recordCheckpoint();
  }, [now, isReady]);

  return { warning, status };
}
