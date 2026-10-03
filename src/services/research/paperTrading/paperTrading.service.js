import 'server-only';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { getResearchDatabaseConfiguration } from '../research.repository';
import { createPaperTradingRepository } from './paperTrading.repository';
import { fetchKalshiPurchaseValue } from '@/services/kalshi/purchaseValue/purchaseValue.service';
import { fetchKalshiMarket } from '@/services/kalshi/kalshi.service';
import { getKalshiContract } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  PAPER_TRADING_POLICY,
  createPaperDecision,
  simulatePaperFill,
  settlePaperPosition,
  getPaperPortfolio,
  getPaperTradingReport,
} from '@/features/BitcoinTracker/features/PaperTrading/utils/paperTrading.utils';

/** One prospective paper policy. Only the collector calls advance; report reads never trade. */
export function createPaperTradingService({
  repository,
  loadBook = fetchKalshiPurchaseValue,
  loadMarket = fetchKalshiMarket,
  now = Date.now,
  policy = PAPER_TRADING_POLICY,
}) {
  let state = null;
  let pendingDecision = null;
  let pendingEvent = null;
  let lastHeartbeatAt = -Infinity;
  const outcomeAttempts = new Map();
  let advancing = null;

  async function reload() {
    state = await repository.readState(policy.id);
  }

  async function heartbeat(status = 'running') {
    const heartbeatAt = now();
    if (status === 'running' && heartbeatAt - lastHeartbeatAt < 10_000) return;
    await repository.writeHeartbeat({ policyId: policy.id, heartbeatAt, status });
    lastHeartbeatAt = heartbeatAt;
  }

  // Persist each frozen result before any dependent action. Unknown commit outcomes retry
  // the identical payload instead of recalculating a better-looking price or probability.
  async function flush() {
    if (pendingDecision) {
      try {
        await repository.saveDecision(pendingDecision);
      } catch (error) {
        await reload();
        if (state.decisions.some((row) => row.id === pendingDecision.id)) {
          pendingDecision = null;
        } else if (error.code === 'PAPER_CAPITAL_CHANGED') {
          pendingDecision = createPaperDecision({
            contract: pendingDecision.contract,
            forecast: pendingDecision.forecast,
            book: pendingDecision.book,
            now: pendingDecision.decidedAt,
            portfolio: getPaperPortfolio({ ...state, policy, now: now() }),
            policy,
          });
          await repository.saveDecision(pendingDecision);
        } else throw error;
      }
      pendingDecision = null;
      await reload();
    }
    if (pendingEvent) {
      try {
        await repository.saveEvent(pendingEvent);
      } catch (error) {
        await reload();
        if (!state.events.some((row) => row.id === pendingEvent.id)) throw error;
      }
      pendingEvent = null;
      await reload();
    }
  }

  async function readBook(ticker) {
    const requestedAt = now();
    try {
      return { ...(await loadBook(ticker)), requestedAt };
    } catch {
      // Failed requests are recorded as skips/no-fills, never retried for a nicer price.
      return null;
    }
  }

  async function advanceOnce({ market, getForecast }) {
    if (!state) {
      await repository.ensurePolicy(policy, now());
      await reload();
    }
    await flush();
    await heartbeat();
    const contract = getKalshiContract(market);
    const observedAt = now();
    const checkpointAt = contract?.expiresAt - policy.checkpointMinutes * 60_000;
    if (
      contract &&
      observedAt >= checkpointAt &&
      observedAt < contract.expiresAt &&
      !state.decisions.some((row) => row.contract.ticker === contract.ticker)
    ) {
      // The callback captures current inputs synchronously before the first book request.
      const withinWindow = observedAt <= checkpointAt + policy.captureGraceMs;
      const forecast = withinWindow
        ? getForecast()
        : { available: false, capturedAt: observedAt, reason: 'The entry checkpoint was missed.' };
      const book = withinWindow && forecast?.available ? await readBook(contract.ticker) : null;
      pendingDecision = createPaperDecision({
        contract,
        forecast,
        book,
        now: now(),
        portfolio: getPaperPortfolio({ ...state, policy, now: now() }),
        policy,
      });
      await flush();
    }

    for (const decision of state.decisions) {
      if (decision.status !== 'intent') continue;
      let execution = state.events.find((row) => row.id === `${decision.id}:execution`);
      if (!execution && now() >= decision.decidedAt + policy.minimumFillDelayMs) {
        // Commit an attempt before reading its price. After a crash, an unknown request
        // outcome becomes no-fill instead of granting a second, possibly better book.
        const withinFillWindow = now() <= decision.decidedAt + policy.maximumFillDelayMs;
        const canRequest = withinFillWindow
          ? await repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: now() })
          : false;
        const book = canRequest ? await readBook(decision.contract.ticker) : null;
        pendingEvent = simulatePaperFill({ decision, book, now: now() });
        if (pendingEvent) await flush();
        execution = state.events.find((row) => row.id === `${decision.id}:execution`);
      }
      if (
        execution?.kind !== 'fill' ||
        now() < decision.contract.expiresAt ||
        state.events.some((row) => row.id === `${decision.id}:settlement`) ||
        now() - (outcomeAttempts.get(decision.id) ?? -Infinity) < 60_000
      )
        continue;
      outcomeAttempts.set(decision.id, now());
      let outcome;
      try {
        outcome = await loadMarket(decision.contract.ticker);
      } catch {
        // Retain the position and reserved risk until its exact official outcome is known.
        continue;
      }
      pendingEvent = settlePaperPosition({
        decision,
        fill: execution,
        market: outcome,
        now: now(),
      });
      if (pendingEvent) await flush();
    }
  }

  return {
    advance(input) {
      if (advancing) return advancing;
      advancing = advanceOnce(input)
        .catch(async (error) => {
          await heartbeat('error').catch(() => {});
          throw error;
        })
        .finally(() => {
          advancing = null;
        });
      return advancing;
    },
    async stop(status = 'stopped') {
      if (advancing) await advancing;
      if (state) await heartbeat(status);
    },
    async getReport() {
      const saved = await repository.readState(policy.id);
      const collector = await repository.readHeartbeat(policy.id);
      const asOf = now();
      return {
        policy: saved.policy ?? policy,
        startedAt: saved.startedAt,
        asOf,
        collector: collector ?? { status: 'not-started', heartbeatAt: null },
        summary: getPaperTradingReport({ ...saved, policy: saved.policy ?? policy, now: asOf }),
      };
    },
  };
}

let defaultService;
export async function getPaperTradingReportFromStore() {
  if (!defaultService) {
    defaultService = (async () => {
      const configuration = getResearchDatabaseConfiguration();
      if (configuration.mode === 'local-database')
        await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
      return createPaperTradingService({
        repository: createPaperTradingRepository({ client: createClient(configuration) }),
      });
    })().catch((error) => {
      defaultService = null;
      throw error;
    });
  }
  return (await defaultService).getReport();
}
