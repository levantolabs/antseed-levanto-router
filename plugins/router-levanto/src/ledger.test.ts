import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTING_DECISIONS_FILE, RoutingLedger } from './ledger.js';

function pending(overrides: Partial<{ model: string; predictedCostUsd: number | null; conversationKey: string | null }> = {}) {
  return {
    model: overrides.model ?? 'gpt-5.6-luna',
    predictedCostUsd: overrides.predictedCostUsd ?? 0.001,
    predictedInputTokens: 100,
    predictedCachedInputTokens: 10,
    predictedOutputTokens: 40,
    cqt: 5,
    routingLatencyMs: 12,
    atMs: Date.now(),
    baselinePrices: { 'claude-opus-5': { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 1.5 } },
    conversationKey: overrides.conversationKey ?? null,
  };
}

function actual(usdcPaid = 0.0009) {
  return { promptTokens: 100, cachedTokens: 10, completionTokens: 38, usdcPaid };
}

describe('RoutingLedger (decisions doc SS13 item 12)', () => {
  describe('without a dataDir', () => {
    it('stays in-memory only -- no crash, no file written', () => {
      const ledger = new RoutingLedger();
      ledger.recordPending('req-1', pending());
      const row = ledger.recordResult('req-1', '0xAAA', actual());
      expect(row).not.toBeNull();
      expect(ledger.all()).toHaveLength(1);
    });
  });

  describe('with a dataDir', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'routing-ledger-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('persists a recorded row to routing-decisions.jsonl on disk', async () => {
      const ledger = new RoutingLedger(dir);
      ledger.recordPending('req-1', pending());
      ledger.recordResult('req-1', '0xAAA', actual());
      await ledger.flush();

      const persisted = await RoutingLedger.readPersistedForTest(dir);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ actualModel: 'gpt-5.6-luna', actualPeer: '0xAAA', actualUsdcPaid: 0.0009 });
      expect(persisted[0]?.baselinePrices).toEqual({ 'claude-opus-5': { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 1.5 } });
    });

    it('a freshly-constructed ledger reloads rows a prior instance persisted (survives a process restart)', async () => {
      const first = new RoutingLedger(dir);
      first.recordPending('req-1', pending({ model: 'kimi-k3' }));
      first.recordResult('req-1', '0xAAA', actual(0.0005));
      await first.flush();

      const second = new RoutingLedger(dir);
      expect(second.all()).toHaveLength(1);
      expect(second.all()[0]).toMatchObject({ actualModel: 'kimi-k3', actualUsdcPaid: 0.0005 });
    });

    it('accumulates multiple rows across separate recordResult calls, each appended not rewritten', async () => {
      const ledger = new RoutingLedger(dir);
      ledger.recordPending('req-1', pending());
      ledger.recordResult('req-1', '0xAAA', actual(0.001));
      ledger.recordPending('req-2', pending());
      ledger.recordResult('req-2', '0xBBB', actual(0.002));
      await ledger.flush();

      const persisted = await RoutingLedger.readPersistedForTest(dir);
      expect(persisted).toHaveLength(2);
      expect(persisted.map((r) => r.actualUsdcPaid)).toEqual([0.001, 0.002]);

      const reloaded = new RoutingLedger(dir);
      expect(reloaded.all()).toHaveLength(2);
    });

    it('tolerates a corrupt line on reload, keeping the well-formed rows around it', async () => {
      const ledger = new RoutingLedger(dir);
      ledger.recordPending('req-1', pending());
      ledger.recordResult('req-1', '0xAAA', actual(0.001));
      await ledger.flush();

      // Simulate a crash mid-append: a trailing corrupt line, plus one more good row after it.
      const filePath = join(dir, ROUTING_DECISIONS_FILE);
      writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{not valid json\n${JSON.stringify({
        atMs: Date.now(), actualModel: 'kimi-k3', actualPeer: '0xCCC', actualPromptTokens: 1, actualCachedTokens: 0,
        actualCompletionTokens: 1, actualUsdcPaid: 0.0001, predictedCostUsd: null, predictedInputTokens: null,
        predictedCachedInputTokens: null, predictedOutputTokens: null, cqt: 5, routingLatencyMs: null,
      })}\n`);

      const reloaded = new RoutingLedger(dir);
      expect(reloaded.all()).toHaveLength(2);
      expect(reloaded.all().map((r) => r.actualPeer)).toEqual(['0xAAA', '0xCCC']);
    });

    it('reloads cleanly when no file exists yet (first run)', () => {
      const ledger = new RoutingLedger(dir);
      expect(ledger.all()).toHaveLength(0);
    });
  });

  describe('conversationKey', () => {
    it('carries the pending decision\'s conversationKey through to the persisted row', () => {
      const ledger = new RoutingLedger();
      ledger.recordPending('req-1', pending({ conversationKey: 'conv-abc' }));
      const row = ledger.recordResult('req-1', '0xAAA', actual());
      expect(row?.conversationKey).toBe('conv-abc');
    });

    it('defaults to null when no ConversationIdentity was available', () => {
      const ledger = new RoutingLedger();
      ledger.recordPending('req-1', pending());
      const row = ledger.recordResult('req-1', '0xAAA', actual());
      expect(row?.conversationKey).toBeNull();
    });

    it('sanitizes a missing/malformed conversationKey on reload to null, not a crash', () => {
      const dir = mkdtempSync(join(tmpdir(), 'routing-ledger-conv-'));
      try {
        writeFileSync(join(dir, ROUTING_DECISIONS_FILE), `${JSON.stringify({
          atMs: Date.now(), actualModel: 'kimi-k3', actualPeer: '0xCCC', actualPromptTokens: 1, actualCachedTokens: 0,
          actualCompletionTokens: 1, actualUsdcPaid: 0.0001, predictedCostUsd: null, predictedInputTokens: null,
          predictedCachedInputTokens: null, predictedOutputTokens: null, cqt: 5, routingLatencyMs: null,
          conversationKey: 42,
        })}\n`);
        const ledger = new RoutingLedger(dir);
        expect(ledger.all()[0]?.conversationKey).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('MAX_LEDGER_ROWS cap', () => {
    it('evicts the oldest in-memory row once past the cap, keeping the most recent', () => {
      const ledger = new RoutingLedger();
      for (let i = 0; i < 5001; i += 1) {
        ledger.recordPending(`req-${i}`, pending());
        ledger.recordResult(`req-${i}`, '0xAAA', actual(i));
      }
      const rows = ledger.all();
      expect(rows).toHaveLength(5000);
      expect(rows[0]?.actualUsdcPaid).toBe(1); // row 0 (usdcPaid=0) evicted
      expect(rows[rows.length - 1]?.actualUsdcPaid).toBe(5000);
    });
  });
});
