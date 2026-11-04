import { assertKalshiTicker } from './kalshi.validation';

// Pending saved contracts are resolved independently of the selected UI market.
export async function fetchKalshiMarketClient(ticker, { signal } = {}) {
  assertKalshiTicker(ticker);
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`/api/kalshi/markets/${encodeURIComponent(ticker)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error('The official Kalshi result is not available yet.');
  const payload = await response.json();
  const market = payload?.market ?? payload;
  if (market?.ticker !== ticker || market.seriesTicker !== 'KXBTC15M') {
    throw new Error('Kalshi returned a different contract.');
  }
  return market;
}
