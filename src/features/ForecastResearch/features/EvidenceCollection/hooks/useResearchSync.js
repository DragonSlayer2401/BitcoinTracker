import { useEffect, useRef, useState } from 'react';
import { uploadResearchBatch } from '@/services/research/research.client.service';
import {
  queueForecastSnapshots,
  readResearchOutbox,
  acknowledgeResearchBatch,
} from '../utils/researchOutbox.utils';

export default function useResearchSync({ forecasts, isReady, now }) {
  const busy = useRef(false);
  const queued = useRef(new Set());
  const retryAt = useRef(0);
  const mounted = useRef(true);
  const [status, setStatus] = useState({ warning: null, lastSyncedAt: null });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!isReady) return;
    const additions = forecasts.filter((row) => !queued.current.has(`${row.id}:${row.status}`));
    if (!additions.length) return;
    for (const row of additions) queued.current.add(`${row.id}:${row.status}`);
    queueForecastSnapshots(additions).catch((error) => {
      for (const row of additions) queued.current.delete(`${row.id}:${row.status}`);
      if (mounted.current) setStatus((previous) => ({ ...previous, warning: error.message }));
    });
  }, [forecasts, isReady, now]);

  useEffect(() => {
    if (!isReady || !now || busy.current || now < retryAt.current) return;
    busy.current = true;
    retryAt.current = now + 15_000;
    async function synchronize() {
      try {
        // Bound each pass so a large legacy archive cannot monopolize the tab.
        for (let batchIndex = 0; batchIndex < 5 && mounted.current; batchIndex += 1) {
          const batch = await readResearchOutbox();
          if (!batch.evidence.length && !batch.forecasts.length) break;
          await uploadResearchBatch(batch);
          await acknowledgeResearchBatch(batch);
          if (mounted.current) setStatus({ warning: null, lastSyncedAt: Date.now() });
        }
      } catch (error) {
        retryAt.current = Date.now() + 30_000;
        if (mounted.current) setStatus((previous) => ({ ...previous, warning: error.message }));
      } finally {
        busy.current = false;
      }
    }
    synchronize();
  }, [now, isReady]);
  return status;
}
