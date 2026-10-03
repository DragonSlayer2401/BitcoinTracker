# Kalshi purchase-value comparison

Open **Forecast risk → Compare purchase value**. The optional section uses the current model
probability for the saved contract, a requested whole number of contracts, and displayed asks.
It adds no height to the dashboard and never submits orders.

The order book supplies Yes and No bids. A No bid at $0.40 supplies a Yes ask at $0.60 with the
same quantity. The comparison walks up to 100 price levels, best ask first, to calculate the
quantity-weighted purchase cost. If depth cannot cover the requested quantity, it shows the
available quantity and its partial cost, but withholds whole-order expected value.

For a fully covered hypothetical buy held to settlement:

- Expected payout = current model probability × requested contracts.
- Gross expected value = expected payout − purchase cost.
- Net expected value = gross expected value − estimated exchange fee.
- Break-even probability = (purchase cost + estimated fee) / requested contracts.
- Profit if correct = requested contracts − purchase cost − estimated fee.
- Loss if incorrect = purchase cost + estimated fee.

These estimates depend on the model probability and displayed liquidity. They do not establish
an actionable advantage, guarantee a fill, or represent a forecast accuracy measurement.

The fee lookup verifies the current KXBTC15M series fee type and multiplier and applies the most
recent effective event override. Incomplete override pagination, unsupported schedules, failed
lookups, and expired fee information leave net value unavailable. A future event fee change
expires the current fee information at its effective time. The supported quadratic taker fee
uses `0.07 × multiplier × quantity × price × (1 − price)` at each filled price level.

Users explicitly choose whether they use Kalshi directly or through an intermediary. Integer
arithmetic calculates six-decimal-dollar trade fees and accumulates balance rounding across a
single hypothetical order. Direct-member balances align to $0.0001; intermediary balances align
to $0.01. The estimate assumes the displayed price-level fills; actual execution fragmentation
can change rounding. Unknown intermediary charges suppress net value even when the exchange
fee portion is available. Funding charges are outside this comparison.

The purchase-value service is in `src/services/kalshi/purchaseValue/`. It uses the existing
shared GET-only Kalshi transport and quota limiter. The resource allowlist permits exactly
100-level KXBTC15M order-book reads and a bounded, event-specific fee query. The component mounts
only while its optional section is open, polls every ten seconds while focused, and rejects
book receipts older than fifteen seconds. It never substitutes a midpoint for an ask or counts
an old response as fresh after a refresh error.

Official references checked on September 15, 2026:

- [Order-book bid/ask semantics](https://docs.kalshi.com/api-reference/market/get-market-orderbook)
- [Series fee metadata](https://docs.kalshi.com/api-reference/market/get-series)
- [Event fee overrides](https://docs.kalshi.com/api-reference/events/get-event-fee-changes)
- [Current fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)
- [Per-order fee rounding and member precision](https://docs.kalshi.com/getting_started/fee_rounding)

Targeted tests: `pnpm test -- KalshiPurchase KalshiRatePolicy KalshiRisk`.
