import { createSlice } from '@reduxjs/toolkit';
import {
  getValidatedForecast,
  getValidatedJournalState,
  getValidatedScheduledForecast,
} from '../../utils/journal.utils';
import { DEADLINE_OUTCOME_DEFINITION, isVerifiedDeadlineOutcome } from '../../utils/outcome.utils';
import { MARKET_AWARE_POLICY_VERSION } from '../../utils/fixedPrediction.utils';

const maximumForecasts = 100;
const observationWindow = 15 * 1000;
const maximumQuoteAge = 20 * 1000;
const maximumClockLead = 5 * 1000;
const scheduleStartGrace = 15 * 1000;

const initialState = { forecasts: [], scheduledForecast: null, storageWarning: null };
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isActiveForecast = (forecast) => ['analyzing', 'pending'].includes(forecast.status);

function canObserveForecast(forecast, ticker, now) {
  return (
    ticker !== null &&
    typeof ticker === 'object' &&
    typeof ticker.price === 'number' &&
    Number.isFinite(ticker.price) &&
    ticker.price > 0 &&
    isTimestamp(ticker.time) &&
    isTimestamp(ticker.receivedAt) &&
    now >= forecast.expiresAt &&
    ticker.time >= forecast.expiresAt &&
    ticker.time <= forecast.expiresAt + observationWindow &&
    now - ticker.receivedAt <= maximumQuoteAge &&
    ticker.receivedAt - now <= maximumClockLead &&
    ticker.time >= now - maximumQuoteAge &&
    ticker.time <= now + maximumClockLead
  );
}

const trackerSlice = createSlice({
  name: 'tracker',
  initialState,
  reducers: {
    forecastRecorded(state, action) {
      const forecast = getValidatedForecast(action.payload);
      if (
        forecast === null ||
        !isActiveForecast(forecast) ||
        state.scheduledForecast?.status === 'scheduled' ||
        state.forecasts.some(
          (existing) => existing.id === forecast.id || isActiveForecast(existing),
        )
      ) {
        return;
      }

      state.scheduledForecast = null;
      state.forecasts.unshift(forecast);
      state.forecasts = state.forecasts.slice(0, maximumForecasts);
    },
    scheduleCreated(state, action) {
      const schedule = getValidatedScheduledForecast(action.payload);
      if (
        schedule === null ||
        schedule.status !== 'scheduled' ||
        state.scheduledForecast?.status === 'scheduled' ||
        state.forecasts.some(
          (forecast) => isActiveForecast(forecast) || forecast.id === schedule.id,
        )
      ) {
        return;
      }

      state.scheduledForecast = schedule;
    },
    scheduleCancelled(state) {
      state.scheduledForecast = null;
    },
    scheduleStartMissed(state, action) {
      const { now } = action.payload ?? {};
      if (
        isTimestamp(now) &&
        state.scheduledForecast?.status === 'scheduled' &&
        now > state.scheduledForecast.startsAt + scheduleStartGrace
      ) {
        state.scheduledForecast.status = 'missed';
      }
    },
    scheduledForecastStarted(state, action) {
      const { forecast: snapshot, now } = action.payload ?? {};
      const forecast = getValidatedForecast(snapshot);
      const schedule = state.scheduledForecast;
      if (
        !isTimestamp(now) ||
        schedule?.status !== 'scheduled' ||
        forecast === null ||
        !isActiveForecast(forecast) ||
        forecast.id !== schedule.id ||
        forecast.target !== schedule.target ||
        forecast.startsAt !== schedule.startsAt ||
        forecast.expiresAt !== schedule.expiresAt ||
        forecast.outcomeDefinition !== schedule.outcomeDefinition ||
        ((schedule.policyVersion || schedule.outcomeDefinition) &&
          forecast.analysis?.policyVersion !==
            (schedule.policyVersion ?? MARKET_AWARE_POLICY_VERSION)) ||
        forecast.createdAt !== now ||
        now < schedule.startsAt ||
        now > schedule.startsAt + scheduleStartGrace ||
        state.forecasts.some(
          (existing) => existing.id === forecast.id || isActiveForecast(existing),
        )
      ) {
        return;
      }

      state.scheduledForecast = null;
      state.forecasts.unshift(forecast);
      state.forecasts = state.forecasts.slice(0, maximumForecasts);
    },
    fixedForecastPublished(state, action) {
      const { id, now, forecast: snapshot } = action.payload ?? {};
      const existing = state.forecasts.find((forecast) => forecast.id === id);
      const forecast = getValidatedForecast(snapshot);
      if (
        existing?.status !== 'analyzing' ||
        !isTimestamp(now) ||
        now < existing.analysis.earliestAt ||
        now > existing.analysis.deadline ||
        forecast === null ||
        forecast.status !== 'pending' ||
        forecast.createdAt !== now ||
        ![
          'id',
          'target',
          'startsAt',
          'expiresAt',
          'timingMode',
          'modelVersion',
          'outcomeDefinition',
        ].every((field) => forecast[field] === existing[field]) ||
        !['startedAt', 'earliestAt', 'deadline', 'policyVersion'].every(
          (field) => forecast.analysis?.[field] === existing.analysis[field],
        )
      ) {
        return;
      }

      state.forecasts[state.forecasts.findIndex((entry) => entry.id === id)] = forecast;
    },
    fixedForecastWithheld(state, action) {
      const { id, now, reason } = action.payload ?? {};
      const forecast = state.forecasts.find((entry) => entry.id === id);
      if (forecast?.status !== 'analyzing' || !isTimestamp(now)) return;
      const hasInsufficientTime = forecast.analysis.earliestAt > forecast.analysis.deadline;
      if (
        now < forecast.analysis.startedAt ||
        (!hasInsufficientTime && now < forecast.analysis.deadline)
      ) {
        return;
      }
      const withheld = getValidatedForecast({
        ...forecast,
        status: 'withheld',
        withholdingReason: reason,
      });
      if (withheld === null) return;
      state.forecasts[state.forecasts.findIndex((entry) => entry.id === id)] = withheld;
    },
    forecastsObserved(state, action) {
      const { ticker, now, deadlineOutcome } = action.payload ?? {};
      if (!isTimestamp(now)) return;

      state.forecasts.forEach((forecast) => {
        if (forecast.status !== 'pending') return;

        const usesDeadline = forecast.outcomeDefinition === DEADLINE_OUTCOME_DEFINITION;
        const hasOutcome = usesDeadline
          ? isVerifiedDeadlineOutcome(deadlineOutcome, forecast.expiresAt, now)
          : canObserveForecast(forecast, ticker, now);
        if (hasOutcome) {
          const price = usesDeadline ? deadlineOutcome.observedPrice : ticker.price;
          forecast.status = 'resolved';
          forecast.observedPrice = price;
          forecast.observedAt = usesDeadline ? deadlineOutcome.observedAt : ticker.time;
          if (usesDeadline) {
            forecast.observedTradeId = deadlineOutcome.observedTradeId;
            forecast.confirmedThrough = deadlineOutcome.confirmedThrough;
            forecast.completeSince = deadlineOutcome.completeSince;
          }
          forecast.outcome =
            price > forecast.target ? 'above' : price < forecast.target ? 'below' : 'equal';
          forecast.correct =
            forecast.direction === 'neutral' || forecast.outcome === 'equal'
              ? null
              : forecast.direction === forecast.outcome;
        } else if (
          (usesDeadline && now >= forecast.expiresAt && deadlineOutcome?.status === 'unobserved') ||
          now > forecast.expiresAt + observationWindow + maximumQuoteAge
        ) {
          forecast.status = 'unobserved';
        }
      });
    },
    historyCleared(state) {
      state.forecasts = state.forecasts.filter(isActiveForecast);
    },
    storageWarningChanged(state, action) {
      state.storageWarning = typeof action.payload === 'string' ? action.payload : null;
    },
    historyRestored(state, action) {
      if (state.scheduledForecast !== null || state.forecasts.some(isActiveForecast)) {
        return;
      }
      const journal = getValidatedJournalState(
        Array.isArray(action.payload)
          ? { forecasts: action.payload, scheduledForecast: null }
          : action.payload,
      );
      if (journal !== null) {
        state.forecasts = journal.forecasts;
        state.scheduledForecast = journal.scheduledForecast;
      }
    },
  },
});

export const {
  forecastRecorded,
  scheduleCreated,
  scheduleCancelled,
  scheduleStartMissed,
  scheduledForecastStarted,
  fixedForecastPublished,
  fixedForecastWithheld,
  forecastsObserved,
  historyCleared,
  storageWarningChanged,
  historyRestored,
} = trackerSlice.actions;

export default trackerSlice.reducer;
