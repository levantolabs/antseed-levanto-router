import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 1,
  name: 'create_routing_decisions_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        actual_model TEXT NOT NULL,
        actual_peer TEXT NOT NULL,
        actual_prompt_tokens INTEGER NOT NULL,
        actual_cached_tokens INTEGER NOT NULL,
        actual_completion_tokens INTEGER NOT NULL,
        actual_usdc_paid REAL NOT NULL,
        predicted_cost_usd REAL,
        predicted_input_tokens INTEGER,
        predicted_cached_input_tokens INTEGER,
        predicted_output_tokens INTEGER,
        cqt INTEGER NOT NULL,
        routing_latency_ms INTEGER,
        -- baseline_prices/considered_candidates are nested objects/arrays on
        -- RoutingDecisionRow -- no existing domain in this file has a JSON
        -- column precedent, so they're stored JSON-encoded the same way
        -- bigints elsewhere are stored as strings: a documented, deliberate
        -- choice, not an oversight.
        baseline_prices TEXT NOT NULL,
        conversation_key TEXT,
        considered_candidates TEXT NOT NULL,
        input_message_preview TEXT
      );

      -- Ordering/retention queries (most-recent-N) and the savings
      -- dashboard's per-session drill-down, respectively.
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_at_ms ON routing_decisions(at_ms);
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_conversation_key ON routing_decisions(conversation_key);
    `);
  },
};
