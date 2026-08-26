import { describe, expect, it, vi } from 'vitest';
import { ModelHealthChecker, supportsHealthProbe } from './model-health-checker.js';
import type { Provider } from '../interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';

function makeProvider(overrides: Partial<Provider> & { handleRequest: Provider['handleRequest'] }): Provider {
  return {
    name: 'test-provider',
    services: ['antseed-subscription'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 10,
    getCapacity: () => ({ current: 0, max: 10 }),
    ...overrides,
  };
}

describe('supportsHealthProbe', () => {
  it('excludes antseed-subscription, same as openai-images', () => {
    expect(supportsHealthProbe('antseed-subscription')).toBe(false);
    expect(supportsHealthProbe('openai-images')).toBe(false);
    expect(supportsHealthProbe('openai-chat-completions')).toBe(true);
  });
});

describe('ModelHealthChecker with an antseed-subscription service', () => {
  it('never probes it and never removes it, even after many sweeps', async () => {
    const handleRequest = vi.fn(async (): Promise<SerializedHttpResponse> => {
      throw new Error('should never be called for a subscription pseudo-service');
    });
    const provider = makeProvider({
      services: ['antseed-subscription'],
      serviceApiProtocols: { 'antseed-subscription': ['antseed-subscription'] },
      handleRequest,
    });
    const onChange = vi.fn();
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
      onChange,
    });

    for (let i = 0; i < 5; i += 1) {
      await checker.runSweep();
    }

    expect(handleRequest).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(provider.services).toEqual(['antseed-subscription']);

    const snapshot = checker.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.advertised).toBe(true);
    expect(snapshot[0]?.lastDetail).toMatch(/Skipped health probe/);
  });

  it('still probes and can remove an ordinary text service on the same provider', async () => {
    const handleRequest = vi.fn(async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => ({
      requestId: req.requestId,
      statusCode: 500,
      headers: {},
      body: new Uint8Array(),
    }));
    const provider = makeProvider({
      services: ['antseed-subscription', 'real-model'],
      serviceApiProtocols: {
        'antseed-subscription': ['antseed-subscription'],
        'real-model': ['openai-chat-completions'],
      },
      handleRequest,
    });
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
    });

    await checker.runSweep();

    // Only the real model was probed -- the subscription pseudo-service never hit handleRequest.
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(provider.services).toEqual(['antseed-subscription']);
  });
});
