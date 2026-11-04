import { act, renderHook } from '@testing-library/react';
import useCoinbaseStream from '../hooks/useCoinbaseStream';

const NOW = Date.UTC(2026, 8, 9, 12, 0);
const OriginalWebSocket = globalThis.WebSocket;

class FakeSocket {
  static instances = [];
  constructor() {
    this.readyState = 0;
    this.send = jest.fn();
    this.close = jest.fn(() => {
      this.readyState = 3;
    });
    FakeSocket.instances.push(this);
  }
  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('useCoinbaseStream', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    FakeSocket.instances = [];
    globalThis.WebSocket = FakeSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    jest.useRealTimers();
  });

  test('owns one connection, exposes a stable deadline lookup, publishes once per second and cleans up', () => {
    const view = renderHook(() => useCoinbaseStream());
    const lookup = view.result.current.getDeadlineOutcome;
    const socket = FakeSocket.instances[0];
    act(() => {
      socket.readyState = 1;
      socket.onopen();
      socket.message({
        type: 'subscriptions',
        channels: ['matches', 'ticker', 'heartbeat', 'level2_50'].map((name) => ({
          name,
          product_ids: ['BTC-USD'],
        })),
      });
      socket.message({
        type: 'heartbeat',
        product_id: 'BTC-USD',
        last_trade_id: 10,
        time: new Date(NOW).toISOString(),
      });
    });
    expect(view.result.current.status).toBe('connecting');
    act(() => jest.advanceTimersByTime(1000));
    expect(view.result.current.status).toBe('warming');
    const previousSnapshot = view.result.current;
    view.rerender();
    expect(view.result.current).toBe(previousSnapshot);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(view.result.current.getDeadlineOutcome).toBe(lookup);
    expect(lookup(NOW + 10_000, NOW + 1000).status).toBe('waiting');
    view.unmount();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(lookup(NOW, NOW + 16_000).status).toBe('unobserved');
  });

  test('unmounting during reconnect prevents another socket from being created', () => {
    const view = renderHook(() => useCoinbaseStream());
    act(() => FakeSocket.instances[0].onerror());
    expect(view.result.current.status).toBe('reconnecting');
    view.unmount();
    act(() => jest.advanceTimersByTime(60_000));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
