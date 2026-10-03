export const RESEARCH_EXPERIMENT_V1 = 'kalshi-ablation-v1';
export const RESEARCH_EXPERIMENT_V2 = 'kalshi-ablation-v2';
export const RESEARCH_EXPERIMENT_V3 = 'kalshi-ablation-v3';
export const RESEARCH_EXPERIMENT_V4 = 'kalshi-ablation-v4';
export const RESEARCH_EXPERIMENT_V5 = 'kalshi-ablation-v5';

const originalVariants = Object.freeze([
  'settlement-only',
  'spot-only',
  'futures-only',
  'combined',
]);
const currentVariants = Object.freeze([
  ...originalVariants,
  'reduced-pressure',
  'fast-decay',
  'market-blend',
  'market-only',
  'reversal-candidate',
  'forward-pressure-candidate',
]);
const noVariants = Object.freeze([]);
const directionalVariants = Object.freeze([...currentVariants, 'directional-reversal-candidate']);

export function getResearchVariantNames(version) {
  if (version === RESEARCH_EXPERIMENT_V1) return originalVariants;
  if (version === RESEARCH_EXPERIMENT_V5) return directionalVariants;
  if ([RESEARCH_EXPERIMENT_V2, RESEARCH_EXPERIMENT_V3, RESEARCH_EXPERIMENT_V4].includes(version))
    return currentVariants;
  return noVariants;
}

export const RESEARCH_VARIANT_LABELS = Object.freeze({
  'settlement-only': 'Settlement only',
  'spot-only': 'Spot pressure only',
  'futures-only': 'Futures pressure only',
  combined: 'Combined pressure',
  'reduced-pressure': 'Half pressure',
  'fast-decay': 'Faster pressure decay',
  'market-blend': 'Market blend',
  'market-only': 'Kalshi market midpoint',
  'reversal-candidate': 'Reversal candidate',
  'directional-reversal-candidate': 'Directional reversal',
  'forward-pressure-candidate': 'Forward pressure candidate',
  production: 'Production',
});

// These are frozen experiments, not fitted or approved replacements for production.
export const PRESSURE_RESEARCH_POLICIES = Object.freeze({
  'reduced-pressure': Object.freeze({
    version: 'half-directional-pressure-v1',
    directionalScale: 0.5,
  }),
  'fast-decay': Object.freeze({
    version: 'thirty-second-pressure-decay-v1',
    pressureHalfLifeMinutes: 0.5,
  }),
});

export const MARKET_BLEND_POLICY = Object.freeze({
  version: 'kalshi-market-blend-v1',
  maximumQuoteAgeMs: 15_000,
  maximumSpread: 0.1,
  maximumHorizonMinutes: 15,
  minimumMarketWeight: 0.15,
  maximumMarketWeight: 0.5,
});
