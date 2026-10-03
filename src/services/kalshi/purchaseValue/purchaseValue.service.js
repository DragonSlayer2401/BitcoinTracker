import 'server-only';
import { fetchKalshiResource } from '../kalshi.transport';
import { assertKalshiTicker } from '../kalshi.validation';
import { parseKalshiPurchaseBook, parseKalshiPurchaseFees } from './purchaseValue.validation';

/** Optional purchase comparison reads share the same global quota as collection. */
export function createKalshiPurchaseValueService({
  request = fetchKalshiResource,
  now = Date.now,
} = {}) {
  async function fetchPurchaseValue(ticker) {
    assertKalshiTicker(ticker);
    const eventTicker = ticker.slice(0, ticker.lastIndexOf('-'));
    const [book, series, fees] = await Promise.allSettled([
      request(`/markets/${ticker}/orderbook?depth=100`).then((payload) =>
        parseKalshiPurchaseBook(payload, ticker, now()),
      ),
      request('/series/KXBTC15M'),
      request(`/events/fee_changes?event_ticker=${eventTicker}&limit=100`),
    ]);
    if (book.status !== 'fulfilled') throw book.reason;
    const fee =
      series.status === 'fulfilled' && fees.status === 'fulfilled'
        ? parseKalshiPurchaseFees(series.value, fees.value, eventTicker, now())
        : {
            available: false,
            reason: 'Fee data is unavailable; only value before fees can be shown.',
            checkedAt: now(),
          };
    return { ...book.value, fee };
  }
  return { fetchPurchaseValue };
}

const service = createKalshiPurchaseValueService();
export const fetchKalshiPurchaseValue = (ticker) => service.fetchPurchaseValue(ticker);
