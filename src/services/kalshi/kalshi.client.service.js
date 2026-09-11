import { assertKalshiTicker } from './kalshi.validation';

// Pending saved contracts are resolved independently of the selected UI market.
export async function fetchKalshiMarketClient(ticker, { signal } = {}) {
  assertKalshiTicker(ticker);
  const response = await fetch(`/api/kalshi/markets/${encodeURIComponent(ticker)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('The official Kalshi result is not available yet.');
  const market = await response.json();
  if (market?.ticker !== ticker || market.seriesTicker !== 'KXBTC15M') {
    throw new Error('Kalshi returned a different contract.');
  }
  return market;
}
