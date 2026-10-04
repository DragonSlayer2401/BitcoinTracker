import 'server-only';
import { createHash } from 'node:crypto';
import {
  getResearchReadTransaction,
  getResearchWriteTransaction,
  runResearchSchemaStatements,
} from '../research.connection';
import { getCanonicalResearchJson, ResearchDataError } from '../research.validation';
import { advanceTradingPolicyTrial, createTradingPolicyTrial } from './tradingPolicyTrials.utils';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => {
  const payload = getCanonicalResearchJson(value, 8 * 1024 * 1024);
  return { payload, contentHash: hash(payload) };
};
const decode = (row) => {
  if (!row) return null;
  if (hash(row.payload) !== row.content_hash)
    throw new ResearchDataError('Trading-policy trial evidence failed its integrity check.', 409);
  return JSON.parse(row.payload);
};

const schema = [
  `CREATE TABLE IF NOT EXISTS advisor_profit_trials (
    policy_id TEXT PRIMARY KEY, registered_at INTEGER NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_profit_trial_state (
    policy_id TEXT PRIMARY KEY REFERENCES advisor_profit_trials(policy_id),
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_profit_observations (
    id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES advisor_profit_trials(policy_id),
    observed_at INTEGER NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_profit_transitions (
    policy_id TEXT NOT NULL REFERENCES advisor_profit_trials(policy_id),
    sequence INTEGER NOT NULL, observed_at INTEGER NOT NULL,
    payload TEXT NOT NULL, content_hash TEXT NOT NULL,
    PRIMARY KEY (policy_id, sequence))`,
  `CREATE INDEX IF NOT EXISTS advisor_profit_transition_time
    ON advisor_profit_transitions(policy_id, observed_at)`,
  ...['advisor_profit_trials', 'advisor_profit_observations', 'advisor_profit_transitions'].flatMap(
    (table) =>
      ['UPDATE', 'DELETE'].map(
        (operation) =>
          `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
       BEFORE ${operation} ON ${table}
       BEGIN SELECT RAISE(ABORT, 'Trading-policy trial evidence is append-only.'); END`,
      ),
  ),
];

async function one(connection, table, policyId) {
  const result = await connection.execute({
    sql: `SELECT * FROM ${table} WHERE policy_id = ?`,
    args: [policyId],
  });
  return decode(result.rows[0]);
}

/** Resolve only transitions already recorded at the decision time, inside its caller's transaction. */
export async function getTradingPolicySelection(connection, policyId, evaluatedAt) {
  let registration;
  try {
    registration = await one(connection, 'advisor_profit_trials', policyId);
  } catch (error) {
    if (/no such table: advisor_profit_trials/i.test(error.message)) return null;
    throw error;
  }
  if (!registration || evaluatedAt < registration.registeredAt) return null;
  const result = await connection.execute({
    sql: `SELECT * FROM advisor_profit_transitions WHERE policy_id = ? AND observed_at <= ?
          ORDER BY observed_at DESC, sequence DESC LIMIT 1`,
    args: [policyId, evaluatedAt],
  });
  const transition = decode(result.rows[0]);
  const id = transition?.kind === 'activated' ? transition.strategyId : 'standard';
  const selected = registration.policies[id];
  if (!selected) throw new ResearchDataError('The activated strategy was not registered.', 409);
  return selected;
}

/** Append captured inputs and update every shadow account in one local database transaction. */
export function createTradingPolicyTrialRepository({ client, now = Date.now }) {
  let initialization;
  let queue = Promise.resolve();
  const initialize = () => {
    initialization ??= runResearchSchemaStatements(client, schema).catch((error) => {
      initialization = null;
      throw error;
    });
    return initialization;
  };
  function write(operation) {
    const result = queue.then(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const result = await operation(transaction);
        await transaction.commit();
        return result;
      } finally {
        transaction.close();
      }
    });
    queue = result.catch(() => {});
    return result;
  }
  async function read(operation) {
    await initialize();
    const transaction = await getResearchReadTransaction(client);
    try {
      return await operation(transaction);
    } finally {
      transaction.close();
    }
  }
  return {
    initialize,
    ensureTrial(policy, registeredAt) {
      if (!Number.isSafeInteger(registeredAt) || registeredAt <= 0 || registeredAt > now())
        return Promise.reject(
          new ResearchDataError('Profit-trial registration cannot use a future time.', 409),
        );
      const frozenPolicy = JSON.parse(encode(policy).payload);
      return write(async (transaction) => {
        policy = frozenPolicy;
        const prior = await one(transaction, 'advisor_profit_trials', policy.id);
        if (prior) {
          if (encode(prior.policies.standard).payload !== encode(policy).payload)
            throw new ResearchDataError('A registered trading strategy cannot be rewritten.', 409);
          return one(transaction, 'advisor_profit_trial_state', policy.id);
        }
        const state = createTradingPolicyTrial(policy, registeredAt);
        const registration = encode({
          policyId: policy.id,
          registeredAt,
          rules: state.rules,
          policies: Object.fromEntries(
            Object.values(state.strategies).map((strategy) => [strategy.id, strategy.policy]),
          ),
        });
        await transaction.execute({
          sql: 'INSERT INTO advisor_profit_trials VALUES (?, ?, ?, ?)',
          args: [policy.id, registeredAt, registration.payload, registration.contentHash],
        });
        const entry = encode(state);
        await transaction.execute({
          sql: 'INSERT INTO advisor_profit_trial_state VALUES (?, ?, ?)',
          args: [policy.id, entry.payload, entry.contentHash],
        });
        return state;
      });
    },
    record(policyId, input) {
      if (
        !Number.isSafeInteger(input.observedAt) ||
        input.observedAt <= 0 ||
        input.observedAt > now()
      )
        return Promise.reject(
          new ResearchDataError('Trial observations cannot be recorded before capture.', 409),
        );
      const captured = encode(input);
      const frozenInput = JSON.parse(captured.payload);
      const captureKind =
        input.kind === 'observation' && input.forecast !== undefined ? 'decision' : input.kind;
      const id = `${policyId}:${captureKind}:${input.observedAt}:${input.contract?.ticker ?? input.market?.ticker ?? input.book?.ticker ?? 'clock'}`;
      return write(async (transaction) => {
        const prior = await transaction.execute({
          sql: 'SELECT * FROM advisor_profit_observations WHERE id = ?',
          args: [id],
        });
        const original = decode(prior.rows[0]);
        if (original) {
          if (encode(original).payload !== captured.payload)
            throw new ResearchDataError('A captured trial observation cannot be rewritten.', 409);
          return one(transaction, 'advisor_profit_trial_state', policyId);
        }
        const previous = await one(transaction, 'advisor_profit_trial_state', policyId);
        if (!previous)
          throw new ResearchDataError(
            'Register a prospective profit trial before collecting evidence.',
            409,
          );
        const state = advanceTradingPolicyTrial(previous, frozenInput);
        await transaction.execute({
          sql: 'INSERT INTO advisor_profit_observations VALUES (?, ?, ?, ?, ?, ?)',
          args: [
            id,
            policyId,
            input.observedAt,
            input.kind,
            captured.payload,
            captured.contentHash,
          ],
        });
        for (
          let index = previous.transitions.length;
          index < state.transitions.length;
          index += 1
        ) {
          const transition = encode(state.transitions[index]);
          await transaction.execute({
            sql: 'INSERT INTO advisor_profit_transitions VALUES (?, ?, ?, ?, ?)',
            args: [
              policyId,
              index + 1,
              state.transitions[index].at,
              transition.payload,
              transition.contentHash,
            ],
          });
        }
        const entry = encode(state);
        await transaction.execute({
          sql: 'UPDATE advisor_profit_trial_state SET payload = ?, content_hash = ? WHERE policy_id = ?',
          args: [entry.payload, entry.contentHash, policyId],
        });
        return state;
      });
    },
    readState: (policyId) =>
      read((transaction) => one(transaction, 'advisor_profit_trial_state', policyId)),
    getSelection: (policyId, evaluatedAt) =>
      read((transaction) => getTradingPolicySelection(transaction, policyId, evaluatedAt)),
  };
}
