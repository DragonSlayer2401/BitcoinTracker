import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';

export const eventStart = Date.UTC(2026, 10, 6, 12);
export const eventEnd = eventStart + 900_000;
export const currentMarket = {
  ticker: 'KXBTC15M-26NOV061215-15',
  eventTicker: 'KXBTC15M-26NOV061215',
  seriesTicker: 'KXBTC15M',
  startsAt: eventStart,
  expiresAt: eventEnd,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
};
export const createMarketFeed = (now, price = 50_000) => {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: Math.floor(now / 1000) * 1000 - (1200 - index) * 1000,
    price: price * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
    receivedAt: now,
  }));
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price * Math.exp(Math.sin((index - 120) / 5) * 0.0005);
    const close = price * Math.exp(Math.sin((index - 119) / 5) * 0.0005);
    return {
      time: Math.floor(now / 60_000) * 60_000 - (120 - index) * 60_000,
      open,
      close,
      high: Math.max(open, close) * 1.0002,
      low: Math.min(open, close) * 0.9998,
      volume: 5 + (index % 7),
    };
  });
  return {
    candles,
    ticker: { price, bid: price - 1, ask: price + 1, volume: 100, time: now, receivedAt: now },
    benchmark: { available: true, receivedAt: now, current: samples.at(-1), samples },
    stream: {},
    derivatives: {},
    hasRequestError: false,
    hasContractError: false,
    isLoading: false,
  };
};
