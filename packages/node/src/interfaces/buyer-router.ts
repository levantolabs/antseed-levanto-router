import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';
import type { ConversationIdentity } from '../routing/conversation-identity.js';
import type { ModelRoutingPreferences } from '../routing/model-route-ranking.js';

/**
 * A candidate returned by `Router.selectRoute` — one seller offering one
 * model, already scored and ordered by the router's own objective.
 *
 * Same shape buyer-proxy already builds internally for the existing
 * fixed-model pipeline (buyer-proxy.ts:2392-2429) — `selectRoute` produces
 * the cross-model equivalent.
 */
export type RouteCandidate = {
  peer: PeerInfo;
  peerId: string;
  /** The model this candidate serves. */
  serviceId: string;
  /** Already model-substituted for this candidate. */
  request: SerializedHttpRequest;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
};

/**
 * One resolved routing decision, predicted vs. actual (model-routing
 * software-architecture doc SS2.5) -- the shape a `selectRoute`-implementing
 * router's local ledger is expected to produce, so a host UI (e.g. VPR's
 * savings dashboard) can read it generically without depending on any one
 * router package. Not a billing record: real settlement is governed by the
 * signed SpendingAuth, not by anything this row displays.
 */
export type RoutingDecisionRow = {
  atMs: number;
  actualModel: string;
  actualPeer: string;
  actualPromptTokens: number;
  actualCachedTokens: number;
  actualCompletionTokens: number;
  actualUsdcPaid: number;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  /**
   * A price snapshot for each fixed, curated baseline/dropdown model
   * (model-routing decisions doc §8.4) that was actually present in this
   * decision's ranked response -- collapsed across peers to the best
   * available offer per model, keyed by model name. Absent entirely for a
   * baseline model that wasn't offered at the moment of this decision.
   * Lets a savings dashboard compare "actual paid" against one fixed
   * reference model's real AntSeed price at the time of THIS decision,
   * without needing to hold a live price table or re-fetch anything.
   */
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
  /**
   * The `ConversationIdentity.sessionKey` in scope when this decision was
   * made, or `null` when no identity was available (e.g. a CLI-only caller
   * with no per-chat headers). Lets a host UI filter this router's ledger
   * down to one conversation's history (a per-session drill-down alongside
   * the aggregate savings dashboard) without any router-specific plumbing --
   * same "generic, read via `getRoutingDecisions`" reasoning as the rest of
   * this type. Deliberately the bare `sessionKey`, not a tool-qualified
   * `${tool}:${sessionKey}` key: the desktop app's own conversation id is
   * exactly this value for VPR chats (`x-vpr-session-id`'s header value,
   * apps/desktop/src/main/chat/proxy-service.ts), so a host can compare
   * directly against its own conversation id with no reconstruction.
   * `null` on rows persisted before this field existed.
   */
  conversationKey: string | null;
};

/**
 * Interface that buyer nodes implement for peer selection.
 *
 * The SDK discovers available sellers via DHT. Your router decides
 * which seller to send each request to based on price, latency,
 * reputation, capacity, or any custom logic.
 *
 * If you don't provide a router, the SDK uses a default that selects
 * the cheapest peer with reputation above a minimum threshold.
 */
export interface Router {
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    /**
     * Optional, additive token/cost split -- computeResponseTelemetry
     * already computes this at both onResult call sites (buyer-proxy.ts);
     * forwarded here so a router can build a real per-decision ledger
     * (software-architecture doc SS2.5) without re-deriving it. Absent from
     * older callers; a router that doesn't need it can ignore it entirely.
     */
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
    /**
     * The originating client request's id (`SerializedHttpRequest.requestId`,
     * stable across a peer walk for one client request) -- decisions doc
     * SS13 item 13. `selectRoute` receives the same id via its own `req`
     * param, so a router that keys its pending-decision bookkeeping by
     * requestId instead of peerId alone can correctly pair this result with
     * the decision that produced it, even when two different conversations
     * are concurrently routed to the same peer. Optional/additive -- older
     * callers or routers that don't implement `selectRoute` can ignore it.
     */
    requestId?: string;
  }): void;

  /**
   * Optional, additive: pick both model and seller together, ahead of the
   * usual fixed-model peer narrowing. Called unconditionally by buyer-proxy
   * whenever the registered router implements it; returning `null` (or not
   * implementing it) falls through to the unmodified `selectPeer` pipeline.
   *
   * `req` is the same raw, unmodified request `selectPeer` gets, before any
   * model substitution — a router implementing this parses `req.body` itself
   * to read the model field.
   */
  selectRoute?(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
    /**
     * The pre-existing "antseed" alias's currently-resolved target
     * (`buyer.state.json`'s `defaultRoutedModel`, `apps/cli/src/proxy/request-utils.ts`'s
     * `ROUTED_MODEL_ALIAS`) -- host-owned state, passed in the same way
     * `conversation` is, so a router never needs a direct dependency on
     * `apps/cli`'s state file to read it (decisions doc SS13 item 8). `null`
     * when no default route is set, or for a host that doesn't have this
     * concept at all. Optional param -- existing callers/implementers that
     * don't pass or read a 5th argument are unaffected.
     */
    defaultRoutedModel?: string | null,
  ): Promise<RouteCandidate[] | null>;

  /**
   * Optional, additive: the router's local `routing_decisions` ledger
   * (software-architecture doc SS2.5), if it keeps one -- read by the host
   * (buyer-proxy's `/_antseed/routing-decisions` local admin endpoint) so a
   * UI's savings dashboard (decisions doc SS4.5) can render it without any
   * router-specific plumbing. A router that doesn't implement `selectRoute`
   * has no reason to implement this either.
   */
  getRoutingDecisions?(): RoutingDecisionRow[];

  /**
   * Optional, additive: a router that needs daily/periodic payment-signing
   * capability (e.g. a subscription-priced routing peer, model-routing
   * decisions doc SS6.2/SS13 item 11) implements this to receive a
   * host-provided signing function, called once by the host after loading
   * and after payments are configured. Generic across any router that needs
   * this, not specific to any one router package -- the router never holds
   * a BuyerPaymentManager or PaymentMux reference directly (software-arch
   * doc SS2.6: that would let plugin code, including third-party routers
   * per SSG3, sign arbitrary messages); the host builds and owns the actual
   * signing closure.
   */
  configureDailySigning?(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void;

  /**
   * Optional, additive: host-callable, independent of any chat request
   * (model-routing decisions doc SS13 item 9) -- a router that implements
   * `configureDailySigning` should also implement this so a background
   * timer can keep billing continuous even on a day the buyer never sends
   * a routable chat message at all. Calls the exact same gated logic
   * `selectRoute` calls internally before routing (a router's own
   * "at most once per calendar day" bookkeeping is shared, not
   * duplicated) -- a no-op if daily signing isn't configured, or if today
   * was already signed by an earlier call this same day, whether from a
   * real chat request or from this same background trigger.
   */
  triggerDailySigningCheck?(): Promise<void>;

  /**
   * Optional, additive: pushed by the host whenever live `buyer.routingPreferences`
   * changes (buyer-proxy's config-file watcher), including once at startup if
   * preferences were supplied at construction. `selectRoute` already receives
   * a fresh `routingPreferences` on every call, but `triggerDailySigningCheck`
   * fires from a background timer with no request in flight and therefore no
   * such parameter -- a router that needs live preference state outside of
   * `selectRoute` (e.g. gating background signing on an explicit
   * subscription-enable toggle, decisions doc SS14 item 29) implements this
   * to receive it. A router that only ever needs `routingPreferences` inside
   * `selectRoute` has no reason to implement this.
   */
  updateRoutingPreferences?(preferences: ModelRoutingPreferences): void;
}

// Duck-typed, not formally part of `Router`, but probed for by buyer-proxy
// when present (existing, unrelated to selectRoute):
//   allowsPeerForPolicy?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
//   allowsPeerForPricing?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
