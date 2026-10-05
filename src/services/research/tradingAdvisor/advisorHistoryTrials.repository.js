import 'server-only';
import { createHash } from 'node:crypto';
import {
  getResearchReadTransaction,
  getResearchWriteTransaction,
  runResearchSchemaStatements,
} from '../research.connection';
import { getCanonicalResearchJson, ResearchDataError } from '../research.validation';
import { isTradingAdvisorPolicy } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';
import {
  ADVISOR_HISTORY_TRIAL_VERSION,
  createAdvisorHistoryTrial,
  advanceAdvisorHistoryTrial,
  recordAdvisorLanguageModelResult,
  getAdvisorHistoryTrialReport,
} from './advisorHistoryTrials.utils';
import {
  ADVISOR_LANGUAGE_MODEL_PRICING,
  ADVISOR_LANGUAGE_MODEL_PRICING_VERSION,
} from './advisorLanguageModel.service';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => {
  const payload = getCanonicalResearchJson(JSON.parse(JSON.stringify(value)), 8 * 1024 * 1024);
  return { payload, hash: hash(payload) };
};
const decode = (row) => {
  if (!row) return null;
  if (hash(row.payload) !== row.content_hash)
    throw new ResearchDataError('History trial evidence failed its integrity check.', 409);
  return JSON.parse(row.payload);
};
const fail = (message) => {
  throw new ResearchDataError(message, 409);
};
const priceTokens = (inputTokens, outputTokens, pricing) =>
  Math.ceil(
    ((inputTokens * pricing.inputUsdPerMillionTokens +
      outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000 -
      1e-12) *
      1e8,
  ) / 1e8;
const schema = [
  `CREATE TABLE IF NOT EXISTS advisor_history_trials (id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, registered_at INTEGER NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_history_state (id TEXT PRIMARY KEY REFERENCES advisor_history_trials(id), payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_history_observations (id TEXT PRIMARY KEY, trial_id TEXT NOT NULL REFERENCES advisor_history_trials(id), observed_at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS advisor_history_policy ON advisor_history_trials(policy_id, registered_at DESC)`,
  `CREATE TABLE IF NOT EXISTS advisor_history_execution_requests (id TEXT PRIMARY KEY, trial_id TEXT NOT NULL REFERENCES advisor_history_trials(id), requested_at INTEGER NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_ai_reservations (id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, utc_day TEXT NOT NULL, maximum_cost REAL NOT NULL, charged_cost REAL NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS advisor_ai_completions (id TEXT PRIMARY KEY REFERENCES advisor_ai_reservations(id), payload TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  ...[
    'advisor_history_trials',
    'advisor_history_observations',
    'advisor_history_execution_requests',
    'advisor_ai_completions',
  ].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (operation) =>
        `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'AI policy evidence is append-only.'); END`,
    ),
  ),
];

/** Own independent shadow accounts and a process-safe inference spend reservation ledger. */
export function createAdvisorHistoryTrialRepository({ client, now = Date.now }) {
  let initialization;
  let queue = Promise.resolve();
  const initialize = () =>
    (initialization ??= runResearchSchemaStatements(client, schema).catch((error) => {
      initialization = null;
      throw error;
    }));
  const one = async (connection, table, id) =>
    decode(
      (
        await connection.execute({
          sql: `SELECT payload, content_hash FROM ${table} WHERE id = ?`,
          args: [id],
        })
      ).rows[0],
    );
  function write(operation) {
    const result = queue.then(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const output = await operation(transaction);
        await transaction.commit();
        return output;
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
  async function persist(connection, state, input) {
    const saved = encode(state);
    const event = encode({
      input,
      languageModelRequest: state.strategies['language-model'].pendingRequest,
      recommendations: Object.fromEntries(
        Object.values(state.strategies).map((strategy) => [
          strategy.id,
          strategy.decisions.slice(-3),
        ]),
      ),
    });
    await connection.execute({
      sql: 'INSERT INTO advisor_history_observations(id,trial_id,observed_at,kind,payload,content_hash) VALUES (?,?,?,?,?,?)',
      args: [input.id, state.id, input.observedAt, input.kind, event.payload, event.hash],
    });
    await connection.execute({
      sql: 'UPDATE advisor_history_state SET payload = ?, content_hash = ? WHERE id = ?',
      args: [saved.payload, saved.hash, state.id],
    });
    return state;
  }
  async function reportState(transaction, state) {
    const report = getAdvisorHistoryTrialReport(state);
    if (!state) return report;
    const costs = (
      await transaction.execute({
        sql: "SELECT COALESCE(SUM(charged_cost), 0) AS total, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS unknown_count FROM advisor_ai_reservations WHERE id LIKE ?",
        args: [`${state.id}:%`],
      })
    ).rows[0];
    const reservedOrActualCost = Number(costs.total);
    if (!Number.isFinite(reservedOrActualCost) || reservedOrActualCost < 0)
      fail('The durable inference cost ledger is invalid.');
    const recordedCost = state.strategies['language-model'].inferenceCost;
    const costDiscrepancy = Math.abs(reservedOrActualCost - recordedCost) > 1e-8;
    // A missing archive must not make reported profit look better. Keep the larger
    // charge until the immutable response and durable budget ledger reconcile.
    const inferenceCost = Math.max(reservedOrActualCost, recordedCost);
    return {
      ...report,
      costDiscrepancy,
      inferenceCostAccounting:
        'Known token charges plus the maximum reserved cost for unfinished requests.',
      unresolvedCostReservations: Number(costs.unknown_count),
      strategies: report.strategies.map((strategy) =>
        strategy.id !== 'language-model'
          ? strategy
          : {
              ...strategy,
              inferenceCost,
              recordedInferenceCost: recordedCost,
              durableInferenceCost: reservedOrActualCost,
              netProfit: Math.round((strategy.realizedPnl - inferenceCost) * 1e8) / 1e8,
              guidance: {
                ...strategy.guidance,
                performance: {
                  ...strategy.guidance.performance,
                  inferenceCost,
                  netProfit: Math.round((strategy.realizedPnl - inferenceCost) * 1e8) / 1e8,
                  costDiscrepancy,
                },
              },
              costDiscrepancy,
              readyForReview: strategy.readyForReview && !costDiscrepancy,
            },
      ),
    };
  }
  return {
    initialize,
    ensureTrial(policy, provider, registeredAt = now()) {
      if (
        !isTradingAdvisorPolicy(policy) ||
        !Number.isSafeInteger(registeredAt) ||
        registeredAt <= 0 ||
        registeredAt > now()
      )
        return Promise.reject(new Error('Invalid prospective history trial registration.'));
      const manifest = {
        version: ADVISOR_HISTORY_TRIAL_VERSION,
        policy,
        provider,
        rulesCandidate: 'history-rules-v1',
        languageCandidate: 'history-llm-v1',
      };
      const frozen = encode(manifest);
      const frozenManifest = JSON.parse(frozen.payload);
      const id = `advisor-history-${frozen.hash.slice(0, 24)}`;
      return write(async (transaction) => {
        const prior = await one(transaction, 'advisor_history_trials', id);
        if (prior) {
          if (encode(prior.manifest).hash !== frozen.hash)
            fail('A shadow trial cannot change its frozen configuration.');
          return one(transaction, 'advisor_history_state', id);
        }
        const state = createAdvisorHistoryTrial({
          id,
          policy: frozenManifest.policy,
          provider: frozenManifest.provider,
          registeredAt,
        });
        const registration = encode({ id, registeredAt, manifest: frozenManifest });
        const saved = encode(state);
        await transaction.execute({
          sql: 'INSERT INTO advisor_history_trials VALUES (?,?,?,?,?)',
          args: [
            id,
            frozenManifest.policy.id,
            registeredAt,
            registration.payload,
            registration.hash,
          ],
        });
        await transaction.execute({
          sql: 'INSERT INTO advisor_history_state VALUES (?,?,?)',
          args: [id, saved.payload, saved.hash],
        });
        return state;
      });
    },
    readState: (id) => read((transaction) => one(transaction, 'advisor_history_state', id)),
    readPendingExecutions: (id) =>
      read(async (transaction) => {
        const state = await one(transaction, 'advisor_history_state', id);
        const pending = [];
        for (const strategy of Object.values(state?.strategies ?? {})) {
          for (const advice of strategy.account.pendingIntents) {
            pending.push({
              advice,
              attempt: await one(transaction, 'advisor_history_execution_requests', advice.id),
            });
          }
        }
        return pending;
      }),
    /** Claim one common delayed book for all due strategies; network work happens after commit. */
    claimExecutionObservation(trialId, at, ticker = null) {
      if (!Number.isSafeInteger(at) || at <= 0 || at > now())
        return Promise.reject(
          new ResearchDataError('A shadow execution request needs a current capture time.', 409),
        );
      return write(async (transaction) => {
        const state = await one(transaction, 'advisor_history_state', trialId);
        if (!state) return null;
        const eligible = [];
        const currentTime = now();
        if (at > currentTime) fail('A shadow execution request cannot use a future capture time.');
        for (const strategy of Object.values(state.strategies)) {
          for (const intent of strategy.account.pendingIntents) {
            if (ticker !== null && intent.contract.ticker !== ticker) continue;
            const minimumAt = intent.evaluatedAt + intent.policy.minimumFillDelayMs;
            const maximumAt = intent.evaluatedAt + intent.policy.maximumFillDelayMs;
            if (
              at < minimumAt ||
              at > maximumAt ||
              currentTime > maximumAt ||
              at >= intent.contract.expiresAt ||
              currentTime >= intent.contract.expiresAt
            )
              continue;
            if (await one(transaction, 'advisor_history_execution_requests', intent.id)) continue;
            eligible.push({
              intent,
              strategyId: strategy.id,
              deadline: Math.min(maximumAt + 1, intent.contract.expiresAt),
            });
          }
        }
        eligible.sort(
          (left, right) =>
            left.deadline - right.deadline || left.intent.id.localeCompare(right.intent.id),
        );
        if (!eligible.length) return null;
        const selected = eligible.filter(
          (row) => row.intent.contract.ticker === eligible[0].intent.contract.ticker,
        );
        const sourceId = `shadow-execution:${hash(
          JSON.stringify({ trialId, at, intentions: selected.map((row) => row.intent.id).sort() }),
        ).slice(0, 32)}`;
        const deadline = Math.min(...selected.map((row) => row.deadline));
        for (const { intent, strategyId } of selected) {
          const captured = encode({
            sourceId,
            requestedAt: at,
            deadline,
            intentId: intent.id,
            strategyId,
            contract: intent.contract,
            evaluatedAt: intent.evaluatedAt,
          });
          await transaction.execute({
            sql: 'INSERT INTO advisor_history_execution_requests VALUES (?,?,?,?,?)',
            args: [intent.id, trialId, at, captured.payload, captured.hash],
          });
        }
        return { contract: selected[0].intent.contract, sourceId, deadline, requestedAt: at };
      });
    },
    getReport(policyId) {
      return read(async (transaction) => {
        const row = (
          await transaction.execute({
            sql: 'SELECT id FROM advisor_history_trials WHERE policy_id = ? ORDER BY registered_at DESC, rowid DESC LIMIT 1',
            args: [policyId],
          })
        ).rows[0];
        const state = row ? await one(transaction, 'advisor_history_state', row.id) : null;
        return reportState(transaction, state);
      });
    },
    getReports: () =>
      read(async (transaction) => {
        const result = await transaction.execute(
          `SELECT state.payload, state.content_hash
           FROM advisor_history_trials AS trial
           JOIN advisor_history_state AS state ON state.id = trial.id
           ORDER BY trial.registered_at DESC, trial.rowid DESC`,
        );
        const reports = [];
        for (const row of result.rows) reports.push(await reportState(transaction, decode(row)));
        return reports;
      }),
    record(id, input) {
      const captured = JSON.parse(encode({ ...input, id: `${id}:${input.id}` }).payload);
      if (
        !Number.isSafeInteger(captured.observedAt) ||
        captured.observedAt <= 0 ||
        captured.observedAt > now()
      )
        return Promise.reject(
          new Error('A shadow observation cannot be backdated from a future capture.'),
        );
      return write(async (transaction) => {
        const prior = await one(transaction, 'advisor_history_observations', captured.id);
        if (prior) {
          if (encode(prior.input).hash !== encode(captured).hash)
            fail('A captured shadow observation cannot change.');
          return one(transaction, 'advisor_history_state', id);
        }
        const state = await one(transaction, 'advisor_history_state', id);
        if (!state) fail('A shadow trial must be enrolled first.');
        if (captured.kind === 'response') {
          const source = captured.evidence?.snapshotId;
          if (typeof source !== 'string' || !source.startsWith(`${id}:`))
            fail('An AI response must reference its own archived trial observation.');
          const archived = await one(transaction, 'advisor_history_observations', source);
          const request = archived?.languageModelRequest;
          if (
            !request ||
            request.requestId !== captured.requestId ||
            encode(request.evidence).hash !== encode(captured.evidence).hash ||
            !Number.isSafeInteger(captured.result?.respondedAt) ||
            captured.result.respondedAt < request.requestedAt ||
            captured.result.respondedAt > captured.observedAt ||
            (captured.result.requestId !== undefined &&
              captured.result.requestId !== captured.requestId)
          )
            fail('An AI response must match its immutable captured request and response time.');
        }
        const executionClaims = {};
        if (captured.kind !== 'response') {
          for (const strategy of Object.values(state.strategies)) {
            for (const intent of strategy.account.pendingIntents) {
              const claim = await one(transaction, 'advisor_history_execution_requests', intent.id);
              if (claim) executionClaims[intent.id] = claim;
            }
          }
        }
        const next =
          captured.kind === 'response'
            ? recordAdvisorLanguageModelResult(state, captured)
            : advanceAdvisorHistoryTrial(state, captured, { executionClaims });
        return persist(transaction, next, captured);
      });
    },
    reserveBudget(input) {
      const captured = JSON.parse(encode(input).payload);
      return write(async (transaction) => {
        input = captured;
        const {
          requestId,
          maximumCostUsd,
          requestedAt,
          reservationExpiresAt,
          minimumRequestIntervalMs,
          maximumDailySpendUsd,
        } = input;
        if (
          typeof requestId !== 'string' ||
          !requestId ||
          requestId.length > 1000 ||
          !Number.isSafeInteger(requestedAt) ||
          requestedAt > now() ||
          requestedAt <= 0 ||
          !Number.isSafeInteger(reservationExpiresAt) ||
          reservationExpiresAt <= requestedAt ||
          reservationExpiresAt <= now() ||
          reservationExpiresAt - requestedAt > 30000 ||
          !Number.isFinite(maximumCostUsd) ||
          maximumCostUsd <= 0 ||
          !Number.isFinite(maximumDailySpendUsd) ||
          maximumDailySpendUsd <= 0 ||
          !Number.isSafeInteger(minimumRequestIntervalMs) ||
          minimumRequestIntervalMs < 30000
        )
          return { accepted: false, reason: 'invalid_budget_request' };
        if (
          input.model !== ADVISOR_LANGUAGE_MODEL_PRICING.model ||
          input.pricingVersion !== ADVISOR_LANGUAGE_MODEL_PRICING_VERSION ||
          input.inputUsdPerMillionTokens !==
            ADVISOR_LANGUAGE_MODEL_PRICING.inputUsdPerMillionTokens ||
          input.outputUsdPerMillionTokens !==
            ADVISOR_LANGUAGE_MODEL_PRICING.outputUsdPerMillionTokens ||
          !Number.isSafeInteger(input.maximumInputTokens) ||
          input.maximumInputTokens < 2048 ||
          input.maximumInputTokens > 67584 ||
          !Number.isSafeInteger(input.maximumOutputTokens) ||
          input.maximumOutputTokens < 256 ||
          input.maximumOutputTokens > 2048 ||
          Math.abs(
            maximumCostUsd -
              priceTokens(input.maximumInputTokens, input.maximumOutputTokens, input),
          ) > 1e-8
        )
          return { accepted: false, reason: 'invalid_pricing_reservation' };
        const prior = await one(transaction, 'advisor_ai_reservations', requestId);
        if (prior) return { accepted: false, reason: 'duplicate_request' };
        const pending = (
          await transaction.execute({
            sql: "SELECT id FROM advisor_ai_reservations WHERE status = 'pending' AND expires_at > ? LIMIT 1",
            args: [requestedAt],
          })
        ).rows[0];
        if (pending) return { accepted: false, reason: 'busy' };
        const latest = (
          await transaction.execute('SELECT MAX(requested_at) AS at FROM advisor_ai_reservations')
        ).rows[0];
        if (latest?.at !== null && requestedAt - Number(latest?.at) < minimumRequestIntervalMs)
          return { accepted: false, reason: 'rate_limited' };
        const day = new Date(requestedAt).toISOString().slice(0, 10);
        const total = (
          await transaction.execute({
            sql: 'SELECT COALESCE(SUM(charged_cost),0) AS total FROM advisor_ai_reservations WHERE utc_day = ?',
            args: [day],
          })
        ).rows[0];
        if (Number(total.total) + maximumCostUsd > maximumDailySpendUsd + 1e-10)
          return { accepted: false, reason: 'daily_budget_exhausted' };
        const saved = encode(input);
        // An abandoned request retains its full estimated cost. Expiry releases concurrency,
        // never the unknown spend; only a verified completion may reconcile the reservation.
        await transaction.execute({
          sql: 'INSERT INTO advisor_ai_reservations VALUES (?,?,?,?,?,?,?,?,?)',
          args: [
            requestId,
            requestedAt,
            reservationExpiresAt,
            day,
            maximumCostUsd,
            maximumCostUsd,
            'pending',
            saved.payload,
            saved.hash,
          ],
        });
        return { accepted: true, reservationId: requestId };
      });
    },
    completeReservation(input) {
      const captured = JSON.parse(encode(input).payload);
      return write(async (transaction) => {
        input = captured;
        const id = input.reservationId;
        const reservation = await one(transaction, 'advisor_ai_reservations', id);
        if (!reservation) fail('Inference completion requires its spend reservation.');
        const prior = await one(transaction, 'advisor_ai_completions', id);
        if (prior) {
          if (encode(prior).hash !== encode(input).hash)
            fail('A recorded inference completion cannot change.');
          return;
        }
        if (
          input.requestId !== reservation.requestId ||
          typeof input.requestStarted !== 'boolean' ||
          ![
            'completed',
            'canceled',
            'timeout',
            'provider_error',
            'refused',
            'incomplete',
            'invalid_response',
          ].includes(input.status) ||
          !Number.isSafeInteger(input.completedAt) ||
          input.completedAt < reservation.requestedAt ||
          input.completedAt > now() ||
          !Number.isFinite(input.costUsd) ||
          input.costUsd < 0 ||
          input.costUsd > reservation.maximumCostUsd + 1e-8
        )
          fail('Invalid inference cost or completion time.');
        const unknownUsage = input.inputTokens === null && input.outputTokens === null;
        const validUsage =
          Number.isSafeInteger(input.inputTokens) &&
          input.inputTokens > 0 &&
          input.inputTokens <= reservation.maximumInputTokens &&
          Number.isSafeInteger(input.outputTokens) &&
          input.outputTokens >= 0 &&
          input.outputTokens <= reservation.maximumOutputTokens;
        if (!unknownUsage && !validUsage) fail('Invalid inference token usage.');
        if (
          !input.requestStarted &&
          (!unknownUsage || !['canceled', 'timeout'].includes(input.status))
        )
          fail('An unstarted request cannot claim model usage or output.');
        const requiredCost = !input.requestStarted
          ? 0
          : unknownUsage
            ? reservation.maximumCostUsd
            : priceTokens(input.inputTokens, input.outputTokens, reservation);
        if (Math.abs(input.costUsd - requiredCost) > 1e-8)
          fail('Inference spend must match verified token usage or retain the full reservation.');
        const saved = encode(input);
        await transaction.execute({
          sql: 'INSERT INTO advisor_ai_completions VALUES (?,?,?)',
          args: [id, saved.payload, saved.hash],
        });
        await transaction.execute({
          sql: "UPDATE advisor_ai_reservations SET status = 'completed', charged_cost = ? WHERE id = ?",
          args: [input.costUsd, id],
        });
      });
    },
  };
}
