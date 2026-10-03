import 'server-only';
import { createHash } from 'node:crypto';
import { getResearchWriteTransaction, runResearchSchemaStatements } from '../research.connection';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  MAXIMUM_RESEARCH_INPUT_BYTES,
  isResearchIdentifier,
  isResearchTimestamp,
} from '../research.validation';
import {
  getPaperPortfolio,
  isPaperTradingPolicy,
  isPaperDecision,
  isPaperExecutionEvent,
  isPaperSettlementEvent,
} from '@/features/BitcoinTracker/features/PaperTrading/utils/paperTrading.utils';

const hash = (json) => createHash('sha256').update(json).digest('hex');
const MAXIMUM_STATE_RECORDS = 10_000;
const emptyState = () => ({ policy: null, startedAt: null, decisions: [], events: [] });
const same = (left, right) => getCanonicalResearchJson(left) === getCanonicalResearchJson(right);
const close = (left, right) =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-8;

function reject(message, code = 'PAPER_RECORD_INVALID', status = 400) {
  throw Object.assign(new ResearchDataError(message, status), { code });
}

function prepare(value, maximumBytes) {
  const json = getCanonicalResearchJson(value, maximumBytes);
  return { value: JSON.parse(json), json, hash: hash(json) };
}

function parseStored(row) {
  if (!row) return null;
  if (hash(row.payload) !== row.content_hash)
    reject(
      'Saved paper-trading evidence failed its integrity check.',
      'PAPER_STORAGE_CORRUPT',
      409,
    );
  return JSON.parse(row.payload);
}

function checkDuplicate(row, entry) {
  if (!row) return null;
  const original = parseStored(row);
  if (row.content_hash !== entry.hash || row.payload !== entry.json)
    reject('A saved paper-trading record cannot be changed.', 'PAPER_RECORD_CONFLICT', 409);
  return original;
}

const statements = [
  `CREATE TABLE IF NOT EXISTS paper_policies (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, content_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS paper_decisions (
    id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, ticker TEXT NOT NULL,
    decided_at INTEGER NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
    summary_hash TEXT NOT NULL, summary_payload TEXT NOT NULL,
    UNIQUE(policy_id, ticker), FOREIGN KEY(policy_id) REFERENCES paper_policies(id)
  )`,
  `CREATE TABLE IF NOT EXISTS paper_events (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fill', 'no-fill', 'settlement')),
    recorded_at INTEGER NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
    FOREIGN KEY(decision_id) REFERENCES paper_decisions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS paper_execution_attempts (
    decision_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL, payload TEXT NOT NULL,
    FOREIGN KEY(decision_id) REFERENCES paper_decisions(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS paper_execution_once
    ON paper_events(decision_id) WHERE kind IN ('fill', 'no-fill')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS paper_settlement_once
    ON paper_events(decision_id) WHERE kind = 'settlement'`,
  `CREATE INDEX IF NOT EXISTS paper_decision_policy_time
    ON paper_decisions(policy_id, decided_at, id)`,
  `CREATE TABLE IF NOT EXISTS paper_heartbeats (
    policy_id TEXT PRIMARY KEY, heartbeat_at INTEGER NOT NULL, payload TEXT NOT NULL,
    FOREIGN KEY(policy_id) REFERENCES paper_policies(id)
  )`,
  ...['paper_policies', 'paper_decisions', 'paper_events', 'paper_execution_attempts'].flatMap(
    (table) =>
      ['UPDATE', 'DELETE'].map(
        (operation) => `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Paper-trading evidence is append-only.'); END`,
      ),
  ),
];

/** Preserve simulated orders separately from forecasts and reserve cash under one write lock. */
export function createPaperTradingRepository({ client, now = Date.now }) {
  let initialization;
  let pendingWrite = Promise.resolve();

  async function initialize() {
    if (!initialization)
      initialization = runResearchSchemaStatements(client, statements).catch((error) => {
        initialization = null;
        throw error;
      });
    await initialization;
  }

  function write(operation) {
    const result = pendingWrite.then(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const value = await operation(transaction);
        await transaction.commit();
        return value;
      } finally {
        transaction.close();
      }
    });
    pendingWrite = result.catch(() => {});
    return result;
  }

  async function readPolicy(transaction, policyId) {
    const result = await transaction.execute({
      sql: 'SELECT started_at, content_hash, payload FROM paper_policies WHERE id = ?',
      args: [policyId],
    });
    const row = result.rows[0];
    return row ? { policy: parseStored(row), startedAt: Number(row.started_at) } : null;
  }

  async function readStateFrom(
    transaction,
    policyId,
    { includeInputs = false, includeAttempts = false } = {},
  ) {
    const saved = await readPolicy(transaction, policyId);
    if (!saved) return emptyState();
    const decisions = await transaction.execute({
      // The original replay stays immutable in storage. Routine balances and reports do not
      // load its potentially large BRTI history; readDecision provides the original archive.
      sql: `SELECT ${includeInputs ? 'content_hash, payload' : 'summary_hash AS content_hash, summary_payload AS payload'}
        FROM paper_decisions WHERE policy_id = ? ORDER BY decided_at, id LIMIT ?`,
      args: [policyId, MAXIMUM_STATE_RECORDS + 1],
    });
    const events = await transaction.execute({
      sql: `SELECT event.content_hash, event.payload FROM paper_events AS event
        JOIN paper_decisions AS decision ON decision.id = event.decision_id
        WHERE decision.policy_id = ? ORDER BY event.recorded_at, event.id LIMIT ?`,
      args: [policyId, MAXIMUM_STATE_RECORDS + 1],
    });
    if (decisions.rows.length > MAXIMUM_STATE_RECORDS || events.rows.length > MAXIMUM_STATE_RECORDS)
      reject(
        'Paper history exceeds the report limit; a paginated full-ledger report is required.',
        'PAPER_HISTORY_LIMIT',
        413,
      );
    const state = {
      ...saved,
      decisions: decisions.rows.map(parseStored),
      events: events.rows.map(parseStored),
    };
    if (includeAttempts) {
      const attempts = await transaction.execute({
        sql: `SELECT attempt.content_hash, attempt.payload FROM paper_execution_attempts AS attempt
          JOIN paper_decisions AS decision ON decision.id = attempt.decision_id
          WHERE decision.policy_id = ? ORDER BY attempt.requested_at, attempt.decision_id LIMIT ?`,
        args: [policyId, MAXIMUM_STATE_RECORDS + 1],
      });
      if (attempts.rows.length > MAXIMUM_STATE_RECORDS)
        reject('Paper execution history exceeds the audit limit.', 'PAPER_HISTORY_LIMIT', 413);
      state.attempts = attempts.rows.map(parseStored);
    }
    return state;
  }

  async function ensurePolicy(policy, startedAt) {
    if (!isPaperTradingPolicy(policy) || !isResearchTimestamp(startedAt) || startedAt > now())
      reject('A paper-trading run needs a valid frozen policy and start time.');
    const entry = prepare(policy);
    return write(async (transaction) => {
      const stored = await readPolicy(transaction, policy.id);
      if (stored) {
        if (!same(stored.policy, entry.value))
          reject('A paper policy cannot change after enrollment.', 'PAPER_RECORD_CONFLICT', 409);
        return stored;
      }
      await transaction.execute({
        sql: 'INSERT INTO paper_policies(id, started_at, content_hash, payload) VALUES (?, ?, ?, ?)',
        args: [policy.id, startedAt, entry.hash, entry.json],
      });
      return { policy: entry.value, startedAt };
    });
  }

  async function readState(policyId, options) {
    if (!isResearchIdentifier(policyId)) reject('A paper policy identity is required.');
    await initialize();
    const transaction = await client.transaction('read');
    try {
      return await readStateFrom(transaction, policyId, options);
    } finally {
      transaction.close();
    }
  }

  async function readDecision(id) {
    if (!isResearchIdentifier(id)) reject('A paper decision identity is required.');
    await initialize();
    const result = await client.execute({
      sql: 'SELECT content_hash, payload FROM paper_decisions WHERE id = ?',
      args: [id],
    });
    return parseStored(result.rows[0]);
  }

  async function saveDecision(decision) {
    const entry = prepare(decision, MAXIMUM_RESEARCH_INPUT_BYTES);
    if (!isPaperDecision(entry.value)) reject('Invalid paper-trading decision.');
    const { researchInputSnapshot: _archive, ...forecast } = entry.value.forecast;
    const summary = prepare({ ...entry.value, forecast });
    return write(async (transaction) => {
      const existing = await transaction.execute({
        sql: 'SELECT content_hash, payload FROM paper_decisions WHERE id = ?',
        args: [entry.value.id],
      });
      const duplicate = checkDuplicate(existing.rows[0], entry);
      if (duplicate) return duplicate;
      const state = await readStateFrom(transaction, entry.value.policyId);
      const checkedAt = now();
      if (!state.policy)
        reject('The paper policy has not started.', 'PAPER_POLICY_NOT_STARTED', 409);
      if (
        !same(state.policy, entry.value.policy) ||
        entry.value.id !== `${state.policy.id}:${entry.value.contract.ticker}` ||
        entry.value.decidedAt < state.startedAt ||
        entry.value.decidedAt > checkedAt
      )
        reject('The decision must use its original policy and a causal capture time.');
      if (entry.value.status === 'intent') {
        const portfolio = getPaperPortfolio({ ...state, now: checkedAt });
        const reserve = entry.value.reservedCapital;
        const supplied = entry.value.portfolio;
        const unchanged = ['cash', 'openRisk', 'dailyRealizedPnl'].every((name) =>
          close(supplied?.[name], portfolio[name]),
        );
        if (
          !unchanged ||
          !Number.isFinite(reserve) ||
          reserve <= 0 ||
          portfolio.cash + 1e-8 < reserve ||
          portfolio.openRisk + reserve > state.policy.maxOpenRisk + 1e-8 ||
          portfolio.dailyRealizedPnl <= -state.policy.maxDailyLoss
        )
          reject(
            'Paper-trading capital or limits changed; refresh the portfolio before deciding.',
            'PAPER_CAPITAL_CHANGED',
            409,
          );
      }
      await transaction.execute({
        sql: `INSERT INTO paper_decisions(id, policy_id, ticker, decided_at, content_hash, payload, summary_hash, summary_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.value.id,
          entry.value.policyId,
          entry.value.contract.ticker,
          entry.value.decidedAt,
          entry.hash,
          entry.json,
          summary.hash,
          summary.json,
        ],
      });
      return entry.value;
    });
  }

  async function saveEvent(event) {
    const entry = prepare(event);
    if (
      !isResearchIdentifier(entry.value.id) ||
      !isResearchIdentifier(entry.value.decisionId) ||
      !isResearchTimestamp(entry.value.recordedAt) ||
      !['fill', 'no-fill', 'settlement'].includes(entry.value.kind)
    )
      reject('Invalid paper-trading event.');
    return write(async (transaction) => {
      const existing = await transaction.execute({
        sql: 'SELECT content_hash, payload FROM paper_events WHERE id = ?',
        args: [entry.value.id],
      });
      const duplicate = checkDuplicate(existing.rows[0], entry);
      if (duplicate) return duplicate;
      const result = await transaction.execute({
        sql: 'SELECT content_hash, payload FROM paper_decisions WHERE id = ?',
        args: [entry.value.decisionId],
      });
      const decision = parseStored(result.rows[0]);
      if (
        !decision ||
        decision.status !== 'intent' ||
        entry.value.recordedAt < decision.decidedAt ||
        entry.value.recordedAt > now()
      )
        reject('An event needs its saved intent and causal observation time.');
      const executionRows = await transaction.execute({
        sql: "SELECT content_hash, payload FROM paper_events WHERE decision_id = ? AND kind IN ('fill', 'no-fill')",
        args: [decision.id],
      });
      const execution = parseStored(executionRows.rows[0]);
      const settlement = entry.value.kind === 'settlement';
      if (
        entry.value.id !== `${decision.id}:${settlement ? 'settlement' : 'execution'}` ||
        (settlement
          ? execution?.kind !== 'fill' ||
            entry.value.recordedAt < execution.recordedAt ||
            !isPaperSettlementEvent(entry.value, decision, execution)
          : execution !== null || !isPaperExecutionEvent(entry.value, decision))
      )
        reject('The paper event does not match its immutable decision and execution.');
      if (!settlement) {
        const attemptRows = await transaction.execute({
          sql: 'SELECT content_hash, payload FROM paper_execution_attempts WHERE decision_id = ?',
          args: [decision.id],
        });
        const attempt = parseStored(attemptRows.rows[0]);
        const hasCausalAttempt =
          attempt &&
          entry.value.recordedAt >= attempt.requestedAt &&
          isResearchTimestamp(entry.value.book?.requestedAt) &&
          entry.value.book.requestedAt >= attempt.requestedAt;
        if (
          (entry.value.kind === 'fill' && !hasCausalAttempt) ||
          (entry.value.kind === 'no-fill' &&
            entry.value.book !== null &&
            !hasCausalAttempt &&
            entry.value.recordedAt <= decision.decidedAt + decision.policy.maximumFillDelayMs)
        )
          reject('An execution needs its first durable book-request attempt.');
      }
      await transaction.execute({
        sql: `INSERT INTO paper_events(id, decision_id, kind, recorded_at, content_hash, payload)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          entry.value.id,
          decision.id,
          entry.value.kind,
          entry.value.recordedAt,
          entry.hash,
          entry.json,
        ],
      });
      return entry.value;
    });
  }

  /** Claim before the network request; a restart never gets another chance at a better book. */
  async function claimExecutionAttempt({ decisionId, requestedAt }) {
    if (!isResearchIdentifier(decisionId) || !isResearchTimestamp(requestedAt))
      reject('An execution attempt needs a decision and request time.');
    const entry = prepare({ decisionId, requestedAt });
    return write(async (transaction) => {
      const existing = await transaction.execute({
        sql: 'SELECT content_hash, payload FROM paper_execution_attempts WHERE decision_id = ?',
        args: [decisionId],
      });
      if (existing.rows.length) {
        parseStored(existing.rows[0]);
        return false;
      }
      const saved = await transaction.execute({
        sql: 'SELECT content_hash, payload FROM paper_decisions WHERE id = ?',
        args: [decisionId],
      });
      const decision = parseStored(saved.rows[0]);
      if (
        !decision ||
        decision.status !== 'intent' ||
        requestedAt < decision.decidedAt + decision.policy.minimumFillDelayMs ||
        requestedAt > decision.decidedAt + decision.policy.maximumFillDelayMs ||
        requestedAt >= decision.contract.expiresAt ||
        requestedAt > now()
      )
        reject('The execution request must fall inside the saved intent window.');
      const executed = await transaction.execute({
        sql: "SELECT id FROM paper_events WHERE decision_id = ? AND kind IN ('fill', 'no-fill')",
        args: [decisionId],
      });
      if (executed.rows.length) return false;
      await transaction.execute({
        sql: 'INSERT INTO paper_execution_attempts(decision_id, requested_at, content_hash, payload) VALUES (?, ?, ?, ?)',
        args: [decisionId, requestedAt, entry.hash, entry.json],
      });
      return true;
    });
  }

  async function writeHeartbeat(heartbeat) {
    if (
      !isResearchIdentifier(heartbeat?.policyId) ||
      !['running', 'waiting', 'stopped', 'error'].includes(heartbeat.status) ||
      !isResearchTimestamp(heartbeat.heartbeatAt) ||
      heartbeat.heartbeatAt > now() ||
      Object.keys(heartbeat).some((key) => !['policyId', 'status', 'heartbeatAt'].includes(key))
    )
      reject('Invalid paper-trading heartbeat.');
    const entry = prepare(heartbeat);
    return write(async (transaction) => {
      if (!(await readPolicy(transaction, heartbeat.policyId)))
        reject('The paper policy has not started.', 'PAPER_POLICY_NOT_STARTED', 409);
      await transaction.execute({
        sql: `INSERT INTO paper_heartbeats(policy_id, heartbeat_at, payload) VALUES (?, ?, ?)
          ON CONFLICT(policy_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at,
            payload = excluded.payload
          WHERE paper_heartbeats.heartbeat_at < excluded.heartbeat_at
            OR (paper_heartbeats.heartbeat_at = excluded.heartbeat_at
              AND json_extract(paper_heartbeats.payload, '$.status') IN ('running', 'waiting')
              AND json_extract(excluded.payload, '$.status') IN ('stopped', 'error'))`,
        args: [heartbeat.policyId, heartbeat.heartbeatAt, entry.json],
      });
      const result = await transaction.execute({
        sql: 'SELECT payload FROM paper_heartbeats WHERE policy_id = ?',
        args: [heartbeat.policyId],
      });
      return JSON.parse(result.rows[0].payload);
    });
  }

  async function readHeartbeat(policyId) {
    if (!isResearchIdentifier(policyId)) reject('A paper policy identity is required.');
    await initialize();
    const result = await client.execute({
      sql: 'SELECT payload FROM paper_heartbeats WHERE policy_id = ?',
      args: [policyId],
    });
    return result.rows.length ? JSON.parse(result.rows[0].payload) : null;
  }

  return {
    initialize,
    ensurePolicy,
    readState,
    readDecision,
    saveDecision,
    saveEvent,
    claimExecutionAttempt,
    writeHeartbeat,
    readHeartbeat,
  };
}
