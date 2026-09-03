import type {
  ConversationIdentity,
  ModelRoutingPreferences,
  PeerInfo,
  RouteAuthHeaders,
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
   * This buyer's own peerId, sent as `x-antseed-buyer-peer-id` on every
   * `/_antseed/route`/`/_antseed/route/digest` call. `routingPeerUrl` is a
   * bare, unauthenticated HTTP endpoint (decisions doc has no wire mechanism
   * for the routing peer to otherwise learn who's asking), so without this
   * the day pass gate has no buyerPeerId to check `hasSession`/
   * `getChannelByPeer` against at all. A client-supplied, unverified header
   * is not a real authentication mechanism -- anyone who can reach
   * `routingPeerUrl` could claim to be any buyer. Genuinely open: how this
   * channel gets authenticated for real (a routing-peer-side P2P bridge, a
   * signed header, TLS client certs, or something else) is unresolved; see
   * the runlog. Omitted -- the routing peer gets no buyerPeerId, so the
   * day pass gate always rejects.
   */
  buyerPeerId?: string;
  /**
   * Proves `buyerPeerId` is genuine (decisions doc SS13 item 8, previously
   * unresolved) -- set via `configureRouteAuthSigning`. Deliberately narrow,
   * same reasoning as `signDailyIfNeeded` below: this plugin never holds a
   * signing key directly. Omitted -- requests carry no auth headers, same
   * as before this capability existed; a verifying routing peer treats that
   * as unauthenticated, not as a hard failure (see the runlog for the
   * rollout choice).
   */
  signRouteAuth?: (routingPeerId: string) => Promise<RouteAuthHeaders>;
  /**
   * Pay-first daily signing (decisions doc SS6.2): called at most once per
   * calendar day, before the first routing call that day. Deliberately
   * narrow -- this plugin never holds a BuyerPaymentManager or PaymentMux
   * reference directly (software-arch doc SS2.6: handing a signing key to
   * plugin code, including third-party ones per SSG3, would let it sign
   * arbitrary messages). The host implements this by calling the real
   * BuyerPaymentManager.signCumulativeAuth and sending the result over
   * PaymentMux -- see apps/cli/src/proxy/day-pass-signing.ts,
   * wired in via configureDailySigning at apps/cli/src/cli/commands/buyer/start.ts.
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
  /**
   * Buyer data directory for persisting the routing_decisions ledger
   * (decisions doc SS13 item 12) -- mirrors the `join(dataDir, 'payments')`/
   * `join(dataDir, 'conversations.json')` convention `ChannelStore`/
   * `ConversationStore` already use (apps/cli/src/cli/commands/metrics.ts,
   * apps/cli/src/proxy/conversation-store.ts). Omitted -- the ledger stays
   * in-memory only, same as before this pass; not a regression, just no
   * durability without a directory to write to.
   */
  dataDir?: string;
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
  inputMessage: string;
  promptTokens: number;
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
    estimate: { costUsd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
    price: { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number };
  }>;
  router: string;
}

/**
 * Default pre-selected comparison model for a future SS8.4 savings-page
 * dropdown (decisions doc SS8.4, SS13 item 10) -- not a limit on which
 * models get a price snapshot (computeBaselinePrices below covers every
 * model actually ranked), just which one a comparison UI opens on before the
 * user picks a different one. `claude-opus-5` matches `recommended.ts`
 * (apps/desktop/src/renderer/modules/catalog/recommended.ts)'s own
 * flagship-tier slot, per SS8.4's "the most expensive, most capable
 * flagship -- the top GPT or Claude model."
 */
export const DEFAULT_BASELINE_MODELS: readonly string[] = ['claude-opus-5', 'gpt-5.6-sol'];

type BaselinePrices = Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
type ConsideredCandidates = Array<{ model: string; peer: string; inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;

/**
 * One entry per DISTINCT model actually present in this decision's ranked
 * response -- every candidate the routing peer offered, not just a curated
 * subset -- collapsed across peers to the best available offer (decisions
 * doc SS2.5) -- "best" here means lowest inUsdPerM, the simplest defensible
 * single-axis choice absent a fixed token mix to combine input and output
 * into one true total cost. Covering every ranked model (not just
 * DEFAULT_BASELINE_MODELS) is deliberate: a future comparison dropdown needs
 * real price data for whatever model the user picks, not just the two
 * pre-selected ones.
 */
function computeBaselinePrices(ranked: RouteResponseBody['ranked']): BaselinePrices {
  const out: BaselinePrices = {};
  const models = new Set(ranked.map((entry) => entry.model));
  for (const model of models) {
    let best: RouteResponseBody['ranked'][number] | null = null;
    for (const entry of ranked) {
      if (entry.model !== model) continue;
      if (!best || entry.price.inUsdPerM < best.price.inUsdPerM) best = entry;
    }
    if (best) {
      out[model] = {
        inUsdPerM: best.price.inUsdPerM,
        outUsdPerM: best.price.outUsdPerM,
        cachedInUsdPerM: best.price.cachedInUsdPerM > 0 ? best.price.cachedInUsdPerM : null,
      };
    }
  }
  return out;
}

/** Bounds how many candidates a ledger row retains -- generous for a "top few options" drill-down, small enough the on-disk ledger doesn't balloon per row. */
const MAX_CONSIDERED_CANDIDATES = 10;

/**
 * The routing peer's own top candidates, in its own ranked order (not
 * re-sorted here) -- so a host UI can show "what else was considered" for
 * a historical decision. Capped, not the full response: `ranked` can be
 * arbitrarily long, and nothing downstream needs more than a handful.
 */
function topConsideredCandidates(ranked: RouteResponseBody['ranked']): ConsideredCandidates {
  return ranked.slice(0, MAX_CONSIDERED_CANDIDATES).map((entry) => ({
    model: entry.model,
    peer: entry.peer,
    inUsdPerM: entry.price.inUsdPerM,
    outUsdPerM: entry.price.outUsdPerM,
    cachedInUsdPerM: entry.price.cachedInUsdPerM > 0 ? entry.price.cachedInUsdPerM : null,
  }));
}

/** Head+tail trim, matching the "trimmed last user turn" shape inputMessage expects. */
const INPUT_MESSAGE_HEAD_TAIL_CHARS = 4096;

function trimForInputMessage(text: string): string {
  if (text.length <= INPUT_MESSAGE_HEAD_TAIL_CHARS * 2) return text;
  return `${text.slice(0, INPUT_MESSAGE_HEAD_TAIL_CHARS)}…${text.slice(-INPUT_MESSAGE_HEAD_TAIL_CHARS)}`;
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

/**
 * Thrown by `selectRoute` when it can't produce a real routing decision for
 * an Auto request -- decisions doc SS13 item 16. Returning `null` here (the
 * old behavior) falls through to the existing fixed-model peer-selection
 * pipeline, which can't resolve `"levanto-auto"` as a real model and fails a
 * moment later with a confusing, generic "no candidates for this model"
 * error instead of a clear one. `null` is still returned, unmodified, for
 * the one case where declining is actually correct: the request's model
 * isn't the Auto sentinel at all (the very first check in `selectRoute`).
 *
 * Covers both `kind`s the software-architecture doc's own SS2.2 note already
 * describes as "meant to reject cleanly" rather than fall through -- the
 * implementation just hadn't matched that yet for either: `'unreachable'`
 * (the routing peer couldn't be reached, or didn't respond within
 * `routeTimeoutMs`) and `'rejected'` (the routing peer responded but
 * declined the request, e.g. 402 "no current day pass").
 */
export class RoutingPeerError extends Error {
  constructor(
    public readonly kind: 'unreachable' | 'rejected',
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'RoutingPeerError';
  }
}

export class LevantoRouter {
  private readonly conversations = new ConversationState();
  private readonly ledger: RoutingLedger;
  private signingInFlight: Promise<void> | null = null;
  private lastDigestSentDayKey: string | null = null;
  /**
   * Most recently seen `routingPreferences` -- kept fresh from two paths:
   * the host's `updateRoutingPreferences` push (fires on config-file change,
   * including once at startup) and every `selectRoute` call that receives a
   * non-null `routingPreferences` parameter. Needed because `signSubscriptionOnDemand`
   * (called from inside `selectRoute`, but taking no parameters of its own)
   * reads this cache rather than a passed-in value -- a `selectRoute` call for
   * a concretely-chosen model, or any other call site with nothing fresh to
   * hand over, passes `null` and relies on whatever was cached last.
   */
  private cachedRoutingPreferences: ModelRoutingPreferences | null = null;

  constructor(private readonly config: LevantoRouterConfig) {
    this.ledger = new RoutingLedger(config.dataDir);
  }

  /** routing_decisions ledger (software-architecture doc SS2.5) -- for the savings dashboard (task #10). */
  getLedgerRows(): readonly RoutingDecisionRow[] {
    return this.ledger.all();
  }

  /** Waits for any pending ledger persistence writes (decisions doc SS13 item 12) -- tests / graceful shutdown. */
  flushLedger(): Promise<void> {
    return this.ledger.flush();
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
   * `Router.configureDailySigning` (packages/node/src/interfaces/buyer-router.ts,
   * decisions doc SS13 item 11) -- the generic hook the host calls once,
   * after loading, to hand this router a real signing closure. Mutates
   * `config.signDailyIfNeeded` in place rather than requiring it at
   * construction time, since the host builds the closure from a real,
   * *started* `AntseedNode` (it needs `node.buyerPaymentManager`, which
   * only exists once payments are configured) -- constructing the router
   * itself happens earlier, before the node has started.
   */
  configureDailySigning(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void {
    this.config.signDailyIfNeeded = signDailyIfNeeded;
  }

  /**
   * `Router.configureRouteAuthSigning` (packages/node/src/interfaces/buyer-router.ts,
   * decisions doc SS13 item 8) -- same generic, additive, mutate-in-place
   * pattern as `configureDailySigning` above, for the same reason (this
   * plugin never holds a signing key directly).
   */
  configureRouteAuthSigning(signRouteAuth: (routingPeerId: string) => Promise<RouteAuthHeaders>): void {
    this.config.signRouteAuth = signRouteAuth;
  }

  /**
   * `Router.updateRoutingPreferences` (packages/node/src/interfaces/buyer-router.ts,
   * decisions doc SS14 item 29) -- keeps `cachedRoutingPreferences` fresh
   * outside of a `selectRoute` call that happens to pass one, e.g. right
   * after a config-file reload, so `signSubscriptionOnDemand` (called only
   * from inside a live `selectRoute`, per runlog 2026-09-0X's fully-reactive
   * billing) still sees a current day-pass-enable toggle on a
   * `selectRoute` call that itself passes `null`.
   */
  updateRoutingPreferences(preferences: ModelRoutingPreferences): void {
    this.cachedRoutingPreferences = preferences;
  }

  /**
   * Signs a day-pass SpendingAuth strictly on demand -- called only when
   * the routing peer's own response just said payment is required (a 402
   * from `attemptRoute` below), never on a schedule, a timer, or any
   * elapsed-time bookkeeping this client keeps itself (runlog 2026-09-0X,
   * supersedes the calendar-day and rolling-window client-side cadences
   * tried before it). This mirrors ordinary per-request metered billing's
   * own seller-driven shape exactly: the seller alone decides, from its own
   * rolling-window check (levanto-routing-server's day-pass-gate.ts),
   * when a charge is due; the client never guesses at that, it only reacts.
   *
   * `signDailyIfNeeded` already handles both cases idempotently -- a
   * genuinely brand-new buyer with no channel yet (opens one) and a
   * returning buyer whose last charge fell outside the seller's window
   * (signs one more day) -- so this has no bootstrap-vs-renewal branch of
   * its own; both look identical from here: a 402, then one sign, then one
   * retry.
   *
   * Gated on `routingPreferences.autoDayPassEnabled` (decisions doc
   * SS14 item 29) -- real money moves here (a signed SpendingAuth is a
   * genuine payment authorization), so an explicit, current "yes" is
   * required. "Unknown" (no preferences ever pushed -- `configureDailySigning`
   * wired but `updateRoutingPreferences` never called, or a CLI-only caller
   * with no preferences UI at all) is treated the same as "no": this must
   * never default to signing.
   *
   * ALSO gated on `autoRouting !== false` -- found live: a buyer trying to
   * stop billing reasonably reached for the standing "Auto select seller"
   * switch (a different, more prominent control than the one that actually
   * owns autoDayPassEnabled), and billing kept running because nothing
   * checked it. `autoRouting` defaults to `undefined`/absent meaning "on"
   * (unlike autoDayPassEnabled's opt-in default), so only an EXPLICIT
   * `false` stops signing here -- a caller that never sends this field at
   * all is unaffected.
   *
   * Concurrent callers collapse onto one in-flight signature via
   * `signingInFlight`, rather than each firing their own -- the only
   * "limiting" this does; it never decides on its own that a sign is due.
   */
  private async signSubscriptionOnDemand(): Promise<void> {
    if (!this.cachedRoutingPreferences?.autoDayPassEnabled) return;
    if (this.cachedRoutingPreferences.autoRouting === false) return;
    if (!this.config.signDailyIfNeeded || !this.config.sellerPeerId) return;
    if (!this.signingInFlight) {
      const signDailyIfNeeded = this.config.signDailyIfNeeded;
      const sellerPeerId = this.config.sellerPeerId;
      this.signingInFlight = signDailyIfNeeded(sellerPeerId)
        .catch((err: unknown) => {
          // Swallowed on purpose (a failed sign must not turn a successful
          // retry attempt below into a thrown error before it even tries),
          // but silent-and-discarded is its own incident: a real one already
          // cost a day of on-chain forensics to diagnose (the routing peer's
          // own error -- "no current day pass, or today's signature is not yet on
          // file" -- gives no hint that a chain-RPC outage upstream is the
          // actual cause). Logging what failed costs nothing and turns the
          // next occurrence into a one-line diagnosis instead of a repeat of
          // that. The retry right after this in selectRoute will simply
          // 402 again and surface as a normal RoutingPeerError.
          const code = (err as { code?: unknown } | null)?.code;
          console.warn(`[LevantoRouter] day-pass signing skipped: ${code ?? (err instanceof Error ? err.message : err)}`);
        })
        .finally(() => {
          this.signingInFlight = null;
        });
    }
    await this.signingInFlight;
  }

  /**
   * Headers proving `buyerPeerId` is genuine (decisions doc SS13 item 8),
   * for both `/_antseed/route` and `/_antseed/route/digest`. `{}` (not a
   * thrown error) whenever signing isn't configured, has no seller to bind
   * to, or itself fails -- lenient by design during rollout (see the
   * runlog): an old client or a signing hiccup must still be able to route,
   * same as before this capability existed, not be hard-blocked by it. A
   * verifying routing peer treats a request with no auth headers as
   * unauthenticated, not as malformed.
   */
  private async buildRouteAuthHeaders(): Promise<Record<string, string>> {
    if (!this.config.signRouteAuth || !this.config.sellerPeerId) return {};
    try {
      const auth = await this.config.signRouteAuth(this.config.sellerPeerId);
      return {
        'x-antseed-route-auth-buyer': auth.buyer,
        'x-antseed-route-auth-issued-at': String(auth.issuedAt),
        'x-antseed-route-auth-nonce': auth.nonce,
        'x-antseed-route-auth-signature': auth.signature,
      };
    } catch {
      return {};
    }
  }

  /**
   * Daily digest (decisions doc SS6.9, software-arch doc SS2.7): its own
   * calendar-day cadence, independent of day-pass signing (runlog
   * 2026-09-0X made signing purely reactive to the seller's 402s, with no
   * calendar-day concept of its own left at all -- the digest still has one,
   * since it's reporting stats, not moving money). Its own request, not
   * bundled into a SpendingAuth (SS3.6 -- SpendingAuthMetadata is the wrong
   * shape, and PaymentMux's MessageType enum is closed). No signing key is
   * involved -- this is plain stats -- so the plugin sends it directly with
   * its own fetchImpl rather than needing a host-mediated method.
   * Best-effort: a failed send must never block or fail routing (SS2.7:
   * "not required for correct routing to work"), so errors are swallowed
   * and retried on the next selectRoute call rather than surfaced.
   *
   * Reports the day that just closed, not the one starting now: "one daily
   * performance digest" per day only makes sense as a finished tally (SS3.6's
   * retention model -- each day's digest accumulates as a permanent record),
   * and at the moment this fires (the first selectRoute of a new calendar
   * day) today's own ledger rows don't exist yet. Sent one day "late"
   * relative to the toggle -- yesterday's numbers, flushed at the start of
   * today.
   */
  private async sendDailyDigestIfNeeded(): Promise<void> {
    if (!this.config.sellerPeerId) return; // nowhere to send it yet
    const todayKey = calendarDayKey();
    if (this.lastDigestSentDayKey === todayKey) return;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const digest = buildDigest(this.ledger.all(), periodKey(yesterday));
    const doFetch = this.config.fetchImpl ?? fetch;
    const timeoutMs = this.config.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    const routeAuthHeaders = await this.buildRouteAuthHeaders();
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      // Explicit suffix path (decisions doc SS13 item 20, resolved) -- states
      // intent via the URL rather than relying on the routing peer to
      // body-sniff for an absent inputMessage field.
      const res = await doFetch(`${this.config.routingPeerUrl}/_antseed/route/digest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.buyerPeerId ? { 'x-antseed-buyer-peer-id': this.config.buyerPeerId } : {}),
          ...routeAuthHeaders,
        },
        body: JSON.stringify(digest),
        signal: timeoutController.signal,
      });
      if (res.ok) this.lastDigestSentDayKey = todayKey;
    } catch {
      // Routing peer unreachable or unresponsive -- try again next call, same as a skipped day's stats.
    } finally {
      clearTimeout(timeoutHandle);
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
   * SS4.3's cache "warmth" observation feed. Router.onResult's shared shape
   * doesn't carry `conversation` or the resolved model (packages/node/src/interfaces/buyer-router.ts's
   * `Router.recordObservedCache`), so buyer-proxy.ts calls this separately,
   * alongside `onResult`, after a successful response.
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
    requestId?: string;
  }): void {
    if (!result.success) return; // a failed/retried dispatch isn't a resolved decision
    // Correlates by requestId, not peer (decisions doc SS13 item 13, resolved)
    // -- two different conversations concurrently routed to the same peer no
    // longer risk mis-pairing predicted vs. actual. Without a requestId (an
    // older or non-conforming caller), there's genuinely nothing to
    // correlate against -- the result is silently dropped from the ledger
    // rather than guessed at.
    if (!result.requestId) return;
    this.ledger.recordResult(result.requestId, peer.peerId, {
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
    defaultRoutedModel?: string | null,
  ): Promise<RouteCandidate[] | null> {
    // Kept fresh regardless of which model this particular call is for --
    // the day-pass-enable toggle is a standing preference, not tied to
    // the model happening to be selected on this one request (decisions doc
    // SS14 item 29).
    if (routingPreferences) this.cachedRoutingPreferences = routingPreferences;

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
        // A reused dispatch still costs real money and still resolves via
        // the normal onResult flow -- decisions doc SS13 item 14: give it
        // its own ledger row too, associated with THIS request's own
        // requestId, reusing the pinned decision's predicted fields rather
        // than requiring a fresh prediction it has no network call to
        // derive one from. routingLatencyMs is null, matching
        // RoutingDecisionRow's own field doc ("null when the gate skipped
        // the call entirely").
        this.ledger.recordPending(req.requestId, {
          model: pinned.serviceId,
          predictedCostUsd: pinned.predictedCostUsd,
          predictedInputTokens: pinned.predictedInputTokens,
          predictedCachedInputTokens: pinned.predictedCachedInputTokens,
          predictedOutputTokens: pinned.predictedOutputTokens,
          cqt: pinned.cqt,
          routingLatencyMs: null,
          atMs: Date.now(),
          baselinePrices: pinned.baselinePrices,
          conversationKey: conversation?.sessionKey ?? null,
          // No fresh routing call on a reused/pinned dispatch, so no ranked
          // response to draw candidates from -- honest empty, not a stale
          // copy of the original decision's list.
          consideredCandidates: [],
          inputMessagePreview: trimForInputMessage(lastUserText) || null,
        });
        return [pinnedToRouteCandidate(pinned, substituteModel(req, pinned.serviceId))];
      }
    }

    // Same daily cadence, its own request (SS2.7) -- fire-and-forget, never
    // blocks or fails the routing call itself.
    await this.sendDailyDigestIfNeeded();

    const promptTokens = estimateTokens(lastUserText);
    const expectedCachedTokens = convKey
      ? this.conversations.observedModelPeers(convKey).map(({ model: m, peerId }) => ({
        model: m,
        peer: peerId,
        tokens: Math.round(this.conversations.expectedCachedTokens(convKey, m, peerId, promptTokens)),
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
      inputMessage: trimForInputMessage(lastUserText),
      promptTokens,
      expectedCachedTokens,
      constraints: {
        maxInputUsdPerMillion: routingPreferences?.maxInputUsdPerMillion ?? undefined,
        minTrustScore: routingPreferences?.minTrustScore ?? undefined,
        allowedPeerIds: routingPreferences?.allowedPeerIds ?? undefined,
        blockedPeerIds: routingPreferences?.blockedPeerIds ?? undefined,
      },
    };

    const doFetch = this.config.fetchImpl ?? fetch;
    const timeoutMs = this.config.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    // Real bug, found live: a single nonce reused across the no-day-pass
    // self-heal retry below gets burned by the routing peer's replay check
    // (RouteAuthVerifier.verify()) as soon as the FIRST attempt's signature
    // checks out -- independent of, and before, the day-pass gate that
    // attempt then fails. So attempt #1 burns the nonce and correctly 402s;
    // the buyer signs the day pass for real; attempt #2 reuses that
    // already-burned nonce and gets rejected as a replay, even though the
    // day-pass gate would now pass. This permanently blocked a brand-new
    // buyer's very first request. Signing fresh per attempt (a local wallet
    // signature, no network cost) fixes it without needing any change on
    // the routing-peer side.
    const attemptRoute = async (): Promise<Response> => {
      const routeAuthHeaders = await this.buildRouteAuthHeaders();
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
      try {
        return await doFetch(`${this.config.routingPeerUrl}/_antseed/route`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.buyerPeerId ? { 'x-antseed-buyer-peer-id': this.config.buyerPeerId } : {}),
            ...routeAuthHeaders,
          },
          body: JSON.stringify(body),
          signal: timeoutController.signal,
        });
      } catch (err) {
        // Routing peer unreachable OR unresponsive -- the AbortController
        // above fires the same way for both, so both land here. Throws rather
        // than returning null (decisions doc SS13 item 16): null would fall
        // through to the fixed-model pipeline, which can't handle the Auto
        // sentinel and fails a moment later with a confusing error instead of
        // a clear one.
        const reason = err instanceof Error ? err.message : String(err);
        throw new RoutingPeerError('unreachable', `Levanto routing peer at ${this.config.routingPeerUrl} is unreachable or timed out: ${reason}`);
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    // Extracts the seller's error message exactly once per Response -- res.json()
    // (and fetch Response bodies in general) can only be consumed a single time,
    // so this must never be called twice on the same res.
    const parseRejectionMessage = async (response: Response): Promise<string> => {
      let message = `Levanto routing peer rejected the request (status ${response.status}).`;
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) message = errBody.error.message;
      } catch {
        // Non-JSON or empty error body -- keep the generic message.
      }
      return message;
    };

    const routingCallStartedAt = Date.now();
    let res = await attemptRoute();

    // Fully reactive day-pass payment (runlog 2026-09-0X): the client
    // keeps no clock of its own for this -- it signs only because the
    // seller's response just said payment is required, exactly once per
    // lapse, the same shape ordinary per-request metered billing already
    // uses (seller decides a charge is due, buyer signs in response, never
    // the other way around). One retry only: covers both a genuinely
    // brand-new buyer (no channel at all yet) and a returning one whose last
    // charge fell outside the seller's rolling window --
    // signSubscriptionOnDemand doesn't need to know which case it is, and a
    // second 402 after the retry just falls through to the throw below like
    // any other rejection.
    if (res.status === 402 && this.config.signDailyIfNeeded && this.config.sellerPeerId) {
      await this.signSubscriptionOnDemand();
      res = await attemptRoute();
    }

    const rejectionMessage = res.ok ? null : await parseRejectionMessage(res);

    const routingLatencyMs = Date.now() - routingCallStartedAt;
    if (!res.ok) {
      // Includes the 402 "no current day pass" case (the retry above already had
      // its one chance to clear it). Same reasoning as the unreachable
      // branch above -- throws instead of falling through to a pipeline
      // that can't handle the Auto sentinel.
      throw new RoutingPeerError('rejected', rejectionMessage!, res.status);
    }

    const parsed = (await res.json()) as RouteResponseBody;
    if (!Array.isArray(parsed?.ranked) || parsed.ranked.some((entry) => !entry?.price || !entry?.estimate)) {
      throw new RoutingPeerError('rejected', `Levanto routing peer at ${this.config.routingPeerUrl} returned a malformed response.`, res.status);
    }
    const peerById = new Map(peers.map((p) => [p.peerId, p] as const));
    // One snapshot per response, not per candidate -- decisions doc SS13
    // item 10, resolved. Duplicated onto every PinnedDecision below the same
    // way cqt already is, since it's a request-level value.
    const baselinePrices = computeBaselinePrices(parsed.ranked);
    const consideredCandidates = topConsideredCandidates(parsed.ranked);

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
        // For SS2.5's ledger, and reused as-is by a later pinned/reused
        // dispatch (SS13 item 14) -- carried on the candidate itself now
        // rather than looked up separately once the winner is known.
        predictedCostUsd: entry.estimate.costUsd,
        predictedInputTokens: entry.estimate.inputTokens,
        predictedCachedInputTokens: entry.estimate.cachedInputTokens,
        predictedOutputTokens: entry.estimate.outputTokens,
        cqt,
        baselinePrices,
      });
    }

    // allowedPeerIds is a client-side re-filter, not a ranking constraint the
    // peer narrows by (decisions doc SS4.4) -- walk the ranked list as usual,
    // skip anything outside the allowlist. If that empties the list, fall
    // back to the allowed peers directly rather than giving up.
    //
    // The fallback needs a model to pair with those peers -- decisions doc
    // SS13 item 8: use whatever the pre-existing "antseed" alias currently
    // resolves to (defaultRoutedModel, host-owned buyer.state.json state
    // passed in by buyer-proxy.ts) -- the buyer's own already-chosen fallback
    // target, which has an actual reason to be one of these allowlisted
    // peers' models. No price data comes with defaultRoutedModel, so the
    // synthesized candidates carry null pricing -- honest "unknown," not a
    // fabricated number.
    const allowedPeerIds = routingPreferences?.allowedPeerIds;
    if (allowedPeerIds && allowedPeerIds.length > 0) {
      const allowedSet = new Set(allowedPeerIds.map((p) => p.toLowerCase()));
      const filtered = ranked.filter((c) => allowedSet.has(c.peerId.toLowerCase()));
      if (filtered.length > 0) {
        ranked = filtered;
      } else if (defaultRoutedModel) {
        ranked = peers
          .filter((peer) => allowedSet.has(peer.peerId.toLowerCase()))
          .map((peer) => ({
            peer,
            peerId: peer.peerId,
            serviceId: defaultRoutedModel,
            reputation: 0,
            hasCachedInputPricing: false,
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            minImageUsdPerImage: null,
            // No real Sage prediction for a synthesized fallback candidate --
            // honest "unknown," same reasoning as the null price fields above.
            predictedCostUsd: null,
            predictedInputTokens: null,
            predictedCachedInputTokens: null,
            predictedOutputTokens: null,
            cqt,
            // Still real: baselinePrices comes from the actual ranked
            // response, independent of which candidate the walk ends up on.
            baselinePrices,
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

    this.ledger.recordPending(req.requestId, {
      model: winner.serviceId,
      predictedCostUsd: winner.predictedCostUsd,
      predictedInputTokens: winner.predictedInputTokens,
      predictedCachedInputTokens: winner.predictedCachedInputTokens,
      predictedOutputTokens: winner.predictedOutputTokens,
      cqt: winner.cqt,
      routingLatencyMs,
      atMs: Date.now(),
      baselinePrices: winner.baselinePrices,
      conversationKey: conversation?.sessionKey ?? null,
      // Independent of allowedPeerIds re-filtering above -- what the peer
      // actually offered, not what survived the client-side filter, so a
      // "what else was considered" view isn't silently missing candidates
      // the buyer's own preferences excluded.
      consideredCandidates,
      inputMessagePreview: trimForInputMessage(lastUserText) || null,
    });

    // No signing here (runlog 2026-09-0X): a response reaching this point is
    // already proof the seller considered the day pass current when it
    // served this request -- see signSubscriptionOnDemand's doc comment for
    // why the client never re-decides that on its own.
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
  // A peer-pinned request (`<peerId>@levanto-auto`) arrives with a `service`
  // field the host's own rewritePeerPinnedServiceInBody already mirrored
  // from `model` (request-utils.ts) -- extractRequestedService prefers
  // `service` over `model`, so leaving it stale here sends the seller the
  // sentinel this function exists to replace: real 400 "Service
  // \"levanto-auto\" is not served by this peer", model correctly "hy3" but
  // ignored. Mirrors overrideRoutedModelInBody's own model/service sync.
  if (typeof parsed['service'] === 'string' && parsed['service'] === parsed['model']) {
    parsed['service'] = model;
  }
  parsed['model'] = model;
  return { ...req, body: new TextEncoder().encode(JSON.stringify(parsed)) };
}
