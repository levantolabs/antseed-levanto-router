import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeGeneratedConversationTitle } from './conversation-title.js';

test('sanitizeGeneratedConversationTitle accepts a real short title', () => {
  assert.equal(sanitizeGeneratedConversationTitle('Debugging the login flow'), 'Debugging the login flow');
});

test('sanitizeGeneratedConversationTitle strips code fences, quotes, and a leading "Title:" label', () => {
  assert.equal(
    sanitizeGeneratedConversationTitle('```text\nTitle: "Fix the retry loop"\n```'),
    'Fix the retry loop',
  );
});

test('sanitizeGeneratedConversationTitle rejects a seller persona intro instead of a title', () => {
  // Regression for a real live incident: a seller's model ignored the
  // "return only a 3-6 word title" system prompt and answered with its own
  // unrelated persona, which got truncated to 60 chars and silently used as
  // the conversation's title.
  const personaIntro = "Hello! I'm Apex Crypto Agent — an on-chain research and investigation analyst. "
    + 'I combine live blockchain data, smart-money intelligence, and forensic tools to answer questions '
    + 'that a plain LLM cannot.';
  assert.equal(sanitizeGeneratedConversationTitle(personaIntro), null);
});

test('sanitizeGeneratedConversationTitle rejects running prose with multiple sentences even if short enough to fit in 60 chars', () => {
  assert.equal(sanitizeGeneratedConversationTitle('Hi there. How are you today?'), null);
});

test('sanitizeGeneratedConversationTitle rejects a single long run-on sentence with no real sentence break', () => {
  assert.equal(
    sanitizeGeneratedConversationTitle(
      'This is a very long single sentence that goes on and on without any punctuation breaks in the middle at all',
    ),
    null,
  );
});

test('sanitizeGeneratedConversationTitle accepts a longer but still phrase-like title under the length/word caps', () => {
  assert.equal(
    sanitizeGeneratedConversationTitle('Refactoring the payment channel reserve logic'),
    'Refactoring the payment channel reserve logic',
  );
});

test('sanitizeGeneratedConversationTitle returns null for empty or whitespace-only input', () => {
  assert.equal(sanitizeGeneratedConversationTitle('   '), null);
  assert.equal(sanitizeGeneratedConversationTitle(undefined), null);
});
