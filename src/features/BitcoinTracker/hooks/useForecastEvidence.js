import { useEffect, useRef, useState } from 'react';
import { appendEvidenceRows, getEvidenceRow } from '../utils/evidenceStorage.utils';
import { getKalshiMarketConditions } from '../utils/kalshi/marketConditions.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_OUTCOME_DEFINITION, isVerifiedKalshiOutcome } from '../utils/kalshi/contract.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../utils/kalshi/forecast.utils';

export default function useForecastEvidence({
  forecasts,
  candles,
  ticker,
  stream,
  derivatives,
  now: clockTick,
  progress,
  isReady,
  models,
  benchmark,
  kalshiOutcomes = [],
}) {
  const tracked = useRef(new Map());
  const recordedIds = useRef(new Set());
  const pendingRows = useRef(new Map());
  const isWriting = useRef(false);
  const hasStarted = useRef(false);
  const hasStoppedRecording = useRef(false);
  const isMounted = useRef(true);
  const [warning, setWarning] = useState(null);
  const recordingSessionId = useRef(null);
  const retryAt = useRef(0);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isReady || !clockTick || clockTick < retryAt.current) return;
    hasStoppedRecording.current = false;
    recordingSessionId.current ??= crypto.randomUUID();
    const now = Date.now();
    const rows = [];
    for (const entry of forecasts ?? []) {
      if (entry.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION) continue;
      const previous = tracked.current.get(entry.id);
      if (!previous) {
        const isRestored = !hasStarted.current || entry.status !== 'analyzing';
        tracked.current.set(entry.id, {
          entry,
          sessionOrigin: isRestored ? 'restored' : 'new',
          hasOutcome: ['resolved', 'unobserved'].includes(entry.status),
        });
        if (isRestored)
          rows.push(getEvidenceRow({ entry, event: 'restored', now, sessionOrigin: 'restored' }));
      } else {
        if (previous.entry.status !== entry.status) {
          if (['pending', 'withheld'].includes(entry.status)) {
            const evidence = progress?.decisionEvidence;
            const inputs = evidence?.forecastId === entry.id ? evidence : {};
            rows.push(
              getEvidenceRow({
                ...inputs,
                entry,
                event: 'decision',
                now,
                reason: entry.withholdingReason ?? progress?.reason,
                sessionOrigin: previous.sessionOrigin,
              }),
            );
          } else if (['resolved', 'unobserved'].includes(entry.status)) {
            rows.push(
              getEvidenceRow({
                entry,
                event: 'outcome',
                now,
                sessionOrigin: previous.sessionOrigin,
              }),
            );
            previous.hasOutcome = true;
          }
        }
        previous.entry = entry;
      }
    }
    hasStarted.current = true;

    for (const record of tracked.current.values()) {
      const { entry, sessionOrigin } = record;
      // A no-call remains in this map through its endpoint even if the visible journal is cleared.
      if (entry.status === 'withheld' && !record.hasOutcome && now >= entry.expiresAt) {
        if (entry.kalshiMarket) {
          const outcome = kalshiOutcomes.find((result) =>
            isVerifiedKalshiOutcome(result, entry.kalshiMarket, now),
          );
          if (outcome) {
            rows.push(
              getEvidenceRow({
                entry: {
                  ...entry,
                  observedPrice: outcome.observedPrice,
                  observedAt: outcome.observedAt,
                  outcome: outcome.outcome,
                  kalshiOutcome: outcome,
                },
                event: 'outcome',
                now,
                sessionOrigin,
                outcomeStatus: 'observed',
              }),
            );
            record.hasOutcome = true;
          }
          continue;
        }
      }
      if (entry.status !== 'analyzing' || now >= entry.expiresAt) continue;
      const horizonMinutes = (entry.expiresAt - now) / 60_000;
      const estimate = getResearchForecast(
        {
          candles,
          ticker,
          target: entry.target,
          now,
          horizonMinutes,
          stream,
          derivatives:
            entry.modelVersion === KALSHI_DERIVATIVES_MODEL_VERSION ? derivatives : undefined,
          expiresAt: entry.expiresAt,
          kalshiMarket: entry.kalshiMarket,
          benchmark,
        },
        models,
        entry.startsAt,
      );
      const conditions = getKalshiMarketConditions({
        candles,
        ticker,
        target: entry.target,
        now,
        horizonMinutes,
        forecast: estimate,
      });
      rows.push(
        getEvidenceRow({
          entry,
          event: 'observation',
          now,
          inputObservedAt: now,
          ticker,
          estimate,
          conditions,
          stream,
          recordingSessionId: recordingSessionId.current,
          reason:
            progress?.decisionEvidence?.forecastId === entry.id
              ? progress.reason
              : conditions.reason,
          sessionOrigin,
        }),
      );
    }

    for (const row of rows) {
      if (!recordedIds.current.has(row.eventId) && !pendingRows.current.has(row.eventId))
        pendingRows.current.set(row.eventId, row);
    }
    if (isWriting.current || !pendingRows.current.size) return;
    isWriting.current = true;
    async function writePendingRows() {
      try {
        while (isMounted.current && !hasStoppedRecording.current && pendingRows.current.size) {
          const batch = [...pendingRows.current.values()].slice(0, 100);
          await appendEvidenceRows(batch);
          if (isMounted.current) setWarning(null);
          for (const row of batch) {
            recordedIds.current.add(row.eventId);
            pendingRows.current.delete(row.eventId);
          }
        }
      } catch (error) {
        hasStoppedRecording.current = true;
        retryAt.current = Date.now() + 30_000;
        if (isMounted.current) setWarning(error.message);
      } finally {
        isWriting.current = false;
      }
    }
    writePendingRows();
  }, [
    forecasts,
    candles,
    ticker,
    stream,
    derivatives,
    clockTick,
    progress,
    isReady,
    models,
    benchmark,
    kalshiOutcomes,
  ]);

  return warning;
}
