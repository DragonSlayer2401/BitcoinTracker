import { useEffect, useRef, useState } from 'react';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { fetchKalshiMarketClient } from '@/services/kalshi/kalshi.client.service';

export const BACKGROUND_RESEARCH_STORAGE_KEY = 'bitcoin-tracker:background-research:kalshi:v2';
const LOCK_NAME = 'bitcoin-tracker-background-research';

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
  const mounted = useRef(true);
  const latest = useRef(null);
  const outcomeCache = useRef(new Map());
  const requests = useRef(new Map());
  const [warning, setWarning] = useState(null);
  const [status, setStatus] = useState({ phase: 'waiting', expiresAt: null, nextStartAt: null });
  latest.current = { ticker, stream, getEstimate, getConditions, markets, benchmark };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
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
    const save = (record) =>
      globalThis.localStorage.setItem(BACKGROUND_RESEARCH_STORAGE_KEY, JSON.stringify(record));
    async function record() {
      try {
        await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock || !mounted.current) return;
          const serialized = globalThis.localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY);
          let saved;
          if (serialized) {
            try {
              saved = JSON.parse(serialized);
            } catch {
              throw new Error('Saved background research state is invalid; recording is paused.');
            }
            if (
              !saved ||
              !saved.state ||
              !Array.isArray(saved.pendingRows) ||
              saved.pendingRows.length > 100
            ) {
              throw new Error('Saved background research state is invalid; recording is paused.');
            }
          } else {
            saved = { recorderId: globalThis.crypto.randomUUID(), state: null, pendingRows: [] };
          }
          const recorder = createResearchRecorder({
            recorderId: saved.recorderId,
            state: saved.state,
          });
          // Replay the original persisted rows before any further decisions. IDs make this idempotent.
          if (saved.pendingRows.length) {
            await appendEvidenceRows(saved.pendingRows);
            saved = { ...saved, pendingRows: [] };
            save(saved);
          }
          const observedAt = Date.now();
          const pending = recorder.getState().markets ?? [];
          for (const record of pending.filter((item) => item.contract.expiresAt <= observedAt)) {
            const marketTicker = record.contract.ticker;
            const cached = outcomeCache.current.get(marketTicker);
            if (
              requests.current.size >= 10 ||
              requests.current.has(marketTicker) ||
              (cached && observedAt - cached.checkedAt < 15_000)
            )
              continue;
            const controller = new AbortController();
            requests.current.set(marketTicker, controller);
            // Settlement retrieval must not block the next live research checkpoint.
            fetchKalshiMarketClient(marketTicker, { signal: controller.signal })
              .then((market) => {
                if (mounted.current)
                  outcomeCache.current.set(marketTicker, { market, checkedAt: Date.now() });
              })
              .catch(() => {
                if (mounted.current)
                  outcomeCache.current.set(marketTicker, { market: null, checkedAt: Date.now() });
              })
              .finally(() => requests.current.delete(marketTicker));
          }
          const pendingTickers = new Set(pending.map((item) => item.contract.ticker));
          for (const key of outcomeCache.current.keys())
            if (!pendingTickers.has(key)) outcomeCache.current.delete(key);
          const result = recorder.advance({
            now: observedAt,
            ...latest.current,
            markets: [
              ...latest.current.markets,
              ...[...outcomeCache.current.values()].flatMap((cached) =>
                cached.market ? [cached.market] : [],
              ),
            ],
          });
          const pendingRecord = {
            recorderId: saved.recorderId,
            state: result.state,
            pendingRows: result.rows,
          };
          // Persist both the immutable target/state and its exact evidence before inserting evidence.
          save(pendingRecord);
          if (result.rows.length) {
            await appendEvidenceRows(result.rows);
            save({ ...pendingRecord, pendingRows: [] });
          }
          if (mounted.current) {
            setStatus(result.status);
            setWarning(null);
          }
        });
      } catch (error) {
        if (mounted.current)
          setWarning(
            error?.message || 'Background research could not be saved. Recording is paused.',
          );
      } finally {
        isWriting.current = false;
      }
    }
    record();
  }, [now, isReady]);

  return { warning, status };
}
