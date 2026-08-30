import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoutingDecisionRow } from '@antseed/node';
import { defaultRouterSavingsBaselineModel } from '../../../modules/routing/router-savings';
import { ConversationRoutingHistory } from './ConversationRoutingHistory';

function row(overrides: Partial<RoutingDecisionRow> = {}): RoutingDecisionRow {
  return {
    atMs: 1_700_000_000_000,
    actualModel: 'kimi-k3',
    actualPeer: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    actualPromptTokens: 1000,
    actualCachedTokens: 0,
    actualCompletionTokens: 200,
    actualUsdcPaid: 0.0005,
    predictedCostUsd: 0.0005,
    predictedInputTokens: 1000,
    predictedCachedInputTokens: 0,
    predictedOutputTokens: 200,
    cqt: 5,
    routingLatencyMs: 120,
    baselinePrices: { [defaultRouterSavingsBaselineModel()]: { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 1.5 } },
    conversationKey: 'conv-1',
    ...overrides,
  };
}

test('renders nothing for an empty conversation', () => {
  const markup = renderToStaticMarkup(<ConversationRoutingHistory rows={[]} />);
  assert.equal(markup, '');
});

test('renders one row per turn, most recent first, with the model and shortened peer', () => {
  const markup = renderToStaticMarkup(<ConversationRoutingHistory rows={[
    row({ atMs: 1000, actualModel: 'gpt-5.6-luna' }),
    row({ atMs: 2000, actualModel: 'kimi-k3' }),
  ]} />);
  assert.match(markup, /2 routed turns in this chat/);
  assert.match(markup, /kimi-k3/);
  assert.match(markup, /gpt-5\.6-luna/);
  assert.match(markup, /0xAAAAAA</); // slice(0, 8) of the full peer id
  const firstRowIndex = markup.indexOf('kimi-k3');
  const secondRowIndex = markup.indexOf('gpt-5.6-luna');
  assert.ok(firstRowIndex < secondRowIndex, 'the more recent row (kimi-k3) should render before the older one');
});

test('shows the savings figure when baselinePrices match the reference model', () => {
  const markup = renderToStaticMarkup(<ConversationRoutingHistory rows={[row()]} />);
  assert.match(markup, /Saved .*vs retail/);
});

test('omits the savings figure when no row has a matching baseline price', () => {
  const markup = renderToStaticMarkup(<ConversationRoutingHistory rows={[row({ baselinePrices: {} })]} />);
  assert.doesNotMatch(markup, /vs retail/);
});
