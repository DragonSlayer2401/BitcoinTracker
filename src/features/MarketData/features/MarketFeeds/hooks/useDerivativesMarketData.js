import { useEffect, useState } from 'react';
import { createDerivativesStream } from '@/services/derivatives/derivativesStream.service';

/** Own only the optional futures connection and its current public market observations. */
export default function useDerivativesMarketData() {
  const [snapshot, setSnapshot] = useState(() => createDerivativesStream().getSnapshot(0));

  useEffect(() => {
    const stream = createDerivativesStream({ onUpdate: setSnapshot });
    stream.start();
    return () => stream.stop();
  }, []);

  return snapshot;
}
