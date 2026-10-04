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
10. At desktop and mobile widths, verify React Select keyboard interaction, visible countdown, native chart controls and keyboard access, focus return from modals, no horizontal overflow, and no hydration warnings.

## Coinbase chart behavior to verify

The chart tests cover completed Coinbase OHLC, indicator initialization, the live ticker marker,
Kalshi target overlays, separate drawing storage, and source-specific history behavior. Existing
BRTI tests retain coverage for its per-second observation rules. Dashboard tests ensure the target
tracks the current event while saved research retains its original contract.

1. Check one-minute candles, line view, 3/5/15-minute aggregation, MACD/RSI/EMA and 15m/30m/1h/2h/3h
   history. Gaps remain gaps; no fabricated BRTI sample counts or incomplete exchange candles.
2. Verify the amber target line and price label match the current Kalshi strike, remain visible
   during zoom, update on event rollover, and disappear when no valid target exists. The current
   Coinbase price has a separate marker; overlapping labels must remain legible.
3. Confirm the source note and separate BRTI headline distinguish spot chart prices from the
   settlement index. No BRTI average or forecast-range overlay appears on the Coinbase chart.
4. Use drawings, exact editing, clear/undo and reload. Coinbase drawings must never read or
   overwrite old BRTI drawings. Expand/restore must retain the chart's zoom and drawing state.
5. At desktop and mobile widths, inspect candle readability, indicator separation, hover values,
   keyboard controls, visible target/countdown, modal focus return and absence of horizontal page
   overflow. The main chart should fill its desktop panel rather than shrink into a price strip.
6. Changing chart controls must make no new market requests, especially no
   `/api/kalshi/benchmark/history` calls. Model inputs, collection and settlement remain unchanged.

Public API smoke checks require network access. Entitled benchmark tests require configured Kalshi credentials and access; report that verification separately. Passing tests proves software behavior, not forecast accuracy.

## Adviser V2 checks

Owning tests live under `features/TradingAdvisor/__tests__/`. Verify configuration migration
preserves losses/cash/risk history, rejects active collection or outstanding obligations, and
does not allow a retired policy to resume writing. Test replay with the historically selected
strategy, complete fresh valuation, daily equity state and delayed execution risk rechecks.
Partial buy/sell fills must cancel the remainder, free reservations and retain proportional cost.

Profit-trial tests use real in-memory repositories and shared observations: future fixed cohort,
missing results, zero-trade outcomes, partial fills, coverage, fees, promotion, rollback and restart
handling. No network requests or actual account configuration changes are required by tests.
Collector-control tests mock process ownership, IPC shutdown, duplicate launch, authentication and
same-origin checks. Local Start/Stop browser smoke tests are separate from these mocked checks.

At desktop and mobile sizes check Setup validation, keyboard controls, visible saved/unsaved state,
collector status, sell price in cents, net proceeds vs profit, expired-plan suppression and
Performance trial progress. No newly displayed percentage should imply proven trading profit.

## History-aware adviser checks

The TradingAdvisor tests also cover independent incumbent, rules and AI paper accounts; causal
same-contract evidence; candidate disagreement without weakening incumbent validation; pullbacks,
deterioration and expiry; structured output validation; delayed/restarted inference; and durable
spend limits. Providers are mocked: these checks do not send paid requests.

Verify that AI decisions create and fill their own delayed paper orders even when the incumbent
has no pending order. Shared execution claims must prevent duplicate fetches or favorable retries
after a lost request. Partial fills cancel remainders; expired orders release cash. Late API charges
must affect net profit and drawdown even after the last settlement.

Check plan/readiness separation, consumed BUY intentions, unchanged HOLD plans with no validity
extension, stale-plan labels, disabled provider state and visible independent-account results.
Actual API latency, account entitlement and prospective profit evidence require a separately
configured collector run; passing tests does not establish a profitable policy.
