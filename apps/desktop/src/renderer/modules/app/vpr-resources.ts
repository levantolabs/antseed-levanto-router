import type {
  BuyerConversationSummary,
  InstalledAppEntry,
  RouterPluginInfo,
  RuntimeProcessState,
  SystemProxyProfileSummary,
} from '../../types/bridge';
import type { RoutingDecisionRow } from '@antseed/node';
import { createCachedResource } from './cached-resource';

const POLL_MS = 3_000;

export const buyerConversationsResource = createCachedResource<BuyerConversationSummary[]>({
  pollMs: POLL_MS,
  async load() {
    const conversations = await window.antseedDesktop?.buyerConversationsList?.();
    if (conversations === null || conversations === undefined) throw new Error('Buyer unavailable');
    return conversations;
  },
});

export type SystemProxySnapshot = {
  profiles: SystemProxyProfileSummary[];
  state: RuntimeProcessState | null;
};

export const systemProxyResource = createCachedResource<SystemProxySnapshot>({
  pollMs: POLL_MS,
  async load() {
    const bridge = window.antseedDesktop;
    const [profiles, state] = await Promise.all([
      bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
      bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
    ]);
    return { profiles, state };
  },
});

/**
 * routing_decisions local ledger (model-routing software-architecture doc
 * SS2.5), for VPR's savings dashboard (decisions doc SS4.5) -- shared by
 * VprHomeView and VprActivityView, same reasoning as the other resources
 * above. Empty (not an error) when the active router doesn't implement
 * getRoutingDecisions (e.g. the default router-local) or the buyer runtime
 * isn't up yet -- see chat:ai-list-routing-decisions in apps/desktop/src/main/chat/engine.ts.
 */
export const routingDecisionsResource = createCachedResource<RoutingDecisionRow[]>({
  pollMs: POLL_MS,
  async load() {
    const result = await window.antseedDesktop?.chatAiListRoutingDecisions?.();
    return (result?.data ?? []) as RoutingDecisionRow[];
  },
});

/**
 * The real, live-advertised daily subscription price (model-routing decisions
 * doc SS13 item 6), for the Levanto Auto Preferences toggle's disclosure
 * copy. `null` (not an error/throw) whenever no routing peer advertising one
 * has been discovered yet -- the toggle falls back to generic copy in that
 * case rather than showing a broken number.
 */
export type SubscriptionPriceOffer = { peerId?: string; flatUsdPrice?: number };

export const subscriptionPriceResource = createCachedResource<SubscriptionPriceOffer | null>({
  pollMs: POLL_MS,
  async load() {
    const result = await window.antseedDesktop?.chatAiGetSubscriptionPrice?.();
    return result?.data ?? null;
  },
});

/**
 * Router-type plugins installed on disk (packages/node's AntseedRouterPlugin
 * metadata), for Preferences' "Select model router" dropdown -- driven by
 * whatever's actually installed rather than a hardcoded option list. Not
 * polled as aggressively as live runtime state since installed plugins
 * change only on an explicit install/reinstall.
 */
export const installedRouterPluginsResource = createCachedResource<RouterPluginInfo[]>({
  pollMs: 30_000,
  async load() {
    const result = await window.antseedDesktop?.pluginsListRouters?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list router plugins');
    return result.routers ?? [];
  },
});

export const installedAppsResource = createCachedResource<InstalledAppEntry[]>({
  async load() {
    const result = await window.antseedDesktop?.listInstalledApps?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list applications');
    return result.apps ?? [];
  },
});
