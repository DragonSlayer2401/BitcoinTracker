/**
 * Shared Phase 2 wire contracts. Integer units serialize as canonical base-10 strings;
 * timestamps are safe integer UTC Unix milliseconds. BigInt is calculation-only.
 * Existing archived v1 feature records retain their own schemas and are not relabeled.
 *
 * @typedef {string} IntegerUnits
 * @typedef {'YES'|'NO'} OutcomeSide
 * @typedef {'BUY'|'HOLD'|'SELL'} DecisionAction
 * @typedef {{id: 'kalshi'|'cf-brti'|'coinbase-btc-usd'|'bybit-btcusdt'|'forecast-model'|'paper-simulator'|'kalshi-demo'|'synthetic-fixture', kind: 'official'|'proxy'|'model'|'paper'|'demo'|'synthetic'}} DomainSource
 * @typedef {{start: IntegerUnits, end: IntegerUnits, step: IntegerUnits}} PriceRange
 * @typedef {{id: string, kind: 'official'|'synthetic', url: string, retrievedAt?: number, retrievedOn?: string, retrievalTimeZone?: string, documentVersion: string|null}} RuleSource
 * @typedef {{minimum: IntegerUnits, step: IntegerUnits, maximum?: IntegerUnits|null, source: RuleSource}} QuantityRules
 * @typedef {{startAt: number, endAt: number, startInclusive: false, endInclusive: true, sampleCount: 60, sampleIntervalMs: 1000}} ReferenceWindow
 *
 * @typedef {object} MarketSpecification
 * @property {'kalshi-market-spec-v1'} version
 * @property {string} marketTicker
 * @property {string} eventTicker
 * @property {'KXBTC15M'} seriesTicker
 * @property {'USD'} currency
 * @property {'unix-ms'} timestampUnit
 * @property {4} priceScale USD per contract, in ten-thousandths.
 * @property {2} quantityScale Hundredths of a contract; representational precision is not permission to trade every increment.
 * @property {6} moneyScale USD microdollars for costs, fees, cash and PnL.
 * @property {{value:string, scale:2}|null} target Exact reference-index decimal; never a trading price.
 * @property {{id:'cf-brti',kind:'official',index:'BRTI',agency:'CF Benchmarks',unit:'USD/BTC'}} referenceSource
 * @property {ReferenceWindow|null} referenceWindow
 * @property {ReferenceWindow|null} closingWindow
 * @property {'greater_or_equal'} comparison
 * @property {'YES'} tieResult
 * @property {{decimalPlaces:2,mode:'nearest',halfway:'unspecified'|'half-up'|'half-even',source:RuleSource|null}} rounding Actionable rules require explicit halfway evidence; synthetic assumptions remain labeled.
 * @property {{opensAt:number|null,closesAt:number|null,expectedExpirationAt:number|null,expirationAt:number|null,latestExpirationAt:number|null,settledAt:number|null}} timestamps
 * @property {{timeZone:'America/New_York',localTime:'10:00:00',sourceUrl:string,settlementDeadline:'day_after_expiration_except_exchange_review'}} expirationRule
 * @property {boolean|null} canCloseEarly Captured venue metadata; unknown blocks action.
 * @property {number|null} settlementTimerSeconds Venue-reported delay, in seconds.
 * @property {PriceRange[]} priceGrid Verified YES-book grid. NO prices are mirrored through one dollar.
 * @property {string|null} priceLevelStructure Venue grid classification; ranges define the actual supported prices.
 * @property {QuantityRules|null} quantityRules Missing venue capability evidence remains null.
 * @property {'1000000'} payoutUnits One USD contract payout, in microdollars.
 * @property {{localMissingObservation:'unknown_not_source_outage',sourceAgencyDataUnavailable:'contract_no_subject_to_exchange_review',postExpirationRevisions:'excluded_by_contract_terms',outcomeReview:'exchange_may_review_before_settlement',indeterminateExpirationValue:'exchange_determines_payout_under_rule_6_3_b',settlementAuthority:'official_finalized_kalshi_result'}} contingency
 * @property {boolean} outcomeRulesVerified Matching outcome semantics alone do not establish trading readiness.
 * @property {{status:'verified'|'incomplete'|'conflicting',reasons:string[]}} verification
 * @property {boolean} actionable
 * @property {RuleSource[]} sources
 * @property {{primary:string|null,secondary:string|null}} ruleText Captured market-specific rule wording.
 * @property {number} receivedAt Local metadata receipt, in UTC Unix milliseconds.
 *
 * @typedef {object} DomainRecord
 * @property {string} id
 * @property {string} marketTicker
 * @property {'kalshi-market-spec-v1'} specificationVersion
 * @property {DomainSource} source
 * @property {number} observedAt Observation/event time, UTC Unix milliseconds; a local-receipt clock explicitly identifies sources without an exchange event timestamp.
 * @property {number} receivedAt First local receipt time; never earlier than observedAt.
 * @property {'source-event'|'local-receipt'} [observationClock] Omitted means source-event.
 * @property {number|null} [sourceObservedAt] Null for local-receipt records; do not invent an exchange timestamp.
 * @property {'USD'} currency
 * @property {'unix-ms'} timestampUnit
 * @property {4} priceScale
 * @property {2} quantityScale
 * @property {6} moneyScale
 *
 * @typedef {DomainRecord & {kind:'observation',version:'timestamped-observation-v1',status:'observed'|'locally-missing'|'source-agency-outage',value:string|null,unit:'USD/BTC'|'USDT/BTC'|'USD/contract'|'contracts',sourceEvidence?:{url:string,retrievedAt:number}}} TimestampedObservation
 * @typedef {DomainRecord & {kind:'forecast',version:'outcome-forecast-v1',modelVersion:string,probabilityYesUnits:IntegerUnits,probabilityScale:6,inputObservedThroughAt:number,validUntil:number}} Forecast
 * @typedef {DomainRecord & {kind:'quote',version:'market-quote-v1',side:OutcomeSide,bookSide:'bid'|'ask',priceUnits:IntegerUnits,quantityUnits:IntegerUnits,validUntil:number}} Quote One timestamped order-book level, not a promised fill.
 * @typedef {DomainRecord & {kind:'order',version:'trading-order-v1',mode:'paper'|'demo',side:OutcomeSide,action:'BUY'|'SELL',quantityUnits:IntegerUnits,limitPriceUnits:IntegerUnits,filledQuantityUnits:IntegerUnits,status:'pending'|'partially-filled'|'filled'|'canceled'|'rejected'}} Order
 * @typedef {DomainRecord & {kind:'fill',version:'trading-fill-v1',mode:'paper'|'demo',orderId:string,side:OutcomeSide,action:'BUY'|'SELL',priceUnits:IntegerUnits,quantityUnits:IntegerUnits,feeUnits:IntegerUnits}} Fill
 * @typedef {DomainRecord & {kind:'position',version:'trading-position-v1',side:OutcomeSide,quantityUnits:IntegerUnits,costBasisUnits:IntegerUnits}} Position
 * @typedef {{state:'flat',positionId:null,quantityUnits:'0'}|{state:'held',positionId:string,quantityUnits:IntegerUnits}} PositionContext
 * @typedef {DomainRecord & {kind:'decision',version:'trading-decision-v1',action:DecisionAction,side:OutcomeSide|null,position:PositionContext,quantityUnits:IntegerUnits,limitPriceUnits:IntegerUnits|null,reason:string,validUntil:number}} Decision HOLD with flat position always has zero order quantity and no limit price.
 */

export {};
