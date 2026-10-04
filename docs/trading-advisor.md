# Position-aware Bitcoin trading adviser

The primary product goal is useful trading decisions evaluated by profit after costs and risk.
Forecasting remains a supporting input and a separate research program. The dashboard therefore
leads with an action, its price and quantity, the simulated account and open positions. Forecast
controls, model research and diagnostic panels remain available in the research dialog.

This release evaluates an experimental adviser with simulated money. It does not connect the
displayed holdings to the user's real Kalshi portfolio, place orders or claim validated profit.
The word UP maps to the contract's YES result; DOWN maps to NO. Exact official contract rules,
target and closing time remain authoritative, including the final-minute BRTI average and equality.

## Start and inspect

```sh
pnpm research:collect --trading-advisor
pnpm research:collect --advisor-report
```

The first command adds the adviser to continuous forecast research. The second only reads saved
results. Stop an existing collector before restarting it with a new flag. To continue the older
entry-and-hold experiment too, use `--paper-trading --trading-advisor`. Its `kalshi-paper-v1`
account, policy and evidence remain separate and unchanged.

The private `GET /api/research/trading-advisor` endpoint reads the archive. Dashboard polling does
not request more exchange data, start a collector or train a model. Only the collector requests
books and official outcomes through the existing shared Kalshi limiter. No paid API or new key
is required beyond the existing configured market access.

## Frozen experimental rules

`kalshi-advisor-v1` starts with $100. The total allocation cap is $100, including committed
capital and fees; profit does not authorize exceeding this cap. Additional limits keep this first
experiment small: $50 cash reserve, $20 aggregate open risk, at most $10 per position, and at most
20 contracts per recommendation. New entries stop while recognized net losses in a UTC day are
$5 or worse. Existing positions can still lose, so that trigger is not a guaranteed loss ceiling.

Advice is observed at a 15-second cadence. Each actionable intention receives one later execution
observation, two to fifteen seconds after its decision. The calculation subtracts five percentage
points from an entry probability, requires three cents of expected profit per contract after fees,
and assumes one cent of adverse slippage per contract. For exits it compares selling with holding
using a five-point upward probability allowance and one cent of required sale advantage.

These are declared engineering assumptions, not fitted policy settings or statistical confidence
bounds. They need prospective comparison and cost sensitivity checks. A new policy version needs
new evidence; saved decisions must never be recalculated into more favorable history.

New purchases are not recommended or filled during the final 30 seconds. Exits remain eligible
until the exact close. This separates data/latency protection from the daily entry-loss trigger.

## Buy, hold, sell and wait

The engine consumes the current deployed forecast, a verified contract, fresh depth and fee data,
and the recorded simulated portfolio. It prices both YES and NO entries. A one-dollar contract's
model fair value is its settlement probability. Purchase cost comes from actual asks across the
required depth, plus adverse slippage and the existing exchange-fee estimate.

```text
entry value = quantity * probability - purchase cost - entry fee
cautious entry value = quantity * max(0, probability - 0.05) - purchase cost - entry fee
```

Only quantities meeting the per-contract edge and all cash/risk limits can be recommended. An
existing or pending position prevents another entry into the same event. BUY includes a maximum
price and maximum fee-inclusive cost. It is a simulated recommendation, not an exchange order.

For owned contracts, executable sale value consumes bids on the owned side, subtracts adverse
slippage and estimates the exit fee. Bids are recovered from the opposite side's asks using the
binary complement relationship already used by the purchase service. See the official
[Kalshi order-book documentation](https://docs.kalshi.com/getting_started/orderbook_responses).

```text
hold value = quantity * current settlement probability
sale value = executable sale proceeds - exit fee
```

A sale is preferred only when net proceeds clear the uncertainty-adjusted hold value and the
required advantage. The original purchase price does not enter this comparison: it is already
spent. It remains essential for realized profit accounting. SELL can reduce a position if only
a smaller whole-contract quantity has adequate depth; it cannot sell contracts already reserved
for another exit. Daily entry restrictions do not prohibit a valid exit.

HOLD means holding currently wins that comparison with usable inputs. Missing forecasts, fees,
depth or timely data instead produce WAIT with an explanation; missing evidence is not a confident
hold recommendation. A fresh recommendation is invalidated when its contract closes or its
observation expires. The UI must not display an old BUY/SELL as an actionable current instruction.

Account, position and performance panels show the report's snapshot time. A failed refresh,
missing or future timestamp, or snapshot at least 30 seconds old marks those values as outdated
and suppresses actionable advice. Cached values remain visible as last-known information until
a successful, timely refresh replaces them.

## Conditional sell limits

For owned contracts, a fee-aware search supplies a minimum sale price at which net proceeds would
beat the uncertainty-adjusted value of holding. The price is derived from current information;
it is not a hard-coded 90-cent target. If no qualifying price below $1 exists, no target is shown.

Suggested buy and sell limits use whole cents, which Kalshi documents as valid across its price
structures. Depth observations retain their original finer precision. The engine does not assume
every arbitrary four-decimal dollar limit is accepted. See
[Kalshi price grids](https://docs.kalshi.com/getting_started/fixed_point_migration).

This is a conditional plan requiring fresh reassessment, not a submitted standing order or a
promised fill. The estimate uses the available conservative fee assumptions rather than assuming
a resting order is free. Limit-order advice and simulated immediate exits are distinct. This
release does not simulate maker queue position or automatically fill a target because a chart
touched its price. See [Kalshi limit sales](https://help.kalshi.com/en/articles/13823815-limit-order-sale).

## Execution and evaluation

The intention, quantity, limits, probability, model and evidence are saved before execution.
The later book must cover the requested quantity at acceptable prices and within its time window.
Fees are refreshed. There is no series of retries selecting a favorable snapshot. Interrupted or
expired attempts become no-fills. All fills are simulations from observed depth, not exchange
confirmations; displayed orders may disappear before a real order executes.

The execution request has an overall deadline bounded by the saved fill window and contract
close. A hung or late response becomes a no-fill and releases its cash or quantity reservation;
a later response cannot retry that execution. If storage fails after an observation was captured
on time, recovery retains that exact observation and capture time rather than fetching a new book.

Sale proceeds credit cash. Each partial sale realizes its proportion of original purchase cost
and entry fee, plus its own exit fee; only the remaining quantity and cost basis stay open. Exact
official Kalshi outcomes resolve remaining positions. Unknown outcomes stay unresolved rather
than being inferred from a last Bitcoin price.

The report compares realized results, entry and exit counts, fees, available cash and open risk.
Realized drawdown excludes market-value changes in open positions, and available cash is not
equity. Comparisons with holding to official settlement use the same entered positions and wait
for their official outcomes, including positions sold before close. No future outcome enters
an earlier decision. Neither early profit nor a high win rate automatically promotes this policy.

The hold comparison evaluates exits for each actual entered position. If the adviser sells and
later reenters the same event, those hypothetical holds can overlap. It is not a separately
budget-constrained buy-and-hold account and does not by itself prove that the entries are useful.

## Account value and sampled risk

The **Account risk** dialog shows prospective `advisor-valuation-v1` observations. The collector
reuses the book already archived for each advice or execution and values the resulting holdings
in the same transaction as that account update. Settlement/comparison updates also record a mark;
holdings without a matching usable book remain unpriced. Report requests only read those marks.
No extra exchange requests, new bankroll, retroactive prices or policy changes are introduced.

```text
estimated account value = available cash + reserved buy cash + net liquidation value
net liquidation value = proceeds from selling every held contract - exit fees and slippage
unrealized P&L = net liquidation value - remaining entry cost (including entry fees)
total marked P&L = estimated account value - initial bankroll
capital still at risk = remaining entry cost + reserved buy cash
cash left if all exposure loses = available cash
```

Reserved sell contracts remain owned and are counted once. Each complete sale estimate uses the
whole held quantity and the displayed bid depth, with the same fees/slippage as the existing
adviser. It does not assume a last trade or midpoint is executable. After a partial sale,
remaining holdings wait for a new book rather than reuse bids consumed by that simulated sale.
All BTC exposures count toward the worst case; opposite sides and related events receive no assumed diversification
benefit. A pending buy is still cash in the current valuation, but its maximum reserved cost
counts as potential loss. These are simulated estimates, not guaranteed sale proceeds.

If any holding has stale/missing prices, unknown fees, insufficient depth or an expired contract
awaiting official settlement, complete account value and unrealized P&L remain unknown. Known
individual estimates remain labeled separately. An old or mismatched-account mark is not made
current by refreshing the report. Current totals disappear when the quote, fees or contract
expire, and never remain current more than 30 seconds after the mark.

Sampled drawdown measures decline from the higher of the original bankroll and the highest
complete observed account value. The dialog shows when tracking started, the last complete mark,
and complete/incomplete counts. Missing marks never reset the peak or become zero-value holdings.
This is not a continuous maximum drawdown or reconstructed history before deployment. The
existing realized P&L and realized drawdown remain separate.

These measurements support later profit/risk-based policy comparisons. They do not size trades
from an unvalidated probability, automatically liquidate holdings or change the frozen `$5`
realized-loss entry trigger. Configurable sizing, portfolio drawdown stops, partial-order fills,
and prospective trading-policy promotion require separately versioned implementation/evidence.

## Storage and ownership

`features/TradingAdvisor/utils/tradingAdvisor.utils.js` owns shared pure advice and execution math.
`services/research/tradingAdvisor/` owns the durable simulated account, immutable observations,
execution and settlement workflow, and read-only reporting. The collector supplies production
forecast inputs. UI components remain in `features/TradingAdvisor/`; the root tracker composes them
with the existing chart and keeps research lifecycles mounted in the background.

Every observation archives compact inputs sufficient to replay the adviser calculation. Actionable
intentions additionally retain compressed full research inputs for inspecting the underlying
forecast. Compact WAIT/HOLD observations do not independently reproduce the entire forecasting
pipeline. Account summaries are updated transactionally with evidence, while audit history remains
available separately; routine dashboard reads do not load all archived BRTI samples.

Collector ownership uses a durable lease with fenced writes. A second collector cannot treat a
currently owned execution request as a failed attempt. Capital and owned quantities are reserved
atomically. Hashes and immutability detect ordinary corruption/conflicts but are not protection
against an administrator rewriting the database and its checks.

`advisor_valuations` is append-only and references its original advice or event by source ID.
`advisor_risk_state` stores the latest hashed mark and accumulated sampled-risk statistics for
bounded report reads. Valuation persistence and account/evidence changes commit or roll back
together. Existing account balances, losses and old observations are preserved.

Future work includes real portfolio reconciliation, user-confirmed transactions, resting-order
lifecycles, execution-quality validation, policy comparisons on unseen periods, calibrated sizing,
and executable portfolio risk controls. Real order routing requires a separate explicitly authorized
phase. Existing forecast research and chronological validation continue independently.
