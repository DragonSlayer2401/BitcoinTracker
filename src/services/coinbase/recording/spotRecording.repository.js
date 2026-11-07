import { createRecordingRepository } from '../../recording/recording.repository';

const repository = createRecordingRepository({
  directoryVersion: 'coinbase-spot-directory-v1',
  manifestVersion: 'coinbase-spot-manifest-v1',
  recordingVersion: 'coinbase-spot-recording-v1',
  markerName: '.spot-recording-directory.json',
  lockName: '.spot-recording.lock',
});

export const createSpotRecordingStore = repository.createStore;
export const readSpotRecording = repository.readRecording;
export const getSpotRecordingStatus = repository.getStatus;
export const pruneSpotRecordings = repository.prune;
