import type { VprModelCatalogEntry } from '../../core/state';

/**
 * "Levanto Auto" model-picker entry (model-routing decisions doc SS4.3/SS8.2,
 * software-architecture doc SS4.1/SS4.3). This string must match the sentinel
 * `LevantoRouter.selectRoute` checks for in `plugins/router-levanto/src/router.ts`
 * ("if (model !== 'levanto-auto') return null"). Duplicated rather than
 * imported -- apps/desktop has no compile-time dependency on router-levanto
 * (it's loaded dynamically by package name at buyer-process startup, per
 * software-arch doc SS4.2 -- any third-party router is just an npm package
 * name, decisions doc SSG3), and this is deliberately Levanto-branded product
 * UI, not a generic AntSeed concept every router needs to share.
 */
export const LEVANTO_AUTO_PROVIDER = 'levanto';
export const LEVANTO_AUTO_SERVICE_ID = 'levanto-auto';
export const LEVANTO_AUTO_LABEL = 'Levanto Auto';

/**
 * Satisfies VprModelCatalogEntry's full shape for type compatibility with the
 * rest of the catalog list (software-arch doc SS4.3), but this is not a real,
 * network-discovered offer -- pricing fields stay null throughout (a flat
 * $0.59/day subscription has no per-token price), and it is never routed
 * through `priceLabel()`/`applyOpenRouterBaselines`'s normal per-token math.
 */
export const LEVANTO_AUTO_CATALOG_ENTRY: VprModelCatalogEntry = {
  provider: LEVANTO_AUTO_PROVIDER,
  serviceId: LEVANTO_AUTO_SERVICE_ID,
  label: LEVANTO_AUTO_LABEL,
  peerCount: 0,
  categories: [],
  kind: 'text',
  protocols: [],
  minInputUsdPerMillion: null,
  maxInputUsdPerMillion: null,
  minOutputUsdPerMillion: null,
  maxOutputUsdPerMillion: null,
  minCachedInputUsdPerMillion: null,
  maxCachedInputUsdPerMillion: null,
  minImageUsdPerImage: null,
  maxImageUsdPerImage: null,
  expectedSavingsPct: null,
  hasEligibleFreeSeller: false,
  bestPeerId: null,
};

export function isLevantoAutoEntry(entry: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'>): boolean {
  return entry.provider === LEVANTO_AUTO_PROVIDER && entry.serviceId === LEVANTO_AUTO_SERVICE_ID;
}

/**
 * Null-safe wrapper around `isLevantoAutoEntry` for `vprRouteSelection.model`
 * (which is `null` before any model is chosen). No longer what the CQT
 * dial's visibility gates on -- decisions doc SS14 item 29 supersedes item
 * 21's "gate on Auto being selected" with a dedicated Preferences toggle
 * (`VprRoutingPreferences.autoSubscriptionEnabled`) instead, since a
 * momentary model selection was never a real substitute for explicit,
 * standing consent to a daily subscription charge. Kept for any other
 * "is Auto the current selection" check that isn't a consent gate.
 */
export function isLevantoAutoSelected(model: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'> | null): boolean {
  return model !== null && isLevantoAutoEntry(model);
}

/**
 * Minimum trust score enforced while `autoSubscriptionEnabled` is on
 * (decisions doc SS14 item 29) -- on the *stored* 0-100 scale.
 * `reputationScaleLabel` (modules/catalog/seller-format.ts) displays this
 * scale as 0.0-10.0 (`score / 10`), so this constant is display "7.0".
 */
export const AUTO_SUBSCRIPTION_MIN_TRUST_SCORE = 70;

/**
 * Idempotently prepends the Auto entry to a freshly-derived catalog, but only
 * when `enabled` is true (`VprRoutingPreferences.autoSubscriptionEnabled`) --
 * the entry starts a real daily USDC charge, so it must not be offered as a
 * pickable model until the buyer has explicitly consented via the Preferences
 * toggle (decisions doc SS14 item 29). When `enabled` is false the entry is
 * dropped even if a stale catalog already contained it (defensive; in
 * practice every caller passes a freshly-derived catalog that never has it
 * unless this same function already added it).
 *
 * Safe to call on every catalog recompute when enabled -- `projectRowsToVprModelCatalog`
 * never produces a `(levanto, levanto-auto)` pair from real network discovery
 * (no seller advertises that serviceId), so there is nothing to deduplicate
 * against beyond a previous call of this same function.
 */
export function withLevantoAutoCatalogEntry(
  catalog: VprModelCatalogEntry[],
  enabled: boolean,
): VprModelCatalogEntry[] {
  if (!enabled) {
    return catalog.some(isLevantoAutoEntry) ? catalog.filter((entry) => !isLevantoAutoEntry(entry)) : catalog;
  }
  if (catalog.some(isLevantoAutoEntry)) return catalog;
  return [LEVANTO_AUTO_CATALOG_ENTRY, ...catalog];
}
