import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import { attachStreamingAntseedHeaders } from './telemetry.js'

function peer(providers: string[]): PeerInfo {
  return { peerId: '0xAAA', providers } as PeerInfo
}

function req(model: string): SerializedHttpRequest {
  return {
    requestId: 'r1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model, messages: [] })),
  }
}

test('attachStreamingAntseedHeaders attaches provider and service, matching the non-streaming path (model-routing decisions doc SS8.3)', () => {
  const headers = attachStreamingAntseedHeaders({}, peer(['openai']), 'req-1', req('gpt-5.6-luna'))
  assert.equal(headers['x-antseed-provider'], 'openai')
  assert.equal(headers['x-antseed-service'], 'gpt-5.6-luna')
})

test('attachStreamingAntseedHeaders reports the resolved model, not the levanto-auto sentinel, for a routed request', () => {
  // The caller passes the already-substituted request (withRoutedModel), not
  // the original "levanto-auto" sentinel -- this test locks that in.
  const headers = attachStreamingAntseedHeaders({}, peer(['openai']), 'req-1', req('gpt-5.6-luna'))
  assert.notEqual(headers['x-antseed-service'], 'levanto-auto')
})

test('attachStreamingAntseedHeaders still attaches peer identity and request id headers as before', () => {
  const headers = attachStreamingAntseedHeaders({}, peer(['openai']), 'req-1', req('gpt-5.6-luna'))
  assert.equal(headers['x-antseed-request-id'], 'req-1')
  assert.equal(headers['x-antseed-peer-id'], '0xAAA')
})

test('attachStreamingAntseedHeaders JSON-encodes route alternatives when provided', () => {
  const alternatives = [
    { peerId: '0xAAA', service: 'gpt-5.6-luna', inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    { peerId: '0xBBB', service: 'kimi-k3', inputUsdPerMillion: 0.5, outputUsdPerMillion: 1 },
  ]
  const headers = attachStreamingAntseedHeaders({}, peer(['openai']), 'req-1', req('gpt-5.6-luna'), alternatives)
  assert.deepEqual(JSON.parse(headers['x-antseed-route-alternatives'] ?? '[]'), alternatives)
})

test('attachStreamingAntseedHeaders omits the alternatives header when there are none (a pinned/direct request)', () => {
  const headers = attachStreamingAntseedHeaders({}, peer(['openai']), 'req-1', req('gpt-5.6-luna'), null)
  assert.equal('x-antseed-route-alternatives' in headers, false)
})
