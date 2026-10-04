import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  getResearchReadTransaction,
  getResearchWriteTransaction,
  runResearchSchemaStatements,
} from '../research.connection';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  MAXIMUM_RESEARCH_INPUT_BYTES,
  isResearchTimestamp,
} from '../research.validation';
import {
  getTradingAdvice,
  TRADING_ADVISOR_POLICY,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';
import { createTradingAdvisorPolicy } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorPolicy.utils';
import { createAdvisorPlan } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorPlan.utils';
import { getAdvisorDecisionPortfolio } from './advisorPortfolio.utils';
import { getTradingPolicySelection } from './tradingPolicyTrials.repository';
import {
  getKalshiOutcome,
  isSameKalshiContract,
} from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  createAdvisorAccount,
  getAdvisorPortfolio,
  applyAdvisorAdvice,
  applyAdvisorEvent,
} from './tradingAdvisor.ledger';
import {
  getAdvisorValuation,
  getAdvisorRiskHistory,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorValuation.utils';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => JSON.parse(JSON.stringify(value));
const encode = (value, maximumBytes) => {
  const payload = getCanonicalResearchJson(clean(value), maximumBytes);
  return { payload, contentHash: hash(payload) };
};
const same = (left, right) => encode(left).payload === encode(right).payload;
const reject = (message, code = 'ADVISOR_RECORD_INVALID') => {
  throw Object.assign(new ResearchDataError(message, 409), { code });
};
function decode(row) {
  if (!row) return null;
  if (hash(row.payload) !== row.content_hash)
    reject('Trading-advisor evidence failed its integrity check.', 'ADVISOR_STORAGE_CORRUPT');
  return JSON.parse(row.payload);
}

const statements = [
  `CREATE TABLE IF NOT EXISTS advisor_configuration (
    id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_configuration_history (
    revision INTEGER PRIMARY KEY, previous_policy_id TEXT NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_policies (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_accounts (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_policies(id),
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_current_plans (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_policies(id),
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_leases (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_policies(id),
    token TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_advice (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL REFERENCES advisor_policies(id), ticker TEXT NOT NULL,
    evaluated_at INTEGER NOT NULL, action TEXT NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL,
    summary_payload TEXT NOT NULL, summary_hash TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS advisor_advice_policy_time
    ON advisor_advice(policy_id, evaluated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS advisor_inputs (
    advice_id TEXT PRIMARY KEY REFERENCES advisor_advice(id),
    encoding TEXT NOT NULL, payload BLOB NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_attempts (
    advice_id TEXT PRIMARY KEY REFERENCES advisor_advice(id),
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL REFERENCES advisor_policies(id), advice_id TEXT,
    position_id TEXT, recorded_at INTEGER NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL,
    summary_payload TEXT NOT NULL, summary_hash TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS advisor_execution_once
    ON advisor_events(advice_id) WHERE kind IN ('fill', 'no-fill')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS advisor_settlement_once
    ON advisor_events(position_id) WHERE kind = 'settlement'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS advisor_comparison_once
    ON advisor_events(position_id) WHERE kind = 'comparison'`,
  `CREATE INDEX IF NOT EXISTS advisor_events_policy_time
    ON advisor_events(policy_id, recorded_at DESC)`,
  `CREATE TABLE IF NOT EXISTS advisor_heartbeats (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_policies(id), payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_valuations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL REFERENCES advisor_policies(id), observed_at INTEGER NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS advisor_valuations_policy_time
    ON advisor_valuations(policy_id, observed_at DESC)`,
  `CREATE TABLE IF NOT EXISTS advisor_risk_state (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_policies(id),
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  ...[
    'advisor_policies',
    'advisor_advice',
    'advisor_inputs',
    'advisor_attempts',
    'advisor_events',
    'advisor_valuations',
    'advisor_configuration_history',
  ].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (operation) =>
        `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
       BEFORE ${operation} ON ${table}
       BEGIN SELECT RAISE(ABORT, 'Trading-advisor evidence is append-only.'); END`,
    ),
  ),
];

/** One fenced writer updates the small account and append-only evidence atomically. */
export function createTradingAdvisorRepository({ client, now = Date.now }) {
  let initialization;
  let pendingWrite = Promise.resolve();
  // Yield to the competing local writer; never block the event loop with SQLite busy waits.
  // Only idempotent schema work, untouched transaction acquisition and reads use this retry.
  async function retryLocalBusy(operation) {
    const delays = [25, 50, 100, 200];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          client.protocol !== 'file' ||
          !/^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(error?.code ?? '') ||
          attempt >= delays.length
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }
  async function initialize() {
    initialization ??= retryLocalBusy(() =>
      runResearchSchemaStatements(client, statements, { retryBusy: false }),
    ).catch((error) => {
      initialization = null;
      throw error;
    });
    await initialization;
  }
  function write(operation) {
    const result = pendingWrite.then(async () => {
      await initialize();
      const transaction = await retryLocalBusy(() =>
        getResearchWriteTransaction(client, { retryBusy: false }),
      );
      try {
        const result = await operation(transaction);
        await transaction.commit();
        return result;
      } finally {
        transaction.close();
      }
    });
    pendingWrite = result.catch(() => {});
    return result;
  }
  async function one(connection, table, field, value) {
    const result = await connection.execute({
      sql: `SELECT * FROM ${table} WHERE ${field} = ?`,
      args: [value],
    });
    return result.rows[0] ?? null;
  }
  async function accountFrom(connection, policyId) {
    return decode(await one(connection, 'advisor_accounts', 'policy_id', policyId));
  }
  async function saveAccount(transaction, policyId, account) {
    const entry = encode(account);
    await transaction.execute({
      sql: 'UPDATE advisor_accounts SET payload = ?, content_hash = ? WHERE policy_id = ?',
      args: [entry.payload, entry.contentHash, policyId],
    });
  }
  // Marks use the already archived observation and post-mutation holdings. They do not
  // change the frozen trading policy, spend cash, or request another market snapshot.
  async function saveValuation(transaction, policyId, account, source, sourceKind) {
    const policy = decode(await one(transaction, 'advisor_policies', 'id', policyId));
    const observedAt = source.evaluatedAt ?? source.recordedAt;
    // A partial sale consumed this observation's bids. Remaining holdings need a new
    // independent book before those bids can support another complete sale estimate.
    const hasConsumedExitDepth =
      source.kind === 'fill' &&
      source.action === 'sell' &&
      account.positions.some((position) => position.id === source.positionId);
    const valuation = {
      ...getAdvisorValuation({
        portfolio: getAdvisorPortfolio(account, observedAt),
        books: source.book && !hasConsumedExitDepth ? [source.book] : [],
        now: observedAt,
        policy,
      }),
      id: `${source.id}:valuation`,
      sourceId: source.id,
      sourceKind,
      policyId,
      accountVersion: account.version,
    };
    const previous = decode(await one(transaction, 'advisor_risk_state', 'policy_id', policyId));
    const history = getAdvisorRiskHistory(
      previous?.history ?? null,
      valuation,
      policy.initialBankroll,
    );
    const entry = encode(valuation);
    const state = encode({ valuation, history });
    await transaction.execute({
      sql: `INSERT INTO advisor_valuations(id, policy_id, observed_at, payload, content_hash)
        VALUES (?, ?, ?, ?, ?)`,
      args: [valuation.id, policyId, observedAt, entry.payload, entry.contentHash],
    });
    await transaction.execute({
      sql: `INSERT INTO advisor_risk_state(policy_id, payload, content_hash) VALUES (?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET payload = excluded.payload,
          content_hash = excluded.content_hash`,
      args: [policyId, state.payload, state.contentHash],
    });
  }
  async function requireLease(transaction, policyId, lease) {
    const saved = await one(transaction, 'advisor_leases', 'policy_id', policyId);
    if (!lease || saved?.token !== lease.token || Number(saved.expires_at) <= now())
      reject('The trading-advisor writer lease expired or changed.', 'ADVISOR_LEASE_LOST');
  }
  async function ensurePolicy(policy, startedAt = now()) {
    if (!isResearchTimestamp(startedAt) || startedAt > now() || !isTradingAdvisorPolicy(policy))
      reject('A policy requires a valid prospective start time.');
    const entry = encode(policy);
    return write(async (transaction) => {
      const original = await one(transaction, 'advisor_policies', 'id', policy.id);
      if (original) {
        if (!same(decode(original), policy)) reject('A saved advisor policy cannot be changed.');
        return Number(original.started_at);
      }
      const account = encode(createAdvisorAccount(policy));
      await transaction.execute({
        sql: 'INSERT INTO advisor_policies(id, started_at, payload, content_hash) VALUES (?, ?, ?, ?)',
        args: [policy.id, startedAt, entry.payload, entry.contentHash],
      });
      await transaction.execute({
        sql: 'INSERT INTO advisor_accounts(policy_id, payload, content_hash) VALUES (?, ?, ?)',
        args: [policy.id, account.payload, account.contentHash],
      });
      return startedAt;
    });
  }
  async function acquireLease(policyId, owner, durationMs = 60_000) {
    if (
      typeof owner !== 'string' ||
      !owner ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1 ||
      durationMs > 60000
    )
      reject('Invalid trading-advisor writer lease.');
    return write(async (transaction) => {
      const retired = await transaction.execute({
        sql: 'SELECT revision FROM advisor_configuration_history WHERE previous_policy_id = ? LIMIT 1',
        args: [policyId],
      });
      if (retired.rows.length) return null;
      const original = await one(transaction, 'advisor_leases', 'policy_id', policyId);
      // Each service owns a fresh UUID and serializes advance calls. If its previous lease
      // release failed, the next completed-call successor can replace and fence that token.
      // Other processes still wait for expiry; a restart receives a different owner UUID.
      if (original && original.owner !== owner && Number(original.expires_at) > now()) return null;
      const lease = { policyId, owner, token: randomUUID(), expiresAt: now() + durationMs };
      await transaction.execute({
        sql: `INSERT INTO advisor_leases(policy_id, token, owner, expires_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(policy_id) DO UPDATE SET token = excluded.token,
            owner = excluded.owner, expires_at = excluded.expires_at`,
        args: [policyId, lease.token, owner, lease.expiresAt],
      });
      return lease;
    });
  }
  async function releaseLease(lease) {
    return write((transaction) =>
      transaction.execute({
        sql: 'DELETE FROM advisor_leases WHERE policy_id = ? AND token = ?',
        args: [lease.policyId, lease.token],
      }),
    );
  }
  async function readState(policyId) {
    await initialize();
    return retryLocalBusy(() => readStateOnce(policyId));
  }
  async function readStateOnce(policyId) {
    // A read transaction prevents mixing a new account with older advice during a commit.
    const transaction = await getResearchReadTransaction(client);
    try {
      const saved = await one(transaction, 'advisor_policies', 'id', policyId);
      const policy = decode(saved);
      if (!policy) {
        await transaction.commit();
        return {
          policy: null,
          startedAt: null,
          account: null,
          advice: [],
          events: [],
          attempts: [],
          risk: null,
        };
      }
      const account = await accountFrom(transaction, policyId);
      if (!account) reject('The enrolled advisor account is missing.', 'ADVISOR_STORAGE_CORRUPT');
      const adviceRows = await transaction.execute({
        sql: `SELECT summary_payload AS payload, summary_hash AS content_hash
          FROM advisor_advice WHERE policy_id = ? ORDER BY sequence DESC LIMIT 50`,
        args: [policyId],
      });
      const eventRows = await transaction.execute({
        sql: `SELECT summary_payload AS payload, summary_hash AS content_hash
          FROM advisor_events WHERE policy_id = ? ORDER BY sequence DESC LIMIT 50`,
        args: [policyId],
      });
      const attempts = [];
      for (const intent of account.pendingIntents) {
        const attempt = decode(await one(transaction, 'advisor_attempts', 'advice_id', intent.id));
        if (attempt) attempts.push(attempt);
      }
      const state = {
        policy,
        startedAt: Number(saved.started_at),
        account,
        advice: adviceRows.rows.map(decode),
        events: eventRows.rows.map(decode),
        attempts,
        risk: decode(await one(transaction, 'advisor_risk_state', 'policy_id', policyId)),
        currentPlan: decode(await one(transaction, 'advisor_current_plans', 'policy_id', policyId)),
      };
      await transaction.commit();
      return state;
    } finally {
      transaction.close();
    }
  }
  async function readAdvice(id, { includeInputs = false } = {}) {
    await initialize();
    const advice = decode(await retryLocalBusy(() => one(client, 'advisor_advice', 'id', id)));
    if (advice && includeInputs) {
      const inputs = await retryLocalBusy(() => one(client, 'advisor_inputs', 'advice_id', id));
      if (inputs) {
        const payload = gunzipSync(Buffer.from(inputs.payload), {
          maxOutputLength: MAXIMUM_RESEARCH_INPUT_BYTES,
        }).toString('utf8');
        if (hash(payload) !== inputs.content_hash) reject('Advisor input archive is corrupt.');
        advice.forecast.researchInputSnapshot = JSON.parse(payload);
      }
    }
    return advice;
  }
  async function saveAdvice({ advice, researchInputSnapshot = null, lease }) {
    const value = clean(advice);
    const entry = encode(value);
    const { book, forecast, ...publicAdvice } = value;
    const summary = encode({
      ...publicAdvice,
      forecast: {
        capturedAt: forecast?.capturedAt ?? null,
        modelVersion: forecast?.modelVersion ?? null,
        modelId: forecast?.modelId ?? null,
      },
    });
    const inputs =
      ['buy', 'sell'].includes(value.action) && researchInputSnapshot
        ? encode(researchInputSnapshot, MAXIMUM_RESEARCH_INPUT_BYTES)
        : null;
    return write(async (transaction) => {
      await requireLease(transaction, value.policyId, lease);
      const original = await one(transaction, 'advisor_advice', 'id', value.id);
      if (original) {
        if (original.content_hash !== entry.contentHash || !same(decode(original), value))
          reject('Saved trading advice cannot be replaced.');
        return decode(original);
      }
      const savedPolicy = await one(transaction, 'advisor_policies', 'id', value.policyId);
      const basePolicy = decode(savedPolicy);
      const policy =
        basePolicy?.version === 2
          ? ((await getTradingPolicySelection(transaction, value.policyId, value.evaluatedAt)) ??
            basePolicy)
          : basePolicy;
      const account = await accountFrom(transaction, value.policyId);
      if (
        !policy ||
        !account ||
        value.evaluatedAt < Number(savedPolicy.started_at) ||
        value.evaluatedAt > now() ||
        (account.lastAdviceAt !== null &&
          value.evaluatedAt - account.lastAdviceAt < policy.cadenceMs)
      )
        reject('Advice must be prospective and obey the saved observation cadence.');
      const risk = decode(
        await one(transaction, 'advisor_risk_state', 'policy_id', value.policyId),
      );
      const portfolio = getAdvisorDecisionPortfolio({
        account,
        book: value.book,
        now: value.evaluatedAt,
        policy,
        riskHistory: risk?.history ?? null,
      });
      if (value.accountVersion !== account.version || !same(value.portfolio, portfolio))
        reject('Advice must preserve its exact available portfolio.');
      if (['buy', 'sell'].includes(value.action) && !researchInputSnapshot?.timing?.replayable)
        reject('An actionable recommendation requires causal underlying forecast inputs.');
      const expected = getTradingAdvice({
        contract: value.contract,
        forecast: value.forecast,
        book: value.book,
        portfolio,
        now: value.evaluatedAt,
        policy,
      });
      if (!Object.keys(expected).every((key) => same(expected[key], value[key])))
        reject('Advice does not match the available account and saved inputs.');
      const next = applyAdvisorAdvice(account, value);
      await transaction.execute({
        sql: `INSERT INTO advisor_advice(id, policy_id, ticker, evaluated_at, action,
          payload, content_hash, summary_payload, summary_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          value.id,
          value.policyId,
          value.contract.ticker,
          value.evaluatedAt,
          value.action,
          entry.payload,
          entry.contentHash,
          summary.payload,
          summary.contentHash,
        ],
      });
      if (inputs)
        await transaction.execute({
          sql: 'INSERT INTO advisor_inputs(advice_id, encoding, payload, content_hash) VALUES (?, ?, ?, ?)',
          args: [value.id, 'gzip-json', gzipSync(inputs.payload), inputs.contentHash],
        });
      await saveAccount(transaction, value.policyId, next);
      await saveValuation(transaction, value.policyId, next, value, 'advice');
      const previousPlan = decode(
        await one(transaction, 'advisor_current_plans', 'policy_id', value.policyId),
      );
      const financialSignature = (account) =>
        hash(
          encode({
            cash: account.cash,
            positions: account.positions,
            pendingIntents: account.pendingIntents,
          }).payload,
        );
      const plan = createAdvisorPlan(
        value,
        previousPlan?.financialSignature === financialSignature(account) ? previousPlan : null,
      );
      if (plan) {
        const savedPlan = encode({
          ...plan,
          accountVersion: next.version,
          financialSignature: financialSignature(next),
        });
        await transaction.execute({
          sql: `INSERT INTO advisor_current_plans(policy_id,payload,content_hash) VALUES (?,?,?)
            ON CONFLICT(policy_id) DO UPDATE SET payload = excluded.payload, content_hash = excluded.content_hash`,
          args: [value.policyId, savedPlan.payload, savedPlan.contentHash],
        });
      }
      return value;
    });
  }
  async function claimExecutionAttempt({ adviceId, requestedAt, lease }) {
    return write(async (transaction) => {
      const advice = decode(await one(transaction, 'advisor_advice', 'id', adviceId));
      if (!advice) reject('Execution requires saved advice.');
      await requireLease(transaction, advice.policyId, lease);
      const account = await accountFrom(transaction, advice.policyId);
      const existing = decode(await one(transaction, 'advisor_attempts', 'advice_id', adviceId));
      if (existing || !account.pendingIntents.some((row) => row.id === adviceId)) return false;
      if (
        !isResearchTimestamp(requestedAt) ||
        requestedAt > now() ||
        requestedAt < advice.evaluatedAt + advice.policy.minimumFillDelayMs ||
        requestedAt > advice.evaluatedAt + advice.policy.maximumFillDelayMs ||
        requestedAt >= advice.contract.expiresAt
      )
        reject('Execution request is outside the saved intention window.');
      const entry = encode({
        adviceId,
        requestedAt,
        owner: lease.owner,
        leaseToken: lease.token,
        leaseExpiresAt: lease.expiresAt,
      });
      await transaction.execute({
        sql: 'INSERT INTO advisor_attempts(advice_id, payload, content_hash) VALUES (?, ?, ?)',
        args: [adviceId, entry.payload, entry.contentHash],
      });
      return true;
    });
  }
  async function appendEvent(transaction, event, account) {
    const { account: next, realizedPnl } = applyAdvisorEvent(account, event);
    const value = clean({ ...event, realizedPnl });
    const entry = encode(value);
    const { book, market, ...summaryValue } = value;
    const summary = encode(summaryValue);
    await transaction.execute({
      sql: `INSERT INTO advisor_events(id, policy_id, advice_id, position_id, recorded_at, kind,
        payload, content_hash, summary_payload, summary_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        value.id,
        value.policyId,
        value.adviceId ?? null,
        value.positionId ?? null,
        value.recordedAt,
        value.kind,
        entry.payload,
        entry.contentHash,
        summary.payload,
        summary.contentHash,
      ],
    });
    await saveAccount(transaction, value.policyId, next);
    await saveValuation(transaction, value.policyId, next, value, 'event');
    return value;
  }
  async function saveExecution({
    adviceId,
    book,
    recordedAt,
    observationAttemptToken = null,
    lease,
  }) {
    return write(async (transaction) => {
      const advice = decode(await one(transaction, 'advisor_advice', 'id', adviceId));
      if (!advice) reject('Execution requires saved advice.');
      await requireLease(transaction, advice.policyId, lease);
      const id = `${adviceId}:execution`;
      const existing = decode(await one(transaction, 'advisor_events', 'id', id));
      if (existing) {
        if (existing.recordedAt !== recordedAt || !same(existing.book, book))
          reject('A saved execution observation cannot be replaced.');
        return existing;
      }
      if (!isResearchTimestamp(recordedAt) || recordedAt > now()) reject('Invalid execution time.');
      const attempt = decode(await one(transaction, 'advisor_attempts', 'advice_id', adviceId));
      const executionWindowExpired =
        recordedAt > advice.evaluatedAt + advice.policy.maximumFillDelayMs ||
        recordedAt >= advice.contract.expiresAt;
      // A failed network observation is frozen evidence too. Its original owner may retry
      // persisting that exact failure after renewing its lease, without fetching a new price.
      // A response received after the original lease may only resolve an expired window
      // as no-fill; it must not leave its reservation permanently stuck in the retry queue.
      const ownsFrozenObservation = Boolean(
        attempt &&
        attempt.leaseToken === observationAttemptToken &&
        attempt.owner === lease.owner &&
        recordedAt >= attempt.requestedAt &&
        (recordedAt <= attempt.leaseExpiresAt || executionWindowExpired),
      );
      if (book && (!ownsFrozenObservation || book.requestedAt < attempt.requestedAt))
        reject('Execution price needs its original durable request claim.');
      if (
        !book &&
        !ownsFrozenObservation &&
        attempt &&
        attempt.leaseToken !== lease.token &&
        recordedAt < attempt.leaseExpiresAt &&
        recordedAt <= advice.evaluatedAt + advice.policy.maximumFillDelayMs
      )
        reject('Another execution observation may still be in progress.');
      const account = await accountFrom(transaction, advice.policyId);
      const risk = decode(
        await one(transaction, 'advisor_risk_state', 'policy_id', advice.policyId),
      );
      const execution = simulateTradingExecution({
        advice,
        book,
        now: recordedAt,
        portfolio: getAdvisorDecisionPortfolio({
          account,
          book,
          now: recordedAt,
          policy: advice.policy,
          riskHistory: risk?.history ?? null,
          releasedIntentId: adviceId,
        }),
        policy: advice.policy,
      });
      if (!execution) return null;
      if (execution.kind === 'fill' && !attempt) reject('Fill requires a durable request claim.');
      const round = (amount) => Math.round(amount * 1e8) / 1e8;
      const expectedNetValueAtFill =
        execution.kind !== 'fill'
          ? null
          : round(
              advice.action === 'buy'
                ? advice.probability * execution.quantity - execution.totalCost
                : execution.netProceeds - advice.probability * execution.quantity,
            );
      const conservativeExpectedNetValueAtFill =
        execution.kind !== 'fill'
          ? null
          : round(
              advice.action === 'buy'
                ? Math.max(0, advice.probability - advice.policy.probabilityReserve) *
                    execution.quantity -
                    execution.totalCost
                : execution.netProceeds -
                    (advice.probability + advice.policy.probabilityReserve) * execution.quantity,
            );
      return appendEvent(
        transaction,
        {
          ...execution,
          id,
          adviceId,
          policyId: advice.policyId,
          contract: advice.contract,
          positionId: advice.positionId ?? `${advice.id}:position`,
          book: book ?? null,
          recordedAt,
          probability: advice.probability,
          expectedNetValueAtFill,
          conservativeExpectedNetValueAtFill,
        },
        account,
      );
    });
  }
  async function saveSettlement({ policyId, positionId, market, recordedAt, lease }) {
    return write(async (transaction) => {
      await requireLease(transaction, policyId, lease);
      const id = `${positionId}:settlement`;
      const original = decode(await one(transaction, 'advisor_events', 'id', id));
      if (original) {
        if (original.recordedAt !== recordedAt || !same(original.market, market))
          reject('A saved official settlement cannot be changed.');
        return original;
      }
      const account = await accountFrom(transaction, policyId);
      const position = account.positions.find((row) => row.id === positionId);
      const outcome = getKalshiOutcome(market, recordedAt);
      if (
        !position ||
        !outcome ||
        recordedAt > now() ||
        !isSameKalshiContract(position.contract, market)
      )
        return null;
      return appendEvent(
        transaction,
        {
          id,
          policyId,
          positionId,
          adviceId: position.entryAdviceId,
          kind: 'settlement',
          contract: position.contract,
          action: 'settle',
          side: position.side,
          quantity: position.quantity,
          payout: position.side === outcome.result ? position.quantity : 0,
          outcome,
          market,
          recordedAt,
        },
        account,
      );
    });
  }
  async function saveComparison({ policyId, positionId, market, recordedAt, lease }) {
    return write(async (transaction) => {
      await requireLease(transaction, policyId, lease);
      const id = `${positionId}:comparison`;
      const original = decode(await one(transaction, 'advisor_events', 'id', id));
      if (original) {
        if (original.recordedAt !== recordedAt || !same(original.market, market))
          reject('A saved paired comparison cannot be changed.');
        return original;
      }
      const account = await accountFrom(transaction, policyId);
      const comparison = account.pendingComparisons.find((row) => row.positionId === positionId);
      const outcome = getKalshiOutcome(market, recordedAt);
      if (
        !comparison ||
        !outcome ||
        recordedAt > now() ||
        account.positions.some((row) => row.id === positionId) ||
        !isSameKalshiContract(comparison.contract, market)
      )
        return null;
      const round = (amount) => Math.round(amount * 1e8) / 1e8;
      const strategyPnl = round(comparison.actualProceeds - comparison.initialCost);
      const holdPnl = round(
        (comparison.side === outcome.result ? comparison.initialQuantity : 0) -
          comparison.initialCost,
      );
      return appendEvent(
        transaction,
        {
          id,
          policyId,
          positionId,
          adviceId: comparison.entryAdviceId,
          kind: 'comparison',
          contract: comparison.contract,
          side: comparison.side,
          quantity: comparison.initialQuantity,
          initialCost: comparison.initialCost,
          strategyPnl,
          holdPnl,
          advantage: round(strategyPnl - holdPnl),
          outcome,
          market,
          recordedAt,
        },
        account,
      );
    });
  }
  async function writeHeartbeat({ policyId, status, heartbeatAt }, lease) {
    return write(async (transaction) => {
      await requireLease(transaction, policyId, lease);
      if (
        !['running', 'error', 'stopped'].includes(status) ||
        !isResearchTimestamp(heartbeatAt) ||
        heartbeatAt > now()
      )
        reject('Invalid advisor heartbeat.');
      await transaction.execute({
        sql: `INSERT INTO advisor_heartbeats(policy_id, payload) VALUES (?, ?)
          ON CONFLICT(policy_id) DO UPDATE SET payload = excluded.payload`,
        args: [policyId, encode({ policyId, status, heartbeatAt }).payload],
      });
    });
  }
  async function readHeartbeat(policyId) {
    await initialize();
    const row = await retryLocalBusy(() =>
      one(client, 'advisor_heartbeats', 'policy_id', policyId),
    );
    return row ? JSON.parse(row.payload) : null;
  }
  async function readConfiguration() {
    await initialize();
    return (
      decode(await retryLocalBusy(() => one(client, 'advisor_configuration', 'id', 1))) ?? {
        revision: 0,
        configuredAt: null,
        policy: TRADING_ADVISOR_POLICY,
      }
    );
  }

  /** Retire the daily-loss rule prospectively without rewriting evidence or resetting money. */
  async function ensureDailyLossLimitRemoved() {
    const configuration = await readConfiguration();
    if (configuration.policy.dailyLossLimitEnabled === false) return configuration;
    return write(async (transaction) => {
      const previous = decode(await one(transaction, 'advisor_configuration', 'id', 1)) ?? {
        revision: 0,
        configuredAt: null,
        policy: TRADING_ADVISOR_POLICY,
      };
      const previousPolicy = previous.policy;
      if (previousPolicy.dailyLossLimitEnabled === false) return previous;
      const lease = await one(transaction, 'advisor_leases', 'policy_id', previousPolicy.id);
      const previousAccount = await accountFrom(transaction, previousPolicy.id);
      if (!previousAccount && (await one(transaction, 'advisor_policies', 'id', previousPolicy.id)))
        reject('The enrolled advisor account is missing.', 'ADVISOR_STORAGE_CORRUPT');
      // Finish already recorded orders under their original rules. An active writer must
      // release its lease before we snapshot the account and fence the previous policy.
      if (Number(lease?.expires_at ?? 0) > now() || previousAccount?.pendingIntents.length)
        return previous;
      const policy = {
        ...previousPolicy,
        id: `kalshi-advisor-v${previousPolicy.version === 2 ? 2 : 3}-${randomUUID()}`,
        dailyLossLimitEnabled: false,
      };
      if (!isTradingAdvisorPolicy(policy)) reject('The revised advisor policy is invalid.');
      const account = previousAccount
        ? { ...previousAccount, version: previousAccount.version + 1 }
        : createAdvisorAccount(policy);
      const configuredAt = now();
      const next = {
        revision: previous.revision + 1,
        configuredAt,
        policy,
        previousPolicyId: previousPolicy.id,
        carriedRealizedPnl: account.realizedPnl,
        reason: 'daily_loss_limit_removed',
      };
      const policyEntry = encode(policy);
      const accountEntry = encode(account);
      const entry = encode(next);
      await transaction.execute({
        sql: 'INSERT INTO advisor_policies(id, started_at, payload, content_hash) VALUES (?, ?, ?, ?)',
        args: [policy.id, configuredAt, policyEntry.payload, policyEntry.contentHash],
      });
      await transaction.execute({
        sql: 'INSERT INTO advisor_accounts(policy_id, payload, content_hash) VALUES (?, ?, ?)',
        args: [policy.id, accountEntry.payload, accountEntry.contentHash],
      });
      const previousRisk = decode(
        await one(transaction, 'advisor_risk_state', 'policy_id', previousPolicy.id),
      );
      if (previousRisk) {
        // A valuation belongs to its original policy and account version; history carries
        // forward, while the next captured book supplies the new account's valuation.
        const riskEntry = encode({ ...previousRisk, valuation: null });
        await transaction.execute({
          sql: 'INSERT INTO advisor_risk_state(policy_id, payload, content_hash) VALUES (?, ?, ?)',
          args: [policy.id, riskEntry.payload, riskEntry.contentHash],
        });
      }
      await transaction.execute({
        sql: 'INSERT INTO advisor_configuration_history(revision, previous_policy_id, payload, content_hash) VALUES (?, ?, ?, ?)',
        args: [next.revision, previousPolicy.id, entry.payload, entry.contentHash],
      });
      await transaction.execute({
        sql: `INSERT INTO advisor_configuration(id, payload, content_hash) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, content_hash = excluded.content_hash`,
        args: [entry.payload, entry.contentHash],
      });
      return next;
    });
  }

  /** Change a stopped, flat account's allocation without erasing losses or resetting its risk peak. */
  async function configure({ allocation, riskLevel, expectedRevision }) {
    if (
      !Number.isFinite(allocation) ||
      allocation < 1 ||
      allocation > 100 ||
      !['conservative', 'balanced'].includes(riskLevel)
    )
      reject('Choose an allocation of $1–$100 in whole cents and a supported risk level.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      reject('Reload setup before saving its configuration.');
    let policy;
    try {
      policy = createTradingAdvisorPolicy({ allocation, riskLevel, runId: randomUUID() });
    } catch {
      reject('Choose an allocation of $1–$100 in whole cents and a supported risk level.');
    }
    return write(async (transaction) => {
      const previous = decode(await one(transaction, 'advisor_configuration', 'id', 1));
      if ((previous?.revision ?? 0) !== expectedRevision)
        reject('Setup changed in another window. Reload it before saving.');
      const previousPolicy = previous?.policy ?? TRADING_ADVISOR_POLICY;
      const lease = await one(transaction, 'advisor_leases', 'policy_id', previousPolicy.id);
      const heartbeatRow = await one(
        transaction,
        'advisor_heartbeats',
        'policy_id',
        previousPolicy.id,
      );
      const heartbeat = heartbeatRow ? JSON.parse(heartbeatRow.payload) : null;
      if (
        Number(lease?.expires_at ?? 0) > now() ||
        (heartbeat?.status === 'running' && now() - heartbeat.heartbeatAt < 30000)
      )
        reject('Stop the collector before changing account setup.');
      const previousAccount = await accountFrom(transaction, previousPolicy.id);
      if (!previousAccount && (await one(transaction, 'advisor_policies', 'id', previousPolicy.id)))
        reject('The enrolled advisor account is missing.', 'ADVISOR_STORAGE_CORRUPT');
      if (
        previousAccount &&
        (previousAccount.positions.length ||
          previousAccount.pendingIntents.length ||
          previousAccount.pendingComparisons.length)
      )
        reject(
          'Wait for open positions, pending orders and official settlement comparisons to finish.',
        );
      const account = createAdvisorAccount(policy);
      const difference = policy.initialBankroll - previousPolicy.initialBankroll;
      if (previousAccount) {
        Object.assign(account, previousAccount, {
          policyVersion: 2,
          version: previousAccount.version + 1,
        });
        account.cash = Math.round((previousAccount.cash + difference) * 1e8) / 1e8;
        if (account.cash < 0)
          reject('The selected allocation cannot cover the account’s recorded losses.');
        account.dailyStartEquity = Math.max(
          0,
          (previousAccount.dailyStartEquity ?? previousPolicy.initialBankroll) + difference,
        );
      }
      const configuredAt = now();
      const configuration = {
        revision: expectedRevision + 1,
        configuredAt,
        policy,
        previousPolicyId: previousPolicy.id,
        carriedRealizedPnl: account.realizedPnl,
      };
      const policyEntry = encode(policy);
      const accountEntry = encode(account);
      const entry = encode(configuration);
      await transaction.execute({
        sql: 'INSERT INTO advisor_policies(id, started_at, payload, content_hash) VALUES (?, ?, ?, ?)',
        args: [policy.id, configuredAt, policyEntry.payload, policyEntry.contentHash],
      });
      await transaction.execute({
        sql: 'INSERT INTO advisor_accounts(policy_id, payload, content_hash) VALUES (?, ?, ?)',
        args: [policy.id, accountEntry.payload, accountEntry.contentHash],
      });
      const previousRisk = decode(
        await one(transaction, 'advisor_risk_state', 'policy_id', previousPolicy.id),
      );
      if (previousRisk?.history) {
        const riskEntry = encode({
          valuation: null,
          history: {
            ...previousRisk.history,
            peakEquity: Math.max(
              policy.initialBankroll,
              previousRisk.history.peakEquity + difference,
            ),
            historicalPeakEquity: Math.max(
              previousRisk.history.peakEquity,
              previousRisk.history.historicalPeakEquity ?? previousRisk.history.peakEquity,
            ),
          },
        });
        await transaction.execute({
          sql: 'INSERT INTO advisor_risk_state(policy_id, payload, content_hash) VALUES (?, ?, ?)',
          args: [policy.id, riskEntry.payload, riskEntry.contentHash],
        });
      }
      await transaction.execute({
        sql: 'INSERT INTO advisor_configuration_history(revision, previous_policy_id, payload, content_hash) VALUES (?, ?, ?, ?)',
        args: [configuration.revision, previousPolicy.id, entry.payload, entry.contentHash],
      });
      await transaction.execute({
        sql: `INSERT INTO advisor_configuration(id, payload, content_hash) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, content_hash = excluded.content_hash`,
        args: [entry.payload, entry.contentHash],
      });
      return configuration;
    });
  }
  /** Bounded audit pages preserve access to old evidence without replaying it on every tick. */
  async function readEvidencePage(
    policyId,
    { afterSequence = 0, limit = 100, kind = 'advice' } = {},
  ) {
    if (
      !['advice', 'events', 'valuations'].includes(kind) ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      reject('Invalid advisor audit page.');
    await initialize();
    const result = await retryLocalBusy(() =>
      client.execute({
        sql: `SELECT sequence, payload, content_hash FROM advisor_${kind}
        WHERE policy_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        args: [policyId, afterSequence, limit],
      }),
    );
    return result.rows.map((row) => ({ sequence: Number(row.sequence), value: decode(row) }));
  }
  return {
    initialize,
    ensurePolicy,
    acquireLease,
    releaseLease,
    readState,
    readAdvice,
    saveAdvice,
    claimExecutionAttempt,
    saveExecution,
    saveSettlement,
    saveComparison,
    writeHeartbeat,
    readHeartbeat,
    readConfiguration,
    ensureDailyLossLimitRemoved,
    configure,
    readEvidencePage,
  };
}
