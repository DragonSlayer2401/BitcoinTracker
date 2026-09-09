import { useEffect, useRef, useState } from 'react';
import { appendEvidenceRows, getEvidenceRow } from '../utils/evidenceStorage.utils';
import { getForecast } from '../utils/forecast.utils';
import { getPressureForecast } from '../utils/pressureForecast.utils';
import { PRESSURE_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getMarketConditions } from '../utils/marketConditions.utils';
import { DEADLINE_OUTCOME_DEFINITION, isVerifiedDeadlineOutcome } from '../utils/outcome.utils';

export default function useForecastEvidence({
  forecasts,
  candles,
  ticker,
  stream,
  now: clockTick,
  progress,
  isReady,
}) {
  const tracked = useRef(new Map());
  const recordedIds = useRef(new Set());
  const pendingRows = useRef(new Map());
  const isWriting = useRef(false);
  const hasStarted = useRef(false);
  const hasStoppedRecording = useRef(false);
  const isMounted = useRef(true);
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isReady || !clockTick || hasStoppedRecording.current) return;
    const now = Date.now();
    const rows = [];
    for (const entry of forecasts ?? []) {
      if (entry.outcomeDefinition !== DEADLINE_OUTCOME_DEFINITION) continue;
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
        const outcome = stream?.getDeadlineOutcome?.(entry.expiresAt, now);
        const status = isVerifiedDeadlineOutcome(outcome, entry.expiresAt, now)
          ? 'observed'
          : outcome?.status === 'unobserved' || now > entry.expiresAt + 15_000
            ? 'unobserved'
            : 'waiting';
        if (status !== 'waiting') {
          const observed =
            status === 'observed'
              ? {
                  observedAt: outcome.observedAt,
                  observedPrice: outcome.observedPrice,
                  observedTradeId: outcome.observedTradeId,
                  confirmedThrough: outcome.confirmedThrough,
                  completeSince: outcome.completeSince,
                  outcome:
                    outcome.observedPrice > entry.target
                      ? 'above'
                      : outcome.observedPrice < entry.target
                        ? 'below'
                        : 'equal',
                }
              : {};
          rows.push(
            getEvidenceRow({
              entry: { ...entry, ...observed },
              event: 'outcome',
              now,
              sessionOrigin,
              outcomeStatus: status,
              reason:
                outcome?.reason ??
                (status === 'unobserved' ? 'The deadline trade could not be verified.' : null),
            }),
          );
          record.hasOutcome = true;
        }
      }
      if (entry.status !== 'analyzing' || now >= entry.expiresAt) continue;
      const horizonMinutes = (entry.expiresAt - now) / 60_000;
      const estimate = (
        entry.analysis?.policyVersion === PRESSURE_POLICY_VERSION
          ? getPressureForecast
          : getForecast
      )({ candles, ticker, target: entry.target, now, horizonMinutes, stream });
      const conditions = getMarketConditions({
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
          for (const row of batch) {
            recordedIds.current.add(row.eventId);
            pendingRows.current.delete(row.eventId);
          }
        }
      } catch (error) {
        hasStoppedRecording.current = true;
        pendingRows.current.clear();
        if (isMounted.current) setWarning(error.message);
      } finally {
        isWriting.current = false;
      }
    }
    writePendingRows();
  }, [forecasts, candles, ticker, stream, clockTick, progress, isReady]);

  return warning;
}
