# Verification

Run the owning feature's Jest tests after behavior changes, then the full suite, Prettier and a production build. Tests live in `src/features/BitcoinTracker/__tests__`.

```sh
pnpm test
pnpm format:check
pnpm build
```

If Windows prevents Turbopack from spawning its Sass worker, use `pnpm exec next build --webpack` and `pnpm exec next dev --webpack`, and report the environment limitation.

## Kalshi behavior to verify

1. Actual public contract target, open time and close time populate the panel. The expiration/settlement publication time must not change the countdown.
2. Joining late subtracts elapsed time. Future events with pending targets can be armed, restored and canceled; the schedule waits for fresh data and the official target, preserving the original deadline.
3. Fixed observation lasts at most three minutes with shorter late-entry waits. Weak or balanced valid calls publish. Essential invalid data can delay publication only through the saved cutoff. A fixed call remains unchanged while live probabilities move.
4. Live reversal risk uses the saved contract. Selecting or rolling to another event cannot attach a different target or deadline to that call.
5. The settlement model handles correlated readings, partial averages, missing elapsed samples, proxy uncertainty, cent rounding and YES equality. Do not display Coinbase spot bounds as a Kalshi settlement interval.
6. Closed calls await the exact official finalized result and retry after reload. Coinbase prints and later REST prices cannot settle a Kalshi call. Awaiting settlement does not block the next event.
7. Browser migration deletes old records and upload queues before sync starts, retains Kalshi records, rolls back failed IndexedDB transactions and exposes storage failures. Server migration is idempotent and rejects old writers.
8. Real checkpoint collection records missing captures without inventing inputs. Overlapping events/checkpoints remain grouped across chronological splits; candidates cannot activate using future labels or unsupported inputs.
9. History and research reports show only Kalshi outcomes, honest sample counts and absent scores when no results exist.
10. At desktop and mobile widths, verify React Select keyboard interaction, visible countdown, ECharts hover/keyboard point inspection, focus return from modals, no horizontal overflow, and no hydration warnings.

## BRTI chart behavior to verify

The chart tests include `BenchmarkChart.test.js`, `ChartIndicators.test.js`, `TradingChartOptions.test.js`, `PriceChart.test.jsx`, `ChartDrawings.test.jsx`, and `ChartDrawingInteraction.test.jsx`. Numerical tests check known EMA/MACD/RSI values, candle boundaries, sample coverage, and initialization after missing or partial candles.

1. Open Tools and switch between line and 1/3/5/15-minute candles and each history duration. Confirm display settings, comparison, and drawing placement belong to Tools, saved drawings belong to the separate Drawings manager, and zoom/pan/reset work directly beneath the plot without opening a popup. Confirm observed OHLC and sample counts remain accurate, missing periods stay empty, partial/forming candles are labeled, and stale history never appears live.
2. Toggle MACD, RSI, and EMA. Confirm separate MACD and RSI headings, value readouts, backgrounds, and dividers, with each panel disappearing when disabled. Check linked crosshairs and zoom, a stable price readout above the plot, and correct inspected prices using both pointer and keyboard controls. Historical line inspection must use a candle that closed at or before the inspected reading, with its close timestamp displayed. Indicators must stay blank until enough complete, consecutive candles exist; zooming must not restart initialization. Longer candle intervals may not have enough history even in the four-hour view.
3. Inspect an observation, open Tools to pin it, then inspect another and verify the dollar and percentage differences. Confirm the pinned value stays fixed as new readings arrive, Clear comparison in Tools removes it, and changing view or candle interval resets it.
4. Choose horizontal/vertical or two-point trend placement from Tools; the popup should close for chart interaction. Open Drawings to enter exact prices and local times, edit labels/colors, delete individual lines, clear all drawings, and undo. Verify deletion and clearing survive reloads, plus the 50-drawing limit, visible storage errors, and synchronization with another tab without undo overwriting that tab's edits. Confirm drawing mode pauses pan/zoom and Escape cancels placement.
5. Expand and restore the chart without losing selected settings, drawings, comparison, or zoom. Confirm Tools, Drawings, and direct zoom controls work in both dashboard and expanded views. At desktop and mobile widths, inspect the compact chart header, popup scrolling, readable panels, keyboard access, modal focus return, and absence of horizontal page overflow.
6. Confirm chart-only changes do not modify captured forecasts, probabilities, research inputs, or settlement rules. Additional history requests occur only for longer history selections; zooming and drawing do not trigger them.

Public API smoke checks require network access. Entitled benchmark tests require configured Kalshi credentials and access; report that verification separately. Passing tests proves software behavior, not forecast accuracy.
