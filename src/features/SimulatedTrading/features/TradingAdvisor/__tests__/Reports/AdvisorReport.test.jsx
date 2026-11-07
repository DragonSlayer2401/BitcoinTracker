import './setup';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client/node';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { researchApi } from '@/services/research/research.api';
import { researchErrorResponse } from '@/services/research/research.http';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createTradingPolicyTrialRepository } from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createConfiguredTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { createAdvisorAccount } from '../../utils/advisorLedger.utils';
import {
  createAdvisorResearchPolicy,
  createTradingAdvisorPolicy,
} from '../../utils/advisorPolicy.utils';
import { createAdvisorPlan } from '../../utils/advisorPlan.utils';
import SimulatedTrading from '../../../../SimulatedTrading';

jest.mock('server-only', () => ({}));
jest.mock('@libsql/client', () => jest.requireActual('@libsql/client/node'));

const observedAt = Date.UTC(2026, 10, 6, 15);
const market = {
  ticker: 'KXBTC15M-26NOV060900',
  target: 100000,
  startsAt: observedAt - 6 * 60_000,
  expiresAt: observedAt + 9 * 60_000,
};
const originalFetch = globalThis.fetch;
let client;
let store;

const encode = (value) => {
  const payload = JSON.stringify(value);
  return [payload, createHash('sha256').update(payload).digest('hex')];
};

const renderSavedAccount = async (policy, { enrollResearch = false } = {}) => {
  client = createClient({ url: ':memory:' });
  const repository = createTradingAdvisorRepository({ client, now: () => observedAt });
  await repository.initialize();
  const trialRepository = createTradingPolicyTrialRepository({ client, now: () => observedAt });
  await trialRepository.initialize();
  if (enrollResearch) {
    await trialRepository.ensureTrial(createAdvisorResearchPolicy(policy), observedAt - 60_000);
  }
  const account = {
    ...createAdvisorAccount(policy),
    cash: 80.0044,
    realizedPnl: -19.9956,
    feesPaid: 0.2,
  };
  const configuration = { revision: 4, configuredAt: observedAt - 60_000, policy };
  await client.execute({
    sql: 'INSERT INTO advisor_policies(id, started_at, payload, content_hash) VALUES (?, ?, ?, ?)',
    args: [policy.id, observedAt - 60_000, ...encode(policy)],
  });
  await client.execute({
    sql: 'INSERT INTO advisor_accounts(policy_id, payload, content_hash) VALUES (?, ?, ?)',
    args: [policy.id, ...encode(account)],
  });
  await client.execute({
    sql: 'INSERT INTO advisor_configuration(id, payload, content_hash) VALUES (1, ?, ?)',
    args: encode(configuration),
  });
  const savedPlan = createAdvisorPlan({
    id: 'saved-buy-advice',
    policyId: policy.id,
    action: 'buy',
    side: 'yes',
    quantity: 1,
    contract: market,
    evaluatedAt: observedAt,
    validUntil: observedAt + 15000,
    reason: 'fee_adjusted_entry_edge',
    limitPrice: 0.45,
    maxCost: 0.47,
  });
  await client.execute({
    sql: 'INSERT INTO advisor_current_plans(policy_id, payload, content_hash) VALUES (?, ?, ?)',
    args: [policy.id, ...encode(savedPlan)],
  });
  await client.execute({
    sql: 'INSERT INTO advisor_heartbeats(policy_id, payload) VALUES (?, ?)',
    args: [policy.id, JSON.stringify({ status: 'running', heartbeatAt: observedAt })],
  });
  const changesBeforeRead = (await client.execute('SELECT total_changes() AS count')).rows[0].count;
  const loadBook = jest.fn();
  const loadMarket = jest.fn();
  const service = createConfiguredTradingAdvisorService({
    repository,
    trialRepository,
    now: () => observedAt,
    loadBook,
    loadMarket,
  });
  const reports = [];
  globalThis.fetch = jest.fn(async (request) => {
    expect(request.url).toBe('http://localhost/api/research/trading-advisor');
    try {
      const report = await service.getReport();
      reports.push(report);
      return Response.json(report);
    } catch (error) {
      return researchErrorResponse(error);
    }
  });
  store = configureStore({
    reducer: { [researchApi.reducerPath]: researchApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(researchApi.middleware),
  });
  render(
    <Provider store={store}>
      <SimulatedTrading market={market} now={observedAt} />
    </Provider>,
  );
  return {
    repository,
    service,
    reports,
    loadBook,
    loadMarket,
    configuration,
    account,
    changesBeforeRead,
  };
};

afterEach(() => {
  cleanup();
  store?.dispatch(researchApi.util.resetApiState());
  client?.close();
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(observedAt);
});

test('saved checkpoint policy retains balances across research refreshes and reopening', async () => {
  const user = userEvent.setup();
  const policy = {
    ...createTradingAdvisorPolicy({ allocation: 100, riskLevel: 'balanced', runId: 'saved' }),
    id: 'kalshi-advisor-v2-saved-risk-sizing-v1-checkpoint-nine-v1',
    maxContracts: null,
    maxDrawdown: 20,
    drawdownLimit: 20,
    sizingMode: 'risk-based',
    decisionMode: 'prediction-checkpoint',
    checkpointMinutes: 9,
    captureGraceMs: 5000,
    entryContracts: 1,
  };
  const {
    repository,
    service,
    reports,
    loadBook,
    loadMarket,
    configuration,
    account,
    changesBeforeRead,
  } = await renderSavedAccount(policy);
  expect(screen.queryByRole('region', { name: 'Simulated account' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Current paper guidance' })).not.toBeInTheDocument();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Paper trading research' }));
  const researchDialog = within(
    await screen.findByRole('dialog', { name: 'Paper trading research' }),
  );
  const accountRegion = within(researchDialog.getByRole('region', { name: 'Simulated account' }));
  expect(await accountRegion.findByText('$80.0044')).toBeVisible();
  expect(accountRegion.getByText('-$19.9956')).toBeVisible();
  expect(accountRegion.getByText(/The saved adviser policy is not supported/)).toBeVisible();
  const guidance = within(researchDialog.getByRole('region', { name: 'Current paper guidance' }));
  expect(guidance.getByRole('heading', { name: 'Saved policy unavailable' })).toBeVisible();
  expect(guidance.getByText('Recorded plan')).toBeVisible();
  expect(guidance.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
  expect(guidance.queryByText('Fresh evaluation')).not.toBeInTheDocument();

  expect(researchDialog.getByRole('button', { name: 'Paper trading' })).toBeVisible();
  expect(
    researchDialog.queryByText('The latest adviser report could not be loaded.'),
  ).not.toBeInTheDocument();
  await user.click(researchDialog.getByRole('button', { name: 'Refresh adviser' }));
  await waitFor(() => expect(reports).toHaveLength(2));
  await user.click(researchDialog.getByRole('button', { name: 'Close research' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('region', { name: 'Simulated account' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Current paper guidance' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Paper trading research' })).toHaveFocus();

  await user.click(screen.getByRole('button', { name: 'Paper trading research' }));
  const reopenedDialog = within(
    await screen.findByRole('dialog', { name: 'Paper trading research' }),
  );
  expect(await reopenedDialog.findByText('$80.0044')).toBeVisible();
  expect(reopenedDialog.getByText('-$19.9956')).toBeVisible();
  expect(reopenedDialog.getByRole('heading', { name: 'Saved policy unavailable' })).toBeVisible();
  await waitFor(() => expect(reports).toHaveLength(3));
  expect(reports.every((report) => JSON.stringify(report.policy) === JSON.stringify(policy))).toBe(
    true,
  );
  await expect(service.advance({ market, getForecast: jest.fn() })).rejects.toMatchObject({
    name: 'ResearchDataError',
    status: 409,
  });
  await expect(service.observeOutcome(market)).rejects.toMatchObject({
    name: 'ResearchDataError',
    status: 409,
  });
  expect(await repository.readConfiguration()).toEqual(configuration);
  expect((await repository.readState(policy.id)).account).toEqual(account);
  expect(loadBook).not.toHaveBeenCalled();
  expect(loadMarket).not.toHaveBeenCalled();
  expect((await client.execute('SELECT total_changes() AS count')).rows[0].count).toBe(
    changesBeforeRead,
  );
});

test('current policy still shows its paper guidance and separately funded research accounts', async () => {
  const user = userEvent.setup();
  const policy = createTradingAdvisorPolicy({
    allocation: 100,
    riskLevel: 'balanced',
    runId: 'current',
  });
  const { reports, configuration, account, repository, changesBeforeRead } =
    await renderSavedAccount(policy, {
      enrollResearch: true,
    });
  await user.click(screen.getByRole('button', { name: 'Paper trading research' }));
  const researchDialog = within(
    await screen.findByRole('dialog', { name: 'Paper trading research' }),
  );
  expect(await screen.findByRole('heading', { name: 'BUY UP' })).toBeVisible();
  expect(screen.queryByText(/The saved adviser policy is not supported/)).not.toBeInTheDocument();
  const performanceButton = researchDialog.getByRole('button', { name: 'Performance' });
  await user.click(performanceButton);
  const performance = within(
    await screen.findByRole('dialog', { name: 'Paper adviser performance' }),
  );
  expect(performance.getByText('-$19.9956')).toBeVisible();
  expect(performance.getByText(/Entry limit: 1 contract/)).toBeVisible();
  expect(performance.getByText(/separate paper funding/)).toBeVisible();
  expect(performance.getByRole('row', { name: /Standard rules \$100.00 \$0.00/ })).toBeVisible();
  await user.click(performance.getByRole('button', { name: 'Close performance' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Paper adviser performance' }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByRole('dialog', { name: 'Paper trading research' })).toBeVisible();
  expect(performanceButton).toHaveFocus();
  expect(researchDialog.getByRole('heading', { name: 'BUY UP' })).toBeVisible();
  expect(reports[0].researchPolicy.id).toBe(`${policy.id}-research-one-contract-v1`);
  expect(await repository.readConfiguration()).toEqual(configuration);
  expect((await repository.readState(policy.id)).account).toEqual(account);
  expect((await client.execute('SELECT total_changes() AS count')).rows[0].count).toBe(
    changesBeforeRead,
  );
});
