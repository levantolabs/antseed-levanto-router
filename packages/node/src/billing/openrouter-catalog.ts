/**
 * Comparable retail-price catalog.
 *
 * Fetches a configurable models API and derives per-model retail pricing
 * (USD per million tokens) -- the desktop app strikes this through on the
 * VPR Home "Popular" list as a savings baseline, and it's also the retail
 * ("OpenRouter list price") tier a savings dashboard needs to separate
 * router-driven savings from marketplace-driven savings (model-routing
 * architecture doc SS4.6). The endpoint must serve the OpenRouter-compatible
 * models schema -- `{ data: [{ id, name, pricing: { prompt, completion,
 * input_cache_read } }] }` with prices in USD per token -- which is what the
 * OpenRouter* type names in this file refer to. The URL comes from the
 * ANTSEED_COMPARABLE_PRICES_URL environment variable (e.g. set it to
 * OpenRouter's models endpoint); a caller may also supply its own baked
 * release default (the desktop app bakes one via
 * scripts/bake-comparable-prices-url.mjs) -- an env var always wins over
 * that default, and a set-but-empty env disables the baseline entirely.
 * With neither, retail baselines are simply off. Cached in-memory with a TTL
 * so callers don't hammer the endpoint on every refresh. All failures
 * degrade to an empty map -- callers omit the struck-through/retail baseline.
 */

import { canonicalModelKey } from '../model-identity.js'

export const COMPARABLE_PRICES_URL_ENV = 'ANTSEED_COMPARABLE_PRICES_URL'

function comparablePricesUrl(bakedDefaultUrl: string | null): string | null {
  const raw = process.env[COMPARABLE_PRICES_URL_ENV]
  if (raw !== undefined) {
    // A set-but-empty env explicitly disables a baked release default.
    return raw.trim() || null
  }
  return bakedDefaultUrl
}
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const FAILURE_BACKOFF_MS = 60 * 1000 // retry soon after a failed/empty fetch
const FETCH_TIMEOUT_MS = 8000

/** USD per million tokens. `null` when OpenRouter doesn't price that dimension. */
export type OpenRouterReferencePrice = {
  input: number | null
  output: number | null
  /** Cache-read price; null when the model has no cache discount listed. */
  cachedInput: number | null
}

export type OpenRouterReferenceMap = Record<string, OpenRouterReferencePrice>

type OpenRouterModel = {
  id?: unknown
  name?: unknown
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown } | null
}

let cache: { at: number; map: OpenRouterReferenceMap } | null = null
let inflight: Promise<OpenRouterReferenceMap> | null = null
let lastFailedAt = 0

function perMillion(pricePerToken: unknown): number | null {
  const numeric = typeof pricePerToken === 'string' ? Number(pricePerToken) : Number(pricePerToken)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric * 1_000_000
}

function buildMap(models: OpenRouterModel[]): OpenRouterReferenceMap {
  const map: OpenRouterReferenceMap = {}
  for (const model of models) {
    const price: OpenRouterReferencePrice = {
      input: perMillion(model.pricing?.prompt),
      output: perMillion(model.pricing?.completion),
      cachedInput: perMillion(model.pricing?.input_cache_read),
    }
    if (price.input === null && price.output === null) continue
    for (const raw of [model.id, model.name]) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const key = canonicalModelKey(raw)
      // First match wins; ids are listed before names so canonical ids win ties.
      if (key && !map[key]) map[key] = price
    }
  }
  return map
}

async function fetchReferenceMap(bakedDefaultUrl: string | null): Promise<OpenRouterReferenceMap> {
  const url = comparablePricesUrl(bakedDefaultUrl)
  if (!url) return {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return {}
    const body = (await response.json()) as { data?: unknown }
    const models = Array.isArray(body?.data) ? (body.data as OpenRouterModel[]) : []
    return buildMap(models)
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns the cached reference-price map, refreshing it in the background when
 * stale. Concurrent callers share a single in-flight request. `bakedDefaultUrl`
 * is used only when ANTSEED_COMPARABLE_PRICES_URL is unset; pass a caller-specific
 * baked release default (or omit it to rely on the env var alone).
 */
export async function getOpenRouterReferencePrices(bakedDefaultUrl: string | null = null): Promise<OpenRouterReferenceMap> {
  if (!comparablePricesUrl(bakedDefaultUrl)) return cache?.map ?? {}
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map
  if (inflight) return inflight
  // After a failed/empty fetch, back off briefly instead of hammering the
  // endpoint on every call; serve stale data (or nothing) in the meantime.
  if (lastFailedAt && now - lastFailedAt < FAILURE_BACKOFF_MS) return cache?.map ?? {}
  inflight = fetchReferenceMap(bakedDefaultUrl)
    .then((map) => {
      if (Object.keys(map).length > 0) {
        // Only a non-empty result counts as success; never seed the 6h TTL
        // cache with an empty map (e.g. a cold-start fetch failure), and never
        // overwrite good data with a transient failure.
        cache = { at: Date.now(), map }
        lastFailedAt = 0
      } else {
        lastFailedAt = Date.now()
      }
      return cache?.map ?? map
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
