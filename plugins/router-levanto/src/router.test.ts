import { describe, expect, it, vi } from 'vitest';
import type { ConversationIdentity, PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LevantoRouter } from './router.js';

function conversation(sessionKey = 'sess-1'): ConversationIdentity {
  return { tool: 'claude-code', sessionKey, parentSessionKey: null, isUserThread: true };
}

function rankedResponse(overrides?: Partial<{ ranked: unknown[]; baselineSuggestion: unknown }>) {
  return {
    v: 1,
    ranked: overrides?.ranked ?? [
      { model: 'gpt-5.6-luna', peer: '0xAAA', score: 0.9, predictedQuality: 0.9, predictedCostUsd: 0.001,
        predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
        price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
    ],
    baselineSuggestion: overrides?.baselineSuggestion ?? { model: 'gpt-5.6-sol', peer: '0xBBB', price: { inUsdPerM: 1.1, outUsdPerM: 8.9 } },
    receipt: { routerId: 'mock', artifactVersion: 'test', lambdaVersion: 'test' },
  };
}

function req(model: string, lastUserText = 'hello'): SerializedHttpRequest {
  return {
    requestId: 'r1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({
      model,
      messages: [{ role: 'user', content: lastUserText }],
    })),
  };
}

function peer(peerId: string): PeerInfo {
  return { peerId } as PeerInfo;
}

describe('LevantoRouter.selectRoute', () => {
  it('declines immediately for a concretely-chosen model, without calling the routing peer', async () => {
    const fetchImpl = vi.fn();
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl });
    const result = await router.selectRoute(req('gpt-4o'), [], null, null);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls the routing peer for the levanto-auto sentinel and maps ranked candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        ranked: [
          {
            model: 'gpt-5.6-luna', peer: '0xAAA', score: 0.9,
            predictedQuality: 0.9, predictedCostUsd: 0.001,
            predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 },
          },
        ],
        baselineSuggestion: { model: 'gpt-5.6-sol', peer: '0xBBB', price: { inUsdPerM: 1.1, outUsdPerM: 8.9 } },
        receipt: { routerId: 'mock', artifactVersion: 'test', lambdaVersion: 'test' },
      }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const peers = [peer('0xAAA'), peer('0xCCC')];
    const result = await router.selectRoute(req('levanto-auto'), peers, null, null);

    expect(fetchImpl).toHaveBeenCalledWith('http://x/_antseed/route', expect.objectContaining({ method: 'POST' }));
    expect(result).toHaveLength(1);
    expect(result?.[0]?.serviceId).toBe('gpt-5.6-luna');
    expect(result?.[0]?.peerId).toBe('0xAAA');
    expect(result?.[0]?.inputUsdPerMillion).toBe(0.2);
  });

  it('drops ranked candidates whose peer is not in the current peer set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        ranked: [
          { model: 'gpt-5.6-luna', peer: '0xNOT-A-PEER', score: 0.9, predictedQuality: 0.9, predictedCostUsd: 0.001,
            predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
        ],
        baselineSuggestion: { model: 'x', peer: '0xBBB', price: { inUsdPerM: 1, outUsdPerM: 1 } },
        receipt: { routerId: 'mock', artifactVersion: 'test', lambdaVersion: 'test' },
      }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
    expect(result).toBeNull();
  });

  it('declines (does not throw) when the routing peer is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
    expect(result).toBeNull();
  });

  it('declines when the routing peer returns a non-OK status (e.g. 402 not subscribed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 402 });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
    expect(result).toBeNull();
  });

  describe('new-user-message gate (decisions doc SS4.2)', () => {
    it('a tool-loop continuation (same last user message) skips the network call and reuses the pinned decision', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xBBB')];
      const conv = conversation();

      const first = await router.selectRoute(req('levanto-auto', 'hello'), peers, conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(first?.[0]?.serviceId).toBe('gpt-5.6-luna');

      // Same last user message -- e.g. a tool-call/tool-result round trip.
      const second = await router.selectRoute(req('levanto-auto', 'hello'), peers, conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1 -- no new network call
      expect(second).toHaveLength(1);
      expect(second?.[0]?.serviceId).toBe('gpt-5.6-luna');
      expect(second?.[0]?.peerId).toBe('0xAAA');
    });

    it('a genuinely new user message re-routes with a fresh network call', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA')];
      const conv = conversation();

      await router.selectRoute(req('levanto-auto', 'hello'), peers, conv, null);
      await router.selectRoute(req('levanto-auto', 'a different message'), peers, conv, null);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('gates independently per conversation (different sessionKey never shares a pin)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA')];

      await router.selectRoute(req('levanto-auto', 'hello'), peers, conversation('sess-1'), null);
      await router.selectRoute(req('levanto-auto', 'hello'), peers, conversation('sess-2'), null);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('routes every call when there is no ConversationIdentity to key on (safe default)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], null, null);
      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], null, null);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('pay-first daily signing (decisions doc SS6.2)', () => {
    it('signs today before the first routing call of the day, only once even across multiple calls', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto', 'first'), [peer('0xAAA')], conversation('a'), null);
      await router.selectRoute(req('levanto-auto', 'second'), [peer('0xAAA')], conversation('b'), null);

      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    it('signs before the routing call it gates, not after', async () => {
      const order: string[] = [];
      const fetchImpl = vi.fn().mockImplementation(async () => {
        order.push('fetch');
        return { ok: true, json: async () => rankedResponse() };
      });
      const signDailyIfNeeded = vi.fn().mockImplementation(async () => { order.push('sign'); });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);

      expect(order).toEqual(['sign', 'fetch']);
    });

    it('does not sign at all for a pinned tool-loop continuation (no network call to gate)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const conv = conversation();

      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], conv, null);
      signDailyIfNeeded.mockClear();
      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], conv, null); // same message -- pinned

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('does nothing when signDailyIfNeeded is not configured (no payment wiring yet)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      expect(result).not.toBeNull();
    });
  });

  describe('routing_decisions ledger (software-architecture doc SS2.5)', () => {
    it('writes a row once onResult reports the resolved decision, joining predicted and actual', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', score: 0.9, predictedQuality: 0.9, predictedCostUsd: 0.0012,
              predictedInputTokens: 100, predictedCachedInputTokens: 20, predictedOutputTokens: 45,
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      expect(router.getLedgerRows()).toHaveLength(0); // nothing until onResult

      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 250, tokens: 140,
        freshInputTokens: 90, cachedInputTokens: 18, outputTokens: 42, estimatedCostUsd: 0.0011,
      });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actualModel: 'gpt-5.6-luna',
        actualPeer: '0xAAA',
        actualPromptTokens: 108, // fresh + cached
        actualCachedTokens: 18,
        actualCompletionTokens: 42,
        actualUsdcPaid: 0.0011,
        predictedCostUsd: 0.0012,
        predictedInputTokens: 100,
        predictedCachedInputTokens: 20,
        predictedOutputTokens: 45,
        cqt: 5,
      });
      expect(rows[0]?.routingLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('does not write a row for a failed dispatch', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      router.onResult(peer('0xAAA'), { success: false, latencyMs: 100, tokens: 0 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('does not write a row for an onResult with no matching pending decision', () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      router.onResult(peer('0xUNRELATED'), { success: true, latencyMs: 10, tokens: 5 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });
  });

  describe('allowedPeerIds re-filter (decisions doc SS4.4)', () => {
    it('keeps only ranked candidates inside the allowlist', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', score: 0.9, predictedQuality: 0.9, predictedCostUsd: 0.001,
              predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
            { model: 'kimi-k3', peer: '0xBBB', score: 0.8, predictedQuality: 0.8, predictedCostUsd: 0.0005,
              predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
              price: { inUsdPerM: 0.1, outUsdPerM: 0.5, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xBBB')];

      const result = await router.selectRoute(req('levanto-auto'), peers, null, { allowedPeerIds: ['0xBBB'] });

      expect(result).toHaveLength(1);
      expect(result?.[0]?.peerId).toBe('0xBBB');
    });

    it('falls back to the allowed peers directly when the walk exhausts the ranked list', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', score: 0.9, predictedQuality: 0.9, predictedCostUsd: 0.001,
              predictedInputTokens: 100, predictedCachedInputTokens: 0, predictedOutputTokens: 50,
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
          baselineSuggestion: { model: 'gpt-5.6-sol', peer: '0xCCC', price: { inUsdPerM: 1.1, outUsdPerM: 8.9 } },
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      // 0xCCC is allowed but never appeared in the ranked list.
      const peers = [peer('0xAAA'), peer('0xCCC')];

      const result = await router.selectRoute(req('levanto-auto'), peers, null, { allowedPeerIds: ['0xCCC'] });

      expect(result).toHaveLength(1);
      expect(result?.[0]?.peerId).toBe('0xCCC');
      expect(result?.[0]?.serviceId).toBe('gpt-5.6-sol'); // baselineSuggestion's model
    });
  });
});
