import assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeNewChatTarget } from './ChatListPanel';

const OPTION = { value: 'svc-1', peerId: 'peer-apex', id: 'apex-crypto-agent', provider: 'apex-omni' };

test('does not inherit a peer from an auto-routed active conversation', () => {
  const activeConversation = {
    peerId: 'peer-apex',
    service: 'apex-crypto-agent',
    provider: 'apex-omni',
    routeMode: 'auto',
  };
  const target = computeNewChatTarget(activeConversation, '', [OPTION], '', []);
  assert.equal(target, null);
});

test('inherits the peer from an explicitly pinned active conversation', () => {
  const activeConversation = {
    peerId: 'peer-apex',
    service: 'apex-crypto-agent',
    provider: 'apex-omni',
    routeMode: 'pinned',
  };
  const target = computeNewChatTarget(activeConversation, '', [OPTION], '', []);
  assert.deepEqual(target, { peerId: 'peer-apex', serviceValue: 'svc-1' });
});

test('returns null when there is no active conversation', () => {
  assert.equal(computeNewChatTarget(null, 'peer-apex', [OPTION], '', []), null);
});

test('returns null for a pinned conversation with no matching option or discover row', () => {
  const activeConversation = { peerId: 'peer-unknown', routeMode: 'pinned' };
  assert.equal(computeNewChatTarget(activeConversation, '', [OPTION], '', []), null);
});
