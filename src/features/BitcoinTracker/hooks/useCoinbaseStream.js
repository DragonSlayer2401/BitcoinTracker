import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createCoinbaseStream } from '@/services/coinbase/stream/coinbaseStream.service';

export default function useCoinbaseStream() {
  const connection = useRef(null);
  const [snapshot, setSnapshot] = useState(() => createCoinbaseStream().getSnapshot());

  useEffect(() => {
    const stream = createCoinbaseStream({ onUpdate: setSnapshot });
    connection.current = stream;
    stream.start();
    return () => {
      connection.current = null;
      stream.stop();
    };
  }, []);

  const getDeadlineOutcome = useCallback((expiresAt, now) => {
    if (connection.current) return connection.current.getDeadlineOutcome(expiresAt, now);
    return {
      status: now > expiresAt + 15_000 ? 'unobserved' : 'waiting',
      reason: 'The live trade connection is unavailable.',
      observedPrice: null,
      observedAt: null,
      observedTradeId: null,
      confirmedThrough: null,
      completeSince: null,
    };
  }, []);

  return useMemo(() => ({ ...snapshot, getDeadlineOutcome }), [snapshot, getDeadlineOutcome]);
}
