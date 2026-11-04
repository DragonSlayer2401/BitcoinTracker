export const FORWARD_RESEARCH_HORIZONS = Object.freeze([15, 60, 180]);
const LABEL_WAIT_MS = 10 * 60_000;

/** Labels are future observations, never forecast inputs. No nearby tick substitutes for a gap. */
export function getForwardResearchLabels(captures, benchmark, now) {
  const readings = new Map();
  const conflicts = new Set();
  for (const sample of [...(benchmark?.samples ?? []), benchmark?.current]) {
    const receivedAt = sample?.receivedAt ?? benchmark?.receivedAt;
    if (
      !sample ||
      !Number.isSafeInteger(sample.time) ||
      sample.time <= 0 ||
      sample.time > now ||
      sample.time % 1000 !== 0 ||
      !Number.isSafeInteger(receivedAt) ||
      receivedAt < sample.time ||
      receivedAt > now ||
      !Number.isFinite(sample.price) ||
      sample.price <= 0 ||
      sample.price > 1e9
    )
      continue;
    const previous = readings.get(sample.time);
    if (previous && previous.price !== sample.price) conflicts.add(sample.time);
    readings.set(sample.time, {
      time: sample.time,
      price: sample.price,
      receivedAt,
      provenance: sample.provenance ?? benchmark.transport ?? 'kalshi-rest-history',
    });
  }
  const labels = [];
  for (const { decision, completedHorizons = [] } of captures) {
    const capturedAt = decision.featureCutoffAt;
    const reference = {
      time: decision.quoteTime ?? null,
      price: decision.spot ?? null,
      receivedAt: decision.receivedAt ?? null,
      source: decision.referenceSource ?? null,
    };
    const validReference =
      reference.source === 'cf-brti' &&
      Number.isFinite(reference.price) &&
      reference.price > 0 &&
      reference.price <= 1e9 &&
      Number.isSafeInteger(reference.time) &&
      reference.time > 0 &&
      reference.time % 1000 === 0 &&
      reference.time <= capturedAt &&
      Number.isSafeInteger(reference.receivedAt) &&
      reference.receivedAt >= reference.time &&
      reference.receivedAt <= capturedAt;
    if (!Number.isSafeInteger(capturedAt)) continue;
    for (const horizonSeconds of FORWARD_RESEARCH_HORIZONS) {
      if (completedHorizons.includes(horizonSeconds)) continue;
      // Decision clocks can have milliseconds; record the exact next canonical second explicitly.
      const dueAt = Math.ceil((capturedAt + horizonSeconds * 1000) / 1000) * 1000;
      if (now < dueAt) continue;
      const reading = conflicts.has(dueAt) ? null : readings.get(dueAt);
      if (validReference && !reading && now < dueAt + LABEL_WAIT_MS) continue;
      const observed = validReference && Boolean(reading);
      labels.push({
        version: 'brti-forward-label-v1',
        labelId: `${decision.eventId}:forward:${horizonSeconds}`,
        snapshotId: decision.eventId,
        forecastId: decision.forecastId,
        capturedAt,
        horizonSeconds,
        dueAt,
        recordedAt: now,
        status: observed ? 'observed' : 'missing',
        reference,
        reading: observed ? reading : null,
        logReturn: observed ? Math.log(reading.price / reference.price) : null,
        reason: observed
          ? null
          : !validReference
            ? 'capture-reference-is-not-observed-brti'
            : 'exact-forward-brti-reading-unavailable',
      });
    }
  }
  return labels;
}
