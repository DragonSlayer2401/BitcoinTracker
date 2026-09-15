import { useEffect, useRef, useState } from 'react';
import {
  getAutomaticKalshiEvent,
  getLatestAutomaticForecastContract,
  readAutomaticForecastMarker,
  writeAutomaticForecastMarker,
} from '../utils/forecastAutomation.utils';

/** The journal writer owns this lifecycle; this hook never acquires a competing collector lock. */
export default function useAutomaticKalshiForecast({
  enabled,
  isReady,
  markets,
  forecasts,
  scheduledForecast,
  now,
  onStartEvent,
}) {
  const started = useRef(null);
  const paused = useRef(false);
  const [warning, setWarning] = useState(null);
  const [lastStartedEvent, setLastStartedEvent] = useState(null);

  useEffect(() => {
    if (!enabled) {
      paused.current = false;
      setWarning(null);
      return;
    }
    if (!isReady || paused.current || typeof onStartEvent !== 'function') return;
    const saved = readAutomaticForecastMarker();
    if (saved.warning) {
      paused.current = true;
      setWarning(saved.warning);
      return;
    }
    let marker =
      (started.current?.expiresAt ?? 0) > (saved.lastStartedEvent?.expiresAt ?? 0)
        ? started.current
        : saved.lastStartedEvent;
    const restored = getLatestAutomaticForecastContract(forecasts);
    if (restored && restored.expiresAt > (marker?.expiresAt ?? 0)) {
      const repairWarning = writeAutomaticForecastMarker(restored);
      if (repairWarning) {
        paused.current = true;
        setWarning(repairWarning);
        return;
      }
      marker = {
        marketTicker: restored.ticker,
        startsAt: restored.startsAt,
        expiresAt: restored.expiresAt,
      };
      started.current = marker;
    }
    setLastStartedEvent((previous) =>
      previous?.marketTicker === marker?.marketTicker && previous?.expiresAt === marker?.expiresAt
        ? previous
        : marker,
    );
    const contract = getAutomaticKalshiEvent({
      markets,
      forecasts,
      scheduledForecast,
      now,
      lastStartedEvent: marker,
    });
    if (!contract) return;
    try {
      // onStartEvent must synchronously persist the journal batch before returning true. A crash
      // before this marker is saved is then deduplicated by the restored journal's contract IDs.
      if (onStartEvent(contract) !== true) return;
      started.current = {
        marketTicker: contract.ticker,
        startsAt: contract.startsAt,
        expiresAt: contract.expiresAt,
      };
      setLastStartedEvent(started.current);
      const saveWarning = writeAutomaticForecastMarker(contract);
      if (saveWarning) paused.current = true;
      setWarning(saveWarning);
    } catch (error) {
      paused.current = true;
      setWarning(error?.message || 'Automatic recording could not start and is paused.');
    }
  }, [enabled, isReady, markets, forecasts, scheduledForecast, now, onStartEvent]);

  return { warning, lastStartedEvent };
}
