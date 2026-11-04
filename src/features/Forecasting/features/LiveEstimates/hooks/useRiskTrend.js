import { useEffect, useRef, useState } from 'react';

/** Compare unique, fresh quotes over about a minute within one immutable saved window. */
export default function useRiskTrend({ id, target, expiresAt, probability, quoteTime, now }) {
  const observations = useRef({ key: null, values: [] });
  const [trend, setTrend] = useState(null);
  const key = JSON.stringify([id, target, expiresAt]);

  useEffect(() => {
    const valid =
      id &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1 &&
      Number.isFinite(now) &&
      Number.isFinite(quoteTime) &&
      quoteTime <= now + 5000 &&
      now - quoteTime <= 20_000 &&
      expiresAt > now;
    const history = observations.current;
    if (!valid || history.key !== key) {
      observations.current = { key, values: valid ? [{ probability, quoteTime, time: now }] : [] };
      setTrend(null);
      return;
    }
    const previous = history.values.at(-1);
    if (previous && (now < previous.time || now - previous.time > 20_000)) {
      history.values = [{ probability, quoteTime, time: now }];
      setTrend(null);
      return;
    }
    if (previous && (quoteTime <= previous.quoteTime || now - previous.time < 5000)) return;
    history.values = history.values.filter((observation) => now - observation.time <= 75_000);
    history.values.push({ probability, quoteTime, time: now });
    const reference = history.values
      .filter((observation) => now - observation.time >= 55_000)
      .sort(
        (first, second) =>
          Math.abs(now - first.time - 60_000) - Math.abs(now - second.time - 60_000),
      )[0];
    if (!reference) {
      setTrend(null);
      return;
    }
    setTrend({
      key,
      percentagePoints: (probability - reference.probability) * 100,
      elapsedSeconds: Math.round((now - reference.time) / 1000),
    });
  }, [id, key, expiresAt, probability, quoteTime, now]);

  return trend?.key === key && Number.isFinite(probability) ? trend : null;
}
