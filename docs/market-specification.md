# Market specification and shared domain contracts

Phase 2, reviewed **2026-11-06 America/Chicago** (2026-11-07 UTC). This document
records rules and implementation evidence, not an entry/exit strategy or a claim
of profitable execution. Production order submission is not implemented.

## Verified series and source register

The intended series is **KXBTC15M**, frequency `fifteen_min`, exchange index `2` in
the inspected responses. Its metadata names **CF Benchmarks** and links the generic
CRYPTO contract terms. These values identify the inspected series; the parser must
still verify each new response. Official sources were retrieved on the review date:

| Source                                                                                           | Applicable version or observation                                        | Use and limitation                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Series metadata](https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M)                  | Trade API v2; `last_updated_ts` observed as `2026-10-29T18:50:05.14347Z` | Series, settlement agency, terms URL and quadratic series fee multiplier 1. Re-read market/event fee metadata for execution; do not freeze this multiplier globally.                                                                        |
| [Inspected market](https://external-api.kalshi.com/trade-api/v2/markets/KXBTC15M-26NOV062315-15) | Final public parser check, `2026-11-07T04:13:18.254Z`                    | Actual market identity, primary/secondary rules, target, timestamps, payout and price ranges. One response is not evidence for every future market.                                                                                         |
| [Linked CRYPTO terms](https://assets.kalshi.com/contract_terms/CRYPTO.pdf)                       | No printed revision; retained as the linked terms reviewed on this date  | Settlement authority, expiry time and contingencies. Conflicting metadata is retained and blocks recommendations.                                                                                                                           |
| [Get Market](https://docs.kalshi.com/api-reference/market/get-market)                            | Trade API v2, unversioned online schema                                  | Timestamp meanings, price ranges, payout and market attributes. Market-specific fractional capability/minimum/increment was not present in the inspected schema or response.                                                                |
| [Fixed-point migration](https://docs.kalshi.com/getting_started/fixed_point_migration)           | Documentation updated November 5, 2026                                   | Dollar prices have four-decimal representation and quantities two-decimal representation. Representation does not establish a permitted increment. Read `price_ranges`; do not infer quantity permission from `_fp` fields.                 |
| [CF Benchmarks feed](https://docs.kalshi.com/websockets/cfbenchmarks-value)                      | Unversioned; explicit quarter-hour averaging semantics                   | The final-minute interval is start-exclusive and end-inclusive. Raw one-second BRTI values are distinct from rolling averages and proxy exchange prices.                                                                                    |
| [Fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)                                  | Effective July 7, 2026                                                   | General quadratic fee schedule and applicable exceptions; maker/taker applicability and event changes remain execution inputs. No settlement fee in this schedule.                                                                          |
| [Fee rounding](https://docs.kalshi.com/getting_started/fee_rounding)                             | Unversioned, reviewed on the date above                                  | Microdollar fee computation, signed revenues, rounding, per-order accumulation/rebates and direct/non-direct treatment. This phase preserves the existing conservative estimator; it does not establish exchange-equivalent fee accounting. |

Runtime specifications store source URLs, metadata receipt timestamps, reviewed
documentation dates/time zone, and available document versions. An unversioned URL
is labeled unversioned, never given an invented revision. Future documentation or
template changes require re-verification. Full document bytes are not archived by
this phase.

## Contract interpretation and unresolved evidence

| Field                      | Recorded interpretation                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reference index            | CF Benchmarks Bitcoin Real Time Index, **BRTI**, USD per BTC. Coinbase BTC-USD and Bybit BTCUSDT remain explicitly labeled proxies, not settlement sources.                                                                                                                                                                                |
| Opening reference          | Simple mean of 60 one-second BRTI readings in `(opensAt − 60 seconds, opensAt]`. The exchange-published `floor_strike` is the exact two-decimal target captured for comparison. A local opening estimate cannot replace it.                                                                                                                |
| Closing value              | Simple mean of 60 one-second readings in `(closesAt − 60 seconds, closesAt]`, rounded to the nearest two decimal places. A reading at the interval start is excluded; the close second is included.                                                                                                                                        |
| Comparison/tie             | `greater_or_equal`: final rounded value at or above target is YES, including equality; below is NO. Unsupported rule text/comparison is blocked.                                                                                                                                                                                           |
| Halfway rounding           | The reviewed terms specify nearest two decimals but do not resolve an exact half-cent. This remains unverified and prevents actionable recommendations. Tests may supply explicitly synthetic rounding evidence; it is not a venue claim.                                                                                                  |
| Trading timestamps         | UTC Unix milliseconds internally, strict UTC ISO strings at ingestion. `open_time` and `close_time` delimit the 15-minute trading interval. Existing legacy `expiresAt` names trading close; new `timestamps.expirationAt` names administrative expiry. These must not be interchanged.                                                    |
| Observed market times      | `KXBTC15M-26NOV062315-15`: open `2026-11-07T04:00:00Z`, trading close `04:15:00Z`, expected expiration `04:20:00Z`, expiration/latest expiration `2026-11-14T04:15:00Z`. Expected settlement timing is not an observed settlement.                                                                                                         |
| Expiration conflict        | Linked generic terms specify 10:00 AM Eastern; the inspected administrative expiry is 11:15 PM Eastern. `contract_expiration_schedule_conflict` blocks action. The implementation does not silently choose which source supersedes the other.                                                                                              |
| Trading close/early close  | Preserve `close_time`, `can_close_early` and `settlement_timer_seconds` separately. Inspected metadata: early close permitted and timer 1 second. These do not prove a fill or promise immediate settlement.                                                                                                                               |
| Payout and final authority | $1 per winning contract. Only the official finalized Kalshi result settles an account. Local comparison output always has `officialResult: null`.                                                                                                                                                                                          |
| Agency data unavailable    | Linked terms describe NO if the source-agency data necessary for the outcome is unavailable, subject to exchange review. A local missed reading, disconnected client, unavailable entitlement or failed request is not proof of that contingency. Even an explicitly confirmed source outage remains awaiting the official result in code. |
| Other contingencies        | Post-expiration revisions are excluded under the linked terms; settlement is due by the day after expiration except exchange outcome review; indeterminate expiration value is handled under exchange Rule 6.3(b). No local fallback invents an official payout.                                                                           |

Observed price metadata used `tapered_deci_cent`: $0.001 increments in the 0–0.10
and 0.90–1.00 ranges, and $0.01 in the middle. These are observations only. The
implementation parses and validates each contiguous range and mirrors YES prices
through $1 for the NO side. Malformed, overlapping or missing grids fail closed.

**Quantity rules remain unavailable.** No public response/schema evidence established
the selected market's permitted minimum/increment. Fractional book sizes and global
two-decimal quantity fields are insufficient. `quantityRules` remains null unless
explicit market-matched evidence with official provenance is supplied. There is no
user setting, API field guess or whole-contract fallback that declares it verified.

## Versioned interfaces and units

Use the existing JavaScript stack: JSDoc contracts plus runtime validators, without
a new TypeScript compiler or dependency. Types are in
[tradingDomain.types.js](../src/utils/tradingDomain.types.js); factories and validators
are in [tradingDomain.utils.js](../src/utils/tradingDomain.utils.js).

| Record               | Version                      | Required meaning                                                                                                                                                           |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market specification | `kalshi-market-spec-v1`      | Market/event/series identity, target, windows, rules, timestamps, price/quantity constraints and evidence status.                                                          |
| Observation          | `timestamped-observation-v1` | Source identity, event and receipt time, value/unit, observed/local-missing/agency-outage status. Agency outage requires source evidence.                                  |
| Forecast             | `outcome-forecast-v1`        | Model version, YES probability, causal input cutoff and validity time. Quotes are not part of this forecast contract.                                                      |
| Quote                | `market-quote-v1`            | YES/NO side, bid/ask, legal price/quantity and validity time. A quote is not a fill.                                                                                       |
| Order                | `trading-order-v1`           | Paper/demo only, BUY/SELL, side, size, limit, filled quantity and bounded state. Production mode is rejected; no submission method exists.                                 |
| Fill                 | `trading-fill-v1`            | Order identity, paper/demo mode, side/action, exact price/quantity and signed fee. No fabricated external fill confirmation.                                               |
| Position             | `trading-position-v1`        | Held side, quantity and cost basis.                                                                                                                                        |
| Decision             | `trading-decision-v1`        | BUY/HOLD/SELL, explicit side and flat/held position context, size, limit, reason and expiry. Flat HOLD has zero order quantity and no limit. SELL requires held inventory. |

Canonical base-10 integer **strings** are the JSON wire representation. Arithmetic
uses BigInt through [fixedPoint.utils.js](../src/utils/fixedPoint.utils.js); it does
not use binary floating point for new price/quantity multiplication or money rounding.

- Currency: USD. Price: USD/contract in `10^-4` dollars (`priceScale: 4`).
- Quantity: `10^-2` contracts (`quantityScale: 2`), subject to verified market rules.
- Money, signed fees and PnL: `10^-6` USD (`moneyScale: 6`). For example a price
  of `4250` and quantity `100` produce `425000` microdollars exactly.
- Probability: millionths, `probabilityScale: 6`; timestamps: safe integer UTC Unix
  milliseconds, `timestampUnit: unix-ms`.
- BRTI value: exact decimal string in USD/BTC; local diagnostic arithmetic retains
  up to 18 decimal places before averaging. The target is a two-decimal string.
- Explicit source IDs distinguish `kalshi`, `cf-brti`, `coinbase-btc-usd`,
  `bybit-btcusdt`, `forecast-model`, `paper-simulator`, `kalshi-demo`, and
  `synthetic-fixture`, with matching official/proxy/model/paper/demo/synthetic kinds.
- Source event time and local first receipt are distinct. REST books with no source
  event timestamp declare `observationClock: local-receipt`, `sourceObservedAt: null`.
  They do not fabricate exchange event times.

The existing account ledger and forecast archives retain their Number-based schemas.
Adapters validate exact decimal representation at the new boundary. This phase does
not claim a migration of every historical monetary calculation or all strategy sizing
to arbitrary fractional quantities; existing sizing policy remains in place and is
restricted to permitted increments.

## Ownership, flow and compatibility

- [marketSpecification.utils.js](../src/features/MarketData/utils/kalshi/marketSpecification.utils.js):
  `createKalshiMarketSpecification`, `parseKalshiUtcTimestamp`, supported-rule checks,
  and `evaluateKalshiSettlementSamples`. Rules are independent of trading strategy.
- [kalshi.validation.js](../src/services/kalshi/kalshi.validation.js):
  `parseKalshiSeries` retains specification metadata; `parseKalshiMarket` attaches
  the specification. Its fourth argument accepts `quantityRuleEvidence` and
  `roundingRuleEvidence`, separately from the API payload. Both require a matching
  market and reviewed source/version/receipt time. The evidence versions are
  `kalshi-quantity-rule-evidence-v1` and `kalshi-rounding-rule-evidence-v1`; the
  latter supports only explicitly evidenced `half-up` or `half-even` conventions.
- [contract.utils.js](../src/features/MarketData/utils/kalshi/contract.utils.js):
  new snapshots retain specifications; legacy identity matching remains based on
  original settlement fields. Archived records are not relabeled as verified v1.
- [tradingSpecification.utils.js](../src/features/SimulatedTrading/utils/tradingSpecification.utils.js):
  validates contract/spec identity, quotes, actionable decisions/orders and metadata
  increments; exact gross fill arithmetic and conservative grid-aligned slippage.
- Existing [tradingAdvisor.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/tradingAdvisor.utils.js),
  [advisorCandidate.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/features/Experiments/utils/advisorCandidate.utils.js),
  [advisorPlan.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorPlan.utils.js),
  and [paperTrading.utils.js](../src/features/SimulatedTrading/features/PaperTrading/utils/paperTrading.utils.js)
  consume that boundary. Missing/currently conflicting rules prevent a new BUY/SELL
  or a saved BUY being presented as executable.

Metadata → versioned specification → checked quote/decision/order → existing paper
execution and ledger. Forecast probability remains a separate input. Official
finalized outcome → existing settlement. A local 60-sample comparison is diagnostic
only, never an automatic settlement fallback.

PaperTrading adds `paper-decision-v2`/`paper-execution-v2` markers for new records.
Frozen legacy replay code is private to archive validation; new intents require the
specification. A frozen synthetic account generated from pre-Phase-2 Git source
checks unchanged old costs, fills, report and settlement. New exact accounting and
metadata grids are checked independently. No working account/history is rewritten.

## Acceptance and remaining checks

Fixtures live under TradingAdvisor `__tests__/MarketRules`, `__tests__/DomainContracts`,
and PaperTrading `__tests__/MarketRules`. Fixture sources, quantity/rounding permissions,
prices and fills are synthetic and labeled; no synthetic response is historical data.

The owning status file records exact focused/full test, formatting, build and visual
check results. Passing these checks accepts only their stated behavior. Live actionable
readiness remains blocked on official quantity evidence, expiration reconciliation
and halfway rounding. Fees, exchange lifecycle, calibrated probabilities and positive
net performance require their own later-phase evidence. Stop after Phase 2.
