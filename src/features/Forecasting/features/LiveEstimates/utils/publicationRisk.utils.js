const ADVERSE_FLOW_IMBALANCE = 0.6;
const DEPTH_LOSS_FRACTION = -0.5;

// These are conservative abstention rules. They never turn flow or displayed orders
// into an unvalidated directional probability or count repeated trades as votes.
export function getPublicationRisk({ conditions, stream, direction, target }) {
  if (!conditions?.available)
    return {
      canPublish: false,
      code: 'market-data-unavailable',
      reason: conditions?.reason || 'Waiting for valid candle and quote features.',
    };
  if (!conditions.canPublish)
    return {
      canPublish: false,
      code: 'market-conditions',
      reason: conditions.riskFlags.map((flag) => flag.reason).join(' '),
    };
  if (
    !stream?.quality?.available ||
    !stream.flow?.windows?.[180]?.available ||
    !stream.liquidity?.available
  )
    return {
      canPublish: false,
      code: 'market-data-unavailable',
      reason:
        stream?.quality?.reason ||
        'Collecting three minutes of complete trades and order-book data.',
    };

  const { bid, ask } = stream.liquidity;
  if (
    !Number.isFinite(target) ||
    target <= 0 ||
    !Number.isFinite(bid) ||
    bid <= 0 ||
    !Number.isFinite(ask) ||
    ask <= bid
  )
    return {
      canPublish: false,
      code: 'market-data-unavailable',
      reason: 'A valid saved target and current order-book spread are required.',
    };
  // Level 2 can advance between ticker messages. Check its current spread as well as
  // the candle/quote guards, using the saved target and deriving its midpoint from prices.
  if (target >= bid && target <= ask)
    return {
      canPublish: false,
      code: 'market-conditions',
      reason: 'The saved target is inside the current order-book spread.',
    };
  const directionSign = direction === 'above' ? 1 : direction === 'below' ? -1 : 0;
  const midpoint = bid / 2 + ask / 2;
  if (directionSign && Math.sign(midpoint - target) !== directionSign)
    return {
      canPublish: false,
      code: 'market-conditions',
      reason: 'The current order-book midpoint opposes the proposed fixed call.',
    };
  const hasAdverseFlow =
    directionSign &&
    [15, 60, 180].every((seconds) => {
      const window = stream.flow.windows[seconds];
      return (
        window?.available &&
        window.totalBtc > 0 &&
        window.imbalance * directionSign <= -ADVERSE_FLOW_IMBALANCE
      );
    });
  if (hasAdverseFlow)
    return {
      canPublish: false,
      code: 'market-conditions',
      reason: 'Sustained executed trade flow opposes the proposed fixed call.',
    };
  const depthChange = stream.liquidity.depthChange60;
  if (depthChange?.available && depthChange.totalFraction <= DEPTH_LOSS_FRACTION)
    return {
      canPublish: false,
      code: 'market-conditions',
      reason: 'Near-price liquidity has fallen by at least half over the last minute.',
    };
  return { canPublish: true, code: null, reason: null };
}
