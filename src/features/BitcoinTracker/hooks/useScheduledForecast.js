import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectScheduledForecast } from '../state/selectors/trackerSelectors';
import { scheduledForecastStarted, scheduleStartMissed } from '../state/slices/trackerSlice';
import { getForecast } from '../utils/forecast.utils';

export default function useScheduledForecast({
  ticker,
  candles,
  now,
  isReady,
  hasRequestError,
  refetchTicker,
  refetchCandles,
}) {
  const dispatch = useDispatch();
  const schedule = useSelector(selectScheduledForecast);
  const requestedScheduleId = useRef(null);

  useEffect(() => {
    if (!isReady || !now || schedule?.status !== 'scheduled') return;
    const capturedAt = Date.now();
    if (capturedAt < schedule.startsAt) return;

    if (capturedAt > schedule.startsAt + 15_000) {
      dispatch(scheduleStartMissed({ now: capturedAt }));
      return;
    }

    if (requestedScheduleId.current !== schedule.id) {
      requestedScheduleId.current = schedule.id;
      refetchTicker();
      refetchCandles();
    }

    // Only a quote fetched and traded at/after the chosen start can open the window.
    if (
      hasRequestError ||
      !ticker ||
      ticker.time < schedule.startsAt ||
      ticker.receivedAt < schedule.startsAt
    )
      return;
    const estimate = getForecast({
      candles,
      ticker,
      target: schedule.target,
      now: capturedAt,
      horizonMinutes: (schedule.expiresAt - capturedAt) / 60_000,
    });
    if (!estimate.available) return;

    dispatch(
      scheduledForecastStarted({
        now: capturedAt,
        forecast: {
          id: schedule.id,
          createdAt: capturedAt,
          startsAt: schedule.startsAt,
          expiresAt: schedule.expiresAt,
          price: ticker.price,
          target: schedule.target,
          aboveProbability: estimate.aboveProbability,
          belowProbability: estimate.belowProbability,
          direction: estimate.direction,
          modelVersion: estimate.modelVersion,
          status: 'pending',
        },
      }),
    );
  }, [
    candles,
    dispatch,
    hasRequestError,
    isReady,
    now,
    refetchCandles,
    refetchTicker,
    schedule,
    ticker,
  ]);
}
