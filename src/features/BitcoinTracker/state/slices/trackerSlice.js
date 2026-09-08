import { createSlice } from '@reduxjs/toolkit';
import {
  getValidatedForecast,
  getValidatedJournalState,
  getValidatedScheduledForecast,
} from '../../utils/journal.utils';

const maximumForecasts = 100;
const observationWindow = 15 * 1000;
const maximumQuoteAge = 20 * 1000;
const maximumClockLead = 5 * 1000;
const scheduleStartGrace = 15 * 1000;

const initialState = { forecasts: [], scheduledForecast: null, storageWarning: null };
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;

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
        forecast.status !== 'pending' ||
        state.scheduledForecast?.status === 'scheduled' ||
        state.forecasts.some(
          (existing) => existing.id === forecast.id || existing.status === 'pending',
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
          (forecast) => forecast.status === 'pending' || forecast.id === schedule.id,
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
        forecast.status !== 'pending' ||
        forecast.id !== schedule.id ||
        forecast.target !== schedule.target ||
        forecast.startsAt !== schedule.startsAt ||
        forecast.expiresAt !== schedule.expiresAt ||
        forecast.createdAt !== now ||
        now < schedule.startsAt ||
        now > schedule.startsAt + scheduleStartGrace ||
        state.forecasts.some(
          (existing) => existing.id === forecast.id || existing.status === 'pending',
        )
      ) {
        return;
      }

      state.scheduledForecast = null;
      state.forecasts.unshift(forecast);
      state.forecasts = state.forecasts.slice(0, maximumForecasts);
    },
    forecastsObserved(state, action) {
      const { ticker, now } = action.payload ?? {};
      if (!isTimestamp(now)) return;

      state.forecasts.forEach((forecast) => {
        if (forecast.status !== 'pending') return;

        if (canObserveForecast(forecast, ticker, now)) {
          forecast.status = 'resolved';
          forecast.observedPrice = ticker.price;
          forecast.observedAt = ticker.time;
          forecast.outcome =
            ticker.price > forecast.target
              ? 'above'
              : ticker.price < forecast.target
                ? 'below'
                : 'equal';
          forecast.correct =
            forecast.direction === 'neutral' || forecast.outcome === 'equal'
              ? null
              : forecast.direction === forecast.outcome;
        } else if (now > forecast.expiresAt + observationWindow + maximumQuoteAge) {
          forecast.status = 'unobserved';
        }
      });
    },
    historyCleared(state) {
      state.forecasts = state.forecasts.filter((forecast) => forecast.status === 'pending');
    },
    storageWarningChanged(state, action) {
      state.storageWarning = typeof action.payload === 'string' ? action.payload : null;
    },
    historyRestored(state, action) {
      if (
        state.scheduledForecast !== null ||
        state.forecasts.some((forecast) => forecast.status === 'pending')
      ) {
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
  forecastsObserved,
  historyCleared,
  storageWarningChanged,
  historyRestored,
} = trackerSlice.actions;

export default trackerSlice.reducer;
