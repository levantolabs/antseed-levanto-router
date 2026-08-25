import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RoutingDecisionRow } from '@antseed/node';
import { computeRouterSavings } from './router-savings.js';
import type { OpenRouterReferenceMap } from '../catalog/openrouter-baseline.js';
import { canonicalModelKey } from '../catalog/model-identity.js';

function row(overrides: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    atMs: Date.now(),
    actualModel: 'kimi-k3',
    actualPeer: '0xAAA',
    actualPromptTokens: 1000,
    actualCachedTokens: 0,
    actualCompletionTokens: 200,
    actualUsdcPaid: 0.0005,
    predictedCostUsd: 0.0005,
    predictedInputTokens: 1000,
    predictedCachedInputTokens: 0,
    predictedOutputTokens: 200,
    cqt: 5,
    routingLatencyMs: 50,
    ...overrides,
  };
}

const REFERENCE_MAP: OpenRouterReferenceMap = {
  [canonicalModelKey('kimi-k3')]: { input: 5, output: 20, cachedInput: null },
};

test('returns null with no rows', () => {
  assert.equal(computeRouterSavings([], REFERENCE_MAP), null);
});

test('returns null with no reference map', () => {
  assert.equal(computeRouterSavings([row()], null), null);
});

test('computes real savings for a routed model with a retail match', () => {
  const result = computeRouterSavings([row()], REFERENCE_MAP);
  assert.ok(result);
  // baseline: 1000*5/1e6 + 200*20/1e6 = 0.005 + 0.004 = 0.009
  assert.ok(Math.abs(result!.baselineUsd - 0.009) < 1e-9);
  assert.equal(result!.actualUsd, 0.0005);
  assert.equal(result!.matchedServices, 1);
  assert.ok(result!.pct > 90); // paid far below retail
});

test('excludes rows whose model has no retail match', () => {
  const result = computeRouterSavings([row({ actualModel: 'unknown-model-xyz' })], REFERENCE_MAP);
  assert.equal(result, null);
});

test('splits fresh vs cached tokens from the combined actualPromptTokens field', () => {
  const cachedMap: OpenRouterReferenceMap = {
    [canonicalModelKey('kimi-k3')]: { input: 10, output: 0, cachedInput: 1 },
  };
  const result = computeRouterSavings(
    [row({ actualPromptTokens: 1000, actualCachedTokens: 400, actualCompletionTokens: 0 })],
    cachedMap,
  );
  // fresh 600 * 10/1e6 + cached 400 * 1/1e6 = 0.006 + 0.0004 = 0.0064
  assert.ok(result);
  assert.ok(Math.abs(result!.baselineUsd - 0.0064) < 1e-9);
});

test('counts distinct matched models, not rows', () => {
  const result = computeRouterSavings([row(), row(), row({ actualModel: 'kimi-k3' })], REFERENCE_MAP);
  assert.ok(result);
  assert.equal(result!.matchedServices, 1);
});

test('clamps a paid-above-retail scenario to 0%, never negative', () => {
  const result = computeRouterSavings(
    [row({ actualUsdcPaid: 1 })], // way above the 0.009 baseline
    REFERENCE_MAP,
  );
  assert.ok(result);
  assert.equal(result!.pct, 0);
});
