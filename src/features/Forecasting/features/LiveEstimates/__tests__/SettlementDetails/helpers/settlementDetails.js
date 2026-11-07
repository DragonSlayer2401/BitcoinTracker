import { screen } from '@testing-library/react';
import { createMarketFeed, eventEnd } from '../../helpers/liveEstimateFixtures';

export const getDetailValue = (label) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling;

export const createFinalMinuteBenchmark = (now, { missingTimes = [] } = {}) => {
  const feed = createMarketFeed(now, 50_100);
  const samples = feed.benchmark.samples
    .filter((sample) => !missingTimes.includes(sample.time))
    .map((sample) => (sample.time > eventEnd - 60_000 ? { ...sample, price: 50_100 } : sample));
  return { ...feed.benchmark, samples, current: samples.at(-1) };
};
