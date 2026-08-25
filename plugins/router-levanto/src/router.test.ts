import { describe, expect, it, vi } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LevantoRouter } from './router.js';

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
});
