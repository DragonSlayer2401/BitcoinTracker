import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  getTradingPolicyPendingExecutions,
  getTradingPolicyTrialReport,
} from './tradingPolicyTrials.utils';

/** Consume the collector's existing observations; this service has no exchange API client. */
export function createTradingPolicyTrialService({ repository, now = Date.now }) {
  let policyId = null;
  return {
    async ensureTrial(policy, registeredAt = now()) {
      const state = await repository.ensureTrial(policy, registeredAt);
      policyId = policy.id;
      return getTradingPolicyTrialReport(state, now());
    },
    async getPendingExecutions() {
      return getTradingPolicyPendingExecutions(
        policyId ? await repository.readState(policyId) : null,
      );
    },
    async getPendingSettlementContracts() {
      const state = policyId ? await repository.readState(policyId) : null;
      return (state?.contracts ?? []).filter((row) => !row.outcome).map((row) => row.contract);
    },
    async claimExecutionObservation(contract, observedAt = now()) {
      if (!policyId) return null;
      const sourceId = `execution:${randomUUID()}`;
      const state = await repository.record(policyId, {
        kind: 'execution-request',
        contract,
        observedAt,
        sourceId,
      });
      return (
        getTradingPolicyPendingExecutions(state).find(
          ({ attempt }) => attempt?.sourceId === sourceId,
        )?.attempt ?? null
      );
    },
    observe({ contract = null, forecast, book = null, observedAt = now(), sourceId }) {
      if (!policyId) return Promise.resolve(null);
      const input = { kind: 'observation', contract, book, observedAt };
      if (sourceId !== undefined) input.sourceId = sourceId;
      if (forecast !== undefined) {
        // Keep replayable prediction identity/probability, without copying the large raw
        // research snapshot again into each strategy's prospective trading journal.
        const { researchInputSnapshot, ...capturedForecast } = forecast ?? {};
        input.forecast = capturedForecast;
      }
      return repository.record(policyId, input);
    },
    settle({ market, observedAt = now() }) {
      if (!policyId) return Promise.resolve(null);
      return repository.record(policyId, { kind: 'settlement', market, observedAt });
    },
    async getReport(selectedPolicyId = policyId) {
      const state = selectedPolicyId ? await repository.readState(selectedPolicyId) : null;
      return getTradingPolicyTrialReport(state, now());
    },
    async getActivePolicy(basePolicy, at = now()) {
      return (await repository.getSelection(basePolicy.id, at)) ?? basePolicy;
    },
  };
}
