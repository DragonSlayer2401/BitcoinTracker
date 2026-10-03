# Prospective paper trading

The product objective is long-term profitability after costs, subject to bankroll protection.
Forecast accuracy and calibration support that objective; they do not establish trading profit.
This first phase measures one experimental entry policy followed by holding to official Kalshi
settlement. It never submits an order or changes a prediction model's activation rules.

## Run and inspect

Stop the existing research collector normally before starting its replacement:

```sh
pnpm research:collect --paper-trading
```

The flag adds paper collection to the same research process, using its existing feeds and
current production probability. Without the flag, ordinary forecast research behaves as before.
Only one collector may own a state-file lock; never remove a live process's lock.

Read saved results without opening feeds, starting paper collection, fitting or activating models:

```sh
pnpm research:collect --paper-report
```

The dashboard's **Paper trading** button opens the same report. Its read-only, private
`GET /api/research/paper-trading` endpoint polls only while the popup is open. An old heartbeat
does not prove a collector is still running. No additional paid API is required by this phase;
it reuses the configured Kalshi access and existing order-book and fee endpoints.

## The frozen first experiment

`kalshi-paper-v1` starts with these explicit, unoptimized assumptions:

| Setting                     | Value                                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| Simulated starting cash     | $100                                                                           |
| Entry checkpoint            | Six minutes before the exact official close; five seconds of grace             |
| Size                        | One contract, at most one entry attempt per event                              |
| Account fee assumptions     | Direct Kalshi account; verified current exchange fees                          |
| Probability allowance       | Subtract five percentage points from the chosen side's probability             |
| Required remaining edge     | At least $0.03 per contract after the allowance, fees and assumed slippage     |
| Adverse slippage assumption | Add $0.01 to each contract's depth-derived purchase price                      |
| Execution observation       | First attempted new book request from two through fifteen seconds after intent |
| Maximum aggregate open risk | $5, including unfilled intent reservations                                     |
| Daily loss trigger          | Stop new entries once recognized net losses reach $5 in a UTC day              |
| Exit                        | Hold to official settlement                                                    |

The daily trigger is not a guaranteed daily loss ceiling: positions already open can still lose.
The probability allowance is a declared sensitivity assumption, not a calibrated confidence
interval. These parameters were not selected to maximize historical returns. A policy's settings
cannot change under its existing ID. Changing the policy requires a new version and new prospective
evidence; it must not reset or relabel the previous experiment.

## Decision and fill math

Both sides are evaluated. A YES contract paying $1 has model fair value `P(YES)` dollars;
NO has fair value `1 - P(YES)`. The book's actual ask levels and quantities determine purchase
cost. Walking that depth already incorporates the spread and displayed depth impact; the spread
is not charged again. We then apply the declared adverse slippage assumption and the existing
verified quadratic exchange fee estimate.

For one contract:

```text
estimated net value = chosen-side probability - simulated price - fee
cautious net value = max(0, chosen-side probability - 0.05) - simulated price - fee
```

The side with the greater qualifying cautious value becomes the entry intent. Otherwise the
decision is **No trade**, with the exact reason retained. A numeric search finds the largest
four-decimal price that still clears the cautious edge after fees. Cash is reserved at that
maximum cost, not merely the cheaper initial quote. Cash and risk are checked again in the database
transaction, so simultaneous processes cannot independently spend the same paper capital.

The probability, model identity, complete research replay inputs, contract identity, decision book,
fee metadata, portfolio and policy are saved before simulating any fill. The later book must have
been requested and received after the minimum delay. It must cover the entire contract within the
saved price and cost limits. This is an all-or-none snapshot simulation, not evidence that Kalshi
executed an order. Missing depth, fees or timely data yields a saved no-fill; there is no sequence
of retries waiting for a more favorable price. The later book and fee snapshot are also saved.

On restart, a past fill window becomes a no-fill; a historical book is never reconstructed.
The execution attempt is committed before requesting the later book. An interrupted request
becomes a conservative no-fill on restart, even if time remains; it cannot request a second price.
An unresolved filled position retains its cash usage and open risk. Only a verified, matching
official Kalshi settlement can pay it out. An API outage does not invent a losing or winning result.
Exact writes can be retried without changing the original intent, execution or settlement.

The fee math is shared with [purchase value](kalshi-purchase-value.md). It remains an estimate:
actual execution fragmentation and account-specific charges can differ. This experiment excludes
funding charges, intermediary charges, maker queue assumptions, early exits and live order routing.

## What the results mean

The report includes decisions, skips, attempted and filled trades, unresolved positions, available
cash, reserved cash, open risk, recognized net profit/loss, fees, average return per settled trade,
win rate, profit factor, trade coverage, return on initial cash and largest realized drawdown.
Expected versus actual results use the same settled trades, with expected value recomputed from
the frozen entry probability and simulated fill costs. Results can be grouped by model and side.

Realized drawdown excludes mark-to-market losses on open positions. Available cash is not account
equity. Profit factor is unavailable until there are losses; zero completed trades is not evidence
of zero-risk performance. The report does not annualize a tiny sample or present a Sharpe ratio
without an adequate return series. Current production models may change under their separate
prediction validation process; each paper decision preserves the exact probability and model used.

Old forecast research lacks contemporaneous execution depth and fees. It is not imported as past
paper profit. Collector downtime can miss entire events; trade coverage is among recorded
opportunities, not all Kalshi events. A late but observed event is explicitly recorded as a missed
checkpoint. Original input archives remain immutable for later replay and audit.

Paper results are prospective observations of an experimental policy, not a release approval for
live trading. Future changes need chronological development, a separately frozen later evaluation,
cost and latency stress tests, comparisons against no trade and simpler price-based strategies,
and adequate evidence across market conditions. A few profitable trades cannot demonstrate a
reliable edge. Entry policy, probability calibration, position sizing and exit policy must remain
separate so a change's contribution can be measured.

## Ownership and next phase

- `src/features/BitcoinTracker/features/PaperTrading/utils/paperTrading.utils.js` owns policy,
  decisions, simulation, accounting and summary calculations.
- `src/services/research/paperTrading/` owns durable paper records and orchestration; the collector
  only supplies current forecast inputs and calls the workflow.
- `paper_policies`, `paper_decisions`, `paper_execution_attempts`, `paper_events` and `paper_heartbeats` live in the configured
  research database (locally `data/bitcoin-research.db`). Prediction evidence remains separate.
  Policy, decision and lifecycle records reject changes and conflicting identity reuse.
- Routine reads use separately hashed compact decision records; full replay inputs remain available
  through the repository's `readDecision`. The first-phase report has an explicit 10,000-record
  limit per list and fails rather than silently truncating balances. Longer-running archives need
  a paginated accounting report before reaching that bound.
- The feature's modal and injected RTK Query endpoint only read saved results. Its tests live in
  `features/PaperTrading/__tests__/`.

There are normally two book/fee bundles per qualifying event: one for the decision, one later
for execution. Each bundle performs three bounded reads through the existing shared Kalshi limiter.
Pending official results are retried at most once per minute per open paper position. No Kalshi
write requests, new signing proxy or separate rate-limit pool are introduced.

The next phase should record a fixed cadence of sell-side depth and fees before testing cash-out
rules. For an owned contract, compare expected settlement proceeds with executable sale proceeds
after exit costs; the original purchase price is a sunk cost for that choice, while remaining
essential for lifecycle P&L. Exit evidence must be collected prospectively too. Bankroll sizing
and eventual supervised execution need their own validation and explicit operating limits.
