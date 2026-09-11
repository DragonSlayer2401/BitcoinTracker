import { KALSHI_OUTCOME_DEFINITION } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import { getResearchWriteTransaction } from './research.connection';

export const KALSHI_RESEARCH_MIGRATION = 'kalshi-only-research-v1';

/** User-requested removal of the old Coinbase research, preserving every Kalshi record. */
export async function migrateResearchToKalshi(client) {
  const transaction = await getResearchWriteTransaction(client);
  try {
    const applied = await transaction.execute({
      sql: 'SELECT migration_id FROM research_migrations WHERE migration_id = ?',
      args: [KALSHI_RESEARCH_MIGRATION],
    });
    if (applied.rows.length) {
      await transaction.commit();
      return { applied: false, removed: {} };
    }
    const removed = {};
    const activations = await transaction.execute({
      sql: `DELETE FROM model_activations WHERE model_id NOT IN (
        SELECT model_id FROM model_artifacts WHERE json_extract(payload, '$.outcomeDefinition') = ?
      )`,
      args: [KALSHI_OUTCOME_DEFINITION],
    });
    removed.model_activations = activations.rowsAffected;
    for (const table of ['evidence_events', 'forecast_snapshots', 'model_artifacts']) {
      const result = await transaction.execute({
        sql: `DELETE FROM ${table} WHERE COALESCE(json_extract(payload, '$.outcomeDefinition'), '') <> ?`,
        args: [KALSHI_OUTCOME_DEFINITION],
      });
      removed[table] = result.rowsAffected;
      // An older tab/server/collector must not repopulate a migrated database.
      await transaction.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_kalshi_only
        BEFORE INSERT ON ${table}
        WHEN COALESCE(json_extract(NEW.payload, '$.outcomeDefinition'), '') <> '${KALSHI_OUTCOME_DEFINITION}'
        BEGIN SELECT RAISE(ABORT, 'Only Kalshi contract research can be stored'); END`);
    }
    await transaction.execute({
      sql: 'INSERT INTO research_migrations(migration_id, applied_at, details) VALUES (?, ?, ?)',
      args: [KALSHI_RESEARCH_MIGRATION, Date.now(), JSON.stringify({ removed })],
    });
    await transaction.commit();
    return { applied: true, removed };
  } finally {
    transaction.close();
  }
}
