import 'server-only';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { getResearchDatabaseConfiguration } from '../research.repository';
import { createTradingAdvisorRepository } from './tradingAdvisor.repository';
import { createAdvisorAccount, getAdvisorPortfolio } from './tradingAdvisor.ledger';
import { getAdvisorDecisionPortfolio } from './advisorPortfolio.utils';
import { createTradingPolicyTrialRepository } from './tradingPolicyTrials.repository';
import { createTradingPolicyTrialService } from './tradingPolicyTrials.service';
import { createAdvisorHistoryTrialRepository } from './advisorHistoryTrials.repository';
import { createAdvisorHistoryTrialService } from './advisorHistoryTrials.service';
import { fetchKalshiPurchaseValue } from '@/services/kalshi/purchaseValue/purchaseValue.service';
import { fetchKalshiMarket } from '@/services/kalshi/kalshi.service';
import { getKalshiContract } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  TRADING_ADVISOR_POLICY,
  getTradingAdvice,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';
import { createAdvisorResearchPolicy } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorPolicy.utils';
import { getAdvisorForecastReconciliation } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorForecast.utils';

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Autonomous simulated positions; report readers never fetch prices or execute advice. */
export function createTradingAdvisorService({
  repository,
  loadBook = fetchKalshiPurchaseValue,
  loadMarket = fetchKalshiMarket,
  now = Date.now,
  policy = TRADING_ADVISOR_POLICY,
  researchPolicy = policy,
  trials = null,
  historyTrials = null,
  owner = randomUUID(),
}) {
  let advancing = null;
  let started = false;
  let pendingWrite = null;
  let nextWakeAt = 0;
  let lastHeartbeatAt = -Infinity;
  const outcomeAttempts = new Map();
  let trialInitialization = null;
  let historyInputs = [];
  async function ensureTrials() {
    if (!trials) return;
    trialInitialization ??= trials.ensureTrial(researchPolicy, now()).catch((error) => {
      trialInitialization = null;
      throw error;
    });
    await trialInitialization;
  }

  async function writeFrozen(method, args, lease) {
    pendingWrite = { method, args };
    const result = await repository[method]({ ...args, lease });
    pendingWrite = null;
    return result;
  }

  async function readBook(ticker, deadline = null) {
    const requestedAt = now();
    let timeout;
    try {
      const request = loadBook(ticker);
      const book =
        deadline === null
          ? await request
          : await Promise.race([
              request,
              new Promise((resolve) => {
                timeout = setTimeout(() => resolve(null), Math.max(1, deadline - requestedAt));
              }),
            ]);
      return book ? { ...book, requestedAt } : null;
    } catch {
      // A missing observation is saved as wait/no-fill, never another favorable attempt.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  function captureForecast(getForecast, options) {
    try {
      return copy(getForecast(options) ?? null);
    } catch {
      return {
        available: false,
        capturedAt: options?.now ?? now(),
        reason: 'Forecast capture failed.',
      };
    }
  }

  async function executePending(state, lease, getForecast) {
    const pending = state.account.pendingIntents.map((advice) => ({
      advice,
      attempt: state.attempts.find((row) => row.adviceId === advice.id),
      isMainAccount: true,
    }));
    if (trials) pending.push(...(await trials.getPendingExecutions()));
    if (historyTrials)
      pending.push(
        ...(await historyTrials.getPendingExecutions()).map((row) => ({
          ...row,
          isHistoryTrial: true,
        })),
      );
    const groups = new Map();
    for (const row of pending) {
      const { advice } = row;
      if (now() < advice.evaluatedAt + advice.policy.minimumFillDelayMs) continue;
      const group = groups.get(advice.contract.ticker) ?? [];
      group.push(row);
      groups.set(advice.contract.ticker, group);
    }

    let changed = false;
    for (const rows of groups.values()) {
      const contract = rows[0].advice.contract;
      const observedAt = now();
      const withinWindow = (advice) =>
        observedAt <= advice.evaluatedAt + advice.policy.maximumFillDelayMs &&
        observedAt < advice.contract.expiresAt;
      const executions = [];
      for (const { advice, attempt, isMainAccount } of rows) {
        if (!isMainAccount) continue;
        // A different writer cannot close an active request while it is in flight.
        if (attempt && attempt.leaseExpiresAt > observedAt && withinWindow(advice)) continue;
        const canRead =
          !attempt &&
          withinWindow(advice) &&
          (await repository.claimExecutionAttempt({
            adviceId: advice.id,
            requestedAt: now(),
            lease,
          }));
        executions.push({ advice, canRead });
      }
      const trialAttempt =
        trials &&
        rows.some(
          (row) =>
            !row.isMainAccount && !row.isHistoryTrial && !row.attempt && withinWindow(row.advice),
        )
          ? await trials.claimExecutionObservation(contract, now())
          : null;
      const historyAttempt =
        historyTrials &&
        rows.some((row) => row.isHistoryTrial && !row.attempt && withinWindow(row.advice))
          ? await historyTrials.claimExecutionObservation(contract, now())
          : null;
      const deadlines = executions
        .filter(({ canRead }) => canRead)
        .map(({ advice }) =>
          Math.min(
            advice.evaluatedAt + advice.policy.maximumFillDelayMs + 1,
            advice.contract.expiresAt,
          ),
        );
      if (trialAttempt) deadlines.push(trialAttempt.deadline);
      if (historyAttempt) deadlines.push(historyAttempt.deadline);
      const hasExpiredTrial = rows.some((row) => !row.isMainAccount && !withinWindow(row.advice));
      if (!executions.length && !trialAttempt && !historyAttempt && !hasExpiredTrial) continue;

      // One request serves all orders eligible at request time, including orders
      // belonging only to shadow accounts. Original execution deadlines still apply.
      const deadline = Math.min(...deadlines);
      const book =
        deadlines.length && now() < deadline ? await readBook(contract.ticker, deadline) : null;
      const recordedAt = now();
      // Recompute once from the inputs available after this exact execution book arrives.
      // This is shadow evidence: a delayed fill still obeys its immutable saved intention.
      const capturedForecast =
        book && executions.some(({ canRead }) => canRead)
          ? captureForecast(getForecast, { contract, book, now: recordedAt })
          : null;
      const { researchInputSnapshot = null, ...executionForecast } = capturedForecast ?? {};
      const sourceId = trialAttempt?.sourceId ?? `execution:${randomUUID()}`;
      if (trials) await trials.observe({ contract, book, observedAt: recordedAt, sourceId });
      if (historyTrials)
        historyInputs.push({
          kind: 'observation',
          contract,
          book,
          observedAt: recordedAt,
          sourceId: historyAttempt?.sourceId ?? sourceId,
          executionObservation: true,
        });
      for (const { advice, canRead } of executions) {
        await writeFrozen(
          'saveExecution',
          {
            adviceId: advice.id,
            book: canRead ? book : null,
            recordedAt,
            forecast: canRead && capturedForecast ? executionForecast : null,
            researchInputSnapshot: canRead ? researchInputSnapshot : null,
            observationAttemptToken: canRead ? lease.token : null,
          },
          lease,
        );
        changed = true;
      }
    }
    return changed;
  }

  async function resolveOutcomes(state, lease) {
    let changed = false;
    const pending = state.account.pendingComparisons.map((comparison) => comparison.contract);
    if (trials) pending.push(...(await trials.getPendingSettlementContracts()));
    if (historyTrials) pending.push(...(await historyTrials.getPendingSettlementContracts()));
    const contracts = new Map();
    for (const contract of pending)
      if (now() >= contract.expiresAt) contracts.set(contract.ticker, contract);
    // Retain retry limits until every account has received the official result.
    for (const ticker of outcomeAttempts.keys())
      if (!contracts.has(ticker)) outcomeAttempts.delete(ticker);
    for (const contract of contracts.values()) {
      if (now() - (outcomeAttempts.get(contract.ticker) ?? -Infinity) < 60_000) continue;
      outcomeAttempts.set(contract.ticker, now());
      let market;
      try {
        market = await loadMarket(contract.ticker);
      } catch {
        continue;
      }
      if (trials) await trials.settle({ market, observedAt: now() });
      if (historyTrials)
        historyInputs.push({
          kind: 'settlement',
          market,
          observedAt: now(),
          sourceId: `outcome:${contract.ticker}:${market?.receivedAt}`,
        });
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
    }
    return changed;
  }

  async function scheduleNextWake(state, contract) {
    const trialExecutions = trials ? await trials.getPendingExecutions() : [];
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
    for (const { advice, attempt } of trialExecutions) {
      deadlines.push(
        attempt
          ? Math.min(
              advice.evaluatedAt + advice.policy.maximumFillDelayMs + 1,
              advice.contract.expiresAt,
            )
          : advice.evaluatedAt + advice.policy.minimumFillDelayMs,
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

  async function advanceOnce({ market, getForecast, allowNewAdvice = true }) {
    if (!pendingWrite && now() < nextWakeAt) return;
    if (!started) {
      await repository.ensurePolicy(policy, now());
      await ensureTrials();
      started = true;
    }
    const lease = await repository.acquireLease(policy.id, owner);
    if (!lease) return;
    try {
      if (pendingWrite) {
        const { method, args } = pendingWrite;
        // Another fenced writer may have closed this intention while its original
        // request was delayed. Keep that committed result instead of retrying a
        // conflicting observation forever; the account and execution commit together.
        const executionAlreadyResolved =
          method === 'saveExecution' &&
          !(await repository.readState(policy.id)).account.pendingIntents.some(
            (intent) => intent.id === args.adviceId,
          );
        if (!executionAlreadyResolved) await repository[method]({ ...args, lease });
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
      if (await executePending(state, lease, getForecast))
        state = await repository.readState(policy.id);
      if (await resolveOutcomes(state, lease)) state = await repository.readState(policy.id);
      const contract = getKalshiContract(market);
      if (
        !allowNewAdvice ||
        !contract ||
        now() < contract.startsAt ||
        now() >= contract.expiresAt ||
        (state.account.lastAdviceAt !== null &&
          now() - state.account.lastAdviceAt < policy.cadenceMs)
      ) {
        await scheduleNextWake(state, contract);
        return;
      }

      // Full model replay inputs are retained only for entries/exits; every observation keeps
      // the exact probability/model identity and book needed to replay the adviser decision.
      const originalForecast = captureForecast(getForecast);
      const book = await readBook(contract.ticker);
      const evaluatedAt = now();
      const captured = captureForecast(getForecast, { contract, book, now: evaluatedAt });
      const { researchInputSnapshot = null, ...forecast } = captured ?? {};
      forecast.available = Boolean(forecast.available && researchInputSnapshot?.timing?.replayable);
      const forecastReconciliation = getAdvisorForecastReconciliation({
        contract,
        originalForecast,
        currentForecast: captured,
        book,
        now: evaluatedAt,
      });
      if (trials) await trials.observe({ contract, forecast, book, observedAt: evaluatedAt });
      // The original account keeps its own saved selection. Research transitions use a
      // different policy ID, so their simulated success cannot change this account's rules.
      const selectedPolicy = trials ? await trials.getActivePolicy(policy, evaluatedAt) : policy;
      const portfolio = getAdvisorDecisionPortfolio({
        account: state.account,
        book,
        now: evaluatedAt,
        policy: selectedPolicy,
        riskHistory: state.risk?.history ?? null,
      });
      const output = getTradingAdvice({
        contract,
        forecast,
        book,
        policy: selectedPolicy,
        now: evaluatedAt,
        portfolio,
      });
      const advice = {
        ...output,
        id: `${policy.id}:${contract.ticker}:${evaluatedAt}`,
        forecast,
        book,
        portfolio,
        forecastReconciliation,
        accountVersion: state.account.version,
        validUntil: Math.min(evaluatedAt + policy.cadenceMs, contract.expiresAt),
      };
      await writeFrozen('saveAdvice', { advice, researchInputSnapshot }, lease);
      if (historyTrials)
        historyInputs.push({
          kind: 'observation',
          contract,
          forecast,
          book,
          observedAt: evaluatedAt,
          sourceId: advice.id,
        });
      await scheduleNextWake(await repository.readState(policy.id), contract);
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
    async observeOutcome(market) {
      if (trials) {
        await ensureTrials();
        await trials.settle({ market, observedAt: now() });
      }
      if (historyTrials)
        await historyTrials.observe({
          kind: 'settlement',
          market,
          observedAt: now(),
          sourceId: `outcome:${market.ticker}:${market.receivedAt}`,
        });
    },
    advance(input) {
      if (advancing) return advancing;
      advancing = (async () => {
        if (historyTrials) await historyTrials.start().catch(() => {});
        try {
          await advanceOnce(input);
        } finally {
          // Apply shared history observations after releasing the incumbent's lease;
          // bounded AI inference remains outside its simulated execution transaction.
          const captured = historyInputs;
          historyInputs = [];
          for (const observation of captured) await historyTrials.observe(observation);
          if (historyTrials) {
            const observedAt = now();
            for (const { advice, attempt } of await historyTrials.getPendingExecutions()) {
              const deadline = attempt
                ? Math.min(
                    advice.evaluatedAt + advice.policy.maximumFillDelayMs + 1,
                    advice.contract.expiresAt,
                  )
                : advice.evaluatedAt + advice.policy.minimumFillDelayMs;
              nextWakeAt = Math.min(nextWakeAt, Math.max(observedAt + 1, deadline));
            }
          }
        }
      })().finally(() => {
        advancing = null;
      });
      return advancing;
    },
    async stop(status = 'stopped') {
      if (advancing) await advancing;
      if (historyTrials) await historyTrials.stop();
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
      const valuation = state.risk?.valuation ?? null;
      const hasCurrentValuation = Boolean(
        valuation &&
        valuation.accountVersion === account.version &&
        Number.isFinite(valuation.validUntil) &&
        asOf < valuation.validUntil &&
        valuation.observedAt <= asOf &&
        asOf - valuation.observedAt < 30000,
      );
      return {
        trials: trials ? await trials.getReport(researchPolicy.id) : null,
        historyTrials: historyTrials ? await historyTrials.getReport() : null,
        currentPlan: state.currentPlan ?? null,
        asOf,
        startedAt: state.startedAt,
        simulated: true,
        collector: collector ?? { status: 'not-started', heartbeatAt: null },
        policy: savedPolicy,
        portfolio,
        risk: {
          valuation,
          history: state.risk?.history ?? null,
          isCurrent: hasCurrentValuation,
        },
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

/** Select a saved configuration without restarting collection or discarding account history. */
export function createConfiguredTradingAdvisorService({
  repository,
  trialRepository,
  historyTrialRepository,
  now = Date.now,
  ...options
}) {
  let current = null;
  let currentPolicyId = null;
  let currentResearchPolicyId = null;
  let updating = Promise.resolve();
  async function select() {
    const configuration = await repository.readConfiguration();
    const policy = configuration.policy;
    let researchPolicy = policy.version === 2 ? createAdvisorResearchPolicy(policy) : policy;
    let drainingTrials = false;
    if (researchPolicy.id !== policy.id) {
      const researchTrial = trialRepository
        ? await trialRepository.readState(researchPolicy.id)
        : null;
      const researchHistory = historyTrialRepository
        ? await historyTrialRepository.getReport(researchPolicy.id)
        : null;
      if (!researchTrial && !researchHistory?.id) {
        const previousTrial = trialRepository ? await trialRepository.readState(policy.id) : null;
        const previousHistory = historyTrialRepository
          ? await historyTrialRepository.getReport(policy.id)
          : null;
        // Finish already recorded orders and settlements before freezing the old experiment.
        // This does not register a new account or change an existing policy during a report read.
        drainingTrials =
          Object.values(previousTrial?.strategies ?? {}).some(
            ({ account }) =>
              account.positions.length ||
              account.pendingIntents.length ||
              account.pendingComparisons.length,
          ) ||
          (previousHistory?.strategies ?? []).some(
            (strategy) =>
              strategy.openPositionCount ||
              strategy.pendingOrderCount ||
              strategy.pendingComparisonCount,
          );
        if (drainingTrials) researchPolicy = policy;
      }
    }
    if (currentPolicyId !== policy.id || currentResearchPolicyId !== researchPolicy.id) {
      if (current) await current.stop();
      current = createTradingAdvisorService({
        repository,
        now,
        ...options,
        policy: configuration.policy,
        researchPolicy,
        historyTrials: historyTrialRepository
          ? createAdvisorHistoryTrialService({
              repository: historyTrialRepository,
              policy: researchPolicy,
              now,
            })
          : null,
        trials:
          configuration.policy.version === 2 && trialRepository
            ? createTradingPolicyTrialService({ repository: trialRepository, now })
            : null,
      });
      currentPolicyId = configuration.policy.id;
      currentResearchPolicyId = researchPolicy.id;
    }
    return { service: current, configuration, researchPolicy, drainingTrials };
  }
  function serial(operation) {
    const result = updating.then(operation);
    updating = result.catch(() => {});
    return result;
  }
  return {
    advance: (input) =>
      serial(async () => {
        await repository.ensureDailyLossLimitRemoved();
        const { service, configuration, drainingTrials } = await select();
        // Drain old intentions before rolling over, without replacing them with another
        // old-policy order that would keep the migration waiting indefinitely.
        return service.advance({
          ...input,
          allowNewAdvice: configuration.policy.dailyLossLimitEnabled === false && !drainingTrials,
        });
      }),
    observeOutcome: (market) => serial(async () => (await select()).service.observeOutcome(market)),
    stop: (status) => serial(async () => current?.stop(status)),
    async getReport() {
      const { configuration, service, researchPolicy, drainingTrials } = await select();
      const report = await service.getReport();
      if (report.trials && trialRepository) {
        report.trials.previousExperiments = (await trialRepository.getReports()).filter(
          (trial) => trial.policyId !== researchPolicy.id,
        );
      }
      if (report.historyTrials && historyTrialRepository) {
        report.historyTrials.previousExperiments = (
          await historyTrialRepository.getReports()
        ).filter((trial) => trial.id !== report.historyTrials.id);
      }
      return { ...report, configuration, researchPolicy, drainingTrials };
    },
  };
}

let defaultStore;
async function getAdvisorStore() {
  defaultStore ??= (async () => {
    const configuration = getResearchDatabaseConfiguration();
    if (configuration.mode === 'local-database')
      await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
    const client = createClient(configuration);
    const repository = createTradingAdvisorRepository({ client });
    const trialRepository = createTradingPolicyTrialRepository({ client });
    const historyTrialRepository = createAdvisorHistoryTrialRepository({ client });
    return {
      repository,
      service: createConfiguredTradingAdvisorService({
        repository,
        trialRepository,
        historyTrialRepository,
      }),
    };
  })().catch((error) => {
    defaultStore = null;
    throw error;
  });
  return defaultStore;
}

export async function getTradingAdvisorReportFromStore() {
  return (await getAdvisorStore()).service.getReport();
}
export async function getAdvisorConfigurationFromStore() {
  return (await getAdvisorStore()).repository.readConfiguration();
}
export async function saveAdvisorConfigurationToStore(configuration) {
  return (await getAdvisorStore()).repository.configure(configuration);
}
