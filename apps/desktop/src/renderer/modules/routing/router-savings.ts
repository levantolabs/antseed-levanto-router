/**
 * "Router savings" (decisions doc SS4.5/SS4.6's three-tier diagram; software-
 * architecture doc SS2.5's ledger is the source). Scoped to requests the
 * routing-client actually decided (the `routing_decisions` ledger), not the
 * aggregate buyer usage `computeMeasuredSavings` already covers -- so this
 * line answers "how much did Auto-routing save you," distinct from "AntSeed
 * savings" (which every AntSeed user gets regardless of routing).
 *
 * Implements SS4.6's middle tier literally: actual paid vs. one fixed
 * reference model's real AntSeed price *at the time of each decision*
 * (`RoutingDecisionRow.baselinePrices`, decisions doc SS13 item 10, now
 * populated) -- not an approximation against today's retail price for each
 * row's own actual model, which is what this used to compute before
 * baselinePrices existed to read from (see the runlog for that prior stand-in
 * and why it was superseded, not just replaced silently).
 */
import type { RoutingDecisionRow } from '@antseed/node';
import type { MeasuredSavings } from '../catalog/measured-savings.js';
import { activeAutoRouterSavingsBaselineModel } from './levanto-auto.js';

/**
 * Default reference model for the SS8.4 savings-page dropdown -- "the most
 * expensive, most capable flagship... the top GPT or Claude model." No
 * dropdown UI exists yet to let a buyer pick a different one (SS8.4 is not
 * built), so callers get this default unless/until that UI exists to pass a
 * different `baselineModel` through. Sourced from the active router plugin's
 * own declared `savingsBaselineModel` (packages/node's AntseedRouterPlugin)
 * when one is active, falling back to Levanto's historical default
 * otherwise -- see `activeAutoRouterSavingsBaselineModel`.
 */
export function defaultRouterSavingsBaselineModel(): string {
  return activeAutoRouterSavingsBaselineModel();
}

export function computeRouterSavings(
  rows: readonly RoutingDecisionRow[] | undefined,
  baselineModel: string = defaultRouterSavingsBaselineModel(),
): MeasuredSavings | null {
  if (!rows || rows.length === 0) return null;

  let actualUsd = 0;
  let baselineUsd = 0;
  const seenModels = new Set<string>();

  for (const row of rows) {
    if (!row.actualModel) continue;
    const baseline = row.baselinePrices?.[baselineModel];
    // Absent, not zero -- the baseline model wasn't offered as a ranked
    // candidate at the moment of this specific decision, so there is no
    // real AntSeed price to compare against for this row.
    if (!baseline) continue;

    const freshInput = Math.max(0, row.actualPromptTokens - row.actualCachedTokens);
    const cached = row.actualCachedTokens;
    const output = row.actualCompletionTokens;
    if (freshInput === 0 && cached === 0 && output === 0) continue;

    const cachedPrice = baseline.cachedInUsdPerM ?? baseline.inUsdPerM;
    const rowBaseline = (freshInput * baseline.inUsdPerM + cached * cachedPrice + output * baseline.outUsdPerM) / 1_000_000;
    if (rowBaseline <= 0) continue;

    baselineUsd += rowBaseline;
    actualUsd += row.actualUsdcPaid;
    seenModels.add(row.actualModel);
  }

  const matchedServices = seenModels.size;
  if (matchedServices === 0 || baselineUsd <= 0) return null;
  const pct = Math.round(Math.max(0, Math.min(1, 1 - actualUsd / baselineUsd)) * 100);
  return { pct, actualUsd, baselineUsd, matchedServices };
}

export type RecentAutoSession = {
  conversationKey: string;
  label: string;
  lastActiveAt: number;
  turnCount: number;
  savings: MeasuredSavings | null;
};

/**
 * Groups a router's ledger rows by `conversationKey` into one entry per
 * session -- the "can see sessions in vpr" list on the Activity view, a
 * lighter-weight sibling of the full per-turn ConversationRoutingHistory
 * panel shown inside an open chat. `conversationMeta` supplies a human
 * label/last-active timestamp per key (the caller cross-references its own
 * conversation list -- this module stays free of any bridge/IPC type
 * coupling); a key with no matching metadata still gets a row (falls back to
 * "Chat" and this session's own latest decision timestamp) rather than being
 * dropped, since the ledger data is what actually answers "did this chat get
 * routed," independent of whether the conversation list happened to load.
 */
export function groupRoutingDecisionsByConversation(
  rows: readonly RoutingDecisionRow[] | undefined,
  conversationMeta: ReadonlyMap<string, { label: string; lastActiveAt: number }>,
  limit = 8,
): RecentAutoSession[] {
  if (!rows || rows.length === 0) return [];
  const rowsByKey = new Map<string, RoutingDecisionRow[]>();
  for (const row of rows) {
    if (!row.conversationKey) continue;
    const existing = rowsByKey.get(row.conversationKey);
    if (existing) existing.push(row);
    else rowsByKey.set(row.conversationKey, [row]);
  }
  return Array.from(rowsByKey.entries())
    .map(([conversationKey, convRows]) => {
      const meta = conversationMeta.get(conversationKey);
      return {
        conversationKey,
        label: meta?.label ?? 'Chat',
        lastActiveAt: meta?.lastActiveAt ?? Math.max(...convRows.map((r) => r.atMs)),
        turnCount: convRows.length,
        savings: computeRouterSavings(convRows),
      };
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
}
