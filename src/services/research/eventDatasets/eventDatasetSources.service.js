import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  getKalshiRecordingStatus,
  readKalshiArchive,
} from '../../kalshi/recording/kalshiRecording.repository';
import { createKalshiIngestionState } from '../../kalshi/ingestion/kalshiIngestionState.utils';
import { getSpotRecordingStatus } from '../../coinbase/recording/spotRecording.repository';
import { replaySpotRecording } from '../../coinbase/recording/spotRecording.service';

const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const canonicalJson = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const reject = (code) => {
  throw Object.assign(new Error(code), { code });
};
const readJsonFile = async (filename, maximumBytes) => {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) reject('unsafe_source_file');
  if (info.size > maximumBytes) reject('source_file_limit');
  return JSON.parse(await readFile(filename, 'utf8'));
};
const sourceError = (error) => {
  if (error?.code === 'ENOENT') return 'source_missing';
  if (/INCOMPLETE|HISTORY|DIRECTORY/.test(error?.code ?? '')) return 'source_history_unavailable';
  if (/CORRUPT|MANIFEST|SCHEMA|ORDINAL/.test(error?.code ?? '')) return 'source_corrupt';
  return /^[a-z][a-z_]+$/.test(error?.code ?? '') ? error.code : 'source_validation_failed';
};

/** Read-only adapters. A source is admitted only after its whole retained history verifies. */
export const loadEventDatasetSources = async ({
  kalshiDirectories = [],
  spotFiles = [],
  historicalFiles = [],
  synthetic = false,
  maxRecords = 500_000,
} = {}) => {
  if (
    ![kalshiDirectories, spotFiles, historicalFiles].every(
      (values) =>
        Array.isArray(values) &&
        values.every((value) => typeof value === 'string' && value.length > 0),
    ) ||
    typeof synthetic !== 'boolean' ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1
  )
    throw new TypeError('Choose source paths, a boolean fixture flag and a positive record limit.');
  const admitted = new Map();
  const reports = new Map();
  const issues = [];
  let recordCount = 0;

  const load = async (sourceKind, location, requestIndex) => {
    const provenance = synthetic
      ? 'synthetic-fixture'
      : sourceKind === 'historical'
        ? 'retrospective-history'
        : 'original-recording';
    let sourceId = `excluded:${sourceKind}:${requestIndex}`;
    const sourceRecords = [];
    const sourceIssues = [];
    let coverage = null;
    let lastReceivedAt = null;
    let observedRecordCount = null;
    const addIssue = (code, details = {}) => sourceIssues.push({ sourceId, code, ...details });
    const append = ({ captureId, captureSequence, ordinal, input, normalized, configuration }) => {
      if (!isTimestamp(input?.receivedAt)) reject('invalid_receive_time');
      if (lastReceivedAt !== null && input.receivedAt < lastReceivedAt)
        reject('receive_clock_regressed');
      if (sourceRecords.length >= maxRecords) reject('source_record_limit');
      lastReceivedAt = input.receivedAt;
      const id = `${sourceId}:${captureId}:${ordinal}`;
      sourceRecords.push({
        schemaVersion: 'event-source-record-v1',
        id,
        sourceId,
        sourceKind,
        captureSequence,
        ordinal,
        receivedAt: input.receivedAt,
        availableAt: input.receivedAt,
        provenance,
        configuration,
        input,
        normalized,
      });
      if (['invalid', 'partial', 'out_of_order'].includes(normalized?.disposition))
        addIssue(`record_${normalized.disposition}`, { recordId: id, ordinal });
      if (Array.isArray(normalized?.gaps) && normalized.gaps.length)
        addIssue('recorded_feed_gap', { recordId: id, ordinal, gapCount: normalized.gaps.length });
      if (input.kind === 'book-frame' && normalized?.requiresResync)
        addIssue('recorded_book_unusable', { recordId: id, ordinal });
    };
    try {
      if (sourceKind === 'kalshi') {
        const status = await getKalshiRecordingStatus(location, { now: () => 1 });
        if (!status.configured) reject('source_missing');
        const marker = await readJsonFile(
          path.join(location, '.kalshi-recording-directory.json'),
          16_384,
        );
        if (
          marker.version !== 'kalshi-market-directory-v1' ||
          typeof marker.id !== 'string' ||
          !marker.id
        )
          reject('source_corrupt');
        sourceId = `kalshi:${marker.id}`;
        observedRecordCount = status.recordCount;
        if (status.recordCount > maxRecords) reject('source_record_limit');
        coverage = {
          retainedHistory: status.retainedHistory ?? null,
          captureCount: status.captures.length,
          historicalOrderBooks: 'original-recordings-only',
        };
        if (status.retainedHistory?.warning) addIssue('retained_history_boundary');
        let state = null;
        let configuration = null;
        for await (const { captureId, captureSequence, record } of readKalshiArchive(location)) {
          if (!state) {
            configuration = record.configuration;
            state = createKalshiIngestionState(configuration);
          }
          if (!isDeepStrictEqual(configuration, record.configuration))
            reject('normalization_configuration_changed');
          const normalized = state.apply(record.input);
          if (!isDeepStrictEqual(normalized, record.normalized))
            reject('normalization_replay_mismatch');
          append({
            captureId,
            captureSequence,
            ordinal: record.ordinal,
            input: record.input,
            normalized,
            configuration: record.configuration,
          });
        }
        if (sourceRecords.at(-1)?.input.kind !== 'capture-stopped') reject('source_not_stopped');
      } else if (sourceKind === 'coinbase') {
        const selected = path.resolve(location);
        const status = await getSpotRecordingStatus(path.dirname(selected), { now: () => 1 });
        const capture = status.captures.find(
          (item) => path.basename(item.location) === path.basename(selected),
        );
        if (!capture) reject('source_missing');
        sourceId = `coinbase:${capture.captureId}`;
        observedRecordCount = capture.recordCount;
        if (capture.recordCount > maxRecords) reject('source_record_limit');
        coverage = {
          captureCount: 1,
          sourceKind: 'proxy',
          instrument: 'BTC-USD',
          historicalOrderBooks: 'original-recordings-only',
        };
        await replaySpotRecording(selected, {
          onRecord: (record) =>
            append({
              captureId: capture.captureId,
              captureSequence: 1,
              ordinal: record.ordinal,
              input: record.input,
              normalized: record.normalized,
              configuration: record.configuration,
            }),
        });
      } else {
        const supplement = await readJsonFile(location, 64 * 1024 * 1024);
        if (
          supplement?.schemaVersion !== 'event-historical-supplement-v1' ||
          typeof supplement.supplementId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(supplement.supplementId) ||
          !Array.isArray(supplement.captures) ||
          !Array.isArray(supplement.requests) ||
          !supplement.coverage ||
          !Array.isArray(supplement.coverage.requestedTickers)
        )
          reject('unsupported_historical_artifact');
        sourceId = `historical:${supplement.supplementId}`;
        coverage = supplement.coverage;
        observedRecordCount = supplement.captures.length;
        const state = createKalshiIngestionState();
        for (const [index, input] of supplement.captures.entries()) {
          if (
            !['series', 'market', 'benchmark-rest'].includes(input?.kind) ||
            input.provenance !== 'retrospective-history' ||
            input.originalAvailability !== 'unknown'
          )
            reject('unsupported_historical_capture');
          const request = supplement.requests.find(
            (entry) =>
              entry?.kind === input.kind &&
              entry.resourcePath === input.resourcePath &&
              entry.receivedAt === input.receivedAt,
          );
          if (!request) reject('historical_request_evidence_missing');
          const normalized =
            input.kind === 'market' && request.status !== 'available'
              ? {
                  disposition: 'invalid',
                  kind: input.kind,
                  reason: 'Historical market request failed identity validation.',
                }
              : state.apply(input);
          append({
            captureId: supplement.supplementId,
            captureSequence: 1,
            ordinal: index + 1,
            input,
            normalized,
            configuration: { freshnessMs: 5000 },
          });
        }
        const receivedTickers = new Set(
          sourceRecords.flatMap((record) =>
            record.normalized?.market?.ticker ? [record.normalized.market.ticker] : [],
          ),
        );
        for (const ticker of coverage.requestedTickers) {
          if (typeof ticker !== 'string') reject('unsupported_historical_artifact');
          if (!receivedTickers.has(ticker)) addIssue('historical_market_missing', { ticker });
        }
        for (const request of supplement.requests) {
          if (!request || typeof request.status !== 'string')
            reject('unsupported_historical_artifact');
          if (request.status !== 'available')
            addIssue('historical_request_unavailable', {
              ticker: request.ticker ?? null,
              resourcePath: request.resourcePath ?? null,
              status: request.status,
              hourStartsAt: request.hourStartsAt ?? null,
            });
        }
        addIssue('historical_availability_unknown');
        addIssue('historical_order_book_unavailable');
      }
      if (sourceRecords.length === 0 && sourceKind !== 'historical') reject('source_empty');
      const digest = createHash('sha256');
      for (const record of sourceRecords) digest.update(canonicalJson(record)).update('\n');
      digest.update(canonicalJson(coverage));
      const contentDigest = digest.digest('hex');
      const previous = reports.get(sourceId);
      if (previous) {
        if (previous.contentDigest === contentDigest && previous.status === 'verified') {
          previous.duplicateRequests = (previous.duplicateRequests ?? 0) + 1;
          return;
        }
        recordCount -= admitted.get(sourceId)?.length ?? 0;
        admitted.delete(sourceId);
        previous.status = 'excluded';
        previous.recordCount = 0;
        const issue = { sourceId, code: 'conflicting_source_identity' };
        previous.issues.push(issue);
        issues.push(issue);
        return;
      }
      if (recordCount + sourceRecords.length > maxRecords) reject('dataset_record_limit');
      const report = {
        sourceId,
        sourceKind,
        provenance,
        status: 'verified',
        recordCount: sourceRecords.length,
        firstReceivedAt: sourceRecords[0]?.receivedAt ?? null,
        lastReceivedAt,
        issues: sourceIssues,
        contentDigest,
        ...(coverage ? { coverage } : {}),
      };
      reports.set(sourceId, report);
      admitted.set(sourceId, sourceRecords);
      recordCount += sourceRecords.length;
      issues.push(...sourceIssues);
    } catch (error) {
      const code = sourceError(error);
      const issue = { sourceId, code };
      sourceIssues.push(issue);
      const previous = reports.get(sourceId);
      if (previous) {
        recordCount -= admitted.get(sourceId)?.length ?? 0;
        admitted.delete(sourceId);
        previous.status = 'excluded';
        previous.recordCount = 0;
        previous.issues.push(issue);
      } else
        reports.set(sourceId, {
          sourceId,
          sourceKind,
          provenance,
          status: 'excluded',
          recordCount: 0,
          observedRecordCount,
          firstReceivedAt: null,
          lastReceivedAt: null,
          issues: sourceIssues,
          ...(coverage ? { coverage } : {}),
        });
      issues.push(...sourceIssues);
    }
  };
  for (const [index, directory] of kalshiDirectories.entries())
    await load('kalshi', directory, index);
  for (const [index, filename] of spotFiles.entries()) await load('coinbase', filename, index);
  for (const [index, filename] of historicalFiles.entries())
    await load('historical', filename, index);
  const records = [...admitted.values()]
    .flat()
    .sort(
      (left, right) =>
        left.availableAt - right.availableAt ||
        compareText(left.sourceId, right.sourceId) ||
        left.captureSequence - right.captureSequence ||
        left.ordinal - right.ordinal,
    );
  return {
    records,
    sources: [...reports.values()].sort((left, right) =>
      compareText(left.sourceId, right.sourceId),
    ),
    issues: issues.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right))),
  };
};
