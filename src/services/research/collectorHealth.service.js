import 'server-only';
import * as researchRepository from './research.repository';
import {
  COLLECTOR_HEALTH_POLICY,
  getCollectorHealth as summarizeCollectorHealth,
} from '@/features/BitcoinTracker/utils/collectorHealth.utils';

/** Existing archive reads only; this endpoint never contacts Kalshi or changes collector state. */
export function createCollectorHealthService(repository) {
  return {
    async getCollectorHealth({ now = Date.now(), events, labels } = {}) {
      const archive =
        events && labels
          ? Promise.resolve({ evidence: events, labels })
          : repository.getCollectorHealthRows
            ? repository.getCollectorHealthRows({
                since: now - COLLECTOR_HEALTH_POLICY.reportingWindowMs,
                now,
              })
            : Promise.all([
                events ?? repository.getLearningEvidenceRows(),
                labels ?? repository.getForwardResearchLabels?.() ?? [],
              ]).then(([evidence, forwardLabels]) => ({ evidence, labels: forwardLabels }));
      const [heartbeats, rows] = await Promise.all([
        repository.readCollectorHeartbeats?.() ?? [],
        archive,
      ]);
      return summarizeCollectorHealth({
        heartbeats,
        evidence: events ?? rows.evidence,
        labels: labels ?? rows.labels,
        now,
      });
    },
  };
}

const service = createCollectorHealthService(researchRepository);
export const getCollectorHealth = service.getCollectorHealth;
