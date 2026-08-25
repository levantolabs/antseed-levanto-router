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
  ): Promise<RouteCandidate[] | null>;
}

// Duck-typed, not formally part of `Router`, but probed for by buyer-proxy
// when present (existing, unrelated to selectRoute):
//   allowsPeerForPolicy?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
//   allowsPeerForPricing?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
