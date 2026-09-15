import { useEffect, useRef, useState } from 'react';
import { useGetResearchModelsQuery } from '@/services/research/research.api';
import { runResearchLearning } from '@/services/research/research.client.service';

const EMPTY_MODELS = Object.freeze({ active: null, candidate: null });

export default function useResearchLearning({ isReady, canReview = isReady, now }) {
  const query = useGetResearchModelsQuery(undefined, {
    skip: !isReady,
    pollingInterval: 60_000,
    refetchOnFocus: true,
  });
  const nextReviewAt = useRef(0);
  const busy = useRef(false);
  const [warning, setWarning] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !isReady ||
      !canReview ||
      !now ||
      query.isError ||
      !query.data ||
      busy.current ||
      now < nextReviewAt.current
    )
      return;
    nextReviewAt.current = now + 15 * 60_000;
    busy.current = true;
    runResearchLearning()
      .then(() => {
        if (mounted.current) {
          setWarning(null);
          query.refetch();
        }
      })
      .catch((error) => {
        if (mounted.current) setWarning(error.message);
      })
      .finally(() => {
        busy.current = false;
      });
  }, [isReady, canReview, now, query.data, query.isError, query.refetch]);
  return { models: query.data ?? EMPTY_MODELS, warning };
}
