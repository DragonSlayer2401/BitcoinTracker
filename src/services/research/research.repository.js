import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { getResearchWriteTransaction } from './research.connection';
import { initializeResearchSchema } from './research.schema';
import { EARLY_MODEL_VERSION } from '@/features/BitcoinTracker/utils/learning/earlyModel.utils';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  getResearchPage,
  isResearchIdentifier,
  isResearchTimestamp,
  validateEvidenceRow,
  validateResearchInputSnapshot,
  validateForecastSnapshot,
  validateForecastSnapshotConsistency,
  validateModelArtifact,
  validateResearchBatch,
} from './research.validation';

const forecastStateRanks = {
  analyzing: 0,
  pending: 1,
  'awaiting-settlement': 2,
  withheld: 2,
  unobserved: 3,
  resolved: 4,
};
const getContentHash = (json) => createHash('sha256').update(json).digest('hex');

function getStoredModel(row) {
  return {
    ...JSON.parse(row.payload),
    ...(row.retired_at == null
      ? {}
      : {
          retirement: {
            retiredAt: Number(row.retired_at),
            reason: row.retirement_reason,
            wasActive: Boolean(row.was_active),
          },
        }),
  };
}

export function getResearchDatabaseConfiguration(environment = process.env) {
  const isHosted = Boolean(
    environment.VERCEL || environment.AWS_LAMBDA_FUNCTION_NAME || environment.NETLIFY,
  );
  const configuredUrl = environment.TURSO_DATABASE_URL;
  if (isHosted && (!configuredUrl || configuredUrl.startsWith('file:'))) {
    throw new ResearchDataError(
      'Durable research storage requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN on hosted serverless deployments.',
      503,
    );
  }
  if (configuredUrl && !/^(?:libsql|https|file):/.test(configuredUrl)) {
    throw new ResearchDataError(
      'TURSO_DATABASE_URL must use libsql, https, or a local file URL.',
      503,
    );
  }
  const url =
    configuredUrl || pathToFileURL(path.resolve(process.cwd(), 'data/bitcoin-research.db')).href;
  const isLocal = url.startsWith('file:');
  if (!isLocal && !environment.TURSO_AUTH_TOKEN) {
    throw new ResearchDataError(
      'Set TURSO_AUTH_TOKEN for the configured remote research database.',
      503,
    );
  }
  return {
    url,
    authToken: isLocal ? undefined : environment.TURSO_AUTH_TOKEN,
    mode: isLocal ? 'local-database' : 'remote-database',
  };
}

function getPageResult(result, limit) {
  const selected = result.rows.slice(0, limit);
  return {
    rows: selected.map((row) => JSON.parse(row.payload)),
    nextCursor: result.rows.length > limit ? String(selected.at(-1).sequence) : null,
  };
}

async function readAllResearchPages(readPage, maximumRows) {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
    throw new ResearchDataError('Research analysis requires a positive row limit.');
  }
  const rows = [];
  let after = 0;
  do {
    const page = await readPage({ after, limit: 2000 });
    rows.push(...page.rows);
    if (rows.length > maximumRows) {
      throw new ResearchDataError(
        'Research analysis exceeds its configured row limit. Use paginated export or a larger analysis job.',
        413,
      );
    }
    after = page.nextCursor;
  } while (after !== null);
  return rows;
}

async function insertForecastSnapshot(transaction, entry) {
  const previousSnapshots = await transaction.execute({
    sql: 'SELECT payload FROM forecast_snapshots WHERE forecast_id = ?',
    args: [entry.row.id],
  });
  for (const snapshot of previousSnapshots.rows) {
    validateForecastSnapshotConsistency(JSON.parse(snapshot.payload), entry.row);
  }
  await transaction.execute({
    sql: 'INSERT INTO forecast_snapshots(snapshot_id, forecast_id, state, state_rank, created_at, content_hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [
      entry.id,
      entry.row.id,
      entry.row.status,
      forecastStateRanks[entry.row.status],
      entry.row.createdAt,
      entry.hash,
      entry.json,
    ],
  });
}

async function insertEvidenceEvent(transaction, entry) {
  await transaction.execute({
    sql: 'INSERT INTO evidence_events(event_id, forecast_id, recorded_at, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
    args: [entry.id, entry.row.forecastId, entry.row.recordedAt, entry.hash, entry.json],
  });
  if (entry.inputSnapshotJson) {
    // A retired-ID trigger can ignore the evidence insert. Never create an orphan replay.
    const accepted = await transaction.execute({
      sql: 'SELECT event_id FROM evidence_events WHERE event_id = ?',
      args: [entry.id],
    });
    if (accepted.rows.length)
      await transaction.execute({
        sql: 'INSERT INTO research_input_snapshots(snapshot_id, forecast_id, captured_at, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
        args: [
          entry.id,
          entry.row.forecastId,
          entry.row.featureCutoffAt,
          entry.inputSnapshotHash,
          entry.inputSnapshotJson,
        ],
      });
  }
}

export function createResearchRepository({ client, mode = 'local-database' }) {
  let schemaInitialization;
  let pendingWrite = Promise.resolve();

  function runWriteOperation(operation) {
    const result = pendingWrite.then(operation);
    // A rejected batch must not prevent later uploads from using the queue.
    pendingWrite = result.catch(() => {});
    return result;
  }

  async function initialize() {
    if (!schemaInitialization) {
      schemaInitialization = initializeResearchSchema(client).catch((error) => {
        schemaInitialization = null;
        throw error;
      });
    }
    await schemaInitialization;
  }

  async function getWriteAvailability() {
    if (mode !== 'local-database')
      return { writeAvailable: null, writeStatus: 'not-checked', writeReason: null };
    try {
      // A single pooled connection acquires and immediately releases the lock, without
      // changing any rows. The driver's finally cleanup rolls back on an interrupted probe.
      await client.executeMultiple('BEGIN EXCLUSIVE; ROLLBACK;');
      return { writeAvailable: true, writeStatus: 'available', writeReason: null };
    } catch (error) {
      const locked = /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(error?.code ?? '');
      const readOnly = /^SQLITE_READONLY(?:_|$)/.test(error?.code ?? '');
      return {
        writeAvailable: false,
        writeStatus: locked ? 'locked' : readOnly ? 'read-only' : 'unavailable',
        writeReason: locked
          ? 'The database is locked. Finish or close the open transaction in your database viewer, then retry. Existing data is retained.'
          : readOnly
            ? 'The database is read-only. Restore write access before recording new evidence. Existing data is retained.'
            : 'The database is readable, but write access could not be verified. Existing data is retained.',
      };
    }
  }

  async function appendEvents(table, rows, prepareEntry) {
    return runWriteOperation(async () => {
      validateResearchBatch(rows);
      const entries = rows.map(prepareEntry);
      await initialize();

      const isForecastBatch = table === 'forecast_snapshots';
      const identityColumn = isForecastBatch ? 'snapshot_id' : 'event_id';
      const insertEntry = isForecastBatch ? insertForecastSnapshot : insertEvidenceEvent;
      const transaction = await getResearchWriteTransaction(client);
      let inserted = 0;
      let duplicates = 0;
      try {
        for (const entry of entries) {
          const existing = await transaction.execute({
            sql: `SELECT content_hash FROM ${table} WHERE ${identityColumn} = ?`,
            args: [entry.id],
          });
          if (existing.rows.length) {
            if (existing.rows[0].content_hash !== entry.hash) {
              throw new ResearchDataError(
                'A saved research event already exists with different content. Original evidence was retained.',
                409,
              );
            }
            duplicates += 1;
            continue;
          }
          await insertEntry(transaction, entry);
          inserted += 1;
        }
        await transaction.commit();
        return { inserted, duplicates };
      } finally {
        transaction.close();
      }
    });
  }

  const repository = {
    persistEvidenceRows(rows) {
      return appendEvents('evidence_events', rows, (row) => {
        const evidenceJson = validateEvidenceRow(row);
        const inputSnapshotJson =
          row.researchInputSnapshot == null ? null : validateResearchInputSnapshot(row);
        const inputSnapshotHash = inputSnapshotJson ? getContentHash(inputSnapshotJson) : null;
        const json = inputSnapshotJson
          ? getCanonicalResearchJson({
              ...JSON.parse(evidenceJson),
              researchReplay: {
                status: 'stored',
                snapshotId: row.eventId,
                contentHash: inputSnapshotHash,
                replayable: row.researchInputSnapshot.timing?.replayable === true,
              },
            })
          : evidenceJson;
        return {
          row,
          id: row.eventId,
          json,
          hash: getContentHash(json),
          inputSnapshotJson,
          inputSnapshotHash,
        };
      });
    },
    async readResearchInputSnapshot(snapshotId) {
      if (!isResearchIdentifier(snapshotId))
        throw new ResearchDataError('Invalid replay identity.');
      await initialize();
      const result = await client.execute({
        sql: 'SELECT snapshot_id, content_hash, payload FROM research_input_snapshots WHERE snapshot_id = ?',
        args: [snapshotId],
      });
      const row = result.rows[0];
      if (!row) return null;
      if (getContentHash(row.payload) !== row.content_hash)
        throw new ResearchDataError('Stored replay input hash does not match its contents.', 409);
      return {
        snapshotId: row.snapshot_id,
        contentHash: row.content_hash,
        snapshot: JSON.parse(row.payload),
      };
    },
    async getPendingForwardCaptures({ now, limit = 100 } = {}) {
      if (!isResearchTimestamp(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ResearchDataError('Invalid forward-label query.');
      await initialize();
      const result = await client.execute({
        sql: `SELECT e.payload, s.snapshot_id FROM research_input_snapshots s
          JOIN evidence_events e ON e.event_id = s.snapshot_id
          WHERE s.captured_at <= ? AND
          (SELECT COUNT(*) FROM research_forward_labels l WHERE l.snapshot_id = s.snapshot_id) < 3
          ORDER BY s.captured_at LIMIT ?`,
        args: [now - 15_000, limit],
      });
      const captures = [];
      for (const row of result.rows) {
        const labels = await client.execute({
          sql: 'SELECT payload FROM research_forward_labels WHERE snapshot_id = ?',
          args: [row.snapshot_id],
        });
        captures.push({
          decision: JSON.parse(row.payload),
          completedHorizons: labels.rows.map((label) => JSON.parse(label.payload).horizonSeconds),
        });
      }
      return captures;
    },
    async persistForwardLabels(labels) {
      return runWriteOperation(async () => {
        validateResearchBatch(labels);
        const prepared = labels.map((label) => {
          if (
            label?.version !== 'brti-forward-label-v1' ||
            !isResearchIdentifier(label.snapshotId) ||
            !isResearchIdentifier(label.labelId) ||
            !isResearchIdentifier(label.forecastId) ||
            label.labelId !== `${label.snapshotId}:forward:${label.horizonSeconds}` ||
            ![15, 60, 180].includes(label.horizonSeconds) ||
            !['observed', 'missing'].includes(label.status) ||
            !isResearchTimestamp(label.recordedAt) ||
            !isResearchTimestamp(label.capturedAt) ||
            !isResearchTimestamp(label.dueAt) ||
            label.dueAt !==
              Math.ceil((label.capturedAt + label.horizonSeconds * 1000) / 1000) * 1000 ||
            label.recordedAt < label.dueAt ||
            !label.reference ||
            typeof label.reference !== 'object' ||
            Array.isArray(label.reference) ||
            (label.status === 'missing' &&
              (label.reading !== null ||
                label.logReturn !== null ||
                ![
                  'capture-reference-is-not-observed-brti',
                  'exact-forward-brti-reading-unavailable',
                ].includes(label.reason))) ||
            (label.status === 'observed' &&
              (label.reason !== null ||
                label.reference.source !== 'cf-brti' ||
                !isResearchTimestamp(label.reference.time) ||
                label.reference.time % 1000 !== 0 ||
                label.reference.time > label.capturedAt ||
                !isResearchTimestamp(label.reference.receivedAt) ||
                label.reference.receivedAt < label.reference.time ||
                label.reference.receivedAt > label.capturedAt ||
                label.reading?.time !== label.dueAt ||
                !isResearchTimestamp(label.reading.receivedAt) ||
                label.reading.receivedAt < label.reading.time ||
                label.reading.receivedAt > label.recordedAt ||
                !Number.isFinite(label.reference.price) ||
                label.reference.price <= 0 ||
                label.reference.price > 1e9 ||
                !Number.isFinite(label.reading.price) ||
                label.reading.price <= 0 ||
                label.reading.price > 1e9 ||
                !Number.isFinite(label.logReturn) ||
                Math.abs(label.logReturn - Math.log(label.reading.price / label.reference.price)) >
                  1e-12))
          )
            throw new ResearchDataError('Invalid forward BRTI label.');
          const json = getCanonicalResearchJson(label);
          return { label, json, hash: getContentHash(json) };
        });
        await initialize();
        const transaction = await getResearchWriteTransaction(client);
        try {
          let inserted = 0;
          for (const { label, json, hash } of prepared) {
            const capture = await transaction.execute({
              sql: `SELECT s.captured_at, s.forecast_id, e.payload, e.content_hash
                FROM research_input_snapshots s JOIN evidence_events e ON e.event_id = s.snapshot_id
                WHERE s.snapshot_id = ?`,
              args: [label.snapshotId],
            });
            const original = capture.rows[0];
            if (Number(original?.captured_at) !== label.capturedAt)
              throw new ResearchDataError('A forward label requires its original captured input.');
            const decision = JSON.parse(original.payload);
            const referenceFields = {
              time: 'quoteTime',
              price: 'spot',
              receivedAt: 'receivedAt',
              source: 'referenceSource',
            };
            if (
              getContentHash(original.payload) !== original.content_hash ||
              original.forecast_id !== label.forecastId ||
              decision.forecastId !== label.forecastId ||
              decision.featureCutoffAt !== label.capturedAt ||
              Object.entries(referenceFields).some(
                ([field, originalField]) =>
                  (label.reference[field] ?? null) !== (decision[originalField] ?? null),
              )
            )
              throw new ResearchDataError(
                'A forward label must retain the original forecast and BRTI reference.',
                409,
              );
            const exists = await transaction.execute({
              sql: 'SELECT content_hash FROM research_forward_labels WHERE label_id = ?',
              args: [label.labelId],
            });
            if (exists.rows.length) {
              if (exists.rows[0].content_hash !== hash)
                throw new ResearchDataError(
                  'A forward label cannot overwrite its original observation.',
                  409,
                );
              continue;
            }
            await transaction.execute({
              sql: 'INSERT INTO research_forward_labels(label_id, snapshot_id, recorded_at, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
              args: [label.labelId, label.snapshotId, label.recordedAt, hash, json],
            });
            inserted++;
          }
          await transaction.commit();
          return { inserted, duplicates: labels.length - inserted };
        } finally {
          transaction.close();
        }
      });
    },
    async getForwardResearchLabels({ maximumRows = 250_000 } = {}) {
      await initialize();
      return readAllResearchPages(
        async ({ after, limit }) =>
          getPageResult(
            await client.execute({
              sql: 'SELECT sequence, payload FROM research_forward_labels WHERE sequence > ? ORDER BY sequence LIMIT ?',
              args: [after, limit + 1],
            }),
            limit,
          ),
        maximumRows,
      );
    },
    persistForecastSnapshots(rows) {
      return appendEvents('forecast_snapshots', rows, (row) => {
        const json = validateForecastSnapshot(row);
        return { row, id: `${row.id}:${row.status}`, json, hash: getContentHash(json) };
      });
    },
    async readStoredEvidence(parameters) {
      const { after, limit } = getResearchPage(parameters);
      await initialize();
      return getPageResult(
        await client.execute({
          sql: 'SELECT sequence, payload FROM evidence_events WHERE sequence > ? ORDER BY sequence LIMIT ?',
          args: [after, limit + 1],
        }),
        limit,
      );
    },
    async readStoredForecasts(parameters) {
      const { after, limit } = getResearchPage(parameters);
      await initialize();
      return getPageResult(
        await client.execute({
          sql: `SELECT sequence, payload FROM (
          SELECT sequence, payload, ROW_NUMBER() OVER (PARTITION BY forecast_id ORDER BY state_rank DESC, sequence DESC) AS current_snapshot
          FROM forecast_snapshots
        ) WHERE current_snapshot = 1 AND sequence > ? ORDER BY sequence LIMIT ?`,
          args: [after, limit + 1],
        }),
        limit,
      );
    },
    async readForecastSnapshotEvents(parameters) {
      const { after, limit } = getResearchPage(parameters);
      await initialize();
      return getPageResult(
        await client.execute({
          sql: 'SELECT sequence, payload FROM forecast_snapshots WHERE sequence > ? ORDER BY sequence LIMIT ?',
          args: [after, limit + 1],
        }),
        limit,
      );
    },
    async getResearchRows({ maximumRows = 250_000 } = {}) {
      return readAllResearchPages(repository.readStoredEvidence, maximumRows);
    },
    async getLearningEvidenceRows({ maximumRows = 250_000 } = {}) {
      await initialize();
      return readAllResearchPages(
        async ({ after, limit }) =>
          getPageResult(
            await client.execute({
              sql: "SELECT sequence, payload FROM evidence_events WHERE json_extract(payload, '$.event') IN ('decision', 'outcome') AND sequence > ? ORDER BY sequence LIMIT ?",
              args: [after, limit + 1],
            }),
            limit,
          ),
        maximumRows,
      );
    },
    async writeModelArtifact(artifact) {
      return runWriteOperation(async () => {
        const json = validateModelArtifact(artifact);
        const contentHash = getContentHash(json);
        await initialize();
        const transaction = await getResearchWriteTransaction(client);
        try {
          const existing = await transaction.execute({
            sql: 'SELECT content_hash FROM model_artifacts WHERE model_id = ?',
            args: [artifact.id],
          });
          if (existing.rows.length && existing.rows[0].content_hash !== contentHash)
            throw new ResearchDataError(
              'A model version cannot overwrite an existing artifact.',
              409,
            );
          if (!existing.rows.length)
            await transaction.execute({
              sql: 'INSERT INTO model_artifacts(model_id, saved_at, content_hash, payload) VALUES (?, ?, ?, ?)',
              args: [artifact.id, Date.now(), contentHash, json],
            });
          await transaction.commit();
          return artifact;
        } finally {
          transaction.close();
        }
      });
    },
    async readModelArtifact(id) {
      if (!isResearchIdentifier(id)) throw new ResearchDataError('Invalid model identifier.');
      await initialize();
      const result = await client.execute({
        sql: `SELECT payload, retired_at, model_retirements.reason AS retirement_reason,
          EXISTS(SELECT 1 FROM model_activations WHERE model_activations.model_id = model_artifacts.model_id) AS was_active
          FROM model_artifacts LEFT JOIN model_retirements USING(model_id) WHERE model_id = ?`,
        args: [id],
      });
      return result.rows.length ? getStoredModel(result.rows[0]) : null;
    },
    async readModelArtifacts() {
      await initialize();
      const result = await client.execute(`SELECT payload, retired_at,
        model_retirements.reason AS retirement_reason,
        EXISTS(SELECT 1 FROM model_activations WHERE model_activations.model_id = model_artifacts.model_id) AS was_active
        FROM model_artifacts
        LEFT JOIN model_retirements USING(model_id) ORDER BY model_artifacts.sequence`);
      return result.rows.map(getStoredModel);
    },
    async getActiveModelArtifact() {
      await initialize();
      const result = await client.execute(
        `SELECT payload, model_id, activated_at, evaluation, retired_at FROM model_artifacts
          JOIN model_activations USING(model_id) LEFT JOIN model_retirements USING(model_id)
          ORDER BY model_activations.sequence DESC LIMIT 1`,
      );
      // Retirement disables the latest activation; it must not resurrect an older model.
      if (!result.rows.length || result.rows[0].retired_at != null) return null;
      const row = result.rows[0];
      return {
        ...JSON.parse(row.payload),
        activation: {
          modelId: row.model_id,
          activatedAt: Number(row.activated_at),
          shadowEvaluation: JSON.parse(row.evaluation),
        },
      };
    },
    async activateModelArtifact(id, { activatedAt, shadowEvaluation } = {}) {
      if (
        !isResearchIdentifier(id) ||
        !isResearchTimestamp(activatedAt) ||
        shadowEvaluation?.eligibleForPromotion !== true ||
        shadowEvaluation.modelId !== id ||
        !isResearchTimestamp(shadowEvaluation.evaluatedAt) ||
        shadowEvaluation.evaluatedAt > activatedAt
      ) {
        throw new ResearchDataError(
          'Activation requires a timestamp and a passing prospective shadow evaluation.',
        );
      }
      return runWriteOperation(async () => {
        await initialize();
        const transaction = await getResearchWriteTransaction(client);
        try {
          const stored = await transaction.execute({
            sql: `SELECT payload, retired_at FROM model_artifacts
              LEFT JOIN model_retirements USING(model_id) WHERE model_id = ?`,
            args: [id],
          });
          if (!stored.rows.length)
            throw new ResearchDataError('The model artifact must be saved before activation.', 404);
          if (stored.rows[0].retired_at != null)
            throw new ResearchDataError('A retired model cannot be activated again.', 409);
          const artifact = JSON.parse(stored.rows[0].payload);
          if (activatedAt <= artifact.trainedAt)
            throw new ResearchDataError('Model activation must follow training.');
          const current = await transaction.execute(`SELECT payload, activated_at, retired_at
            FROM model_artifacts JOIN model_activations USING(model_id)
            LEFT JOIN model_retirements USING(model_id)
            ORDER BY model_activations.sequence DESC LIMIT 1`);
          const latest = current.rows[0];
          if (latest && activatedAt < Number(latest.activated_at))
            throw new ResearchDataError('Activation cannot replace a newer activation.', 409);
          if (
            artifact.version === EARLY_MODEL_VERSION &&
            latest &&
            latest.retired_at == null &&
            JSON.parse(latest.payload).version !== EARLY_MODEL_VERSION
          ) {
            throw new ResearchDataError(
              'An early model cannot replace the full learned model.',
              409,
            );
          }
          await transaction.execute({
            sql: 'INSERT INTO model_activations(model_id, activated_at, evaluation) VALUES (?, ?, ?)',
            args: [id, activatedAt, getCanonicalResearchJson(shadowEvaluation)],
          });
          await transaction.commit();
          return { ...artifact, activation: { modelId: id, activatedAt, shadowEvaluation } };
        } finally {
          transaction.close();
        }
      });
    },
    async retireModelArtifact(id, { retiredAt, reason } = {}) {
      if (
        !isResearchIdentifier(id) ||
        !isResearchTimestamp(retiredAt) ||
        typeof reason !== 'string' ||
        !reason.trim() ||
        reason.length > 2000
      ) {
        throw new ResearchDataError(
          'Model retirement requires an identifier, timestamp and reason.',
        );
      }
      return runWriteOperation(async () => {
        await initialize();
        const transaction = await getResearchWriteTransaction(client);
        try {
          const stored = await transaction.execute({
            sql: `SELECT payload, retired_at, model_retirements.reason AS retirement_reason,
              EXISTS(SELECT 1 FROM model_activations WHERE model_activations.model_id = model_artifacts.model_id) AS was_active
              FROM model_artifacts LEFT JOIN model_retirements USING(model_id) WHERE model_id = ?`,
            args: [id],
          });
          if (!stored.rows.length)
            throw new ResearchDataError('The model artifact must be saved before retirement.', 404);
          const artifact = getStoredModel(stored.rows[0]);
          if (retiredAt <= artifact.trainedAt)
            throw new ResearchDataError('Model retirement must follow training.');
          const activated = await transaction.execute({
            sql: 'SELECT MAX(activated_at) AS latest_activation FROM model_activations WHERE model_id = ?',
            args: [id],
          });
          if (retiredAt < Number(activated.rows[0].latest_activation ?? 0))
            throw new ResearchDataError('Model retirement cannot precede its activation.');
          if (!artifact.retirement) {
            await transaction.execute({
              sql: 'INSERT INTO model_retirements(model_id, retired_at, reason) VALUES (?, ?, ?)',
              args: [id, retiredAt, reason.trim()],
            });
          }
          await transaction.commit();
          return {
            ...artifact,
            retirement: artifact.retirement ?? {
              retiredAt,
              reason: reason.trim(),
              wasActive: activated.rows[0].latest_activation != null,
            },
          };
        } finally {
          transaction.close();
        }
      });
    },
    async getResearchStatus() {
      await initialize();
      const result = await client.execute(`SELECT
        (SELECT COUNT(*) FROM evidence_events) AS evidence_count,
        (SELECT COUNT(DISTINCT forecast_id) FROM forecast_snapshots) AS forecast_count,
        (SELECT COUNT(*) FROM forecast_snapshots) AS snapshot_count,
        (SELECT MAX(recorded_at) FROM evidence_events) AS last_recorded_at,
        (SELECT COUNT(*) FROM model_artifacts) AS model_count`);
      const counts = result.rows[0];
      const activeModel = await repository.getActiveModelArtifact();
      const writeAvailability = await runWriteOperation(getWriteAvailability);
      return {
        available: true,
        ...writeAvailability,
        mode,
        evidenceCount: Number(counts.evidence_count),
        forecastCount: Number(counts.forecast_count),
        snapshotCount: Number(counts.snapshot_count),
        lastRecordedAt: counts.last_recorded_at == null ? null : Number(counts.last_recorded_at),
        modelCount: Number(counts.model_count),
        activeModelId: activeModel?.id ?? null,
      };
    },
    async acquireLearningLease({ ownerId, now, expiresAt }) {
      if (
        !isResearchIdentifier(ownerId) ||
        !isResearchTimestamp(now) ||
        !isResearchTimestamp(expiresAt) ||
        expiresAt <= now ||
        expiresAt - now > 120_000
      ) {
        throw new ResearchDataError(
          'A learning lease requires an owner and an expiry within two minutes.',
        );
      }
      await initialize();
      const result = await client.execute({
        sql: `INSERT INTO research_leases(lease_key, owner_id, expires_at) VALUES ('training', ?, ?)
          ON CONFLICT(lease_key) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at
          WHERE research_leases.expires_at <= ?`,
        args: [ownerId, expiresAt, now],
      });
      return result.rowsAffected === 1;
    },
    async releaseLearningLease(ownerId) {
      if (!isResearchIdentifier(ownerId))
        throw new ResearchDataError('Invalid learning lease owner.');
      await initialize();
      await client.execute({
        sql: "DELETE FROM research_leases WHERE lease_key = 'training' AND owner_id = ?",
        args: [ownerId],
      });
    },
  };
  repository.saveModelArtifact = repository.writeModelArtifact;
  repository.getActiveModel = repository.getActiveModelArtifact;
  return repository;
}

let defaultRepository;
async function getDefaultRepository() {
  if (!defaultRepository) {
    defaultRepository = (async () => {
      const configuration = getResearchDatabaseConfiguration();
      if (configuration.mode === 'local-database')
        await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
      return createResearchRepository({
        client: createClient(configuration),
        mode: configuration.mode,
      });
    })().catch((error) => {
      defaultRepository = null;
      throw error;
    });
  }
  return defaultRepository;
}

export const persistEvidenceRows = async (rows) =>
  (await getDefaultRepository()).persistEvidenceRows(rows);
export const persistForecastSnapshots = async (rows) =>
  (await getDefaultRepository()).persistForecastSnapshots(rows);
export const readStoredEvidence = async (parameters) =>
  (await getDefaultRepository()).readStoredEvidence(parameters);
export const readStoredForecasts = async (parameters) =>
  (await getDefaultRepository()).readStoredForecasts(parameters);
export const readForecastSnapshotEvents = async (parameters) =>
  (await getDefaultRepository()).readForecastSnapshotEvents(parameters);
export const getResearchRows = async (parameters) =>
  (await getDefaultRepository()).getResearchRows(parameters);
export const getLearningEvidenceRows = async (parameters) =>
  (await getDefaultRepository()).getLearningEvidenceRows(parameters);
export const getResearchStatus = async () => (await getDefaultRepository()).getResearchStatus();
export const writeModelArtifact = async (artifact) =>
  (await getDefaultRepository()).writeModelArtifact(artifact);
export const saveModelArtifact = writeModelArtifact;
export const readModelArtifact = async (id) => (await getDefaultRepository()).readModelArtifact(id);
export const readModelArtifacts = async () => (await getDefaultRepository()).readModelArtifacts();
export const getActiveModelArtifact = async () =>
  (await getDefaultRepository()).getActiveModelArtifact();
export const getActiveModel = getActiveModelArtifact;
export const activateModelArtifact = async (id, activation) =>
  (await getDefaultRepository()).activateModelArtifact(id, activation);
export const retireModelArtifact = async (id, retirement) =>
  (await getDefaultRepository()).retireModelArtifact(id, retirement);
export const acquireLearningLease = async (parameters) =>
  (await getDefaultRepository()).acquireLearningLease(parameters);
export const releaseLearningLease = async (ownerId) =>
  (await getDefaultRepository()).releaseLearningLease(ownerId);
