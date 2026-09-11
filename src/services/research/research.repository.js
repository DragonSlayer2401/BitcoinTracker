import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { KALSHI_RESEARCH_MIGRATION, migrateResearchToKalshi } from './research.migration';
import { getResearchWriteTransaction, runResearchSchemaStatements } from './research.connection';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  getResearchPage,
  isResearchIdentifier,
  isResearchTimestamp,
  validateEvidenceRow,
  validateForecastSnapshot,
  validateResearchBatch,
} from './research.validation';

const statements = [
  `CREATE TABLE IF NOT EXISTS research_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    details TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    forecast_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS evidence_forecast ON evidence_events(forecast_id)',
  "CREATE INDEX IF NOT EXISTS evidence_event_kind ON evidence_events(json_extract(payload, '$.event'), sequence)",
  `CREATE TABLE IF NOT EXISTS forecast_snapshots (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL UNIQUE,
    forecast_id TEXT NOT NULL,
    state TEXT NOT NULL,
    state_rank INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS forecast_identity ON forecast_snapshots(forecast_id)',
  `CREATE TABLE IF NOT EXISTS model_artifacts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL UNIQUE,
    saved_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS model_activations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    evaluation TEXT NOT NULL,
    FOREIGN KEY(model_id) REFERENCES model_artifacts(model_id)
  )`,
  `CREATE TABLE IF NOT EXISTS research_leases (
    lease_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];
const schemaObjects = statements.map((statement) => {
  const [, type, name] = statement.match(/CREATE (TABLE|INDEX) IF NOT EXISTS ([a-z_]+)/);
  return {
    name,
    type: type.toLowerCase(),
    columns: [...statement.matchAll(/^\s*([a-z_]+)\s+(?:TEXT|INTEGER)\b/gm)].map(
      (match) => match[1],
    ),
  };
});
const guardedTables = ['evidence_events', 'forecast_snapshots', 'model_artifacts'];
const stateRanks = {
  analyzing: 0,
  pending: 1,
  'awaiting-settlement': 2,
  withheld: 2,
  unobserved: 3,
  resolved: 4,
};
const getHash = (json) => createHash('sha256').update(json).digest('hex');

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

export function createResearchRepository({ client, mode = 'local-database' }) {
  let ready;
  let pendingWrite = Promise.resolve();
  function runWriteOperation(operation) {
    const result = pendingWrite.then(operation);
    pendingWrite = result.catch(() => {});
    return result;
  }
  async function hasInitializedSchema() {
    const schema = await client.execute(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    );
    const objects = new Map(schema.rows.map((row) => [row.name, row.type]));
    if (
      schemaObjects.some((item) => objects.get(item.name) !== item.type) ||
      guardedTables.some((table) => objects.get(`${table}_kalshi_only`) !== 'trigger')
    )
      return false;
    const migration = await client.execute({
      sql: 'SELECT migration_id FROM research_migrations WHERE migration_id = ?',
      args: [KALSHI_RESEARCH_MIGRATION],
    });
    if (!migration.rows.length) return false;
    for (const table of schemaObjects.filter((item) => item.type === 'table')) {
      const result = await client.execute(`PRAGMA table_info(${table.name})`);
      const columns = new Set(result.rows.map((row) => row.name));
      if (table.columns.some((column) => !columns.has(column))) return false;
    }
    return true;
  }
  async function initialize() {
    if (!ready) {
      ready = (async () => {
        // Existing archives can be read while a database viewer holds a transaction.
        // Require the current schema and migration before avoiding startup write locks.
        if (await hasInitializedSchema()) return;
        await runResearchSchemaStatements(client, statements);
        await migrateResearchToKalshi(client);
        if (!(await hasInitializedSchema()))
          throw new ResearchDataError(
            'Research storage has an incomplete schema. Existing data is retained; restore the missing schema objects before recording more evidence.',
            503,
          );
      })().catch((error) => {
        ready = null;
        throw error;
      });
    }
    await ready;
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

  async function appendEvents(table, entries, getEntry) {
    return runWriteOperation(async () => {
      validateResearchBatch(entries);
      const prepared = entries.map(getEntry);
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      let inserted = 0;
      let duplicates = 0;
      try {
        for (const entry of prepared) {
          const identityColumn = table === 'evidence_events' ? 'event_id' : 'snapshot_id';
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
          if (table === 'forecast_snapshots') {
            const previous = await transaction.execute({
              sql: 'SELECT payload FROM forecast_snapshots WHERE forecast_id = ?',
              args: [entry.row.id],
            });
            for (const item of previous.rows) {
              const original = JSON.parse(item.payload);
              const terminalStates = ['withheld', 'unobserved', 'resolved'];
              if (
                (terminalStates.includes(original.status) &&
                  terminalStates.includes(entry.row.status) &&
                  original.status !== entry.row.status) ||
                (original.status === 'withheld' && entry.row.aboveProbability != null) ||
                (entry.row.status === 'withheld' && original.aboveProbability != null)
              ) {
                throw new ResearchDataError(
                  'A forecast cannot replace a previously saved final outcome or publication decision.',
                  409,
                );
              }
              const immutableFields = [
                'target',
                'expiresAt',
                'startsAt',
                'outcomeDefinition',
                'analysis',
                'kalshiMarket',
              ];
              if (original.aboveProbability != null && entry.row.aboveProbability != null) {
                immutableFields.push(
                  'createdAt',
                  'price',
                  'aboveProbability',
                  'belowProbability',
                  'direction',
                  'calculationMode',
                  'learning',
                  'modelVersion',
                  'kalshi',
                );
              }
              if (
                immutableFields.some(
                  (field) =>
                    getCanonicalResearchJson(original[field] ?? null) !==
                    getCanonicalResearchJson(entry.row[field] ?? null),
                )
              ) {
                throw new ResearchDataError(
                  'A forecast snapshot cannot change its original target, deadline, or captured prediction.',
                  409,
                );
              }
            }
            await transaction.execute({
              sql: 'INSERT INTO forecast_snapshots(snapshot_id, forecast_id, state, state_rank, created_at, content_hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
              args: [
                entry.id,
                entry.row.id,
                entry.row.status,
                stateRanks[entry.row.status],
                entry.row.createdAt,
                entry.hash,
                entry.json,
              ],
            });
          } else {
            await transaction.execute({
              sql: 'INSERT INTO evidence_events(event_id, forecast_id, recorded_at, content_hash, payload) VALUES (?, ?, ?, ?, ?)',
              args: [entry.id, entry.row.forecastId, entry.row.recordedAt, entry.hash, entry.json],
            });
          }
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
        const json = validateEvidenceRow(row);
        return { row, id: row.eventId, json, hash: getHash(json) };
      });
    },
    persistForecastSnapshots(rows) {
      return appendEvents('forecast_snapshots', rows, (row) => {
        const json = validateForecastSnapshot(row);
        return { row, id: `${row.id}:${row.status}`, json, hash: getHash(json) };
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
        if (
          !isResearchIdentifier(artifact?.id) ||
          !isResearchIdentifier(artifact?.version) ||
          !isResearchTimestamp(artifact?.trainedAt)
        )
          throw new ResearchDataError(
            'Model artifacts require a stable identifier, version, and training timestamp.',
          );
        if (artifact.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION)
          throw new ResearchDataError('Only Kalshi model artifacts can be stored.');
        const json = getCanonicalResearchJson(artifact, 2 * 1024 * 1024);
        await initialize();
        const transaction = await client.transaction('write');
        try {
          const existing = await transaction.execute({
            sql: 'SELECT content_hash FROM model_artifacts WHERE model_id = ?',
            args: [artifact.id],
          });
          if (existing.rows.length && existing.rows[0].content_hash !== getHash(json))
            throw new ResearchDataError(
              'A model version cannot overwrite an existing artifact.',
              409,
            );
          if (!existing.rows.length)
            await transaction.execute({
              sql: 'INSERT INTO model_artifacts(model_id, saved_at, content_hash, payload) VALUES (?, ?, ?, ?)',
              args: [artifact.id, Date.now(), getHash(json), json],
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
        sql: 'SELECT payload FROM model_artifacts WHERE model_id = ?',
        args: [id],
      });
      return result.rows.length ? JSON.parse(result.rows[0].payload) : null;
    },
    async readModelArtifacts() {
      await initialize();
      const result = await client.execute('SELECT payload FROM model_artifacts ORDER BY sequence');
      return result.rows.map((row) => JSON.parse(row.payload));
    },
    async getActiveModelArtifact() {
      await initialize();
      const result = await client.execute(
        'SELECT payload, model_id, activated_at, evaluation FROM model_artifacts JOIN model_activations USING(model_id) ORDER BY model_activations.sequence DESC LIMIT 1',
      );
      if (!result.rows.length) return null;
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
      const artifact = await repository.readModelArtifact(id);
      if (!artifact)
        throw new ResearchDataError('The model artifact must be saved before activation.', 404);
      if (activatedAt <= artifact.trainedAt)
        throw new ResearchDataError('Model activation must follow training.');
      await client.execute({
        sql: 'INSERT INTO model_activations(model_id, activated_at, evaluation) VALUES (?, ?, ?)',
        args: [id, activatedAt, getCanonicalResearchJson(shadowEvaluation)],
      });
      return { ...artifact, activation: { modelId: id, activatedAt, shadowEvaluation } };
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
export const acquireLearningLease = async (parameters) =>
  (await getDefaultRepository()).acquireLearningLease(parameters);
export const releaseLearningLease = async (ownerId) =>
  (await getDefaultRepository()).releaseLearningLease(ownerId);
