import type {
  ConversationIdentity,
  ModelRoutingPreferences,
  PeerInfo,
  RouteCandidate,
  SerializedHttpRequest,
} from '@antseed/node';
import { ConversationState, pinnedToRouteCandidate, type PinnedDecision } from './conversation-state.js';
import { RoutingLedger, type RoutingDecisionRow } from './ledger.js';
import { buildDigest, periodKey } from './digest.js';

export interface LevantoRouterConfig {
  /** Base URL of the routing peer's HTTP surface, e.g. http://127.0.0.1:8787 */
  routingPeerUrl: string;
  /** The routing peer's own peerId -- who the daily SpendingAuth is signed against. */
  sellerPeerId?: string;
  /**
   * Pay-first daily signing (decisions doc SS6.2): called at most once per
   * calendar day, before the first routing call that day. Deliberately
   * narrow -- this plugin never holds a BuyerPaymentManager or PaymentMux
   * reference directly (software-arch doc SS2.6: handing a signing key to
   * plugin code, including third-party ones per SSG3, would let it sign
   * arbitrary messages). The host implements this by calling the real
   * BuyerPaymentManager.signCumulativeAuth and sending the result over
   * PaymentMux -- NOT WIRED UP in this pass; see the runlog.
   */
  signDailyIfNeeded?: (sellerPeerId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  /**
   * Bounds a hung connection, not just a refused one -- plain fetch() has no
   * default timeout, so an unresponsive (not just unreachable) routing peer
   * would otherwise hang selectRoute indefinitely. Default chosen to sit
   * comfortably under typical chat-completion client timeouts.
   */
  routeTimeoutMs?: number;
}

const DEFAULT_ROUTE_TIMEOUT_MS = 3000;

function calendarDayKey(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

// Wire schema, decisions doc SS4.4. Kept local to this plugin -- it's the
// public contract, not proprietary, but there's no shared package for it yet.
interface RouteRequestBody {
  v: 1;
  cqt: number;
  sagePrompt: string;
  contextTokens: number;
  expectedCachedTokens: Array<{ model: string; peer: string; tokens: number }>;
  constraints: {
    maxInputUsdPerMillion?: number;
    minTrustScore?: number;
    allowedPeerIds?: string[];
    blockedPeerIds?: string[];
  };
}

interface RouteResponseBody {
  v: 1;
  ranked: Array<{
    model: string;
    peer: string;
    score: number;
    predictedQuality: number;
    predictedCostUsd: number;
    predictedInputTokens: number;
    predictedCachedInputTokens: number;
    predictedOutputTokens: number;
    price: { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number };
  }>;
  baselineSuggestion: { model: string; peer: string; price: { inUsdPerM: number; outUsdPerM: number } } | null;
  receipt: { routerId: string; artifactVersion: string; lambdaVersion: string };
}

/** Head+tail trim, matching the "trimmed last user turn" shape sagePrompt expects. */
const SAGE_PROMPT_HEAD_TAIL_CHARS = 4096;

function trimForSagePrompt(text: string): string {
  if (text.length <= SAGE_PROMPT_HEAD_TAIL_CHARS * 2) return text;
  return `${text.slice(0, SAGE_PROMPT_HEAD_TAIL_CHARS)}…${text.slice(-SAGE_PROMPT_HEAD_TAIL_CHARS)}`;
}

function parseChatBody(req: SerializedHttpRequest): { model: string | undefined; lastUserText: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Buffer.from(req.body).toString('utf-8'));
  } catch {
    return { model: undefined, lastUserText: '' };
  }
  const model = typeof parsed['model'] === 'string' ? (parsed['model'] as string) : undefined;
  const messages = Array.isArray(parsed['messages']) ? (parsed['messages'] as Array<Record<string, unknown>>) : [];
  const lastUser = [...messages].reverse().find((m) => m['role'] === 'user');
  const content = lastUser?.['content'];
  const lastUserText = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join(' ')
      : '';
  return { model, lastUserText };
}

/** Very rough token estimate (chars/4) -- a real tokenizer is a further refinement, not this pass's scope. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Per decisions doc SS4.2: not parentSessionKey-preferred (reversed in the design's own Round7). */
function conversationKey(conversation: ConversationIdentity): string {
  return `${conversation.tool}:${conversation.sessionKey}`;
}

export class LevantoRouter {
  private readonly conversations = new ConversationState();
  private readonly ledger = new RoutingLedger();
  private lastSignedDayKey: string | null = null;
  private lastDigestSentDayKey: string | null = null;

  constructor(private readonly config: LevantoRouterConfig) {}

  /** routing_decisions ledger (software-architecture doc SS2.5) -- for the savings dashboard (task #10). */
  getLedgerRows(): readonly RoutingDecisionRow[] {
    return this.ledger.all();
  }

  /**
   * `Router.getRoutingDecisions` (packages/node/src/interfaces/buyer-router.ts)
   * -- the generic hook buyer-proxy's `/_antseed/routing-decisions` local
   * admin endpoint calls to read this router's ledger, so VPR's savings
   * dashboard doesn't need router-levanto-specific plumbing to reach it.
   * Returns a copy: the interface's return type is mutable, this router's
   * own storage isn't.
   */
  getRoutingDecisions(): RoutingDecisionRow[] {
    return [...this.ledger.all()];
  }

  /**
   * Ensures today's SpendingAuth is on file before routing, per SS6.2's
   * "before making any routing calls that day" ordering. At most one call
   * to signDailyIfNeeded per calendar day, however many times selectRoute
   * fires that day.
   */
  private async ensureSignedToday(): Promise<void> {
    if (!this.config.signDailyIfNeeded || !this.config.sellerPeerId) return;
    const todayKey = calendarDayKey();
    if (this.lastSignedDayKey === todayKey) return;
    await this.config.signDailyIfNeeded(this.config.sellerPeerId);
    this.lastSignedDayKey = todayKey;
  }

  /**
   * Daily digest (decisions doc SS6.9, software-arch doc SS2.7): same daily
   * cadence as the SpendingAuth signature above, but its own request, not
   * bundled into it (SS3.6 -- SpendingAuthMetadata is the wrong shape, and
   * PaymentMux's MessageType enum is closed). Unlike signing, no signing key
   * is involved -- this is plain stats -- so the plugin sends it directly
   * with its own fetchImpl rather than needing a host-mediated method.
   * Best-effort: a failed send must never block or fail routing (SS2.7:
   * "not required for correct routing to work"), so errors are swallowed
   * and retried on the next selectRoute call rather than surfaced.
   *
   * Reports the day that just closed, not the one starting now: "one daily
   * performance digest" per day only makes sense as a finished tally (SS3.6's
   * retention model -- each day's digest accumulates as a permanent record),
   * and at the moment this fires (the first selectRoute of a new calendar
   * day, same trigger as ensureSignedToday) today's own ledger rows don't
   * exist yet. Sent the same way signing works one day "late" relative to
   * the toggle -- yesterday's numbers, flushed at the start of today.
   */
  private async sendDailyDigestIfNeeded(): Promise<void> {
    if (!this.config.sellerPeerId) return; // nowhere to send it yet
    const todayKey = calendarDayKey();
    if (this.lastDigestSentDayKey === todayKey) return;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const digest = buildDigest(this.ledger.all(), periodKey(yesterday));
    const doFetch = this.config.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${this.config.routingPeerUrl}/_antseed/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(digest),
      });
      if (res.ok) this.lastDigestSentDayKey = todayKey;
    } catch {
      // Routing peer unreachable -- try again next call, same as a skipped day's stats.
    }
  }

  // Required Router members -- levanto-auto only participates via selectRoute;
  // a concretely-chosen model falls through to the host's existing pipeline
  // before selectPeer would ever be reached for this router (software-arch
  // doc SS2.1). selectPeer/onResult exist only to satisfy the interface.
  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    return peers[0] ?? null;
  }

  /**
   * SS4.3's cache "warmth" observation feed. Router.onResult's shared
   * interface doesn't carry cachedInputTokens (packages/node/src/interfaces/buyer-router.ts,
   * unchanged this pass -- extending it is a wider, riskier change than this
   * pass takes on, since other routers implement the same interface). Real
   * wiring of buyer-proxy calling this after each response is a remaining
   * gap, logged in the runlog; this method is what that wiring would call.
   */
  recordObservedCache(conversation: ConversationIdentity, model: string, peerId: string, promptTokens: number, cachedInputTokens: number): void {
    this.conversations.recordObservedCache(conversationKey(conversation), model, peerId, promptTokens, cachedInputTokens);
  }

  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
  }): void {
    if (!result.success) return; // a failed/retried dispatch isn't a resolved decision
    this.ledger.recordResult(peer.peerId, {
      promptTokens: (result.freshInputTokens ?? 0) + (result.cachedInputTokens ?? 0),
      cachedTokens: result.cachedInputTokens ?? 0,
      completionTokens: result.outputTokens ?? 0,
      usdcPaid: result.estimatedCostUsd ?? 0,
    });
  }

  async selectRoute(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
  ): Promise<RouteCandidate[] | null> {
    const { model, lastUserText } = parseChatBody(req);
    // levanto-auto sentinel check is host-agnostic: any concrete model name
    // declines immediately, matching software-arch doc's "no sentinel
    // knowledge in host code" rule.
    if (model !== 'levanto-auto') return null;

    const convKey = conversation ? conversationKey(conversation) : null;

    // New-user-message gate (decisions doc SS4.2): a tool-loop continuation
    // reuses the last decision, no network call. Conversations we can't key
    // (no ConversationIdentity) always route -- a safe default, not a full
    // content-hash fallback (logged as a simplification in the runlog).
    if (convKey && !this.conversations.isNewUserMessage(convKey, lastUserText)) {
      const pinned = this.conversations.getPinned(convKey);
      if (pinned) {
        return [pinnedToRouteCandidate(pinned, substituteModel(req, pinned.serviceId))];
      }
    }

    // Pay-first (decisions doc SS6.2): today's signature must be on file
    // before this call, not after -- and only now, since a pinned reuse
    // above never reaches the network at all.
    await this.ensureSignedToday();
    // Same daily cadence, its own request (SS2.7) -- fire-and-forget, never
    // blocks or fails the routing call itself.
    await this.sendDailyDigestIfNeeded();

    const contextTokens = estimateTokens(lastUserText);
    const expectedCachedTokens = convKey
      ? this.conversations.observedModelPeers(convKey).map(({ model: m, peerId }) => ({
        model: m,
        peer: peerId,
        tokens: Math.round(this.conversations.expectedCachedTokens(convKey, m, peerId, contextTokens)),
      })).filter((entry) => entry.tokens > 0)
      : [];

    // CQT dial (decisions doc SS8.1, software-arch doc SS4.4): one of the
    // five discrete VPR positions {1,3,5,7,9}; 5 ("Balanced") when the host
    // hasn't wired VprRoutingPreferences.cqt through yet, or for a CLI-only
    // caller with no preferences UI at all.
    const cqt = routingPreferences?.cqt ?? 5;
    const body: RouteRequestBody = {
      v: 1,
      cqt,
      sagePrompt: trimForSagePrompt(lastUserText),
      contextTokens,
      expectedCachedTokens,
      constraints: {
        maxInputUsdPerMillion: routingPreferences?.maxInputUsdPerMillion ?? undefined,
        minTrustScore: routingPreferences?.minTrustScore ?? undefined,
        allowedPeerIds: routingPreferences?.allowedPeerIds ?? undefined,
        blockedPeerIds: routingPreferences?.blockedPeerIds ?? undefined,
      },
    };

    const doFetch = this.config.fetchImpl ?? fetch;
    let res: Response;
    const routingCallStartedAt = Date.now();
    const timeoutMs = this.config.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      res = await doFetch(`${this.config.routingPeerUrl}/_antseed/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
    } catch {
      // Routing peer unreachable OR unresponsive (the AbortController above
      // fires the same way for both) -- decisions doc/software-arch doc
      // leave the client-side mechanism unspecified for this case (flagged
      // as an unformalized gap earlier in this project); the chosen
      // behavior: decline rather than hang or error the chat request, same
      // as a clean 402 -- the existing pipeline falls through to a real
      // model rather than surfacing a routing-specific failure to the user.
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
    const routingLatencyMs = Date.now() - routingCallStartedAt;
    if (!res.ok) return null; // includes the 402 "not subscribed" case

    const parsed = (await res.json()) as RouteResponseBody;
    const peerById = new Map(peers.map((p) => [p.peerId, p] as const));

    // For SS2.5's ledger: predicted fields per (peer, model), read back once
    // the winner is known below -- absent for a candidate synthesized by the
    // allowedPeerIds fallback (no real Sage prediction for it).
    const predictedByPeer = new Map(parsed.ranked.map((entry) => [entry.peer, entry] as const));

    let ranked: PinnedDecision[] = [];
    for (const entry of parsed.ranked) {
      const peer = peerById.get(entry.peer as PeerInfo['peerId']);
      if (!peer) continue; // stale candidate, not in our current peer set
      ranked.push({
        peer,
        peerId: peer.peerId,
        serviceId: entry.model,
        reputation: 0,
        hasCachedInputPricing: entry.price.cachedInUsdPerM > 0,
        inputUsdPerMillion: entry.price.inUsdPerM,
        outputUsdPerMillion: entry.price.outUsdPerM,
        minImageUsdPerImage: null,
      });
    }

    // allowedPeerIds is a client-side re-filter, not a ranking constraint the
    // peer narrows by (decisions doc SS4.4) -- walk the ranked list as usual,
    // skip anything outside the allowlist. If that empties the list, fall
    // back to the allowed peers directly rather than giving up.
    const allowedPeerIds = routingPreferences?.allowedPeerIds;
    if (allowedPeerIds && allowedPeerIds.length > 0) {
      const allowedSet = new Set(allowedPeerIds.map((p) => p.toLowerCase()));
      const filtered = ranked.filter((c) => allowedSet.has(c.peerId.toLowerCase()));
      if (filtered.length > 0) {
        ranked = filtered;
      } else if (parsed.baselineSuggestion) {
        const fallbackModel = parsed.baselineSuggestion.model;
        ranked = peers
          .filter((peer) => allowedSet.has(peer.peerId.toLowerCase()))
          .map((peer) => ({
            peer,
            peerId: peer.peerId,
            serviceId: fallbackModel,
            reputation: 0,
            hasCachedInputPricing: false,
            inputUsdPerMillion: parsed.baselineSuggestion!.price.inUsdPerM,
            outputUsdPerMillion: parsed.baselineSuggestion!.price.outUsdPerM,
            minImageUsdPerImage: null,
          }));
      } else {
        ranked = [];
      }
    }

    if (ranked.length === 0) return null;

    const winner = ranked[0]!;
    if (convKey) {
      this.conversations.recordDecision(convKey, lastUserText, winner);
    }

    const predicted = predictedByPeer.get(winner.peerId);
    this.ledger.recordPending(winner.peerId, {
      model: winner.serviceId,
      predictedCostUsd: predicted?.predictedCostUsd ?? null,
      predictedInputTokens: predicted?.predictedInputTokens ?? null,
      predictedCachedInputTokens: predicted?.predictedCachedInputTokens ?? null,
      predictedOutputTokens: predicted?.predictedOutputTokens ?? null,
      cqt,
      routingLatencyMs,
      atMs: Date.now(),
    });

    return ranked.map((c) => pinnedToRouteCandidate(c, substituteModel(req, c.serviceId)));
  }
}

function substituteModel(req: SerializedHttpRequest, model: string): SerializedHttpRequest {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Buffer.from(req.body).toString('utf-8'));
  } catch {
    return req;
  }
  parsed['model'] = model;
  return { ...req, body: new TextEncoder().encode(JSON.stringify(parsed)) };
}
