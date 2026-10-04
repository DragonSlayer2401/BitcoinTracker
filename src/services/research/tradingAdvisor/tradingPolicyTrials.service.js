import 'server-only';
import { getTradingPolicyTrialReport } from './tradingPolicyTrials.utils';

/** Consume the collector's existing observations; this service has no exchange API client. */
export function createTradingPolicyTrialService({ repository, now = Date.now }) {
  let policyId = null;
  return {
    async ensureTrial(policy, registeredAt = now()) {
      const state = await repository.ensureTrial(policy, registeredAt);
      policyId = policy.id;
      return getTradingPolicyTrialReport(state, now());
    },
    observe({ contract = null, forecast, book = null, observedAt = now() }) {
      if (!policyId) return Promise.resolve(null);
      const input = { kind: 'observation', contract, book, observedAt };
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
