import type { VprModelCatalogEntry, VprRoutingPreferences } from '../../core/state';
import type { RouterPluginInfo } from '../../types/bridge';

/**
 * "Auto" model-picker entry (model-routing decisions doc SS4.3/SS8.2,
 * software-architecture doc SS4.1/SS4.3), generalized to whichever
 * router plugin the user has actually selected (Preferences' "Select model
 * router" dropdown, `VprRoutingPreferences.selectedRouterPackage`) rather
 * than hardcoding router-levanto. `provider`/`serviceId` must match the
 * sentinel a router's own `selectRoute` checks the requested model against
 * (e.g. router-levanto's router.ts: "if (model !== 'levanto-auto') return
 * null") -- sourced from that plugin's own declared `AntseedRouterPlugin.name`/
 * `autoRouteServiceId` (packages/node/src/interfaces/plugin.ts) instead of a
 * second, hand-duplicated copy of the same strings.
 *
 * Kept as a small module-level cache updated by `withLevantoAutoCatalogEntry`
 * (the one function that already recomputes on every routing-state change,
 * in modules/chat/controller.ts) rather than threading the active plugin
 * through every call site below -- `isLevantoAutoEntry`/`isLevantoAutoSelected`
 * are read from several UI components that only need "is this the Auto
 * entry", not "which plugin is active".
 */
export type ActiveAutoRouterPlugin = {
  provider: string;
  serviceId: string;
  label: string;
  info?: { title: string; body: string };
  savingsBaselineModel?: string;
};

/**
 * router-levanto's own identity, used as the fallback default: the app has
 * shipped with it as the only bundled router plugin, and preferences saved
 * before `selectedRouterPackage` existed have `autoSubscriptionEnabled: true`
 * with no package recorded (migrated to this package explicitly in
 * preferences.ts's `loadVprRoutingPreferences`) -- so resolving an unmatched
 * selection back to this identity preserves exactly what those buyers had
 * already opted into, rather than silently turning Auto off for them.
 */
const LEVANTO_FALLBACK: ActiveAutoRouterPlugin = {
  provider: 'levanto',
  serviceId: 'levanto-auto',
  label: 'Levanto Router',
  savingsBaselineModel: 'claude-opus-5',
};
const LEVANTO_FALLBACK_PACKAGE = '@antseed/router-levanto';

let active: ActiveAutoRouterPlugin | null = LEVANTO_FALLBACK;

export let LEVANTO_AUTO_LABEL: string = LEVANTO_FALLBACK.label;

/**
 * Minimum trust score enforced while `autoSubscriptionEnabled` is on
 * (decisions doc SS14 item 29) -- on the *stored* 0-100 scale.
 * `reputationScaleLabel` (modules/catalog/seller-format.ts) displays this
 * scale as 0.0-10.0 (`score / 10`), so this constant is display "7.0". A
 * flat, host-side floor rather than per-plugin metadata -- not worth a new
 * `AntseedRouterPlugin` field for one UX guard.
 */
export const AUTO_SUBSCRIPTION_MIN_TRUST_SCORE = 70;

/**
 * Resolves the Auto entry's *identity* -- independent of whether
 * `autoSubscriptionEnabled` is currently on. `isLevantoAutoEntry`/
 * `isLevantoAutoSelected` need to keep recognizing an already-selected Auto
 * conversation/model even after the user flips the toggle off (e.g. so a
 * discover refresh doesn't silently rebind it to a concrete model) -- only
 * `withLevantoAutoCatalogEntry`'s decision to *offer* the entry as pickable
 * is gated on the toggle.
 */
function resolveActiveAutoRouterPlugin(
  preferences: Pick<VprRoutingPreferences, 'selectedRouterPackage'>,
  availableRouters: RouterPluginInfo[],
): ActiveAutoRouterPlugin | null {
  const selectedPackage = preferences.selectedRouterPackage ?? LEVANTO_FALLBACK_PACKAGE;
  const match = availableRouters.find(
    (router) => router.package === selectedPackage && router.autoRouteServiceId,
  );
  if (match) {
    return {
      provider: match.name,
      serviceId: match.autoRouteServiceId!,
      label: match.displayName,
      info: match.autoRouteInfo,
      savingsBaselineModel: match.savingsBaselineModel,
    };
  }
  // Router list not loaded yet, or the selected package is no longer
  // installed -- fall back to Levanto's identity only when that's actually
  // what was selected (explicitly or via the pre-migration default above),
  // never for some other, now-missing plugin.
  return selectedPackage === LEVANTO_FALLBACK_PACKAGE ? LEVANTO_FALLBACK : null;
}

export function isLevantoAutoEntry(entry: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'>): boolean {
  return active !== null && entry.provider === active.provider && entry.serviceId === active.serviceId;
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

/** The active plugin's info-dialog copy, or `null` when no Auto router is active. */
export function activeAutoRouterInfo(): { title: string; body: string } | null {
  return active?.info ?? null;
}

/**
 * The active plugin's declared savings-comparison baseline model, or
 * Levanto's own default when no plugin is active/declares one -- the
 * savings dashboard (router-savings.ts) always needs *some* default even
 * while Auto is off, since it summarizes past `routing_decisions` history.
 */
export function activeAutoRouterSavingsBaselineModel(): string {
  return active?.savingsBaselineModel ?? LEVANTO_FALLBACK.savingsBaselineModel!;
}

/**
 * Builds a full catalog entry for the currently-recognized Auto identity
 * (`active`, defaulting to Levanto's if nothing more specific has resolved)
 * -- a stable, directly-usable fixture for callers/tests that need a
 * concrete entry object, since it's otherwise only ever constructed inline
 * inside `withLevantoAutoCatalogEntry`.
 */
export function currentAutoRouteEntry(): VprModelCatalogEntry {
  const source = active ?? LEVANTO_FALLBACK;
  return {
    provider: source.provider,
    serviceId: source.serviceId,
    label: source.label,
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
}

/**
 * Idempotently prepends the Auto entry to a freshly-derived catalog, but only
 * when `preferences.autoSubscriptionEnabled` is true -- the entry starts a
 * real daily USDC charge, so it must not be offered as a pickable model until
 * the buyer has explicitly consented via the Preferences toggle (decisions
 * doc SS14 item 29). Also refreshes the shared "active router" cache that
 * `isLevantoAutoEntry`/`isLevantoAutoSelected`/`LEVANTO_AUTO_LABEL` read --
 * this is the one place routing state is recomputed on every relevant
 * change (modules/chat/controller.ts), so it doubles as that cache's sync
 * point instead of requiring a separate bootstrap call.
 *
 * Safe to call on every catalog recompute when enabled -- `projectRowsToVprModelCatalog`
 * never produces a matching (provider, serviceId) pair from real network
 * discovery (no seller advertises an auto-route serviceId), so there is
 * nothing to deduplicate against beyond a previous call of this same function.
 */
export function withLevantoAutoCatalogEntry(
  catalog: VprModelCatalogEntry[],
  preferences: Pick<VprRoutingPreferences, 'autoSubscriptionEnabled' | 'selectedRouterPackage'>,
  availableRouters: RouterPluginInfo[],
): VprModelCatalogEntry[] {
  active = resolveActiveAutoRouterPlugin(preferences, availableRouters);
  LEVANTO_AUTO_LABEL = active?.label ?? LEVANTO_FALLBACK.label;

  if (!preferences.autoSubscriptionEnabled || !active) {
    return catalog.some(isLevantoAutoEntry) ? catalog.filter((entry) => !isLevantoAutoEntry(entry)) : catalog;
  }
  if (catalog.some(isLevantoAutoEntry)) return catalog;
  const entry = currentAutoRouteEntry();
  return [entry, ...catalog];
}
