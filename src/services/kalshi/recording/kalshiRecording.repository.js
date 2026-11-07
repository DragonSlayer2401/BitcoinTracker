import { createRecordingRepository } from '../../recording/recording.repository';

const repository = createRecordingRepository({
  directoryVersion: 'kalshi-market-directory-v1',
  manifestVersion: 'kalshi-market-manifest-v1',
  recordingVersion: 'kalshi-market-recording-v1',
  markerName: '.kalshi-recording-directory.json',
  lockName: '.kalshi-recording.lock',
  errorPrefix: 'KALSHI_RECORDING',
  archiveLabel: 'Kalshi archive',
  requireCompleteHistory: true,
  useCaptureSequence: true,
});

export const createKalshiRecordingStore = repository.createStore;
export const readKalshiRecording = repository.readRecording;
export const getKalshiRecordingStatus = repository.getStatus;
export const pruneKalshiRecordings = repository.prune;
export const readKalshiArchive = repository.readArchive;
