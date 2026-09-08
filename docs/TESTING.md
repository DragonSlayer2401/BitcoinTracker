# Testing

Run `pnpm test` for Jest with Testing Library, `pnpm run format:check` for Prettier, and `pnpm build` for production compilation. Feature tests live in `src/features/BitcoinTracker/__tests__/`.

Tests cover market API validation and route failures, probability behavior and data-quality gates, immutable forecast observations, scheduled starts, persistence compatibility and failures, and user-facing target/timing flows. Use deterministic timestamps and prices; unit tests must not make live exchange requests. A passing model test validates its implementation, not its predictive accuracy.

For browser acceptance, run the app with network access and verify:

1. A fresh Coinbase price, completed history, source attribution, and working 30m/1h/2h chart controls.
2. Editing the USD target changes the estimate; “Use current” centers it near 50/50.
3. **Schedule by → Start now** captures the original target and probabilities with a deadline 15 minutes later. The prominent countdown starts at `15:00`, never `15:01`, then decreases. The calculator remains editable, and reload retains the forecast.
4. **End time** derives the window start exactly 15 minutes earlier. At 12:18, choosing 12:30 displays a 12:15 window start and a `12:00` countdown; submitting captures a fresh estimate now using 12 remaining minutes and preserves the 12:30 deadline. Empty, invalid, or non-future ends are rejected. The latest allowed end is 24 hours 15 minutes ahead.
5. An end more than 15 minutes away schedules its future start. **Start time** still accepts a future local start within 24 hours. Saving a future schedule fixes target and timing without capturing probabilities early. The main countdown stays at `15:00` while **Starts in** decreases. Reload retains the same window, and canceling before its start permits a new schedule.
6. At the scheduled start, the main countdown begins decreasing toward the fixed end. Fresh data captures the forecast within 15 seconds; a capture 5 seconds late shows `14:55` remaining and uses that remaining model horizon. Editing the calculator before capture does not change the saved target or deadline.
7. Missing or stale data through the capture grace window, or resuming a suspended tab after it, marks a future schedule's start as missed without creating or automatically recovering a forecast. The missed schedule can be dismissed. Joining a window already in progress requires a new explicit submission with fresh data. Directly selected past starts and future starts more than 24 hours ahead cannot be scheduled.
8. Missing or stale data pauses immediate recording and removes probability values; reconnect restores estimates. A timely eligible trade resolves an active forecast; a missed outcome window is recorded as unobserved. Automated tests cover timing boundaries and delayed delivery without a 15-minute test wait.
9. Existing valid version 1 history loads alongside the new scheduling persistence format. Storage failures display a warning instead of implying a successful save.
10. A selected or running end 12 minutes away limits the model interval to those 12 minutes, with an **End** chart label and matching **Window volatility**. A future window more than 15 minutes away keeps the 15-minute preview. Invalid or expired horizons remove the forward interval and endpoint claim; 30m/1h/2h history controls still work.
11. The panel layout at 1366×768 and 1440×900 desktop sizes, including end-time selection, joined-window, scheduled-start and active-countdown states, without page scrolling. At 390px/320px mobile widths, confirm a prominent readable countdown, natural vertical scrolling, and no horizontal page overflow. Check keyboard access and visible focus for target, scheduling options, date/time input, buttons, and history/model dialogs; closing a dialog restores focus and preserves the current setup.

The journal represents sampled prices within 15 seconds after a deadline. Scheduled capture requires this browser to be running; no server-side background timer exists. A live scheduled-start check and a live end-to-end 15-minute observation are separate from fast automated tests; report which were actually run.
