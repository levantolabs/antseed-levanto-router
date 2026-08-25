import { describe, expect, it } from 'vitest';
import { buildChatMetaParts, normalizeAssistantMeta } from './chat-shared.js';
import type { ChatMessage } from './chat-shared.js';

function assistantMessage(meta: Record<string, unknown>): ChatMessage {
  return { role: 'assistant', content: 'hi', createdAt: 0, meta };
}

describe('model disclosure (decisions doc SS8.3, software-arch doc SS4.6)', () => {
  it('shows which model actually answered when the response carries a service field', () => {
    const parts = buildChatMetaParts(assistantMessage({ provider: 'openai', service: 'gpt-5.6-luna' }));
    expect(parts).toContain('via gpt-5.6-luna');
  });

  it('omits the disclosure line when no service is present (e.g. before this feature\'s header fix)', () => {
    const parts = buildChatMetaParts(assistantMessage({ peerId: '0xAAAAAAAA' }));
    expect(parts.some((p) => p.startsWith('via '))).toBe(false);
  });

  it('normalizeAssistantMeta reads provider/service from meta (already-existing shape, now populated on the streaming path too)', () => {
    const meta = normalizeAssistantMeta(assistantMessage({ provider: 'openai', service: 'gpt-5.6-luna' }));
    expect(meta?.provider).toBe('openai');
    expect(meta?.service).toBe('gpt-5.6-luna');
  });
});
