import type { PeerInfo, RouteCandidate } from '@antseed/node';

/**
 * New-user-message gate (decisions doc SS4.2) and the pinned decision it
 * gates on, plus the cached-token estimator's per-(model,peer) state
 * (SS4.3) -- both keyed per conversation.
 */

export interface PinnedDecision {
  peer: PeerInfo;
  peerId: string;
  serviceId: string;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
}

interface CacheObservation {
  /** cachedInputTokens / promptTokens from the last turn against this (model, peer), EMA'd. */
  observedRatio: number;
  previousPromptTokens: number;
  lastObservedAtMs: number;
}

interface ConversationEntry {
  lastRoutedUserText: string;
  pinned: PinnedDecision | null;
  /** (model, peer) key -> cache observation, for SS4.3's per-candidate expectedCachedTokens. */
  cacheByModelPeer: Map<string, CacheObservation>;
}

/** Flat timeout, decided (decisions doc SS4.3) -- not per-provider, not learned. */
const CACHE_DECAY_MS = 3 * 60 * 1000;

/** EMA smoothing for the observed cache ratio. */
const CACHE_RATIO_EMA_ALPHA = 0.5;

function modelPeerKey(model: string, peerId: string): string {
  return `${model}::${peerId}`;
}

export class ConversationState {
  private readonly entries = new Map<string, ConversationEntry>();

  private getOrCreate(key: string): ConversationEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { lastRoutedUserText: '', pinned: null, cacheByModelPeer: new Map() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** True when this is a new user message for this conversation, or the conversation is unseen. */
  isNewUserMessage(key: string, lastUserText: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return entry.lastRoutedUserText !== lastUserText;
  }

  /** Read the pinned decision from the last routing call, for a tool-loop continuation. */
  getPinned(key: string): PinnedDecision | null {
    return this.entries.get(key)?.pinned ?? null;
  }

  /** Record a fresh routing decision -- called after a real (non-gated) selectRoute call. */
  recordDecision(key: string, lastUserText: string, pinned: PinnedDecision): void {
    const entry = this.getOrCreate(key);
    entry.lastRoutedUserText = lastUserText;
    entry.pinned = pinned;
  }

  /**
   * Observed cache ratio for a candidate that's been used in this conversation
   * before -- SS4.3's "warmth" estimator. Call after a response completes.
   */
  recordObservedCache(key: string, model: string, peerId: string, promptTokens: number, cachedInputTokens: number, now = Date.now()): void {
    if (promptTokens <= 0) return;
    const entry = this.getOrCreate(key);
    const ratio = Math.max(0, Math.min(1, cachedInputTokens / promptTokens));
    const mpKey = modelPeerKey(model, peerId);
    const prev = entry.cacheByModelPeer.get(mpKey);
    const smoothed = prev ? prev.observedRatio * (1 - CACHE_RATIO_EMA_ALPHA) + ratio * CACHE_RATIO_EMA_ALPHA : ratio;
    entry.cacheByModelPeer.set(mpKey, { observedRatio: smoothed, previousPromptTokens: promptTokens, lastObservedAtMs: now });
  }

  /**
   * Expected cached tokens for one candidate, per SS4.3: zero for a
   * candidate never used in this conversation (correct, not a limitation --
   * it holds none of the prefix), decayed to zero after CACHE_DECAY_MS.
   */
  expectedCachedTokens(key: string, model: string, peerId: string, currentPromptTokens: number, now = Date.now()): number {
    const entry = this.entries.get(key);
    const obs = entry?.cacheByModelPeer.get(modelPeerKey(model, peerId));
    if (!obs) return 0;
    if (now - obs.lastObservedAtMs > CACHE_DECAY_MS) return 0;
    return Math.min(obs.previousPromptTokens * obs.observedRatio, currentPromptTokens);
  }

  /** All (model, peerId) pairs this conversation has observed cache data for -- for building expectedCachedTokens. */
  observedModelPeers(key: string): Array<{ model: string; peerId: string }> {
    const entry = this.entries.get(key);
    if (!entry) return [];
    return [...entry.cacheByModelPeer.keys()].map((mpKey) => {
      const [model, peerId] = mpKey.split('::');
      return { model: model ?? '', peerId: peerId ?? '' };
    });
  }
}

export function pinnedToRouteCandidate(pinned: PinnedDecision, request: RouteCandidate['request']): RouteCandidate {
  return {
    peer: pinned.peer,
    peerId: pinned.peerId,
    serviceId: pinned.serviceId,
    request,
    reputation: pinned.reputation,
    hasCachedInputPricing: pinned.hasCachedInputPricing,
    inputUsdPerMillion: pinned.inputUsdPerMillion,
    outputUsdPerMillion: pinned.outputUsdPerMillion,
    minImageUsdPerImage: pinned.minImageUsdPerImage,
  };
}
