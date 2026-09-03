import { describe, expect, it, vi } from 'vitest';
import { ModelHealthChecker, supportsHealthProbe } from './model-health-checker.js';
import type { Provider } from '../interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';

function makeProvider(overrides: Partial<Provider> & { handleRequest: Provider['handleRequest'] }): Provider {
  return {
    name: 'test-provider',
    services: ['antseed-day-pass'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 10,
    getCapacity: () => ({ current: 0, max: 10 }),
    ...overrides,
  };
}

describe('supportsHealthProbe', () => {
  it('excludes antseed-day-pass, same as openai-images', () => {
    expect(supportsHealthProbe('antseed-day-pass')).toBe(false);
    expect(supportsHealthProbe('openai-images')).toBe(false);
    expect(supportsHealthProbe('openai-chat-completions')).toBe(true);
  });
});

describe('ModelHealthChecker with an antseed-day-pass service', () => {
  it('never probes it and never removes it, even after many sweeps', async () => {
    const handleRequest = vi.fn(async (): Promise<SerializedHttpResponse> => {
      throw new Error('should never be called for a day-pass pseudo-service');
    });
    const provider = makeProvider({
      services: ['antseed-day-pass'],
      serviceApiProtocols: { 'antseed-day-pass': ['antseed-day-pass'] },
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
    expect(provider.services).toEqual(['antseed-day-pass']);

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
      services: ['antseed-day-pass', 'real-model'],
      serviceApiProtocols: {
        'antseed-day-pass': ['antseed-day-pass'],
        'real-model': ['openai-chat-completions'],
      },
      handleRequest,
    });
    const checker = new ModelHealthChecker({
      targets: [{ provider }],
      failureThreshold: 1,
    });

    await checker.runSweep();

    // Only the real model was probed -- the day-pass pseudo-service never hit handleRequest.
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(provider.services).toEqual(['antseed-day-pass']);
  });
});
