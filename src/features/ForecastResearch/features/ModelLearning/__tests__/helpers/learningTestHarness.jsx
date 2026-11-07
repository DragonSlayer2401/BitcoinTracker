import {
  configureLearningService,
  resetLearningServer,
  stopLearningServer,
} from './learningServer';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { serialize, deserialize } from 'node:v8';
import { Provider, useSelector } from 'react-redux';
import { makeStore } from '@/state/store';
import { kalshiApi } from '@/services/kalshi/kalshi.api';
import { researchApi } from '@/services/research/research.api';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import Forecasting from '@/features/Forecasting/Forecasting';
import { selectStorageWarning } from '@/features/Forecasting/state/selectors/forecastSelectors';
import useForecastJournal from '@/features/Forecasting/features/ForecastJournal/hooks/useForecastJournal';
import useForecastSelection from '@/features/Forecasting/features/CheckpointForecasts/hooks/useForecastSelection';
import useCheckpointForecasts from '@/features/Forecasting/features/CheckpointForecasts/hooks/useCheckpointForecasts';
import useEventEstimates from '@/features/Forecasting/features/LiveEstimates/hooks/useEventEstimates';
import { JOURNAL_STORAGE_KEY } from '@/features/Forecasting/features/ForecastJournal/utils/journal.utils';
import useResearchEstimates from '../../../../hooks/useResearchEstimates';
import useResearchLearning from '../../hooks/useResearchLearning';
import Methodology from '@/app/_dashboard/Methodology';
import { currentMarket, createMarketFeed, eventStart } from './learningMarketFixtures';
import { createLearningArchive } from './learningArchive';

jest.mock('server-only', () => ({}));

let clock;
let stores;
export const setupLearningTests = () => {
  const globals = Object.fromEntries(
    ['indexedDB', 'structuredClone'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  beforeEach(() => {
    resetLearningServer();
    localStorage.clear();
    stores = [];
    clock = jest.spyOn(Date, 'now').mockReturnValue(eventStart);
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    if (!globalThis.structuredClone)
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: (value) => deserialize(serialize(value)),
      });
  });
  afterEach(async () => {
    cleanup();
    stores.forEach((store) => {
      store.dispatch(researchApi.util.resetApiState());
      store.dispatch(kalshiApi.util.resetApiState());
      store.dispatch(coinbaseApi.util.resetApiState());
    });
    await stopLearningServer();
    jest.restoreAllMocks();
    localStorage.clear();
    for (const [name, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
  });
};

const LearningWorkflow = ({ now, market, feed, onJournalReady }) => {
  const journal = useForecastJournal();
  const selection = useForecastSelection();
  const marketData = { ...feed, kalshiMarkets: [market], selectedMarket: market };
  const learning = useResearchLearning({
    isReady: journal.isRestored,
    canReview: journal.isReady,
    now,
  });
  const research = {
    ...useResearchEstimates({ marketData, models: learning.models }),
    models: learning.models,
  };
  const estimates = useEventEstimates({ now, marketData, selection, research });
  const checkpoints = useCheckpointForecasts({
    now,
    selection,
    marketData,
    kalshiMarket: estimates.kalshiMarket,
    isJournalReady: journal.isReady,
    research,
  });
  const storageWarning = useSelector(selectStorageWarning);
  onJournalReady(journal);
  return (
    <>
      {storageWarning && <p role="alert">{storageWarning}</p>}
      <Forecasting
        now={now}
        marketData={marketData}
        journal={journal}
        selection={selection}
        checkpoints={checkpoints}
        estimates={estimates}
      />
      <Methodology evidenceWarning={learning.warning} />
    </>
  );
};

// Manual analysis is also available from a following tab. Default to that real
// ownership state so lifecycle tests can initiate each cycle with its UI button.
export const renderModelLearning = async ({
  repository = createLearningArchive().repository,
  now = eventStart,
  lock = 'follower',
  forecasts = [],
  market,
  feedOverrides = {},
} = {}) => {
  configureLearningService(repository);
  localStorage.setItem(
    JOURNAL_STORAGE_KEY,
    JSON.stringify({ version: 7, forecasts, scheduledForecast: null }),
  );
  let owner = lock === 'owner';
  let grantOwnership;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name, { signal }, callback) => {
        if (owner) return await callback({ name });
        return await new Promise((resolve, reject) => {
          grantOwnership = () => {
            owner = true;
            resolve(callback({ name }));
          };
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    },
  });
  const startsAt = Math.floor(now / 900_000) * 900_000;
  let props = {
    now,
    market: market ?? {
      ...currentMarket,
      startsAt,
      expiresAt: startsAt + 900_000,
      receivedAt: now,
    },
    feed: { ...createMarketFeed(now), ...feedOverrides },
  };
  const user = userEvent.setup();
  let journal;
  let store;
  let view;
  const workflow = () => (
    <Provider store={store}>
      <LearningWorkflow
        {...props}
        onJournalReady={(status) => {
          journal = status;
        }}
      />
    </Provider>
  );
  const mount = async () => {
    clock.mockReturnValue(props.now);
    store = makeStore();
    stores.push(store);
    view = render(workflow());
    await waitFor(() => expect(owner ? journal.isReady : journal.isRestored).toBe(true));
  };
  await mount();
  return {
    user,
    update: async (time, { price = 50_000, market: nextMarket = props.market, ...feed } = {}) => {
      props = {
        now: time,
        market: { ...nextMarket, receivedAt: time },
        feed: { ...createMarketFeed(time, price), ...feed },
      };
      clock.mockReturnValue(time);
      await act(async () => view.rerender(workflow()));
    },
    reload: async () => {
      view.unmount();
      await mount();
    },
    unmount: () => view.unmount(),
    acquireOwnership: async () => {
      await act(async () => {
        grantOwnership();
      });
      await waitFor(() => expect(journal.isReady).toBe(true));
    },
  };
};

export const openLearning = async (user) => {
  if (!screen.queryByRole('dialog', { name: 'Forecast research and learning' }))
    await user.click(screen.getByRole('button', { name: 'Research data' }));
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Forecast research and learning' }),
  );
  await waitFor(
    () => expect(dialog.queryByText('Loading archive analysis…')).not.toBeInTheDocument(),
    { timeout: 10_000 },
  );
  return dialog;
};
export const closeLearning = async (user) => {
  const dialog = await openLearning(user);
  await user.click(dialog.getByRole('button', { name: 'Close research data' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Forecast research and learning' }),
    ).not.toBeInTheDocument(),
  );
};
export const analyzeLearning = async (user) => {
  const dialog = await openLearning(user);
  await user.click(dialog.getByRole('button', { name: 'Analyze saved forecasts' }));
  await waitFor(
    () => expect(dialog.getByRole('button', { name: 'Analyze saved forecasts' })).toBeEnabled(),
    { timeout: 10_000 },
  );
  return dialog;
};
