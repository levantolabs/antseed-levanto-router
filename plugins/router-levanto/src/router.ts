import type {
  ConversationIdentity,
  ModelRoutingPreferences,
  PeerInfo,
  RouteCandidate,
  SerializedHttpRequest,
} from '@antseed/node';

export interface LevantoRouterConfig {
  /** Base URL of the routing peer's HTTP surface, e.g. http://127.0.0.1:8787 */
  routingPeerUrl: string;
  fetchImpl?: typeof fetch;
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
  baselineSuggestion: { model: string; peer: string; price: { inUsdPerM: number; outUsdPerM: number } };
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

/** Very rough token estimate (chars/4) -- deepened in task #9's cached-token estimator. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class LevantoRouter {
  constructor(private readonly config: LevantoRouterConfig) {}

  // Required Router members -- levanto-auto only participates via selectRoute;
  // a concretely-chosen model falls through to the host's existing pipeline
  // before selectPeer would ever be reached for this router (software-arch
  // doc SS2.1). selectPeer/onResult exist only to satisfy the interface.
  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    return peers[0] ?? null;
  }

  onResult(): void {
    // Deepened in task #9 (routing_decisions ledger).
  }

  async selectRoute(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    _conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
  ): Promise<RouteCandidate[] | null> {
    const { model, lastUserText } = parseChatBody(req);
    // levanto-auto sentinel check is host-agnostic: any concrete model name
    // declines immediately, matching software-arch doc's "no sentinel
    // knowledge in host code" rule.
    if (model !== 'levanto-auto') return null;

    // TODO(task #9): real new-user-message gate (decisions doc SS4.2) --
    // currently calls the routing peer on every request, no pinning yet.

    const body: RouteRequestBody = {
      v: 1,
      cqt: 5,
      sagePrompt: trimForSagePrompt(lastUserText),
      contextTokens: estimateTokens(lastUserText),
      expectedCachedTokens: [],
      constraints: {
        maxInputUsdPerMillion: routingPreferences?.maxInputUsdPerMillion ?? undefined,
        minTrustScore: routingPreferences?.minTrustScore ?? undefined,
        allowedPeerIds: routingPreferences?.allowedPeerIds ?? undefined,
        blockedPeerIds: routingPreferences?.blockedPeerIds ?? undefined,
      },
    };

    const doFetch = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.config.routingPeerUrl}/_antseed/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Routing peer unreachable -- task #12 covers this properly (timeout
      // vs. clean 402). For now: decline rather than hang.
      return null;
    }
    if (!res.ok) return null; // includes the 402 "not subscribed" case

    const parsed = (await res.json()) as RouteResponseBody;
    const peerById = new Map(peers.map((p) => [p.peerId, p] as const));

    const candidates: RouteCandidate[] = [];
    for (const entry of parsed.ranked) {
      const peer = peerById.get(entry.peer as PeerInfo['peerId']);
      if (!peer) continue; // stale candidate, not in our current peer set
      candidates.push({
        peer,
        peerId: peer.peerId,
        serviceId: entry.model,
        request: substituteModel(req, entry.model),
        reputation: 0,
        hasCachedInputPricing: entry.price.cachedInUsdPerM > 0,
        inputUsdPerMillion: entry.price.inUsdPerM,
        outputUsdPerMillion: entry.price.outUsdPerM,
        minImageUsdPerImage: null,
      });
    }
    return candidates.length > 0 ? candidates : null;
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
