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

/**
 * Default reference model for the SS8.4 savings-page dropdown -- "the most
 * expensive, most capable flagship... the top GPT or Claude model." No
 * dropdown UI exists yet to let a buyer pick a different one (SS8.4 is not
 * built), so callers get this default unless/until that UI exists to pass a
 * different `baselineModel` through. Matches (duplicated, not imported)
 * `DEFAULT_BASELINE_MODELS[0]` in `plugins/router-levanto/src/router.ts` --
 * that package is buyer/Node-side and now depends on `node:fs`, no
 * cross-boundary dependency into renderer UI code is intended.
 */
export const DEFAULT_ROUTER_SAVINGS_BASELINE_MODEL = 'claude-opus-5';

export function computeRouterSavings(
  rows: readonly RoutingDecisionRow[] | undefined,
  baselineModel: string = DEFAULT_ROUTER_SAVINGS_BASELINE_MODEL,
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
