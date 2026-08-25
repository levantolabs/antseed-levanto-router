/**
 * routing_decisions local ledger (software-architecture doc SS2.5). Feeds
 * the savings dashboard (VPR UI, task #10) -- not a billing record; the
 * real settlement is governed entirely by the signed SpendingAuth.
 */
export type RoutingDecisionRow = {
  atMs: number;
  actualModel: string;
  actualPeer: string;
  actualPromptTokens: number;
  actualCachedTokens: number;
  actualCompletionTokens: number;
  actualUsdcPaid: number;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  // baselinePrices (SS2.5) needs the SS8.4 fixed dropdown list threaded in
  // from VPR config, which doesn't exist yet (task #10) -- omitted here,
  // not silently wrong: a savings dashboard reading this ledger before that
  // lands just has one fewer comparison tier available, not bad data.
};

/** The predicted half of a row, captured at selectRoute time -- consumed by the matching onResult. */
export interface PendingDecision {
  model: string;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  atMs: number;
}

/**
 * In-memory only in this pass -- no persistence (SQLite/file) yet. The row
 * shape and the onResult data flow are real and tested; durable storage is
 * a remaining piece, logged in the runlog rather than silently assumed done.
 */
export class RoutingLedger {
  private readonly rows: RoutingDecisionRow[] = [];
  // Keyed by peerId -- onResult doesn't carry a requestId or conversation
  // key, so a concurrent second request to the same peer before the first
  // resolves could mis-pair. Accepted limitation for this pass (buyer
  // traffic here is not meaningfully concurrent per peer in practice);
  // logged in the runlog rather than silently assumed correct.
  private readonly pendingByPeer = new Map<string, PendingDecision>();

  recordPending(peerId: string, pending: PendingDecision): void {
    this.pendingByPeer.set(peerId, pending);
  }

  recordResult(
    peerId: string,
    actual: { promptTokens: number; cachedTokens: number; completionTokens: number; usdcPaid: number },
    now = Date.now(),
  ): RoutingDecisionRow | null {
    const pending = this.pendingByPeer.get(peerId);
    if (!pending) return null;
    this.pendingByPeer.delete(peerId);

    const row: RoutingDecisionRow = {
      atMs: now,
      actualModel: pending.model,
      actualPeer: peerId,
      actualPromptTokens: actual.promptTokens,
      actualCachedTokens: actual.cachedTokens,
      actualCompletionTokens: actual.completionTokens,
      actualUsdcPaid: actual.usdcPaid,
      predictedCostUsd: pending.predictedCostUsd,
      predictedInputTokens: pending.predictedInputTokens,
      predictedCachedInputTokens: pending.predictedCachedInputTokens,
      predictedOutputTokens: pending.predictedOutputTokens,
      cqt: pending.cqt,
      routingLatencyMs: pending.routingLatencyMs,
    };
    this.rows.push(row);
    return row;
  }

  all(): readonly RoutingDecisionRow[] {
    return this.rows;
  }
}
