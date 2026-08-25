/**
 * "Router savings" (decisions doc SS4.5/SS4.6's three-tier diagram; software-
 * architecture doc SS2.5's ledger is the source). Scoped to requests the
 * routing-client actually decided (the `routing_decisions` ledger), not the
 * aggregate buyer usage `computeMeasuredSavings` already covers -- so this
 * line answers "how much did Auto-routing save you," distinct from "AntSeed
 * savings" (which every AntSeed user gets regardless of routing).
 *
 * Deviation from the doc's literal SS4.6 middle tier, logged in the runlog:
 * the doc's middle tier compares against one FIXED reference model's AntSeed
 * price at the time of each decision (`RoutingDecisionRow.baselinePrices`,
 * SS2.5) -- that field needs the SS8.4 fixed baseline dropdown, which is not
 * built yet (no VPR config surface exists to pick or persist it). Rather than
 * fabricate a hardcoded "current flagship" guess, this computes retail-price
 * savings per row's own actual model instead (same math as
 * `computeMeasuredSavings`, reused here on the ledger instead of aggregate
 * usage) -- a real, honestly-labeled approximation until that dropdown lands.
 */
import type { RoutingDecisionRow } from '@antseed/node';
import type { OpenRouterReferenceMap } from '../catalog/openrouter-baseline.js';
import { canonicalModelKey } from '../catalog/model-identity.js';
import type { MeasuredSavings } from '../catalog/measured-savings.js';

export function computeRouterSavings(
  rows: readonly RoutingDecisionRow[] | undefined,
  referenceMap: OpenRouterReferenceMap | null,
): MeasuredSavings | null {
  if (!rows || rows.length === 0 || !referenceMap) return null;

  let actualUsd = 0;
  let baselineUsd = 0;
  let matchedServices = 0;
  const seenModels = new Set<string>();

  for (const row of rows) {
    if (!row.actualModel) continue;
    const ref = referenceMap[canonicalModelKey(row.actualModel)];
    if (!ref || (ref.input === null && ref.output === null)) continue;

    const freshInput = Math.max(0, row.actualPromptTokens - row.actualCachedTokens);
    const cached = row.actualCachedTokens;
    const output = row.actualCompletionTokens;
    if (freshInput === 0 && cached === 0 && output === 0) continue;

    const inputPrice = ref.input ?? 0;
    const cachedPrice = ref.cachedInput ?? inputPrice;
    const outputPrice = ref.output ?? 0;
    const rowBaseline = (freshInput * inputPrice + cached * cachedPrice + output * outputPrice) / 1_000_000;
    if (rowBaseline <= 0) continue;

    baselineUsd += rowBaseline;
    actualUsd += row.actualUsdcPaid;
    seenModels.add(row.actualModel);
  }
  matchedServices = seenModels.size;

  if (matchedServices === 0 || baselineUsd <= 0) return null;
  const pct = Math.round(Math.max(0, Math.min(1, 1 - actualUsd / baselineUsd)) * 100);
  return { pct, actualUsd, baselineUsd, matchedServices };
}
