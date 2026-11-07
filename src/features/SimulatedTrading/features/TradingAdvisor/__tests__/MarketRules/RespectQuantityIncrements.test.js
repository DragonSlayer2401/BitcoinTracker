import { createPaperDecision } from '../../../PaperTrading/utils/paperTrading.utils';
import { createTradingAdvisorPolicy } from '../../utils/advisorPolicy.utils';
import { getTradingAdvice, simulateTradingExecution } from '../../utils/tradingAdvisor.utils';
import {
  ADVISOR_CANDIDATE_VERSIONS,
  getAdvisorCandidateEvidence,
  simulateAdvisorCandidateExecution,
} from '../../features/Experiments/utils/advisorCandidate.utils';
import {
  createMarketMetadata,
  createQuantityRuleEvidence,
  createSpecifiedMarket,
  createTradingInputs,
} from '../helpers/marketRulesFixtures';

const createTwoContractInputs = () => {
  const raw = createMarketMetadata();
  const now = Date.parse(raw.open_time) + 360_000;
  const contract = createSpecifiedMarket({
    raw,
    quantityRuleEvidence: createQuantityRuleEvidence(raw, now, { minimum: '2', step: '2' }),
  });
  const inputs = createTradingInputs(contract);
  const policy = createTradingAdvisorPolicy({ allocation: 15 });
  return {
    ...inputs,
    policy,
    portfolio: {
      ...inputs.portfolio,
      cash: 15,
      accountVersion: 0,
      valuation: {
        complete: true,
        policyId: policy.id,
        observedAt: now,
        validUntil: now + 30_000,
        executableEquity: 15,
        liquidationValue: 0,
      },
    },
  };
};

test('an integer strategy skips unavailable one-contract sizes and buys and fills two legal contracts', () => {
  const inputs = createTwoContractInputs();
  const advice = getTradingAdvice(inputs);
  expect(advice).toMatchObject({ action: 'buy', side: 'yes', quantity: 2 });
  const now = inputs.now + 3000;
  const execution = simulateTradingExecution({
    ...inputs,
    advice,
    now,
    book: { ...inputs.book, requestedAt: now, receivedAt: now },
  });
  expect(execution).toMatchObject({ kind: 'fill', quantity: 2, canceledQuantity: 0 });
  expect(execution.fills).toEqual([{ price: 0.41, quantity: 2 }]);
});

test('candidate exits skip an illegal reduction and can fill the legal two-contract exit', () => {
  const inputs = createTwoContractInputs();
  inputs.portfolio.positions = [
    {
      id: 'synthetic-two-contract-position',
      contract: inputs.contract,
      side: 'yes',
      quantity: 2,
      availableQuantity: 2,
      costBasis: 0.86,
    },
  ];
  inputs.portfolio.openRisk = 0.86;
  const evidence = getAdvisorCandidateEvidence({
    ...inputs,
    snapshotId: 'synthetic-quantity-test',
  });
  expect(evidence.available).toBe(true);
  expect(evidence.options.some((option) => option.action === 'REDUCE')).toBe(false);
  const exit = evidence.options.find((option) => option.action === 'EXIT');
  expect(exit.advice.quantity).toBe(2);
  const advice = {
    ...exit.advice,
    candidatePolicyVersion: ADVISOR_CANDIDATE_VERSIONS.rules,
    candidateAction: 'EXIT',
  };
  const now = inputs.now + 3000;
  const execution = simulateAdvisorCandidateExecution({
    ...inputs,
    advice,
    now,
    book: { ...inputs.book, requestedAt: now, receivedAt: now },
  });
  expect(execution).toMatchObject({ kind: 'fill', quantity: 2, canceledQuantity: 0 });
});

test('the existing one-contract paper strategy skips a two-contract minimum without resizing its policy', () => {
  const { policy: _advisorPolicy, ...inputs } = createTwoContractInputs();
  const decision = createPaperDecision(inputs);
  expect(decision).toMatchObject({ status: 'skipped', reason: 'invalid_market_price_or_quantity' });
});

test('conflicting administrative expiration blocks advice even with explicit synthetic quantity and rounding evidence', () => {
  const contract = createSpecifiedMarket({
    raw: createMarketMetadata({
      expiration_time: '2026-11-08T04:00:00Z',
      latest_expiration_time: '2026-11-08T04:00:00Z',
    }),
  });
  expect(contract.specification.verification.status).toBe('conflicting');
  expect(contract.specification.verification.reasons).toContain(
    'contract_expiration_schedule_conflict',
  );
  expect(getTradingAdvice(createTradingInputs(contract))).toMatchObject({
    action: 'wait',
    quantity: 0,
  });
});
