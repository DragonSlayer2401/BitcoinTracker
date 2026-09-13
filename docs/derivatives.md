# Futures inputs in the current prediction

The browser and persistent collector subscribe to Bybit's public BTCUSDT linear perpetual trade, ticker, and all-liquidation topics. No API key or paid market-data subscription is configured. The connection uses the documented public endpoint directly; connection failures produce an explicit optional-feed fallback. These reads do not consume Kalshi's API quota.

## Calculation

`kalshi-brti-derivatives-v1` extends the existing settlement-average calculation. The official target, closing time, cent rounding, and final-minute BRTI average remain the predicted event.

- Executed buy and sell BTC are measured over 15, 60, and 180 seconds. Large executions are classified relative to earlier activity; a current burst cannot establish its own threshold.
- A fit between signed executed BTC and observed returns in completed 15-second intervals estimates recent price response. Six intervals are needed initially. Shrinkage reduces small-sample influence, and current buying/selling that prices absorb receives less directional weight.
- Large executions and reported liquidations change the directional weighting within a capped budget. Liquidation BTC is not added to trade BTC, since those executions may already be in the trade stream.
- The futures shift decays with a one-minute half-life. Its maximum is 0.35 times the selected settlement minute volatility times the square root of the shorter of the remaining horizon and three minutes. This prefers BRTI history and retains the existing Coinbase volatility fallback when that history is unavailable. Combined spot and futures drift has a separate 0.85 limit on the same scale.
- Liquidation stress can add temporary future-price variance. Observed BRTI readings and elapsed interpolation retain their original treatment; current futures information never rewrites past settlement samples.

These are explicit engineering assumptions, not fitted accuracy guarantees. The futures adjustment affects live percentages and live reversal risk immediately when usable, and is captured once when a new fixed call publishes. It does not wait for a saved-outcome learner to activate. Missing futures inputs remove only this adjustment, without creating a no-call rule.

## Source semantics and reliability

Trade `S` is the **taker** side: Buy means an aggressive buyer. Liquidation `S` is the **position** side: Buy means a long was liquidated, hence selling pressure; Sell means a short was liquidated. A liquidation's published price is a bankruptcy price and is not treated as an execution price.

Trade IDs deduplicate executions. Repeated cross-sequence values may contain distinct trades and are not discarded as duplicate batches. Off-book block trades are excluded from aggressive pressure. Subscription acknowledgements establish the observation boundary; reconnects clear rolling measurements. Buffers, frames, and reconnect retries are bounded. Coverage is explicitly venue-reported; no claim is made that this is every futures trade or liquidation across the market.

## Saved data and learning

New forecasts retain compact futures diagnostics, the probability before futures, the probability after futures, and the exact baseline version. Captured diagnostics are immutable alongside a fixed call. The full learner's v3 feature vector includes futures flow, large-trade pressure, liquidation context, price response, and basis with explicit availability indicators. The early learner still learns a small correction to the resulting baseline percentage.

Historical v2 forecasts, feature vectors, and model artifacts remain readable and scored. They are not relabeled as futures-aware examples. A learner fitted to the earlier baseline cannot silently adjust the new baseline; prospective validation requires compatible newly captured inputs. Existing database records are preserved.

## Inspecting the effect

The Market data panel shows futures imbalance and the effect on Yes probability. Market detail shows executions, large-trade volume, liquidation sides, and the before/after probabilities. A fixed or live estimate using the adjustment shows “Futures pressure”; an active learned correction retains its separate “Learned model” label.

## Official references

- [Public connection and authentication](https://bybit-exchange.github.io/docs/v5/ws/connect)
- [Trade stream and taker-side semantics](https://bybit-exchange.github.io/docs/v5/websocket/public/trade)
- [Liquidation position-side semantics](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation)
- [Ticker, index, mark price, and open interest](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker)
