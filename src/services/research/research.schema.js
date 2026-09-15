import 'server-only';
import { runResearchSchemaStatements } from './research.connection';
import { KALSHI_RESEARCH_MIGRATION, migrateResearchToKalshi } from './research.migration';
import { ResearchDataError } from './research.validation';

const schemaStatements = [
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
  `CREATE TABLE IF NOT EXISTS research_input_snapshots (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL UNIQUE,
    forecast_id TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES evidence_events(event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS research_forward_labels (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id TEXT NOT NULL UNIQUE,
    snapshot_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES research_input_snapshots(snapshot_id)
  )`,
  'CREATE INDEX IF NOT EXISTS research_labels_snapshot ON research_forward_labels(snapshot_id)',
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
  `CREATE TABLE IF NOT EXISTS model_retirements (
    model_id TEXT PRIMARY KEY,
    retired_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    FOREIGN KEY(model_id) REFERENCES model_artifacts(model_id)
  )`,
  `CREATE TABLE IF NOT EXISTS research_leases (
    lease_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

// Derive the readiness checks from the schema so new columns cannot be omitted.
const requiredSchemaObjects = schemaStatements.map((statement) => {
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

async function hasInitializedSchema(client) {
  const schema = await client.execute(
    "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  const existingObjects = new Map(schema.rows.map((row) => [row.name, row.type]));
  const hasMissingObjects = requiredSchemaObjects.some(
    (item) => existingObjects.get(item.name) !== item.type,
  );
  const hasMissingGuards = guardedTables.some(
    (table) => existingObjects.get(`${table}_kalshi_only`) !== 'trigger',
  );
  if (hasMissingObjects || hasMissingGuards) return false;

  const migration = await client.execute({
    sql: 'SELECT migration_id FROM research_migrations WHERE migration_id = ?',
    args: [KALSHI_RESEARCH_MIGRATION],
  });
  if (!migration.rows.length) return false;

  for (const table of requiredSchemaObjects.filter((item) => item.type === 'table')) {
    const result = await client.execute(`PRAGMA table_info(${table.name})`);
    const existingColumns = new Set(result.rows.map((row) => row.name));
    if (table.columns.some((column) => !existingColumns.has(column))) return false;
  }
  return true;
}

export async function initializeResearchSchema(client) {
  // A current archive remains readable while a database viewer holds a write lock.
  if (await hasInitializedSchema(client)) return;

  await runResearchSchemaStatements(client, schemaStatements);
  await migrateResearchToKalshi(client);
  if (!(await hasInitializedSchema(client))) {
    throw new ResearchDataError(
      'Research storage has an incomplete schema. Existing data is retained; restore the missing schema objects before recording more evidence.',
      503,
    );
  }
}
