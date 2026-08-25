import type {
  BuyerConversationSummary,
  InstalledAppEntry,
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

export const installedAppsResource = createCachedResource<InstalledAppEntry[]>({
  async load() {
    const result = await window.antseedDesktop?.listInstalledApps?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list applications');
    return result.apps ?? [];
  },
});
