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
 * (which is `null` before any model is chosen) -- the exact check the CQT
 * dial's visibility gates on (decisions doc SS13 item 21): the dial only
 * applies to "Levanto Auto" requests, so it should render only when Auto is
 * the currently selected model, not unconditionally.
 */
export function isLevantoAutoSelected(model: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'> | null): boolean {
  return model !== null && isLevantoAutoEntry(model);
}

/**
 * Idempotently prepends the Auto entry to a freshly-derived catalog. Safe to
 * call on every catalog recompute -- `projectRowsToVprModelCatalog` never
 * produces a `(levanto, levanto-auto)` pair from real network discovery
 * (no seller advertises that serviceId), so there is nothing to deduplicate
 * against beyond a previous call of this same function.
 */
export function withLevantoAutoCatalogEntry(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  if (catalog.some(isLevantoAutoEntry)) return catalog;
  return [LEVANTO_AUTO_CATALOG_ENTRY, ...catalog];
}
