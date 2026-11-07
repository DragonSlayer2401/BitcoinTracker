import { openResearch } from '../../helpers/evidenceTestHarness';
import { ingestRequests } from '../../helpers/evidenceServer';
import { JOURNAL_STORAGE_KEY } from '@/features/Forecasting/features/ForecastJournal/utils/journal.utils';
import { BACKGROUND_RESEARCH_STORAGE_KEY } from '../../../utils/backgroundResearchStorage.utils';

export const saveJournalFromWriter = (forecasts) =>
  localStorage.setItem(
    JOURNAL_STORAGE_KEY,
    JSON.stringify({ version: 7, forecasts, scheduledForecast: null }),
  );

export const assertCollectionPaused = async (user) => {
  const dialog = await openResearch(user);
  await user.click(dialog.getByRole('button', { name: 'Export pending records' }));
  expect(await dialog.findByText(/No records are available in this export yet/)).toBeVisible();
  expect(ingestRequests).toHaveLength(0);
  expect(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).toBeNull();
};
