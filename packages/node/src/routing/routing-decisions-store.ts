import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../storage/migrate.js';
import { routingMigrations } from '../storage/migrations/routing/index.js';
import type { RoutingDecisionRow } from '../interfaces/buyer-router.js';

/**
 * SQLite-backed replacement for router-levanto's old hand-rolled
 * `routing-decisions.jsonl` (plugins/router-levanto/src/ledger.ts) -- that
 * file grew without rotation or compaction and required a full synchronous
 * read+parse of the entire file on every process start, so both on-disk size
 * and startup time scaled with total lifetime writes rather than the
 * intentional 5000-row retention window. This follows the exact same
 * pattern as `ChannelStore`/metering's storage class: its own SQLite file in
 * the caller's data directory, migrations run once at construction, cached
 * prepared statements.
 */
export const ROUTING_DECISIONS_DB_FILE = 'routing-decisions.db';

interface RoutingDecisionRecord {
  at_ms: number;
  actual_model: string;
  actual_peer: string;
  actual_prompt_tokens: number;
  actual_cached_tokens: number;
  actual_completion_tokens: number;
  actual_usdc_paid: number;
  predicted_cost_usd: number | null;
  predicted_input_tokens: number | null;
  predicted_cached_input_tokens: number | null;
  predicted_output_tokens: number | null;
  cqt: number;
  routing_latency_ms: number | null;
  baseline_prices: string;
  conversation_key: string | null;
  considered_candidates: string;
  input_message_preview: string | null;
}

function toRow(record: RoutingDecisionRecord): RoutingDecisionRow {
  return {
    atMs: record.at_ms,
    actualModel: record.actual_model,
    actualPeer: record.actual_peer,
    actualPromptTokens: record.actual_prompt_tokens,
    actualCachedTokens: record.actual_cached_tokens,
    actualCompletionTokens: record.actual_completion_tokens,
    actualUsdcPaid: record.actual_usdc_paid,
    predictedCostUsd: record.predicted_cost_usd,
    predictedInputTokens: record.predicted_input_tokens,
    predictedCachedInputTokens: record.predicted_cached_input_tokens,
    predictedOutputTokens: record.predicted_output_tokens,
    cqt: record.cqt,
    routingLatencyMs: record.routing_latency_ms,
    baselinePrices: JSON.parse(record.baseline_prices) as RoutingDecisionRow['baselinePrices'],
    conversationKey: record.conversation_key,
    consideredCandidates: JSON.parse(record.considered_candidates) as RoutingDecisionRow['consideredCandidates'],
    inputMessagePreview: record.input_message_preview,
  };
}

export class RoutingDecisionsStore {
  private readonly _db: Database.Database;
  private readonly _insertStmt: Database.Statement;
  private readonly _recentStmt: Database.Statement;
  private readonly _countStmt: Database.Statement;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this._db = new Database(join(dataDir, ROUTING_DECISIONS_DB_FILE));
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, routingMigrations);

    this._insertStmt = this._db.prepare(`
      INSERT INTO routing_decisions (
        at_ms, actual_model, actual_peer, actual_prompt_tokens, actual_cached_tokens,
        actual_completion_tokens, actual_usdc_paid, predicted_cost_usd, predicted_input_tokens,
        predicted_cached_input_tokens, predicted_output_tokens, cqt, routing_latency_ms,
        baseline_prices, conversation_key, considered_candidates, input_message_preview
      ) VALUES (
        @atMs, @actualModel, @actualPeer, @actualPromptTokens, @actualCachedTokens,
        @actualCompletionTokens, @actualUsdcPaid, @predictedCostUsd, @predictedInputTokens,
        @predictedCachedInputTokens, @predictedOutputTokens, @cqt, @routingLatencyMs,
        @baselinePrices, @conversationKey, @consideredCandidates, @inputMessagePreview
      )
    `);
    this._recentStmt = this._db.prepare('SELECT * FROM routing_decisions ORDER BY id DESC LIMIT ?');
    this._countStmt = this._db.prepare('SELECT COUNT(*) as c FROM routing_decisions');
  }

  insert(row: RoutingDecisionRow): void {
    this._insertStmt.run({
      atMs: row.atMs,
      actualModel: row.actualModel,
      actualPeer: row.actualPeer,
      actualPromptTokens: row.actualPromptTokens,
      actualCachedTokens: row.actualCachedTokens,
      actualCompletionTokens: row.actualCompletionTokens,
      actualUsdcPaid: row.actualUsdcPaid,
      predictedCostUsd: row.predictedCostUsd,
      predictedInputTokens: row.predictedInputTokens,
      predictedCachedInputTokens: row.predictedCachedInputTokens,
      predictedOutputTokens: row.predictedOutputTokens,
      cqt: row.cqt,
      routingLatencyMs: row.routingLatencyMs,
      baselinePrices: JSON.stringify(row.baselinePrices),
      conversationKey: row.conversationKey,
      consideredCandidates: JSON.stringify(row.consideredCandidates),
      inputMessagePreview: row.inputMessagePreview,
    });
  }

  /** Bulk-imports rows (e.g. a one-time migration from a legacy JSONL file) in a single transaction. */
  insertMany(rows: RoutingDecisionRow[]): void {
    const txn = this._db.transaction((batch: RoutingDecisionRow[]) => {
      for (const row of batch) this.insert(row);
    });
    txn(rows);
  }

  /** Most recent `limit` rows, oldest first -- matches the old in-memory ledger's row order. */
  recent(limit: number): RoutingDecisionRow[] {
    const records = this._recentStmt.all(limit) as RoutingDecisionRecord[];
    return records.reverse().map(toRow);
  }

  count(): number {
    return (this._countStmt.get() as { c: number }).c;
  }

  close(): void {
    this._db.close();
  }
}
