import 'server-only';
import { createHash } from 'node:crypto';
import {
  runResearchSchemaStatements,
  runResearchConnectionOperation,
} from '../research.connection';
import { getCanonicalResearchJson, ResearchDataError } from '../research.validation';
import { isKalshiContract } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';

const STAGES = ['claim', 'initial', 'delay-claim', 'execution'];
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Append-only book observations, separate from every candidate's simulated account. */
export function createPatternResearchRepository({ client }) {
  let ready;
  const initialize = () =>
    (ready ??= runResearchSchemaStatements(client, [
      `CREATE TABLE IF NOT EXISTS pattern_paper_observations (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL, stage TEXT NOT NULL,
      content_hash TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(ticker, stage)
    )`,
    ]).catch((error) => {
      ready = null;
      throw error;
    }));
  function parse(row) {
    if (hash(row.payload) !== row.content_hash)
      throw new ResearchDataError('Pattern book observations failed their integrity check.', 409);
    return JSON.parse(row.payload);
  }
  async function readStages(ticker) {
    await initialize();
    return runResearchConnectionOperation(client, async () => {
      const result = await client.execute({
        sql: 'SELECT content_hash, payload FROM pattern_paper_observations WHERE ticker = ?',
        args: [ticker],
      });
      return Object.fromEntries(
        result.rows.map((row) => {
          const value = parse(row);
          return [value.stage, value];
        }),
      );
    });
  }
  async function append(value, claim = false) {
    if (
      !STAGES.includes(value?.stage) ||
      !isKalshiContract(value.contract) ||
      value.ticker !== value.contract.ticker ||
      value.id !== `${value.ticker}:${value.stage}` ||
      !Number.isSafeInteger(value.recordedAt) ||
      value.recordedAt <= 0
    )
      throw new ResearchDataError('Invalid pattern book observation.');
    const payload = getCanonicalResearchJson(value, 2 * 1024 * 1024);
    await initialize();
    return runResearchConnectionOperation(client, async () => {
      const result = await client.execute({
        sql: 'INSERT OR IGNORE INTO pattern_paper_observations(id,ticker,stage,content_hash,payload) VALUES (?,?,?,?,?)',
        args: [value.id, value.ticker, value.stage, hash(payload), payload],
      });
      if (result.rowsAffected) return true;
      const saved = await client.execute({
        sql: 'SELECT content_hash, payload FROM pattern_paper_observations WHERE id = ?',
        args: [value.id],
      });
      parse(saved.rows[0]);
      if (!claim && saved.rows[0].payload !== payload)
        throw new ResearchDataError('A pattern book observation cannot be overwritten.', 409);
      return false;
    });
  }
  return {
    readStages,
    claim: (value) => append(value, true),
    save: (value) => append(value),
    async readPaperObservations() {
      await initialize();
      return runResearchConnectionOperation(client, async () => {
        const result = await client.execute(
          'SELECT content_hash,payload FROM pattern_paper_observations ORDER BY ticker,stage',
        );
        return combinePatternPaperObservations(result.rows.map(parse));
      });
    },
  };
}

export function combinePatternPaperObservations(rows) {
  const groups = new Map();
  for (const row of rows) {
    const stages = groups.get(row.ticker) ?? {};
    stages[row.stage] = row;
    groups.set(row.ticker, stages);
  }
  return [...groups.values()]
    .filter((stages) => stages.claim)
    .map((stages) => ({
      ...stages.claim,
      source: 'pattern-independent',
      initial: stages.initial ?? null,
      execution: stages.execution ?? null,
    }));
}
