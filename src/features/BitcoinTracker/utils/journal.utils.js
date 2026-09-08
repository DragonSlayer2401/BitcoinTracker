const journalKey = 'bitcoin-tracker:journal:v1';
const journalVersion = 2;
const forecastDuration = 15 * 60 * 1000;
const observationWindow = 15 * 1000;
const scheduleStartGrace = 15 * 1000;
const maximumScheduleDelay = 24 * 60 * 60 * 1000;
const maximumForecasts = 100;

const snapshotFields = [
  'id',
  'createdAt',
  'expiresAt',
  'price',
  'target',
  'aboveProbability',
  'belowProbability',
  'direction',
  'modelVersion',
  'status',
];
const resultFields = ['observedPrice', 'observedAt', 'outcome', 'correct'];
const scheduleFields = ['id', 'createdAt', 'startsAt', 'expiresAt', 'target', 'status'];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isProbability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isIdentifier = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

export function getValidatedForecast(value) {
  if (!isRecord(value)) return null;

  const hasStartsAt = Object.prototype.hasOwnProperty.call(value, 'startsAt');
  const hasTimingMode = Object.prototype.hasOwnProperty.call(value, 'timingMode');
  const isEndTimeCapture = hasTimingMode && value.timingMode === 'end';
  const fields = [...snapshotFields];
  if (hasStartsAt) fields.push('startsAt');
  if (hasTimingMode) fields.push('timingMode');
  if (value.status === 'resolved') fields.push(...resultFields);
  const startsAt = hasStartsAt ? value.startsAt : value.createdAt;
  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.modelVersion) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(startsAt) ||
    !isTimestamp(value.expiresAt) ||
    (hasTimingMode && (!isEndTimeCapture || !hasStartsAt)) ||
    value.createdAt < startsAt ||
    (isEndTimeCapture
      ? value.createdAt >= value.expiresAt
      : value.createdAt - startsAt > scheduleStartGrace) ||
    value.expiresAt - startsAt !== forecastDuration ||
    !isPositiveNumber(value.price) ||
    !isPositiveNumber(value.target) ||
    !isProbability(value.aboveProbability) ||
    !isProbability(value.belowProbability) ||
    Math.abs(value.aboveProbability + value.belowProbability - 1) > 0.000001 ||
    !['above', 'below', 'neutral'].includes(value.direction) ||
    !['pending', 'resolved', 'unobserved'].includes(value.status)
  ) {
    return null;
  }

  if (value.status === 'resolved') {
    if (
      !isPositiveNumber(value.observedPrice) ||
      !isTimestamp(value.observedAt) ||
      value.observedAt < value.expiresAt ||
      value.observedAt > value.expiresAt + observationWindow
    ) {
      return null;
    }

    const outcome =
      value.observedPrice > value.target
        ? 'above'
        : value.observedPrice < value.target
          ? 'below'
          : 'equal';
    const correct =
      value.direction === 'neutral' || outcome === 'equal' ? null : value.direction === outcome;

    if (value.outcome !== outcome || value.correct !== correct) return null;
  }

  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

export function getValidatedJournal(value) {
  if (!Array.isArray(value) || value.length > maximumForecasts) return null;

  const forecasts = value.map(getValidatedForecast);
  if (
    forecasts.some((forecast) => forecast === null) ||
    new Set(forecasts.map((forecast) => forecast.id)).size !== forecasts.length ||
    forecasts.filter((forecast) => forecast.status === 'pending').length > 1
  ) {
    return null;
  }

  return forecasts.sort((first, second) => second.createdAt - first.createdAt);
}

export function getValidatedScheduledForecast(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== scheduleFields.length ||
    !scheduleFields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
    !isIdentifier(value.id) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.startsAt) ||
    !isTimestamp(value.expiresAt) ||
    value.startsAt <= value.createdAt ||
    value.startsAt - value.createdAt > maximumScheduleDelay ||
    value.expiresAt - value.startsAt !== forecastDuration ||
    !isPositiveNumber(value.target) ||
    value.target > 1_000_000_000 ||
    !['scheduled', 'missed'].includes(value.status)
  ) {
    return null;
  }

  return Object.fromEntries(scheduleFields.map((field) => [field, value[field]]));
}

export function getValidatedJournalState(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'forecasts') ||
    !Object.prototype.hasOwnProperty.call(value, 'scheduledForecast')
  ) {
    return null;
  }

  const forecasts = getValidatedJournal(value.forecasts);
  const scheduledForecast = getValidatedScheduledForecast(value.scheduledForecast);
  if (
    forecasts === null ||
    (value.scheduledForecast !== null && scheduledForecast === null) ||
    (scheduledForecast !== null &&
      forecasts.some(
        (forecast) => forecast.status === 'pending' || forecast.id === scheduledForecast.id,
      ))
  ) {
    return null;
  }

  return { forecasts, scheduledForecast };
}

export function loadJournal(storage) {
  let savedJournal;
  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    savedJournal = journalStorage.getItem(journalKey);
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Forecast history is unavailable on this device.',
    };
  }

  if (savedJournal === null) return { forecasts: [], scheduledForecast: null, warning: null };

  try {
    const parsedJournal = JSON.parse(savedJournal);
    if (
      !isRecord(parsedJournal) ||
      ![1, journalVersion].includes(parsedJournal.version) ||
      Object.keys(parsedJournal).length !== (parsedJournal.version === 1 ? 2 : 3)
    ) {
      throw new Error('Invalid journal version.');
    }
    const journal = getValidatedJournalState({
      forecasts: parsedJournal.forecasts,
      scheduledForecast: parsedJournal.version === 1 ? null : parsedJournal.scheduledForecast,
    });
    if (journal === null) throw new Error('Invalid forecast history.');
    return { ...journal, warning: null };
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Saved forecast history was invalid and has been ignored.',
    };
  }
}

export function saveJournal(forecasts, storage, scheduledForecast = null) {
  const journal = getValidatedJournalState({ forecasts, scheduledForecast });
  if (journal === null) return 'Forecast history could not be saved because it was invalid.';

  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    journalStorage.setItem(journalKey, JSON.stringify({ version: journalVersion, ...journal }));
    return null;
  } catch {
    return 'Forecast history could not be saved on this device.';
  }
}
