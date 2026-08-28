import { describe, expect, it, vi } from 'vitest';
import type { ConversationIdentity, ModelRoutingPreferences, PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LevantoRouter } from './router.js';

/**
 * Explicit consent to the daily subscription (decisions doc SS14 item 29) --
 * `ensureSignedToday` requires this to be true before it will ever call
 * `signDailyIfNeeded`. Most pre-existing signing tests below pass this where
 * they previously passed `null`, since `null`/absent must mean "no consent
 * seen yet," not "assume yes."
 */
function enabledPreferences(): ModelRoutingPreferences {
  return {
    preferFreePeers: false,
    maxInputUsdPerMillion: 25,
    minTrustScore: 60,
    allowedPeerIds: [],
    blockedPeerIds: [],
    cqt: 5,
    autoSubscriptionEnabled: true,
  };
}

function conversation(sessionKey = 'sess-1'): ConversationIdentity {
  return { tool: 'claude-code', sessionKey, parentSessionKey: null, isUserThread: true };
}

function rankedResponse(overrides?: Partial<{ ranked: unknown[] }>) {
  return {
    v: 1,
    ranked: overrides?.ranked ?? [
      { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
        price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
    ],
    router: 'mock',
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
            model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 },
          },
        ],
        router: 'mock',
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
          { model: 'gpt-5.6-luna', peer: '0xNOT-A-PEER', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
        ],
        router: 'mock',
      }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
    expect(result).toBeNull();
  });

  it('throws RoutingPeerError("unreachable") instead of silently declining when the routing peer is unreachable (decisions doc SS13 item 16)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      name: 'RoutingPeerError',
      kind: 'unreachable',
    });
  });

  it('throws RoutingPeerError("rejected") when the routing peer returns a non-OK status (e.g. 402 not subscribed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Not subscribed, or today\'s signature is not yet on file.' } }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      name: 'RoutingPeerError',
      kind: 'rejected',
      statusCode: 402,
      message: 'Not subscribed, or today\'s signature is not yet on file.',
    });
  });

  it('self-heals from a "not subscribed" 402 by forcing a fresh signature and retrying the routing call once', async () => {
    const notSubscribed = { ok: false, status: 402, json: async () => ({ error: { message: 'Not subscribed, or today\'s signature is not yet on file.' } }) };
    const success = { ok: true, json: async () => rankedResponse() };
    let routingCalls = 0;
    // /_antseed/route/digest shares the same fetchImpl (sendDailyDigestIfNeeded)
    // -- discriminate by URL rather than call order/count, same reasoning as
    // the inputMessage filter in "signs before the routing call it gates" above.
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (!url.endsWith('/_antseed/route')) return { ok: true, json: async () => ({}) };
      routingCalls += 1;
      return routingCalls === 1 ? notSubscribed : success;
    });
    const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
    const router = new LevantoRouter({
      routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences());

    expect(result).toHaveLength(1);
    expect(routingCalls).toBe(2);
    // Once from the normal pay-first gate, once again forced by the retry --
    // proves the once-per-day throttle was actually reset, not just skipped.
    expect(signDailyIfNeeded).toHaveBeenCalledTimes(2);
  });

  it('does not retry a second time if the seller still reports "not subscribed" after the forced re-signature', async () => {
    let routingCalls = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (!url.endsWith('/_antseed/route')) return { ok: true, json: async () => ({}) };
      routingCalls += 1;
      return { ok: false, status: 402, json: async () => ({ error: { message: 'Not subscribed, or today\'s signature is not yet on file.' } }) };
    });
    const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
    const router = new LevantoRouter({
      routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences())).rejects.toMatchObject({
      kind: 'rejected',
      statusCode: 402,
    });
    expect(routingCalls).toBe(2); // bounded to exactly one retry, not a loop
  });

  it('does not retry a "not subscribed" 402 when the subscription toggle is off (existing behavior preserved)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 402,
      json: async () => ({ error: { message: 'Not subscribed, or today\'s signature is not yet on file.' } }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic message when a non-OK response has no JSON error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      kind: 'rejected',
      statusCode: 500,
    });
  });

  it('aborts and throws RoutingPeerError("unreachable") if the routing peer never responds within routeTimeoutMs', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const router = new LevantoRouter({
      routingPeerUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      routeTimeoutMs: 20,
    });
    await expect(router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(fetchImpl).toHaveBeenCalledWith('http://x/_antseed/route', expect.objectContaining({ signal: expect.any(Object) }));
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

      await router.selectRoute(req('levanto-auto', 'first'), [peer('0xAAA')], conversation('a'), enabledPreferences());
      await router.selectRoute(req('levanto-auto', 'second'), [peer('0xAAA')], conversation('b'), enabledPreferences());

      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    it('signs before the routing call it gates, not after', async () => {
      const order: string[] = [];
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        // Only the SS4.4 routing call (carries inputMessage) is the "fetch" this
        // test cares about ordering against sign -- the digest submission
        // fires alongside it but isn't part of what this test verifies.
        if ('inputMessage' in JSON.parse(init.body)) order.push('fetch');
        return { ok: true, json: async () => rankedResponse() };
      });
      const signDailyIfNeeded = vi.fn().mockImplementation(async () => { order.push('sign'); });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences());

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

      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], conv, enabledPreferences());
      signDailyIfNeeded.mockClear();
      await router.selectRoute(req('levanto-auto', 'hello'), [peer('0xAAA')], conv, enabledPreferences()); // same message -- pinned

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('does nothing when signDailyIfNeeded is not configured (no payment wiring yet)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      expect(result).not.toBeNull();
    });
  });

  describe('configureDailySigning / triggerDailySigningCheck (decisions doc SS13 items 9 and 11)', () => {
    it('configureDailySigning wires a callback that was never provided at construction', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences());
      expect(signDailyIfNeeded).not.toHaveBeenCalled(); // not wired yet

      router.configureDailySigning(signDailyIfNeeded);
      await router.selectRoute(req('levanto-auto', 'a new message'), [peer('0xAAA')], null, enabledPreferences());
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    it('triggerDailySigningCheck signs today independent of any chat request (decisions doc SS13 item 9)', async () => {
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded });
      router.updateRoutingPreferences(enabledPreferences());

      await router.triggerDailySigningCheck();

      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    it('shares the once-per-day gate with selectRoute -- a background trigger after a real chat already signed today is a no-op', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences()); // real chat signs today
      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);

      await router.triggerDailySigningCheck(); // background tick, same day
      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1); // still just once
    });

    it('and the reverse: a real chat after a background trigger already signed today does not sign again', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      router.updateRoutingPreferences(enabledPreferences());

      await router.triggerDailySigningCheck(); // background tick signs first
      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, enabledPreferences()); // real chat, same day
      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1); // still just once
    });

    describe('subscription-enable gate (decisions doc SS14 item 29)', () => {
      it('selectRoute never signs when autoSubscriptionEnabled is false', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await router.selectRoute(
          req('levanto-auto'), [peer('0xAAA')], null,
          { ...enabledPreferences(), autoSubscriptionEnabled: false },
        );

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
        expect(result).not.toBeNull(); // routing itself is unaffected, only signing is gated
      });

      it('selectRoute never signs when routingPreferences is null (no consent ever seen -- must not default to "yes")', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('triggerDailySigningCheck never signs when autoSubscriptionEnabled is false', async () => {
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded });
        router.updateRoutingPreferences({ ...enabledPreferences(), autoSubscriptionEnabled: false });

        await router.triggerDailySigningCheck();

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('triggerDailySigningCheck never signs before any preferences have been pushed at all', async () => {
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded });

        await router.triggerDailySigningCheck();

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('turning the toggle on via updateRoutingPreferences unblocks signing for a subsequent background trigger', async () => {
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded });

        router.updateRoutingPreferences({ ...enabledPreferences(), autoSubscriptionEnabled: false });
        await router.triggerDailySigningCheck();
        expect(signDailyIfNeeded).not.toHaveBeenCalled();

        router.updateRoutingPreferences({ ...enabledPreferences(), autoSubscriptionEnabled: true });
        await router.triggerDailySigningCheck();
        expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
        expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
      });
    });

    it('triggerDailySigningCheck does nothing when signDailyIfNeeded is not configured', async () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      await expect(router.triggerDailySigningCheck()).resolves.toBeUndefined();
    });
  });

  describe('daily digest (decisions doc SS2.7/SS6.9)', () => {
    function digestAwareFetch(routeHandler: () => unknown) {
      return vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) {
          return { ok: true, json: async () => routeHandler() };
        }
        return { ok: true, json: async () => ({ accepted: true }) };
      });
    }

    it('sends a digest as its own request, once per calendar day, alongside signing', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req('levanto-auto', 'first'), [peer('0xAAA')], conversation('a'), null);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // one digest submission, one routing call

      await router.selectRoute(req('levanto-auto', 'second'), [peer('0xAAA')], conversation('b'), null);
      expect(fetchImpl).toHaveBeenCalledTimes(3); // no repeat digest send same day
    });

    it('sends the digest to the explicit /_antseed/route/digest suffix path, not the routing path (decisions doc SS13 item 20)', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], conversation('a'), null);

      const calledUrls = fetchImpl.mock.calls.map((call: unknown[]) => call[0]);
      expect(calledUrls).toContain('http://x/_antseed/route'); // the routing call
      expect(calledUrls).toContain('http://x/_antseed/route/digest'); // the digest, at its own path
    });

    it('does not send a digest when there is no sellerPeerId to send it to', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // routing call only
    });

    it('a failed digest send never blocks or fails the routing call itself', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) return { ok: true, json: async () => rankedResponse() };
        throw new Error('digest endpoint unreachable');
      });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const result = await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      expect(result).not.toBeNull();
      expect(result?.[0]?.serviceId).toBe('gpt-5.6-luna');
    });

    it('retries the digest send on a later call if the earlier attempt failed', async () => {
      let digestCalls = 0;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) return { ok: true, json: async () => rankedResponse() };
        digestCalls += 1;
        if (digestCalls === 1) throw new Error('digest endpoint unreachable');
        return { ok: true, json: async () => ({ accepted: true }) };
      });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await router.selectRoute(req('levanto-auto', 'first'), [peer('0xAAA')], conversation('a'), null);
      await router.selectRoute(req('levanto-auto', 'second'), [peer('0xAAA')], conversation('b'), null);
      expect(digestCalls).toBe(2); // first attempt failed, second call retried it
    });
  });

  describe('routing_decisions ledger (software-architecture doc SS2.5)', () => {
    it('writes a row once onResult reports the resolved decision, joining predicted and actual', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
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
        requestId: 'r1', // matches req()'s fixed requestId
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

    it('populates baselinePrices from the curated model list, collapsed across peers to the cheapest input price (decisions doc SS13 item 10)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
            // Two sellers of a curated baseline model -- the cheaper one (0xCCC) should win.
            { model: 'claude-opus-5', peer: '0xBBB', estimate: { costUsd: 0.02, inputTokens: 100, cachedInputTokens: 0, outputTokens: 45 },
              price: { inUsdPerM: 16, outUsdPerM: 80, cachedInUsdPerM: 1.6 } },
            { model: 'claude-opus-5', peer: '0xCCC', estimate: { costUsd: 0.018, inputTokens: 100, cachedInputTokens: 0, outputTokens: 45 },
              price: { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 0 } },
            // gpt-5.6-sol (the other curated model) is NOT offered at all this call.
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      await router.selectRoute(req('levanto-auto'), [peer('0xAAA'), peer('0xBBB'), peer('0xCCC')], null, null);
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 10, tokens: 10, requestId: 'r1' });

      const row = router.getLedgerRows()[0];
      expect(row?.baselinePrices).toEqual({
        'claude-opus-5': { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: null }, // 0xCCC wins (cheaper), 0 -> null
      });
      expect(row?.baselinePrices['gpt-5.6-sol']).toBeUndefined(); // never offered -- absent, not fabricated
    });

    it('does not write a row for a failed dispatch', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req('levanto-auto'), [peer('0xAAA')], null, null);
      router.onResult(peer('0xAAA'), { success: false, latencyMs: 100, tokens: 0 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('does not write a row for an onResult carrying no requestId at all (nothing to correlate against)', () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      router.onResult(peer('0xUNRELATED'), { success: true, latencyMs: 10, tokens: 5 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('does not write a row for an onResult whose requestId matches no pending decision', () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 10, tokens: 5, requestId: 'never-routed' });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('correctly pairs two concurrent requests to the same peer by requestId, not peer alone (decisions doc SS13 item 13)', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => ({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: JSON.parse(init.body).inputMessage === 'first' ? 0.001 : 0.002, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      }));
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      // Two different conversations, both routed to peer 0xAAA, before either resolves.
      const reqA: SerializedHttpRequest = { ...req('levanto-auto', 'first'), requestId: 'req-A' };
      const reqB: SerializedHttpRequest = { ...req('levanto-auto', 'second'), requestId: 'req-B' };
      await router.selectRoute(reqA, [peer('0xAAA')], conversation('conv-a'), null);
      await router.selectRoute(reqB, [peer('0xAAA')], conversation('conv-b'), null);

      // Resolve out of order: B's real outcome arrives before A's.
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 50, tokens: 10, estimatedCostUsd: 0.0025, requestId: 'req-B' });
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 40, tokens: 10, estimatedCostUsd: 0.0015, requestId: 'req-A' });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(2);
      const rowA = rows.find((r) => r.actualUsdcPaid === 0.0015);
      const rowB = rows.find((r) => r.actualUsdcPaid === 0.0025);
      // Each result must be paired with ITS OWN request's predicted cost, not the other's.
      expect(rowA?.predictedCostUsd).toBe(0.001);
      expect(rowB?.predictedCostUsd).toBe(0.002);
    });

    it('writes its own row for a pinned tool-loop continuation, reusing the real decision it was pinned to (decisions doc SS13 item 14)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const conv = conversation('sess-1');

      // Real decision: a genuine new user message, network call fires.
      const realReq: SerializedHttpRequest = { ...req('levanto-auto', 'hello'), requestId: 'req-real' };
      await router.selectRoute(realReq, [peer('0xAAA')], conv, null);
      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 250, tokens: 140,
        freshInputTokens: 90, cachedInputTokens: 18, outputTokens: 42, estimatedCostUsd: 0.0011,
        requestId: 'req-real',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Tool-loop continuation: same last user message, no new network call,
      // but a real dispatch with its own requestId and its own eventual outcome.
      const pinnedReq: SerializedHttpRequest = { ...req('levanto-auto', 'hello'), requestId: 'req-pinned' };
      const candidates = await router.selectRoute(pinnedReq, [peer('0xAAA')], conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still no new network call
      expect(candidates).toHaveLength(1);

      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 5, tokens: 30,
        freshInputTokens: 0, cachedInputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.0003,
        requestId: 'req-pinned',
      });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(2);
      const pinnedRow = rows.find((r) => r.actualUsdcPaid === 0.0003);
      expect(pinnedRow).toBeDefined();
      // Reuses the real decision's predicted fields (same model/cost/cqt prediction)...
      expect(pinnedRow?.actualModel).toBe('gpt-5.6-luna');
      expect(pinnedRow?.predictedCostUsd).toBe(0.0012);
      expect(pinnedRow?.predictedInputTokens).toBe(100);
      expect(pinnedRow?.cqt).toBe(5);
      // ...but records its OWN actual outcome, and null latency (gate skipped the call).
      expect(pinnedRow?.actualUsdcPaid).toBe(0.0003);
      expect(pinnedRow?.routingLatencyMs).toBeNull();
    });
  });

  describe('allowedPeerIds re-filter (decisions doc SS4.4)', () => {
    it('keeps only ranked candidates inside the allowlist', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
            { model: 'kimi-k3', peer: '0xBBB', estimate: { costUsd: 0.0005, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
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

    it('falls back to the allowed peers directly, paired with defaultRoutedModel, when the walk exhausts the ranked list', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      // 0xCCC is allowed but never appeared in the ranked list.
      const peers = [peer('0xAAA'), peer('0xCCC')];

      const result = await router.selectRoute(req('levanto-auto'), peers, null, { allowedPeerIds: ['0xCCC'] }, 'gpt-4o');

      expect(result).toHaveLength(1);
      expect(result?.[0]?.peerId).toBe('0xCCC');
      expect(result?.[0]?.serviceId).toBe('gpt-4o'); // defaultRoutedModel, the buyer's own fallback target
      expect(result?.[0]?.inputUsdPerMillion).toBeNull(); // no real price data for this synthesized pair
    });

    it('gives up (null) when the walk exhausts the ranked list and no defaultRoutedModel is set', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xCCC')];

      // No 5th arg -- no default route configured for this buyer.
      const result = await router.selectRoute(req('levanto-auto'), peers, null, { allowedPeerIds: ['0xCCC'] });

      expect(result).toBeNull();
    });
  });
});
