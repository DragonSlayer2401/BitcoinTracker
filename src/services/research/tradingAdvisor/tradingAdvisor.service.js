import 'server-only';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { getResearchDatabaseConfiguration } from '../research.repository';
import { createTradingAdvisorRepository } from './tradingAdvisor.repository';
import { createAdvisorAccount, getAdvisorPortfolio } from './tradingAdvisor.ledger';
import { fetchKalshiPurchaseValue } from '@/services/kalshi/purchaseValue/purchaseValue.service';
import { fetchKalshiMarket } from '@/services/kalshi/kalshi.service';
import { getKalshiContract } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  TRADING_ADVISOR_POLICY,
  getTradingAdvice,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Autonomous simulated positions; report readers never fetch prices or execute advice. */
export function createTradingAdvisorService({
  repository,
  loadBook = fetchKalshiPurchaseValue,
  loadMarket = fetchKalshiMarket,
  now = Date.now,
  policy = TRADING_ADVISOR_POLICY,
  owner = randomUUID(),
}) {
  let advancing = null;
  let started = false;
  let pendingWrite = null;
  let nextWakeAt = 0;
  let lastHeartbeatAt = -Infinity;
  const outcomeAttempts = new Map();

  async function writeFrozen(method, args, lease) {
    pendingWrite = { method, args };
    const result = await repository[method]({ ...args, lease });
    pendingWrite = null;
    return result;
  }

  async function readBook(ticker) {
    const requestedAt = now();
    try {
      return { ...(await loadBook(ticker)), requestedAt };
    } catch {
      // A missing observation is saved as wait/no-fill, never another favorable attempt.
      return null;
    }
  }

  async function executePending(state, lease) {
    let changed = false;
    for (const advice of state.account.pendingIntents) {
      const observedAt = now();
      if (observedAt < advice.evaluatedAt + policy.minimumFillDelayMs) continue;
      const attempt = state.attempts.find((row) => row.adviceId === advice.id);
      const withinWindow =
        observedAt <= advice.evaluatedAt + policy.maximumFillDelayMs &&
        observedAt < advice.contract.expiresAt;
      // A different writer cannot close an active request as no-fill while it is in flight.
      if (attempt && attempt.leaseExpiresAt > observedAt && withinWindow) continue;
      const canRead =
        !attempt &&
        withinWindow &&
        (await repository.claimExecutionAttempt({
          adviceId: advice.id,
          requestedAt: now(),
          lease,
        }));
      const book = canRead ? await readBook(advice.contract.ticker) : null;
      await writeFrozen(
        'saveExecution',
        {
          adviceId: advice.id,
          book,
          recordedAt: now(),
          observationAttemptToken: canRead ? lease.token : null,
        },
        lease,
      );
      changed = true;
    }
    return changed;
  }

  async function resolveOutcomes(state, lease) {
    let changed = false;
    const contracts = new Map();
    for (const comparison of state.account.pendingComparisons) {
      if (now() >= comparison.contract.expiresAt)
        contracts.set(comparison.contract.ticker, comparison.contract);
    }
    for (const contract of contracts.values()) {
      if (now() - (outcomeAttempts.get(contract.ticker) ?? -Infinity) < 60_000) continue;
      outcomeAttempts.set(contract.ticker, now());
      let market;
      try {
        market = await loadMarket(contract.ticker);
      } catch {
        continue;
      }
      for (const position of state.account.positions.filter(
        (row) => row.contract.ticker === contract.ticker,
      )) {
        const result = await writeFrozen(
          'saveSettlement',
          {
            policyId: policy.id,
            positionId: position.id,
            market,
            recordedAt: now(),
          },
          lease,
        );
        changed ||= Boolean(result);
      }
      const fresh = await repository.readState(policy.id);
      for (const comparison of fresh.account.pendingComparisons.filter(
        (row) => row.contract.ticker === contract.ticker,
      )) {
        const result = await writeFrozen(
          'saveComparison',
          {
            policyId: policy.id,
            positionId: comparison.positionId,
            market,
            recordedAt: now(),
          },
          lease,
        );
        changed ||= Boolean(result);
      }
      outcomeAttempts.delete(contract.ticker);
      // Keep only outstanding contracts in memory; a completed comparison never needs polling.
      const unresolved = await repository.readState(policy.id);
      if (
        unresolved.account.pendingComparisons.some((row) => row.contract.ticker === contract.ticker)
      )
        outcomeAttempts.set(contract.ticker, now());
    }
    return changed;
  }

  function scheduleNextWake(state, contract) {
    const observedAt = now();
    const deadlines = [observedAt + 10000];
    if (contract && observedAt < contract.expiresAt) {
      deadlines.push(
        Math.max(contract.startsAt, (state.account.lastAdviceAt ?? observedAt) + policy.cadenceMs),
      );
    }
    for (const intent of state.account.pendingIntents) {
      const attempt = state.attempts.find((row) => row.adviceId === intent.id);
      deadlines.push(
        attempt
          ? Math.min(attempt.leaseExpiresAt, intent.evaluatedAt + policy.maximumFillDelayMs + 1)
          : intent.evaluatedAt + policy.minimumFillDelayMs,
      );
    }
    for (const comparison of state.account.pendingComparisons) {
      deadlines.push(
        Math.max(
          comparison.contract.expiresAt,
          (outcomeAttempts.get(comparison.contract.ticker) ?? observedAt) + 60000,
        ),
      );
    }
    nextWakeAt = Math.max(observedAt + 1, Math.min(...deadlines));
  }

  async function advanceOnce({ market, getForecast }) {
    if (!pendingWrite && now() < nextWakeAt) return;
    if (!started) {
      await repository.ensurePolicy(policy, now());
      started = true;
    }
    const lease = await repository.acquireLease(policy.id, owner);
    if (!lease) return;
    try {
      if (pendingWrite) {
        const { method, args } = pendingWrite;
        await repository[method]({ ...args, lease });
        pendingWrite = null;
      }
      if (now() - lastHeartbeatAt >= 10000) {
        await repository.writeHeartbeat(
          { policyId: policy.id, status: 'running', heartbeatAt: now() },
          lease,
        );
        lastHeartbeatAt = now();
      }
      let state = await repository.readState(policy.id);
      if (await executePending(state, lease)) state = await repository.readState(policy.id);
      if (await resolveOutcomes(state, lease)) state = await repository.readState(policy.id);
      const contract = getKalshiContract(market);
      if (
        !contract ||
        now() < contract.startsAt ||
        now() >= contract.expiresAt ||
        (state.account.lastAdviceAt !== null &&
          now() - state.account.lastAdviceAt < policy.cadenceMs)
      ) {
        scheduleNextWake(state, contract);
        return;
      }

      // Full model replay inputs are retained only for entries/exits; every observation keeps
      // the exact probability/model identity and book needed to replay the adviser decision.
      const captured = copy(getForecast() ?? { available: false, capturedAt: now() });
      const { researchInputSnapshot = null, ...forecast } = captured;
      forecast.available = Boolean(forecast.available && researchInputSnapshot?.timing?.replayable);
      const book = await readBook(contract.ticker);
      const evaluatedAt = now();
      const portfolio = getAdvisorPortfolio(state.account, evaluatedAt);
      const output = getTradingAdvice({
        contract,
        forecast,
        book,
        policy,
        now: evaluatedAt,
        portfolio,
      });
      const advice = {
        ...output,
        id: `${policy.id}:${contract.ticker}:${evaluatedAt}`,
        forecast,
        book,
        portfolio,
        accountVersion: state.account.version,
        validUntil: Math.min(evaluatedAt + policy.cadenceMs, contract.expiresAt),
      };
      await writeFrozen('saveAdvice', { advice, researchInputSnapshot }, lease);
      scheduleNextWake(await repository.readState(policy.id), contract);
    } catch (error) {
      nextWakeAt = 0;
      lastHeartbeatAt = -Infinity;
      await repository
        .writeHeartbeat({ policyId: policy.id, status: 'error', heartbeatAt: now() }, lease)
        .catch(() => {});
      throw error;
    } finally {
      await repository.releaseLease(lease);
    }
  }

  return {
    advance(input) {
      if (advancing) return advancing;
      advancing = advanceOnce(input).finally(() => {
        advancing = null;
      });
      return advancing;
    },
    async stop(status = 'stopped') {
      if (advancing) await advancing;
      if (!started) return;
      const lease = await repository.acquireLease(policy.id, owner);
      if (!lease) return;
      try {
        await repository.writeHeartbeat({ policyId: policy.id, status, heartbeatAt: now() }, lease);
      } finally {
        await repository.releaseLease(lease);
      }
    },
    async getReport() {
      const state = await repository.readState(policy.id);
      const asOf = now();
      const savedPolicy = state.policy ?? policy;
      const account = state.account ?? createAdvisorAccount(savedPolicy);
      const portfolio = getAdvisorPortfolio(account, asOf);
      const collector = await repository.readHeartbeat(policy.id);
      const latest = state.advice[0] ?? null;
      const execution =
        latest &&
        state.events.find(
          (row) => row.adviceId === latest.id && ['fill', 'no-fill'].includes(row.kind),
        );
      const latestAdvice = latest
        ? {
            ...latest,
            executionStatus: account.pendingIntents.some((row) => row.id === latest.id)
              ? 'pending'
              : execution?.kind === 'fill'
                ? 'filled'
                : (execution?.kind ?? null),
          }
        : null;
      const performance = account.performance;
      return {
        asOf,
        startedAt: state.startedAt,
        simulated: true,
        collector: collector ?? { status: 'not-started', heartbeatAt: null },
        policy: savedPolicy,
        portfolio,
        latestAdvice,
        recentActivity: [
          ...state.advice.map((advice) => ({
            ...advice,
            kind: 'advice',
            recordedAt: advice.evaluatedAt,
          })),
          ...state.events,
        ]
          .sort((left, right) => right.recordedAt - left.recordedAt)
          .slice(0, 50),
        performance: {
          ...performance,
          realizationWinCount: performance.winCount,
          realizationLossCount: performance.lossCount,
          realizedPnl: account.realizedPnl,
          totalFees: account.feesPaid,
          returnOnInitialCapital: account.realizedPnl / savedPolicy.initialBankroll,
          profitFactor:
            performance.grossLosses > 0 ? performance.grossProfits / performance.grossLosses : null,
          pairedAdvantage: performance.pairedStrategyPnl - performance.pairedHoldPnl,
          pendingComparisonCount: account.pendingComparisons.length,
          adviceAgeMs: latest ? Math.max(0, asOf - latest.evaluatedAt) : null,
        },
      };
    },
  };
}

let defaultService;
export async function getTradingAdvisorReportFromStore() {
  defaultService ??= (async () => {
    const configuration = getResearchDatabaseConfiguration();
    if (configuration.mode === 'local-database')
      await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
    return createTradingAdvisorService({
      repository: createTradingAdvisorRepository({ client: createClient(configuration) }),
    });
  })().catch((error) => {
    defaultService = null;
    throw error;
  });
  return (await defaultService).getReport();
}
