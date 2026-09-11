import {
  createKalshiResearchRecorder,
  getValidatedKalshiRecorderState,
} from './kalshi/researchRecorder.utils';

export function createResearchRecorder(options) {
  if (options?.state && options.state.version !== 2)
    throw new Error('Legacy Coinbase research is retired. Use the Kalshi recorder state file.');
  return createKalshiResearchRecorder(options);
}

export const getValidatedResearchRecorderState = getValidatedKalshiRecorderState;
