/**
 * Desktop-specific wrapper around @antseed/node's shared OpenRouter
 * reference-price catalog (packages/node/src/billing/openrouter-catalog.ts)
 * -- binds this app's baked release default so callers here keep the
 * original zero-argument call. Release builds bake a default via
 * scripts/bake-comparable-prices-url.mjs; a set-but-empty
 * ANTSEED_COMPARABLE_PRICES_URL disables it. See the shared module for the
 * full behavior (TTL cache, failure backoff, OpenRouter schema).
 */

import { getOpenRouterReferencePrices as getOpenRouterReferencePricesShared } from '@antseed/node';
import { BAKED_COMPARABLE_PRICES_URL } from '../generated/baked-defaults.js';

export { COMPARABLE_PRICES_URL_ENV, type OpenRouterReferenceMap, type OpenRouterReferencePrice } from '@antseed/node';

export async function getOpenRouterReferencePrices() {
  return getOpenRouterReferencePricesShared(BAKED_COMPARABLE_PRICES_URL);
}
