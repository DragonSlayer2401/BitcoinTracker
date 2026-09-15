const HISTORY_MS = 60 * 60_000;
const MAXIMUM_SEED_SAMPLES = 5000;
const MAXIMUM_REVISIONS = 4;
const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const isPrice = (value) => Number.isFinite(value) && value > 0 && value <= 1e9;

/** Bounded receipt-dated history. Later corrections cannot change an earlier captured view. */
export function createBenchmarkStreamHistory() {
  const history = new Map();

  function prune(now) {
    for (const time of history.keys()) if (time <= now - HISTORY_MS) history.delete(time);
  }

  function add(sample) {
    const versions = history.get(sample.time) ?? [];
    const previous = versions.at(-1);
    if (previous && sample.receivedAt < previous.receivedAt) return;
    // Polling the same historical value again must not refresh its original receipt timestamp.
    if (previous?.price === sample.price) return;
    history.set(sample.time, [...versions, { ...sample }].slice(-MAXIMUM_REVISIONS));
  }

  function seed(snapshot, receivedAt) {
    if (
      !isTimestamp(receivedAt) ||
      !isTimestamp(snapshot?.receivedAt) ||
      snapshot.receivedAt > receivedAt ||
      !Array.isArray(snapshot.samples) ||
      snapshot.samples.length > MAXIMUM_SEED_SAMPLES
    )
      return false;
    const samples = new Map();
    for (const sample of [...snapshot.samples, snapshot.current].filter(Boolean)) {
      if (
        !isTimestamp(sample.time) ||
        sample.time % 1000 !== 0 ||
        sample.time > snapshot.receivedAt ||
        !isPrice(sample.price) ||
        (sample.receivedAt !== undefined &&
          (!isTimestamp(sample.receivedAt) || sample.receivedAt > receivedAt)) ||
        (sample.amendTime !== undefined &&
          (!isTimestamp(sample.amendTime) || sample.amendTime > snapshot.receivedAt))
      )
        return false;
      if (sample.time <= receivedAt - HISTORY_MS) continue;
      if (samples.has(sample.time) && samples.get(sample.time).price !== sample.price) return false;
      samples.set(sample.time, {
        time: sample.time,
        price: sample.price,
        // The worker did not possess a newly fetched history response before this receipt.
        receivedAt,
        sourceReceivedAt: sample.receivedAt ?? snapshot.receivedAt,
        provenance: 'rest-history',
        ...(sample.amendTime === undefined ? {} : { amendTime: sample.amendTime }),
      });
    }
    prune(receivedAt);
    for (const sample of samples.values()) add(sample);
    return true;
  }

  function accept(sample) {
    prune(sample.receivedAt);
    add(sample);
  }

  function getSnapshot(now) {
    const samples = [...history.entries()]
      .filter(([time]) => time > now - HISTORY_MS && time <= now)
      .map(([, versions]) => versions.findLast((sample) => sample.receivedAt <= now))
      .filter(Boolean)
      .sort((first, second) => first.time - second.time)
      .map((sample) => ({ ...sample }));
    return {
      samples,
      current: samples.at(-1) ?? null,
      history: {
        windowMinutes: 60,
        sampleCount: samples.length,
        expectedSampleCount: 3600,
        missingSampleCount: 3600 - samples.length,
        coverage: samples.length / 3600,
        firstSampleAt: samples[0]?.time ?? null,
        lastSampleAt: samples.at(-1)?.time ?? null,
      },
    };
  }

  return { seed, accept, getSnapshot, clear: () => history.clear() };
}

/** Only actual canonical one-second values can enter the existing 60-reading settlement grid. */
export function parseBenchmarkStreamValue(message, receivedAt) {
  const envelope = message.msg;
  if (
    envelope?.index_id !== 'BRTI' ||
    !isTimestamp(envelope.received_at) ||
    envelope.received_at > receivedAt + 2000 ||
    typeof envelope.data !== 'string' ||
    envelope.data.length > 16_000
  )
    throw new Error('Invalid BRTI stream envelope.');
  const value = JSON.parse(envelope.data);
  const price =
    typeof value?.value === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.value)
      ? Number(value.value)
      : NaN;
  if (
    value?.type !== 'value' ||
    value.id !== 'BRTI' ||
    !isTimestamp(value.time) ||
    value.time > receivedAt ||
    receivedAt - value.time > 5000 ||
    !isPrice(price) ||
    (value.amendTime != null && (!isTimestamp(value.amendTime) || value.amendTime > receivedAt))
  )
    throw new Error('BRTI stream values are invalid or delayed.');
  if (value.repeatOfPreviousValue === true || value.time % 1000 !== 0) return null;
  return {
    time: value.time,
    price,
    receivedAt,
    sourceReceivedAt: envelope.received_at,
    provenance: 'kalshi-websocket',
    sequence: message.seq,
    ...(value.amendTime == null ? {} : { amendTime: value.amendTime }),
  };
}
