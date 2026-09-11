import { useEffect, useRef, useState } from 'react';
import { getKalshiOutcome, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

/** Official results can arrive after close, including after a browser restart. */
export default function useKalshiSettlement({ forecasts, now, isReady }) {
  const [outcomes, setOutcomes] = useState([]);
  const [warning, setWarning] = useState(null);
  const nextPoll = useRef(0);
  const pending = (forecasts ?? []).filter(
    (entry) =>
      entry.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
      ['pending', 'awaiting-settlement', 'withheld'].includes(entry.status) &&
      entry.expiresAt <= now,
  );
  const marketKey = [...new Set(pending.map((entry) => entry.kalshiMarket.ticker))]
    .sort()
    .join(',');
  useEffect(() => {
    if (!isReady || !now || !marketKey || now < nextPoll.current) return;
    nextPoll.current = now + 15_000;
    const controller = new AbortController();
    let disposed = false;
    (async () => {
      const results = [];
      let failed = false;
      // Bound concurrency and request count while retrying every unfinished result.
      for (const marketTicker of marketKey.split(',')) {
        if (controller.signal.aborted) return;
        try {
          const response = await fetch(`/api/kalshi/markets/${encodeURIComponent(marketTicker)}`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!response.ok) throw new Error('Market result unavailable');
          const payload = await response.json();
          const outcome = getKalshiOutcome(payload.market ?? payload, Date.now());
          if (outcome) results.push(outcome);
        } catch (error) {
          if (error.name !== 'AbortError') failed = true;
        }
      }
      if (!disposed) {
        setOutcomes(results);
        setWarning(
          failed ? 'Kalshi results are delayed. Saved forecasts will be checked again.' : null,
        );
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [marketKey, isReady, Math.floor(now / 15_000)]);
  return { outcomes, warning };
}
