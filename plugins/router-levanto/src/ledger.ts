import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * routing_decisions local ledger (software-architecture doc SS2.5). Feeds
 * the savings dashboard (VPR UI, task #10) -- not a billing record; the
 * real settlement is governed entirely by the signed SpendingAuth.
 *
 * `RoutingDecisionRow` itself now lives in packages/node (`Router.getRoutingDecisions`'s
 * return type) rather than being defined here twice -- the host reads a
 * router's ledger through that generic optional method, so the row shape has
 * to be something packages/node can name without depending on this plugin.
 * baselinePrices (SS2.5, decisions doc SS13 item 10, resolved) is populated
 * from a hardcoded curated model list (see DEFAULT_BASELINE_MODELS in
 * router.ts) -- ahead of the SS8.4 dropdown UI, since the response data
 * needed to fill it already arrives on every /_antseed/route call regardless
 * of whether that UI exists yet.
 */
import type { RoutingDecisionRow } from '@antseed/node';
export type { RoutingDecisionRow } from '@antseed/node';

type BaselinePrices = RoutingDecisionRow['baselinePrices'];

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
  baselinePrices: BaselinePrices;
}

/** File name within the plugin's data directory -- one JSON row per line, append-only. */
export const ROUTING_DECISIONS_FILE = 'routing-decisions.jsonl';

/**
 * Flat cap on in-flight pending decisions retained at once -- oldest is
 * evicted first. A pending entry is normally removed by its matching
 * recordResult, but a request that never resolves (every peer attempt
 * fails, or an older caller's result omits requestId) would otherwise sit
 * in the map forever; this bounds that growth the same way
 * BuyerProxy._trackRequestConversation bounds _requestConversations.
 */
const MAX_PENDING_DECISIONS = 500;

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeBaselinePrices(value: unknown): BaselinePrices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: BaselinePrices = {};
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.inUsdPerM !== 'number' || typeof e.outUsdPerM !== 'number') continue;
    out[model] = { inUsdPerM: e.inUsdPerM, outUsdPerM: e.outUsdPerM, cachedInUsdPerM: numOrNull(e.cachedInUsdPerM) };
  }
  return out;
}

/** Reload-time validation, same spirit as ConversationStore's sanitizeRecord (apps/cli/src/proxy/conversation-store.ts) -- a corrupt or partially-written line is skipped, not fatal. */
function sanitizeRow(value: unknown): RoutingDecisionRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.actualModel !== 'string' || typeof r.actualPeer !== 'string') return null;
  return {
    atMs: num(r.atMs, Date.now()),
    actualModel: r.actualModel,
    actualPeer: r.actualPeer,
    actualPromptTokens: num(r.actualPromptTokens),
    actualCachedTokens: num(r.actualCachedTokens),
    actualCompletionTokens: num(r.actualCompletionTokens),
    actualUsdcPaid: num(r.actualUsdcPaid),
    predictedCostUsd: numOrNull(r.predictedCostUsd),
    predictedInputTokens: numOrNull(r.predictedInputTokens),
    predictedCachedInputTokens: numOrNull(r.predictedCachedInputTokens),
    predictedOutputTokens: numOrNull(r.predictedOutputTokens),
    cqt: num(r.cqt, 5),
    routingLatencyMs: numOrNull(r.routingLatencyMs),
    baselinePrices: sanitizeBaselinePrices(r.baselinePrices),
  };
}

/**
 * Loads whatever rows a prior process already persisted, synchronously, so a
 * freshly-constructed router's ledger is complete before selectRoute can run
 * (matching ConversationStore's `_loadSync` pattern -- apps/cli/src/proxy/conversation-store.ts).
 * Missing file (first run) or corrupt lines are tolerated, not fatal.
 */
function loadSync(filePath: string): RoutingDecisionRow[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return []; // first run -- no file yet
  }
  const rows: RoutingDecisionRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = sanitizeRow(JSON.parse(trimmed));
      if (row) rows.push(row);
    } catch {
      // Corrupt/partially-written line (e.g. a crash mid-append) -- skip it,
      // don't lose every row that came before or after it.
    }
  }
  return rows;
}

/**
 * routing_decisions ledger (decisions doc SS13 item 12, resolved). Persists
 * as an append-only JSON-lines file in the router's data directory when
 * `dataDir` is provided -- one line per resolved decision, mirroring the
 * write-log shape naturally (a ledger is added to, never rewritten in
 * place), unlike ConversationStore's whole-file rewrite (right for a small,
 * bounded, frequently-mutated set of records; wrong for an ever-growing
 * append-only log where rewriting everything on every new row would get
 * slower over time for no benefit). Falls back to in-memory-only when
 * `dataDir` is omitted, same as before this pass -- existing callers that
 * don't need durability are unaffected.
 *
 * No retention/pruning policy yet -- the file grows indefinitely. Not
 * addressed here: no decided retention window exists for this ledger
 * (unlike e.g. the digest's daily cadence), so inventing one would be
 * guessing rather than implementing a decision; logged in the runlog as an
 * open question for whoever builds the savings dashboard against this data.
 */
export class RoutingLedger {
  private readonly rows: RoutingDecisionRow[];
  // Keyed by the originating client request's requestId (decisions doc SS13
  // item 13, resolved) -- Router.onResult now carries the same requestId
  // selectRoute originally saw, so two concurrent requests routed to the
  // same peer can no longer mis-pair the way peerId-only keying used to.
  private readonly pendingByRequestId = new Map<string, PendingDecision>();
  private readonly filePath: string | null;
  private readonly dataDir: string | null;
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? null;
    this.filePath = dataDir ? join(dataDir, ROUTING_DECISIONS_FILE) : null;
    this.rows = this.filePath ? loadSync(this.filePath) : [];
  }

  recordPending(requestId: string, pending: PendingDecision): void {
    this.pendingByRequestId.set(requestId, pending);
    while (this.pendingByRequestId.size > MAX_PENDING_DECISIONS) {
      const oldestKey = this.pendingByRequestId.keys().next().value;
      if (oldestKey === undefined) break;
      this.pendingByRequestId.delete(oldestKey);
    }
  }

  recordResult(
    requestId: string,
    peerId: string,
    actual: { promptTokens: number; cachedTokens: number; completionTokens: number; usdcPaid: number },
    now = Date.now(),
  ): RoutingDecisionRow | null {
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending) return null;
    this.pendingByRequestId.delete(requestId);

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
      baselinePrices: pending.baselinePrices,
    };
    this.rows.push(row);
    this._persist(row);
    return row;
  }

  all(): readonly RoutingDecisionRow[] {
    return this.rows;
  }

  /**
   * Fire-and-forget append, serialized behind a queue so concurrent
   * recordResult calls never interleave writes (mirrors ConversationStore's
   * `_persist`/`_writeQueue`). A write failure never surfaces to the caller
   * -- recordResult is called synchronously from Router.onResult, which
   * can't safely become async or throw without risking the buyer's actual
   * chat response path; a lost ledger row is a savings-dashboard gap, not a
   * billing error (the real settlement is governed by the signed
   * SpendingAuth, unaffected by this ledger either way).
   */
  private _persist(row: RoutingDecisionRow): void {
    if (!this.filePath || !this.dataDir) return;
    const dir = this.dataDir;
    const path = this.filePath;
    const line = `${JSON.stringify(row)}\n`;
    this._writeQueue = this._writeQueue.then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(path, line, 'utf8');
    }).catch(() => { /* keep the queue alive after a failed write */ });
  }

  /** Wait for pending writes (tests / shutdown). */
  flush(): Promise<void> {
    return this._writeQueue;
  }

  /** Test/debug helper -- reads the persisted file directly, bypassing in-memory state. */
  static async readPersistedForTest(dataDir: string): Promise<RoutingDecisionRow[]> {
    let raw: string;
    try {
      raw = await readFile(join(dataDir, ROUTING_DECISIONS_FILE), 'utf8');
    } catch {
      return [];
    }
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as RoutingDecisionRow);
  }
}
