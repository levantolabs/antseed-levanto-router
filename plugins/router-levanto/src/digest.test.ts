import { describe, expect, it } from 'vitest';
import { buildDigest, periodKey } from './digest.js';
import type { RoutingDecisionRow } from './ledger.js';

function row(overrides: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    atMs: Date.now(),
    actualModel: 'gpt-5.6-luna',
    actualPeer: '0xAAA',
    actualPromptTokens: 100,
    actualCachedTokens: 20,
    actualCompletionTokens: 40,
    actualUsdcPaid: 0.001,
    predictedCostUsd: 0.0011,
    predictedInputTokens: 90,
    predictedCachedInputTokens: 18,
    predictedOutputTokens: 42,
    cqt: 5,
    routingLatencyMs: 100,
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('aggregates predicted/observed sums, modelMix, and cqtDistribution across a day\'s rows', () => {
    const period = periodKey();
    const rows = [
      row({ actualModel: 'gpt-5.6-luna', cqt: 5, actualUsdcPaid: 0.001, predictedCostUsd: 0.0011 }),
      row({ actualModel: 'gpt-5.6-luna', cqt: 5, actualUsdcPaid: 0.002, predictedCostUsd: 0.0019 }),
      row({ actualModel: 'kimi-k3', cqt: 3, actualUsdcPaid: 0.0005, predictedCostUsd: 0.0006 }),
    ];
    const digest = buildDigest(rows, period);

    expect(digest.period).toBe(period);
    expect(digest.routedRequests).toBe(3);
    expect(digest.predictedCostUsd).toBeCloseTo(0.0011 + 0.0019 + 0.0006, 6);
    expect(digest.observedCostUsd).toBeCloseTo(0.001 + 0.002 + 0.0005, 6);
    expect(digest.modelMix).toEqual({ 'gpt-5.6-luna': 2, 'kimi-k3': 1 });
    expect(digest.cqtDistribution).toEqual({ 5: 2, 3: 1 });
  });

  it('splits fresh vs cached observed tokens from the combined actualPromptTokens field', () => {
    const period = periodKey();
    const rows = [row({ actualPromptTokens: 100, actualCachedTokens: 20, actualCompletionTokens: 40 })];
    const digest = buildDigest(rows, period);
    expect(digest.observedInputTokens).toBe(80); // 100 - 20
    expect(digest.observedCachedInputTokens).toBe(20);
    expect(digest.observedOutputTokens).toBe(40);
  });

  it('averages routingLatencyMs only across rows where it is non-null', () => {
    const period = periodKey();
    const rows = [row({ routingLatencyMs: 100 }), row({ routingLatencyMs: 200 }), row({ routingLatencyMs: null })];
    const digest = buildDigest(rows, period);
    expect(digest.avgRoutingLatencyMs).toBe(150);
  });

  it('returns null avgRoutingLatencyMs and zero routedRequests for an empty day', () => {
    const digest = buildDigest([], periodKey());
    expect(digest.routedRequests).toBe(0);
    expect(digest.avgRoutingLatencyMs).toBeNull();
    expect(digest.predictedCostUsd).toBe(0);
    expect(digest.modelMix).toEqual({});
  });

  it('excludes rows outside the requested period', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = [row({ atMs: yesterday.getTime() })];
    const digest = buildDigest(rows, periodKey()); // today's period, row is from yesterday
    expect(digest.routedRequests).toBe(0);
  });

  it('failovers/timeouts default to 0 (no signal source yet)', () => {
    const digest = buildDigest([row()], periodKey());
    expect(digest.failovers).toBe(0);
    expect(digest.timeouts).toBe(0);
  });
});
