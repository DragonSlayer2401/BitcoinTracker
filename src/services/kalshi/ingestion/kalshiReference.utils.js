const observationVersion = 'kalshi-reference-observation-v1';
const source = Object.freeze({ id: 'cf-brti', kind: 'official', via: 'kalshi' });
const isTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const readTime = (value) => {
  const timestamp =
    typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return isTime(timestamp) ? timestamp : null;
};
const copy = (value) => JSON.parse(JSON.stringify(value));

/** CF permits scientific notation. Expand it exactly, without converting the value to Number. */
export const normalizeKalshiReferenceDecimal = (value) => {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const digits = match[1] + (match[2] ?? '');
  const position = match[1].length + Number(match[3] ?? 0);
  // Operational bounds reject pathological frames; they do not round source precision.
  if (position < -200 || position > 200 || digits.length > 200) return null;
  const expanded =
    position <= 0
      ? `0.${'0'.repeat(-position)}${digits}`
      : position >= digits.length
        ? `${digits}${'0'.repeat(position - digits.length)}`
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
  const [whole, fraction = ''] = expanded.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  const normalized = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
  return normalized === '0' || normalized.length > 202 ? null : normalized;
};

const getRestTransport = (resourcePath) => {
  if (typeof resourcePath !== 'string' || !resourcePath.startsWith('/cfbenchmarks/')) return null;
  try {
    const url = new URL(resourcePath, 'https://external-api.kalshi.com');
    if (
      url.origin !== 'https://external-api.kalshi.com' ||
      url.searchParams.getAll('id').length !== 1 ||
      url.searchParams.get('id') !== 'BRTI'
    )
      return null;
    if (url.pathname === '/cfbenchmarks/values') return 'kalshi-rest-values';
    if (url.pathname === '/cfbenchmarks/history/values') return 'kalshi-rest-history';
    return null;
  } catch {
    return null;
  }
};

const sameValue = (first, second) =>
  first.value === second.value &&
  first.sourceAmendedAt === second.sourceAmendedAt &&
  first.repeatOfPreviousValue === second.repeatOfPreviousValue;

/**
 * Evidence-only reducer. `time` is calculation time, not an invented publication time.
 * https://docs.cfbenchmarks.com/api/websocket/value/ and /api/rest/values/
 * Retrieved 2026-11-07 UTC; CF API v1. Local revisions are not source revision numbers.
 */
export const createKalshiReferenceNormalizer = ({ maxObservations = 100_000 } = {}) => {
  if (!Number.isSafeInteger(maxObservations) || maxObservations <= 0)
    throw new TypeError('Reference observation capacity must be a positive safe integer.');
  const revisionsByTime = new Map();
  const revisionsById = new Map();
  let lastReceivedAt = null;
  let duplicateCount = 0;
  let invalidCount = 0;

  const getStatus = (asOf = lastReceivedAt) => {
    let latest = null;
    if (isTime(asOf))
      for (const versions of revisionsByTime.values()) {
        const known = versions.findLast(
          (record) => record.firstSeenAt <= asOf && record.sourceCalculatedAt <= asOf,
        );
        if (known && (!latest || known.sourceCalculatedAt > latest.sourceCalculatedAt))
          latest = known;
      }
    return {
      source: { ...source },
      observationCount: revisionsById.size,
      sourceTimeCount: revisionsByTime.size,
      duplicateCount,
      invalidCount,
      latest: latest ? copy(latest) : null,
    };
  };

  const append = (record) => {
    if (revisionsById.size >= maxObservations)
      throw new Error('Reference observation capacity reached; prior evidence was retained.');
    const versions = revisionsByTime.get(record.sourceCalculatedAt) ?? [];
    const saved = copy(record);
    versions.push(saved);
    revisionsByTime.set(record.sourceCalculatedAt, versions);
    revisionsById.set(record.revisionId, saved);
  };

  const apply = (input) => {
    const output = {
      schemaVersion: 'kalshi-reference-batch-v1',
      disposition: 'accepted',
      observations: [],
      issues: [],
    };
    const issue = (code, rowIndex = null) => {
      output.issues.push({ code, rowIndex });
      invalidCount += 1;
    };
    if (
      !isTime(input?.receivedAt) ||
      (lastReceivedAt !== null && input.receivedAt < lastReceivedAt) ||
      typeof input?.rawPayload !== 'string' ||
      input.rawPayload.length > 2_000_000
    ) {
      issue('invalid_capture_envelope');
      output.disposition = 'invalid';
      return output;
    }
    lastReceivedAt = input.receivedAt;
    let payload;
    try {
      payload = JSON.parse(input.rawPayload);
    } catch {
      issue('malformed_reference_json');
      output.disposition = 'invalid';
      return output;
    }
    let rows;
    let transport;
    let providerReceivedAt = null;
    let providerSentAt = null;
    let responseServerAt = null;
    let connectionId = null;
    if (input.kind === 'benchmark-frame') {
      if (
        !Number.isSafeInteger(input.connectionId) ||
        input.connectionId < 1 ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        issue('invalid_reference_frame');
      } else if (payload.type !== 'cfbenchmarks_value') {
        output.disposition = 'ignored';
        return output;
      } else if (payload.msg?.index_id !== 'BRTI' || typeof payload.msg?.data !== 'string') {
        issue('invalid_reference_identity');
      } else {
        try {
          const value = JSON.parse(payload.msg.data);
          if (value?.type !== 'value' || value.id !== 'BRTI') issue('invalid_reference_identity');
          else rows = [value];
        } catch {
          issue('malformed_upstream_reference_json');
        }
        transport = 'kalshi-websocket';
        connectionId = input.connectionId;
        providerReceivedAt = readTime(payload.msg.received_at);
        providerSentAt = readTime(payload.sending_ts_ms);
        if (payload.msg.received_at != null && providerReceivedAt === null)
          issue('invalid_provider_receipt_time');
        if (payload.sending_ts_ms != null && providerSentAt === null)
          issue('invalid_provider_send_time');
      }
    } else if (input.kind === 'benchmark-rest') {
      transport = getRestTransport(input.resourcePath);
      if (!transport) issue('invalid_reference_resource');
      else if (payload?.data?.error || !Array.isArray(payload?.data?.payload))
        issue('invalid_reference_response');
      else {
        rows = payload.data.payload;
        if (typeof payload.data.serverTime === 'string') {
          const parsed = Date.parse(payload.data.serverTime);
          responseServerAt = isTime(parsed) ? parsed : null;
        }
      }
    } else issue('unsupported_reference_capture');
    if (!rows || rows.length > 20_000 || output.issues.length > 0) {
      if (rows?.length > 20_000) issue('reference_response_too_large');
      output.disposition = 'invalid';
      return output;
    }
    let duplicates = 0;
    for (const [rowIndex, row] of rows.entries()) {
      const calculatedAt = readTime(row?.time);
      const amendedAt = row?.amendTime == null ? null : readTime(row.amendTime);
      const value = normalizeKalshiReferenceDecimal(row?.value);
      if (
        (row?.id !== undefined && row.id !== 'BRTI') ||
        value === null ||
        calculatedAt === null ||
        calculatedAt > input.receivedAt ||
        (row.amendTime != null &&
          (amendedAt === null || amendedAt < calculatedAt || amendedAt > input.receivedAt)) ||
        (row.repeatOfPreviousValue !== undefined && typeof row.repeatOfPreviousValue !== 'boolean')
      ) {
        issue('invalid_reference_value', rowIndex);
        continue;
      }
      const versions = revisionsByTime.get(calculatedAt) ?? [];
      const previous = versions.at(-1);
      const revision = (previous?.revision ?? 0) + 1;
      const record = {
        schemaVersion: observationVersion,
        source: { ...source },
        indexId: 'BRTI',
        priceUnit: 'USD/BTC',
        timestampUnit: 'unix-ms',
        transport,
        connectionId,
        value,
        rawValue: row.value,
        sourceCalculatedAt: calculatedAt,
        sourceAmendedAt: amendedAt,
        sourcePublishedAt: null,
        providerReceivedAt,
        providerSentAt,
        responseServerAt,
        receivedAt: input.receivedAt,
        firstSeenAt: input.receivedAt,
        repeatOfPreviousValue: row.repeatOfPreviousValue === true,
        canonicalSecond: calculatedAt % 1000 === 0,
        revision,
        revisionId: `cf-brti:${calculatedAt}:${revision}`,
        supersedesRevisionId: previous?.revisionId ?? null,
      };
      if (previous && sameValue(previous, record)) {
        duplicates += 1;
        duplicateCount += 1;
        continue;
      }
      append(record);
      output.observations.push(record);
    }
    output.disposition = output.issues.length
      ? output.observations.length
        ? 'partial'
        : 'invalid'
      : output.observations.length
        ? 'accepted'
        : duplicates
          ? 'duplicate'
          : 'empty';
    return output;
  };

  /** Restore emitted evidence only; receipt times are never refreshed during a restart. */
  const restore = (records) => {
    if (!Array.isArray(records))
      throw new TypeError('Reference restoration requires observations.');
    for (const record of records) {
      const previous = revisionsByTime.get(record?.sourceCalculatedAt)?.at(-1);
      const existing = revisionsById.get(record?.revisionId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record))
          throw new Error('Restored reference revision conflicts with saved evidence.');
        continue;
      }
      if (
        record?.schemaVersion !== observationVersion ||
        record.source?.id !== source.id ||
        record.source?.kind !== source.kind ||
        record.source?.via !== source.via ||
        record.indexId !== 'BRTI' ||
        record.priceUnit !== 'USD/BTC' ||
        record.timestampUnit !== 'unix-ms' ||
        !['kalshi-websocket', 'kalshi-rest-values', 'kalshi-rest-history'].includes(
          record.transport,
        ) ||
        (record.transport === 'kalshi-websocket'
          ? !Number.isSafeInteger(record.connectionId) || record.connectionId < 1
          : record.connectionId !== null) ||
        [record.providerReceivedAt, record.providerSentAt, record.responseServerAt].some(
          (timestamp) => timestamp !== null && !isTime(timestamp),
        ) ||
        !isTime(record.sourceCalculatedAt) ||
        !isTime(record.firstSeenAt) ||
        record.receivedAt !== record.firstSeenAt ||
        record.sourceCalculatedAt > record.firstSeenAt ||
        normalizeKalshiReferenceDecimal(record.value) !== record.value ||
        normalizeKalshiReferenceDecimal(record.rawValue) !== record.value ||
        (record.sourceAmendedAt !== null &&
          (!isTime(record.sourceAmendedAt) ||
            record.sourceAmendedAt < record.sourceCalculatedAt ||
            record.sourceAmendedAt > record.firstSeenAt)) ||
        record.sourcePublishedAt !== null ||
        typeof record.repeatOfPreviousValue !== 'boolean' ||
        record.canonicalSecond !== (record.sourceCalculatedAt % 1000 === 0) ||
        record.revision !== (previous?.revision ?? 0) + 1 ||
        record.revisionId !== `cf-brti:${record.sourceCalculatedAt}:${record.revision}` ||
        record.supersedesRevisionId !== (previous?.revisionId ?? null) ||
        (previous && (record.firstSeenAt < previous.firstSeenAt || sameValue(previous, record)))
      )
        throw new Error('Invalid restored reference observation.');
      append(record);
      lastReceivedAt = Math.max(lastReceivedAt ?? 0, record.firstSeenAt);
    }
    return getStatus();
  };
  return { apply, restore, getStatus };
};
