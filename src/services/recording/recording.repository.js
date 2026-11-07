import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** One filesystem engine; each owner supplies fixed versions and archive names. */
export const createRecordingRepository = ({
  directoryVersion,
  manifestVersion,
  recordingVersion,
  markerName,
  lockName,
  errorPrefix = 'SPOT_RECORDING',
  archiveLabel = 'spot archive',
  requireCompleteHistory = false,
  useCaptureSequence = false,
}) => {
  const capturePattern = /^[a-f0-9-]{36}\.manifest\.json$/;
  const defaultMaximumBytes = 256 * 1024 * 1024;
  const fail = (message, code) =>
    Object.assign(new Error(message.replaceAll('spot archive', archiveLabel)), {
      code: code.replace(/^SPOT_RECORDING/, errorPrefix),
    });
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  const timestamp = (now) => {
    const value = now();
    if (!positiveInteger(value))
      throw fail('Recording requires a UTC Unix millisecond clock.', 'SPOT_RECORDING_CLOCK');
    return value;
  };
  const checkRetention = (hours) => {
    if (!Number.isFinite(hours) || hours < 0)
      throw fail(
        'Retention hours must be nonnegative; zero disables retention.',
        'SPOT_RECORDING_CONFIG',
      );
  };

  const assertJsonValue = (value, depth = 0) => {
    if (depth > 32) throw fail('Recording JSON is nested too deeply.', 'SPOT_RECORDING_SCHEMA');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, depth + 1);
      return;
    }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      for (const item of Object.values(value)) assertJsonValue(item, depth + 1);
      return;
    }
    throw fail('Recording values must be finite JSON without coercion.', 'SPOT_RECORDING_SCHEMA');
  };

  const readRegularJson = async (filename) => {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink())
      throw fail(
        'Recording metadata must be a regular file, never a link.',
        'SPOT_RECORDING_UNSAFE_PATH',
      );
    return JSON.parse(await readFile(filename, 'utf8'));
  };

  const resolveDirectory = async (directory, { create = false } = {}) => {
    if (typeof directory !== 'string' || !directory)
      throw fail('Choose a recording directory.', 'SPOT_RECORDING_CONFIG');
    const selected = path.resolve(directory);
    if (create) await mkdir(selected, { recursive: true });
    const info = await lstat(selected);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw fail(
        'The recording directory must be a regular directory, never a link.',
        'SPOT_RECORDING_UNSAFE_PATH',
      );
    return realpath(selected);
  };

  const readMarker = async (directory) => {
    const marker = await readRegularJson(path.join(directory, markerName));
    if (
      marker.version !== directoryVersion ||
      typeof marker.id !== 'string' ||
      (useCaptureSequence &&
        (!positiveInteger(marker.nextCaptureSequence) ||
          !Number.isSafeInteger(marker.prunedCaptureCount) ||
          marker.prunedCaptureCount < 0 ||
          (marker.retentionWarningAt !== null && !positiveInteger(marker.retentionWarningAt))))
    )
      throw fail('This directory is not an owned spot archive.', 'SPOT_RECORDING_DIRECTORY');
    return marker;
  };

  const writeAtomicJson = async (filename, value) => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      handle = null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, filename);
          break;
        } catch (error) {
          // Windows readers/scanners can briefly retain a closed metadata file.
          // Keep atomic replacement; never unlink the destination as a fallback.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(50 * 2 ** attempt);
        }
      }
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };

  const acquireLock = async (directory) => {
    const filename = path.join(directory, lockName);
    const token = randomUUID();
    let handle;
    try {
      handle = await open(filename, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw fail(
          'A recording writer or cleanup lock exists. Verify its owner has stopped before repairing it.',
          'SPOT_RECORDING_LOCKED',
        );
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const assertOwned = async () => {
      if ((await readRegularJson(filename)).token !== token)
        throw fail('Recording directory ownership changed.', 'SPOT_RECORDING_LOCK_LOST');
    };
    return {
      assertOwned,
      release: async () => {
        await assertOwned();
        await unlink(filename);
      },
    };
  };

  const readManifest = async (directory, filename, marker) => {
    const manifest = await readRegularJson(path.join(directory, filename));
    const captureId = filename.slice(0, -'.manifest.json'.length);
    if (
      !capturePattern.test(filename) ||
      manifest.version !== manifestVersion ||
      manifest.directoryId !== marker.id ||
      manifest.captureId !== captureId ||
      manifest.filename !== `${captureId}.jsonl` ||
      typeof manifest.complete !== 'boolean' ||
      !positiveInteger(manifest.createdAt) ||
      !Number.isSafeInteger(manifest.recordCount) ||
      manifest.recordCount < 0 ||
      !Number.isSafeInteger(manifest.bytesRecorded) ||
      manifest.bytesRecorded < 0 ||
      (useCaptureSequence &&
        (!positiveInteger(manifest.captureSequence) ||
          manifest.captureSequence >= marker.nextCaptureSequence)) ||
      (manifest.complete &&
        (!positiveInteger(manifest.closedAt) || manifest.closedAt < manifest.createdAt))
    )
      throw fail(
        'Recording manifest is invalid; existing files were retained.',
        'SPOT_RECORDING_MANIFEST',
      );
    const location = path.join(directory, manifest.filename);
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink())
      throw fail(
        'Recording segments must be regular files, never links.',
        'SPOT_RECORDING_UNSAFE_PATH',
      );
    return { ...manifest, location, diskBytes: info.size };
  };

  const inspectDirectory = async (directory, now) => {
    const marker = await readMarker(directory);
    const captures = [];
    let directoryBytes = 0;
    let recordingBytes = 0;
    const recordingFiles = [];
    for (const filename of await readdir(directory)) {
      const info = await lstat(path.join(directory, filename));
      if (info.isFile() && !info.isSymbolicLink()) {
        directoryBytes += info.size;
        if (filename.endsWith('.jsonl')) recordingBytes += info.size;
      }
      if (/^[a-f0-9-]{36}\.jsonl$/.test(filename)) recordingFiles.push(filename);
      if (capturePattern.test(filename))
        captures.push(await readManifest(directory, filename, marker));
    }
    if (
      useCaptureSequence &&
      new Set(captures.map((capture) => capture.captureSequence)).size !== captures.length
    )
      throw fail(
        'Archive capture sequences conflict; existing evidence was retained.',
        'SPOT_RECORDING_MANIFEST',
      );
    captures.sort((left, right) =>
      useCaptureSequence
        ? left.captureSequence - right.captureSequence
        : left.createdAt - right.createdAt || left.captureId.localeCompare(right.captureId),
    );
    const unindexedCaptures = recordingFiles.filter(
      (filename) => !captures.some((capture) => capture.filename === filename),
    );
    const incompleteCaptures = captures.filter((capture) => !capture.complete).length;
    const retainedHistory = useCaptureSequence
      ? {
          firstCaptureSequence: captures[0]?.captureSequence ?? null,
          lastCaptureSequence: captures.at(-1)?.captureSequence ?? null,
          firstRetainedAt: captures[0]?.createdAt ?? null,
          prunedCaptureCount: marker.prunedCaptureCount,
          retentionWarningAt: marker.retentionWarningAt,
          incompleteCaptures,
          unindexedCaptures,
          warning:
            marker.retentionWarningAt !== null
              ? 'Retention cleanup was requested. First-seen timestamps describe retained evidence, not necessarily the first lifetime observation.'
              : (captures[0]?.captureSequence ?? marker.nextCaptureSequence) > 1
                ? 'Earlier capture sequences are absent. First-seen timestamps describe retained evidence only.'
                : null,
        }
      : null;
    return {
      directory,
      configured: true,
      recordingBytes,
      directoryBytes,
      recordCount: captures.reduce((sum, capture) => sum + capture.recordCount, 0),
      captures,
      ...(useCaptureSequence ? { retainedHistory } : {}),
      retentionEligibleCaptures: captures.filter(
        (capture) =>
          capture.complete &&
          capture.retentionHours > 0 &&
          now >= capture.closedAt + capture.retentionHours * 3_600_000,
      ).length,
    };
  };

  const assertRestorableHistory = (status) => {
    if (!requireCompleteHistory) return;
    if (
      status.captures.some((capture) => !capture.complete) ||
      status.retainedHistory?.unindexedCaptures.length
    )
      throw fail(
        'An incomplete or unindexed prior capture blocks ingestion. Existing evidence must be reviewed; first-seen history was not reset.',
        'SPOT_RECORDING_INCOMPLETE_HISTORY',
      );
    if (status.captures.some((capture) => capture.bytesRecorded !== capture.diskBytes))
      throw fail(
        'Prior capture bytes differ from their manifest. Ingestion did not reset history.',
        'SPOT_RECORDING_CORRUPT',
      );
  };

  /** Reads metadata only. It never creates an archive, opens feeds, or removes captures. */
  const getStatus = async (directory, { now = Date.now } = {}) => {
    let resolved;
    try {
      resolved = await resolveDirectory(directory);
    } catch (error) {
      if (error.code === 'ENOENT')
        return {
          directory: path.resolve(directory),
          configured: false,
          recordingBytes: 0,
          directoryBytes: 0,
          recordCount: 0,
          captures: [],
          retentionEligibleCaptures: 0,
        };
      throw error;
    }
    return inspectDirectory(resolved, timestamp(now));
  };

  /** Raw segments are append-only. Acknowledged appends have reached fsync, before metadata is replaced. */
  const createStore = async ({
    directory,
    retentionHours = 0,
    maxBytes = defaultMaximumBytes,
    now = Date.now,
  }) => {
    checkRetention(retentionHours);
    if (!positiveInteger(maxBytes))
      throw fail('The archive byte limit must be a positive integer.', 'SPOT_RECORDING_CONFIG');
    const resolved = await resolveDirectory(directory, { create: true });
    const lock = await acquireLock(resolved);
    let handle;
    let manifest;
    let manifestPath;
    try {
      let marker;
      try {
        marker = await readMarker(resolved);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if ((await readdir(resolved)).some((filename) => filename !== lockName))
          throw fail(
            'A new archive requires an empty directory; existing files were retained.',
            'SPOT_RECORDING_DIRECTORY',
          );
        marker = {
          version: directoryVersion,
          id: randomUUID(),
          createdAt: timestamp(now),
          ...(useCaptureSequence
            ? { nextCaptureSequence: 1, prunedCaptureCount: 0, retentionWarningAt: null }
            : {}),
        };
        await writeAtomicJson(path.join(resolved, markerName), marker);
      }
      const initial = await inspectDirectory(resolved, timestamp(now));
      assertRestorableHistory(initial);
      if (initial.recordingBytes >= maxBytes)
        throw fail(
          'The spot archive byte limit is reached. No records were deleted.',
          'SPOT_RECORDING_LIMIT',
        );
      const captureId = randomUUID();
      const captureSequence = useCaptureSequence ? marker.nextCaptureSequence : null;
      if (useCaptureSequence) {
        if (!positiveInteger(captureSequence + 1))
          throw fail('Archive capture sequence limit reached.', 'SPOT_RECORDING_LIMIT');
        marker = { ...marker, nextCaptureSequence: captureSequence + 1 };
        await writeAtomicJson(path.join(resolved, markerName), marker);
      }
      const createdAt = timestamp(now);
      const location = path.join(resolved, `${captureId}.jsonl`);
      manifestPath = path.join(resolved, `${captureId}.manifest.json`);
      manifest = {
        version: manifestVersion,
        directoryId: marker.id,
        captureId,
        ...(useCaptureSequence ? { captureSequence } : {}),
        filename: `${captureId}.jsonl`,
        createdAt,
        closedAt: null,
        updatedAt: createdAt,
        syncedAt: null,
        complete: false,
        retentionHours,
        maxBytes,
        recordCount: 0,
        bytesRecorded: 0,
        error: null,
      };
      handle = await open(location, 'wx', 0o600);
      await writeAtomicJson(manifestPath, manifest);
      let pending = Promise.resolve();
      let failure = null;
      let closing = false;
      let closed = false;
      let closingTask = null;
      let recordingBytes = initial.recordingBytes;
      // A batch acknowledges every row together. An I/O failure may leave raw bytes,
      // but never acknowledges a prefix or marks that capture complete.
      const appendBatch = (records) => {
        if (closing || closed)
          return Promise.reject(fail('Recording is closed.', 'SPOT_RECORDING_CLOSED'));
        let lines;
        let ordinals;
        try {
          if (!Array.isArray(records) || records.length < 1 || records.length > 100)
            throw fail('Recording batches require 1 to 100 rows.', 'SPOT_RECORDING_SCHEMA');
          ordinals = [];
          lines = Array.from(records, (record) => {
            assertJsonValue(record);
            const line = `${JSON.stringify(record)}\n`;
            const parsed = JSON.parse(line);
            if (parsed.schemaVersion !== recordingVersion || !positiveInteger(parsed.ordinal))
              throw fail('Invalid recording version or ordinal.', 'SPOT_RECORDING_SCHEMA');
            ordinals.push(parsed.ordinal);
            return line;
          }).join('');
        } catch (error) {
          failure ??= error;
          return Promise.reject(error);
        }
        const operation = pending.then(async () => {
          if (failure) throw failure;
          await lock.assertOwned();
          if (ordinals.some((ordinal, index) => ordinal !== manifest.recordCount + index + 1))
            throw fail(
              'Recording ordinals must be consecutive in receipt order.',
              'SPOT_RECORDING_ORDINAL',
            );
          const bytes = Buffer.byteLength(lines, 'utf8');
          if (recordingBytes + bytes > maxBytes)
            throw fail(
              'The spot archive byte limit is reached. Recording stopped without deleting or dropping saved records.',
              'SPOT_RECORDING_LIMIT',
            );
          await handle.writeFile(lines, 'utf8');
          await handle.sync();
          const writtenAt = timestamp(now);
          manifest = {
            ...manifest,
            recordCount: ordinals.at(-1),
            bytesRecorded: manifest.bytesRecorded + bytes,
            updatedAt: writtenAt,
            syncedAt: writtenAt,
          };
          recordingBytes += bytes;
          await writeAtomicJson(manifestPath, manifest);
          return { ordinal: ordinals.at(-1), bytesRecorded: manifest.bytesRecorded };
        });
        pending = operation.catch((error) => {
          failure ??= error;
        });
        return operation;
      };
      const append = (record) => appendBatch([record]);
      const close = ({ complete = true, error = null } = {}) => {
        if (closingTask) return closingTask;
        closing = true;
        closingTask = (async () => {
          await pending;
          try {
            await lock.assertOwned();
            await handle.sync();
            await handle.close();
            handle = null;
            const closedAt = timestamp(now);
            manifest = {
              ...manifest,
              complete: complete && !failure && !error,
              closedAt,
              updatedAt: closedAt,
              error: failure?.code ?? (error ? `${errorPrefix}_INTERRUPTED` : null),
            };
            await writeAtomicJson(manifestPath, manifest);
            return { ...manifest, location };
          } finally {
            closed = true;
            await handle?.close();
            handle = null;
            await lock.release();
          }
        })();
        return closingTask;
      };
      return {
        append,
        appendBatch,
        close,
        location,
        captureId,
        ...(useCaptureSequence
          ? {
              captureSequence,
              readPriorArchive: () =>
                iterateCaptures(async () => {
                  await lock.assertOwned();
                  return initial.captures;
                }),
            }
          : {}),
        getStatus: () => {
          // Polling shares the write queue, so it cannot hold our manifest open
          // while an acknowledged append is atomically replacing it on Windows.
          const inspection = pending.then(async () => ({
            ...(await inspectDirectory(resolved, timestamp(now))),
            ...manifest,
            location,
            remainingBytes: Math.max(0, maxBytes - recordingBytes),
          }));
          pending = inspection.catch(() => {});
          return inspection;
        },
      };
    } catch (error) {
      await handle?.close();
      await lock.release();
      throw error;
    }
  };

  /** Replay only finalized, owned files. Receipt order and newline framing are never repaired. */
  const readRecording = (filename) => ({
    [Symbol.asyncIterator]: () => {
      let stream;
      let chunks;
      let manifest;
      let buffer = '';
      let ordinal = 0;
      let ended = false;
      const initialize = async () => {
        const location = path.resolve(filename);
        const directory = await resolveDirectory(path.dirname(location));
        const marker = await readMarker(directory);
        const manifestName = path.basename(location).replace(/\.jsonl$/, '.manifest.json');
        manifest = await readManifest(directory, manifestName, marker);
        if (
          manifest.location !== path.join(directory, path.basename(location)) ||
          !manifest.complete
        )
          throw fail('Replay requires a completed capture.', 'SPOT_RECORDING_INCOMPLETE');
        if (manifest.diskBytes !== manifest.bytesRecorded)
          throw fail('Recording byte count differs from its manifest.', 'SPOT_RECORDING_CORRUPT');
        stream = createReadStream(manifest.location, { encoding: 'utf8' });
        chunks = stream[Symbol.asyncIterator]();
      };
      return {
        next: async () => {
          try {
            if (!chunks) await initialize();
            while (true) {
              const newline = buffer.indexOf('\n');
              if (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const record = JSON.parse(line);
                if (record?.schemaVersion !== recordingVersion || record.ordinal !== ordinal + 1)
                  throw fail(
                    'Replay encountered an invalid version or ordinal.',
                    'SPOT_RECORDING_CORRUPT',
                  );
                ordinal += 1;
                return { value: record, done: false };
              }
              if (ended) {
                if (buffer.length || ordinal !== manifest.recordCount)
                  throw fail(
                    'Replay encountered a partial or missing record.',
                    'SPOT_RECORDING_CORRUPT',
                  );
                return { value: undefined, done: true };
              }
              const chunk = await chunks.next();
              ended = Boolean(chunk.done);
              if (!ended) buffer += chunk.value;
            }
          } catch (error) {
            stream?.destroy();
            throw error;
          }
        },
        return: async () => {
          stream?.destroy();
          return { done: true };
        },
      };
    },
  });

  /** Restore complete captures in durable capture order, preserving each local ordinal. */
  const iterateCaptures = (loadCaptures) => ({
    [Symbol.asyncIterator]: () => {
      let captures = null;
      let captureIndex = 0;
      let current = null;
      return {
        next: async () => {
          if (captures === null) {
            captures = await loadCaptures();
          }
          while (captureIndex < captures.length) {
            const capture = captures[captureIndex];
            current ??= readRecording(capture.location)[Symbol.asyncIterator]();
            const entry = await current.next();
            if (!entry.done)
              return {
                done: false,
                value: {
                  captureId: capture.captureId,
                  ...(useCaptureSequence ? { captureSequence: capture.captureSequence } : {}),
                  record: entry.value,
                },
              };
            current = null;
            captureIndex += 1;
          }
          return { done: true };
        },
        return: async () => {
          await current?.return?.();
          return { done: true };
        },
      };
    },
  });

  const readArchive = (directory) =>
    iterateCaptures(async () => {
      const status = await getStatus(directory);
      assertRestorableHistory(status);
      return status.captures;
    });

  /** Explicit cleanup removes only completed archive segments. Active or uncertain evidence is retained. */
  const prune = async ({ directory, retentionHours = 0, now = Date.now }) => {
    checkRetention(retentionHours);
    const resolved = await resolveDirectory(directory);
    const lock = await acquireLock(resolved);
    try {
      const checkedAt = timestamp(now);
      const status = await inspectDirectory(resolved, checkedAt);
      if (retentionHours === 0)
        return { removedCaptures: 0, removedBytes: 0, retentionDisabled: true };
      const eligible = status.captures.filter(
        (capture) => capture.complete && checkedAt >= capture.closedAt + retentionHours * 3_600_000,
      );
      if (eligible.some((capture) => capture.diskBytes !== capture.bytesRecorded))
        throw fail(
          'Cleanup found a capture whose bytes differ from its completed manifest. All captures were retained.',
          'SPOT_RECORDING_CORRUPT',
        );
      let removedBytes = 0;
      let marker = useCaptureSequence ? await readMarker(resolved) : null;
      if (marker && eligible.length) {
        // Persist the history warning before the first deletion, including interrupted cleanup.
        marker = { ...marker, retentionWarningAt: checkedAt };
        await writeAtomicJson(path.join(resolved, markerName), marker);
      }
      for (const capture of eligible) {
        await lock.assertOwned();
        // Every candidate was checked before any mutation; targets stay directly inside this directory.
        if (path.dirname(path.resolve(capture.location)) !== resolved)
          throw fail('Cleanup target escaped the archive.', 'SPOT_RECORDING_UNSAFE_PATH');
        const info = await lstat(capture.location);
        if (!info.isFile() || info.isSymbolicLink())
          throw fail(
            'Cleanup refuses linked or nonregular segments.',
            'SPOT_RECORDING_UNSAFE_PATH',
          );
        await unlink(path.join(resolved, `${capture.captureId}.manifest.json`));
        // A failed second unlink leaves an unowned raw file retained and counted toward capacity,
        // rather than a dangling manifest that would block unrelated captures.
        await unlink(capture.location);
        removedBytes += info.size;
        if (marker) {
          marker = { ...marker, prunedCaptureCount: marker.prunedCaptureCount + 1 };
          await writeAtomicJson(path.join(resolved, markerName), marker);
        }
      }
      return { removedCaptures: eligible.length, removedBytes, retentionDisabled: false };
    } finally {
      await lock.release();
    }
  };

  return { createStore, readRecording, getStatus, prune, readArchive };
};
