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

Public API smoke checks require network access. Entitled benchmark tests require configured Kalshi credentials and access; report that verification separately. Passing tests proves software behavior, not forecast accuracy.
