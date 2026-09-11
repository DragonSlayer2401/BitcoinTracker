import { act, renderHook } from '@testing-library/react';
import useResearchSync from '../hooks/useResearchSync';
import { uploadResearchBatch } from '@/services/research/research.client.service';
import {
  acknowledgeResearchBatch,
  queueForecastSnapshots,
  readResearchOutbox,
} from '../utils/researchOutbox.utils';

jest.mock('@/services/research/research.client.service', () => ({
  uploadResearchBatch: jest.fn(),
}));
jest.mock('../utils/researchOutbox.utils', () => ({
  acknowledgeResearchBatch: jest.fn(),
  queueForecastSnapshots: jest.fn(),
  readResearchOutbox: jest.fn(),
}));

const now = Date.UTC(2026, 8, 9, 12);
const forecast = { id: 'forecast-one', status: 'pending' };
const batch = { evidence: [{ eventId: 'forecast-one:decision:pending' }], forecasts: [forecast] };
const emptyBatch = { evidence: [], forecasts: [] };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('research upload lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    queueForecastSnapshots.mockResolvedValue();
    acknowledgeResearchBatch.mockResolvedValue();
    readResearchOutbox.mockResolvedValue(emptyBatch);
    uploadResearchBatch.mockResolvedValue({
      evidence: { inserted: 1, duplicates: 0 },
      forecasts: { inserted: 1, duplicates: 0 },
    });
  });
  afterEach(() => jest.useRealTimers());

  test('waits for local history restoration before queuing or uploading', async () => {
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [forecast], isReady: false, now },
    });
    await flush();
    expect(queueForecastSnapshots).not.toHaveBeenCalled();
    expect(readResearchOutbox).not.toHaveBeenCalled();
    view.rerender({ forecasts: [forecast], isReady: true, now });
    await flush();
    expect(queueForecastSnapshots).toHaveBeenCalledWith([forecast]);
    expect(readResearchOutbox).toHaveBeenCalledTimes(1);
  });

  test('deletes only the exact batch after its upload has completed', async () => {
    const uploading = deferred();
    readResearchOutbox.mockResolvedValueOnce(batch).mockResolvedValue(emptyBatch);
    uploadResearchBatch.mockReturnValueOnce(uploading.promise);
    const view = renderHook(() => useResearchSync({ forecasts: [forecast], isReady: true, now }));
    await flush();
    expect(uploadResearchBatch).toHaveBeenCalledWith(batch);
    expect(acknowledgeResearchBatch).not.toHaveBeenCalled();
    await act(async () =>
      uploading.resolve({
        evidence: { inserted: 1, duplicates: 0 },
        forecasts: { inserted: 1, duplicates: 0 },
      }),
    );
    expect(acknowledgeResearchBatch).toHaveBeenCalledWith(batch);
    expect(view.result.current).toEqual({ warning: null, lastSyncedAt: now });
  });

  test('retains failed uploads and retries the same immutable batch after backoff', async () => {
    readResearchOutbox.mockResolvedValue(batch);
    uploadResearchBatch.mockRejectedValueOnce(new Error('Network unavailable'));
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [forecast], isReady: true, now },
    });
    await flush();
    expect(acknowledgeResearchBatch).not.toHaveBeenCalled();
    expect(view.result.current.warning).toBe('Network unavailable');
    view.rerender({ forecasts: [forecast], isReady: true, now: now + 29_000 });
    await flush();
    expect(uploadResearchBatch).toHaveBeenCalledTimes(1);
    readResearchOutbox.mockResolvedValueOnce(batch).mockResolvedValue(emptyBatch);
    jest.setSystemTime(now + 30_000);
    view.rerender({ forecasts: [forecast], isReady: true, now: now + 30_000 });
    await flush();
    expect(uploadResearchBatch.mock.calls[1][0]).toEqual(batch);
    expect(acknowledgeResearchBatch).toHaveBeenCalledTimes(1);
    expect(view.result.current.warning).toBeNull();
  });

  test('retries safely when the server committed but local acknowledgment failed', async () => {
    readResearchOutbox.mockResolvedValue(batch);
    acknowledgeResearchBatch.mockRejectedValueOnce(new Error('Local disk unavailable'));
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [], isReady: true, now },
    });
    await flush();
    expect(view.result.current.warning).toBe('Local disk unavailable');
    uploadResearchBatch.mockResolvedValueOnce({
      evidence: { inserted: 0, duplicates: 1 },
      forecasts: { inserted: 0, duplicates: 1 },
    });
    readResearchOutbox.mockResolvedValueOnce(batch).mockResolvedValue(emptyBatch);
    jest.setSystemTime(now + 30_000);
    view.rerender({ forecasts: [], isReady: true, now: now + 30_000 });
    await flush();
    expect(uploadResearchBatch).toHaveBeenCalledTimes(2);
    expect(acknowledgeResearchBatch).toHaveBeenCalledTimes(2);
    expect(view.result.current.warning).toBeNull();
  });

  test('does not overlap uploads while the clock continues ticking', async () => {
    const uploading = deferred();
    readResearchOutbox.mockResolvedValueOnce(batch).mockResolvedValue(emptyBatch);
    uploadResearchBatch.mockReturnValueOnce(uploading.promise);
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [], isReady: true, now },
    });
    await flush();
    view.rerender({ forecasts: [], isReady: true, now: now + 60_000 });
    await flush();
    expect(uploadResearchBatch).toHaveBeenCalledTimes(1);
    await act(async () => uploading.resolve({}));
  });

  test('bounds each synchronization pass to five batches', async () => {
    readResearchOutbox.mockResolvedValue(batch);
    renderHook(() => useResearchSync({ forecasts: [], isReady: true, now }));
    await flush();
    expect(uploadResearchBatch).toHaveBeenCalledTimes(5);
    expect(acknowledgeResearchBatch).toHaveBeenCalledTimes(5);
  });

  test('queues later forecast states separately without requeuing unchanged snapshots', async () => {
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [forecast], isReady: true, now },
    });
    await flush();
    view.rerender({ forecasts: [{ ...forecast }], isReady: true, now: now + 1000 });
    await flush();
    expect(queueForecastSnapshots).toHaveBeenCalledTimes(1);
    const resolved = { ...forecast, status: 'resolved' };
    view.rerender({ forecasts: [resolved], isReady: true, now: now + 2000 });
    await flush();
    expect(queueForecastSnapshots.mock.calls[1][0]).toEqual([resolved]);
  });

  test('retries failed local snapshot storage instead of marking the forecast permanently queued', async () => {
    queueForecastSnapshots.mockRejectedValueOnce(new Error('Outbox unavailable'));
    const view = renderHook((props) => useResearchSync(props), {
      initialProps: { forecasts: [forecast], isReady: true, now },
    });
    await flush();
    expect(view.result.current.warning).toBe('Outbox unavailable');
    view.rerender({ forecasts: [forecast], isReady: true, now: now + 1000 });
    await flush();
    expect(queueForecastSnapshots).toHaveBeenCalledTimes(2);
  });

  test('does not drain additional batches after unmounting', async () => {
    const uploading = deferred();
    readResearchOutbox.mockResolvedValue(batch);
    uploadResearchBatch.mockReturnValueOnce(uploading.promise);
    const view = renderHook(() => useResearchSync({ forecasts: [], isReady: true, now }));
    await flush();
    view.unmount();
    await act(async () => uploading.resolve({}));
    expect(acknowledgeResearchBatch).toHaveBeenCalledTimes(1);
    expect(readResearchOutbox).toHaveBeenCalledTimes(1);
  });
});
