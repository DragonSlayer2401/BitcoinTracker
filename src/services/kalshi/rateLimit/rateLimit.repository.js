import 'server-only';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { getResearchWriteTransaction } from '../../research/research.connection';
import { KalshiDataError } from '../kalshi.validation';
import {
  createKalshiRatePolicy,
  getKalshiReadCost,
  getKalshiReadResource,
} from './rateLimit.policy';

const TABLE = 'kalshi_rate_limit_state';
const BOOTSTRAP_RATE = 50;
const MAXIMUM_POLICY_BYTES = 100_000;
const LOCK_RETRY_DELAYS_MS = [20, 40, 80];
const storageMessage =
  'Kalshi requests are paused because the shared API rate-limit database is unavailable. Restore its connection or release its database lock, then retry.';

function unavailable(message = storageMessage) {
  return new KalshiDataError(message, 503);
}

const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositive = (value) => Number.isFinite(value) && value > 0;

function validatePolicy(policy) {
  if (
    !policy ||
    typeof policy.credentialFingerprint !== 'string' ||
    !policy.credentialFingerprint ||
    policy.credentialFingerprint.length > 256 ||
    !isTimestamp(policy.checkedAt) ||
    !isTimestamp(policy.expiresAt) ||
    policy.expiresAt <= policy.checkedAt ||
    !isPositive(policy.refillRate) ||
    policy.refillRate > 100 ||
    !isPositive(policy.bucketCapacity) ||
    policy.bucketCapacity > 100 ||
    !Number.isSafeInteger(policy.defaultCost) ||
    policy.defaultCost < 0 ||
    !Array.isArray(policy.endpointCosts)
  ) {
    throw unavailable('Kalshi requests are paused because the saved API limit policy is invalid.');
  }
  let validated;
  try {
    validated = createKalshiRatePolicy(
      { read: policy.reportedRead, write: policy.reportedWrite },
      { default_cost: policy.defaultCost, endpoint_costs: policy.endpointCosts },
      { credentialFingerprint: policy.credentialFingerprint, now: policy.checkedAt },
    );
  } catch {
    throw unavailable('Kalshi requests are paused because the saved API limit policy is invalid.');
  }
  if (
    policy.refillRate > validated.refillRate ||
    policy.bucketCapacity > validated.bucketCapacity ||
    policy.expiresAt > validated.expiresAt
  ) {
    throw unavailable('Kalshi requests are paused because the saved API limit policy is invalid.');
  }
  if (JSON.stringify(policy).length > MAXIMUM_POLICY_BYTES) throw unavailable();
  return policy;
}

function readState(row) {
  if (
    !row ||
    Number(row.schema_version) !== 1 ||
    !Number.isFinite(Number(row.tokens)) ||
    Number(row.tokens) < 0 ||
    Number(row.tokens) > 100 ||
    !isTimestamp(Number(row.updated_at)) ||
    !isTimestamp(Number(row.blocked_until)) ||
    !isTimestamp(Number(row.last_bootstrap_at)) ||
    !Number.isSafeInteger(Number(row.failure_count)) ||
    Number(row.failure_count) < 0 ||
    Number(row.failure_count) > 10
  ) {
    throw unavailable('Kalshi requests are paused because the shared API limit state is invalid.');
  }
  return {
    tokens: Number(row.tokens),
    updatedAt: Number(row.updated_at),
    blockedUntil: Number(row.blocked_until),
    lastBootstrapAt: Number(row.last_bootstrap_at),
    failureCount: Number(row.failure_count),
    policy: row.policy === null ? null : validatePolicy(JSON.parse(row.policy)),
  };
}

export function getKalshiRateLimitDatabaseConfiguration(environment = process.env) {
  const isHosted = Boolean(
    environment.VERCEL || environment.AWS_LAMBDA_FUNCTION_NAME || environment.NETLIFY,
  );
  const configuredUrl =
    environment.KALSHI_RATE_LIMIT_DATABASE_URL ||
    (/^(?:libsql|https):/.test(environment.TURSO_DATABASE_URL || '')
      ? environment.TURSO_DATABASE_URL
      : null);
  const url =
    configuredUrl || pathToFileURL(path.resolve(process.cwd(), 'data/kalshi-rate-limits.db')).href;
  const isLocal = url.startsWith('file:');
  if (isHosted && isLocal) {
    throw unavailable(
      'Hosted Kalshi requests require a shared remote KALSHI_RATE_LIMIT_DATABASE_URL or TURSO_DATABASE_URL.',
    );
  }
  if (!/^(?:libsql|https|file):/.test(url) || /:memory:|[?&]mode=memory/.test(url)) {
    throw unavailable(
      'Kalshi API rate limits require a durable file, libsql, or HTTPS database URL.',
    );
  }
  const authToken =
    environment.KALSHI_RATE_LIMIT_AUTH_TOKEN || environment.TURSO_AUTH_TOKEN || undefined;
  if (!isLocal && !authToken) {
    throw unavailable(
      'Set KALSHI_RATE_LIMIT_AUTH_TOKEN or TURSO_AUTH_TOKEN for the shared API rate-limit database.',
    );
  }
  return { url, authToken: isLocal ? undefined : authToken };
}

export function createKalshiRateLimitRepository({ client, now }) {
  let pendingOperation = Promise.resolve();

  async function getTime(transaction) {
    const value = now
      ? now()
      : Number(
          (
            await transaction.execute(
              "SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) AS timestamp",
            )
          ).rows[0].timestamp,
        );
    if (!isTimestamp(value)) throw unavailable();
    return value;
  }

  async function getState(transaction, timestamp) {
    const schema = await transaction.execute({
      sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
      args: ['table', TABLE],
    });
    if (schema.rows.length === 0) {
      await transaction.execute(`CREATE TABLE ${TABLE} (
        state_id TEXT PRIMARY KEY CHECK(state_id = 'deployment'),
        schema_version INTEGER NOT NULL,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL,
        last_bootstrap_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        policy TEXT
      )`);
      await transaction.execute({
        sql: `INSERT INTO ${TABLE} VALUES ('deployment', 1, 0, ?, 0, 0, 0, NULL)`,
        args: [timestamp],
      });
    }
    const result = await transaction.execute(`SELECT * FROM ${TABLE}`);
    if (result.rows.length !== 1 || result.rows[0].state_id !== 'deployment') throw unavailable();
    return readState(result.rows[0]);
  }

  async function saveState(transaction, state) {
    await transaction.execute({
      sql: `UPDATE ${TABLE} SET tokens = ?, updated_at = ?, blocked_until = ?, last_bootstrap_at = ?, failure_count = ?, policy = ? WHERE state_id = 'deployment'`,
      args: [
        state.tokens,
        state.updatedAt,
        state.blockedUntil,
        state.lastBootstrapAt,
        state.failureCount,
        state.policy ? JSON.stringify(state.policy) : null,
      ],
    });
  }

  async function runTransaction(operation) {
    let transaction;
    try {
      transaction = await getResearchWriteTransaction(client);
      const timestamp = await getTime(transaction);
      const state = await getState(transaction, timestamp);
      const value = await operation({ transaction, timestamp, state });
      await transaction.commit();
      return value;
    } finally {
      transaction?.close();
    }
  }

  function runOperation(operation) {
    const result = pendingOperation.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await runTransaction(operation);
        } catch (error) {
          const isLocked = error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
          if (isLocked && attempt < LOCK_RETRY_DELAYS_MS.length) {
            // The previous transaction is closed before waiting or reacquiring its lock.
            // An uncertain commit may consume extra tokens; it can never refund them.
            await waitForRetry(LOCK_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          if (error instanceof KalshiDataError) throw error;
          throw unavailable();
        }
      }
    });
    pendingOperation = result.catch(() => {});
    return result;
  }

  return {
    getPolicy(credentialFingerprint) {
      return runOperation(({ state, timestamp }) => {
        const policy = state.policy;
        return policy &&
          policy.credentialFingerprint === credentialFingerprint &&
          policy.checkedAt <= timestamp &&
          policy.expiresAt > timestamp
          ? policy
          : null;
      });
    },

    savePolicy(policy) {
      return runOperation(async ({ transaction, state, timestamp }) => {
        validatePolicy(policy);
        if (policy.expiresAt <= timestamp || policy.checkedAt > timestamp) throw unavailable();
        if (state.policy && policy.checkedAt < state.policy.checkedAt) return;
        state.policy = policy;
        // Refreshing limits or rotating credentials cannot create a new burst budget.
        state.tokens = Math.min(state.tokens, policy.bucketCapacity);
        state.updatedAt = Math.max(state.updatedAt, timestamp);
        await saveState(transaction, state);
      });
    },

    reserve({ cost, bootstrap = false, path: requestPath, credentialFingerprint } = {}) {
      return runOperation(async ({ transaction, state, timestamp }) => {
        const policy = state.policy;
        if (bootstrap && requestPath && !getKalshiReadResource(requestPath).isDiscovery) {
          throw new KalshiDataError(
            'Only Kalshi API limit discovery can use the bootstrap budget.',
            400,
          );
        }
        if (
          !bootstrap &&
          (!policy ||
            policy.checkedAt > timestamp ||
            policy.expiresAt <= timestamp ||
            (credentialFingerprint && policy.credentialFingerprint !== credentialFingerprint))
        ) {
          throw unavailable(
            'Kalshi requests are paused until current account API limits are verified.',
          );
        }
        let requiredCost = cost;
        if (requestPath && policy) requiredCost = getKalshiReadCost(policy, requestPath);
        if (bootstrap) requiredCost = Math.max(BOOTSTRAP_RATE, requiredCost || 0);
        if (!isPositive(requiredCost))
          throw unavailable('The Kalshi request token cost is invalid.');
        const capacity = bootstrap
          ? Math.min(BOOTSTRAP_RATE, policy?.bucketCapacity ?? BOOTSTRAP_RATE)
          : policy.bucketCapacity;
        const refillRate = bootstrap
          ? Math.min(BOOTSTRAP_RATE, policy?.refillRate ?? BOOTSTRAP_RATE)
          : policy.refillRate;
        if (requiredCost > capacity) {
          throw unavailable(
            'The Kalshi request cost exceeds the configured safe API token capacity.',
          );
        }
        state.tokens = Math.min(
          capacity,
          state.tokens + (Math.max(0, timestamp - state.updatedAt) * refillRate) / 1000,
        );
        state.updatedAt = Math.max(state.updatedAt, timestamp);
        const waitMs = Math.max(
          0,
          state.blockedUntil - timestamp,
          bootstrap ? state.lastBootstrapAt + 1000 - timestamp : 0,
          requiredCost > state.tokens
            ? Math.max(0, state.updatedAt - timestamp) +
                Math.ceil(((requiredCost - state.tokens) * 1000) / refillRate)
            : 0,
        );
        const allowed = waitMs === 0;
        if (allowed) {
          state.tokens -= requiredCost;
          if (bootstrap) state.lastBootstrapAt = timestamp;
        }
        await saveState(transaction, state);
        return { allowed, waitMs };
      });
    },

    block({ retryAfterMs = 0 } = {}) {
      return runOperation(async ({ transaction, state, timestamp }) => {
        if (!isTimestamp(retryAfterMs)) throw unavailable();
        state.failureCount = Math.min(10, state.failureCount + 1);
        const delay = Math.max(
          retryAfterMs,
          Math.min(60_000, 2000 * 2 ** (state.failureCount - 1)),
        );
        const blockedUntil = Math.max(state.blockedUntil, timestamp + delay);
        if (!isTimestamp(blockedUntil)) throw unavailable();
        state.blockedUntil = blockedUntil;
        state.tokens = 0;
        state.updatedAt = Math.max(state.updatedAt, timestamp);
        await saveState(transaction, state);
        return { waitMs: state.blockedUntil - timestamp };
      });
    },

    // A different in-flight request succeeding must not clear shared throttling.
    async noteSuccess() {},
  };
}

let repositoryPromise;

export function getKalshiRateLimitRepository() {
  if (!repositoryPromise) {
    repositoryPromise = (async () => {
      const configuration = getKalshiRateLimitDatabaseConfiguration();
      if (configuration.url.startsWith('file:')) {
        await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
      }
      return createKalshiRateLimitRepository({ client: createClient(configuration) });
    })().catch((error) => {
      repositoryPromise = undefined;
      if (error instanceof KalshiDataError) throw error;
      throw unavailable();
    });
  }
  return repositoryPromise;
}
