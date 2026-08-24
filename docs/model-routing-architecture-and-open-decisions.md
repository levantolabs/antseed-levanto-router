# Model Routing on AntSeed — Architecture and Open Decisions

**Status:** Architecture, plugin integration, and the payment mechanism are decided. Two items remain genuinely open: the price point (`D39`) and catalogue coverage before release (`D31`). A handful of implementation details need confirmation from AntSeed (§10).

**Scope:** Integrate the Levanto router into AntSeed as a **client-side routing plugin that replaces `router-local`**, talking to a **routing peer** — a new peer role, of which Levanto's is the first implementation.

**Sources**

| Repo / branch | Role |
|---|---|
| `antseed-levanto-router` @ `main` | AntSeed monorepo — the host |
| `levantolabs/levanto-router-proxy` @ `master` | Working reference implementation of the buyer-side router |
| `levantolabs/sage_model_router` @ `rank-from-precomputed-vector` | The production router library |

---

## 1. Summary

**Shape.** A `routing-client` plugin runs in the buyer (VPR/CLI), holding all state — the CQT dial, per-conversation cache estimates, the failover walk, the local savings ledger, and final policy authority. It replaces `router-local` rather than running alongside it, and calls a `routing-server` plugin on a separate **routing peer** only when a conversation has a new user message. The peer is a pure function: conversation in, ranked `(model, peer)` candidates and prices out, nothing retained.

**Pricing.** $0.59/day, shown to the user as a continuous per-day cost. Mechanically, the client signs one cumulative `SpendingAuth` per elapsed day against a payment channel with the routing peer; the peer holds signatures and settles on-chain once a month via `topUp()`. No new smart contracts are needed. Full mechanism in §6.

**Reused vs. built.** Peer discovery, peer scoring, model-route ranking, model canonicalisation, and the entire payment/signing stack are called directly from existing AntSeed packages. Two small extraction refactors move currently-private logic into shared packages so both `router-local` and `routing-client` can call it (§5). On the router-library side, dynamic per-peer pricing, ranked output, precomputed-vector input, failover with sinbin demotion, and multi-turn handling already exist in `sage_model_router` and `levanto-router-proxy`; the one gap is that cached-input pricing is computed but never wired into ranking (§4.4 fixes this).

**What's still open.**

1. **The price point** (`D39`). At $0.59/day (~$17.96/month), the breakeven at 40% realised savings is ~$45/month of inference spend — a power-user product unless billing is per *active* day rather than calendar day. Needs AntSeed's spend distribution to resolve.
2. **Catalogue coverage** (`D31`). The model hull must span what AntSeed users actually ask for before release; not the ongoing update cadence, which can wait.
3. **Tests on the money path** (`D33`), required before the signing code goes live.

---

## 2. Goals and non-goals

| # | Goal | How we will know |
|---|---|---|
| G1 | A great model router for AntSeed users | Measured savings at matched quality on AntSeed's real traffic |
| G2 | Feels like a feature, not a product | One toggle and one dial in VPR; no new accounts or installs |
| G3 | Open | A third party ships a competing routing peer from public docs |
| G4 | Levanto builds the reusable commons | Client plugin, protocol, ledger, dashboard live in AntSeed packages |
| G5 | Sustainable for Levanto | Subscription plus grant covers R&D, catalogue, commons |

**Non-goals for v1:** other networks; non-text modalities; ensembling or cascading.

---

## 3. What AntSeed already provides

### 3.1 Reusable capabilities

Almost everything a router needs already exists outside `router-local` and is directly callable:

| Capability | Where it lives | Callable from a new plugin? |
|---|---|---|
| Cooldown / failure-streak | `PeerMetricsTracker`, `computeFailureCooldownMs` — exported from `@antseed/router-core` | Yes |
| Peer scoring + weights | `scoreCandidates`, `DEFAULT_WEIGHTS` — exported from `@antseed/router-core` | Yes |
| Peers able to serve a model | `buildNetworkServiceOffers` — `packages/node/src/discovery/service-catalog.ts:162` | Yes |
| Model-route ranking | `rankModelRoutes`, `chooseBestModelRoute` — `packages/node/src/routing/model-route-ranking.ts:191,202` | Yes |
| Model name canonicalisation | `canonicalModelKey` — `@antseed/node` | Yes |
| Payment / signing, including channel-ramp automation | `BuyerPaymentManager.signPerRequestAuth` / `.topUpReserve` | Yes — see §6 |
| Protocol / service compatibility matching | `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` — `apps/cli/src/proxy/routing.ts:231,281` | **No — app code, not a package** |
| Reputation floor + max-price gate | `LocalRouter` private methods — `plugins/router-local/src/router.ts:136-275` | **No — private to the plugin** |

The only genuinely unique content in `router-local` is the reputation gate and the price gate, both private methods. Two small, behaviour-preserving extractions make both reusable (§5.2).

### 3.2 Payment and pricing seams

- **Cached tokens are already reported to the buyer.** The seller reports `cachedInputTokens` in the payment negotiation; the buyer reads it as `reportedCachedInputTokens` (`packages/buyer-core/src/buyer-payment-manager.ts:1225-1235, 1434`). This is the ground truth the cached-token estimator needs (§4.3) — no new plumbing.
- **`SpendingAuth` has no deadline.** `SpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes32 metadataHash)` carries no expiry field, unlike `ReserveAuth`. A signature for a higher cumulative amount can be settled by the seller at any time — the client must sign only for elapsed days (§6).
- **`reserve()` is seller-called, requires seller staking, and is capped at `FIRST_SIGN_CAP = $1.00`** (`AntseedChannels.sol:149-163`). Channels grow only via `topUp()` afterward (§6).
- **The savings UI already ships** and reads local data: `computeMeasuredSavings` compares actual USDC against retail re-pricing, in VPR Home, VPR Activity, and `antseed buyer activity`.
- **Payments** use cumulative channels; `computeCostUsdc` already handles `cachedInputUsdPerMillion`; the buyer re-verifies seller claims against a 1.4× tolerance; platform fee is 2%.

### 3.3 Levanto router-proxy — reference implementation

`levanto-router-proxy` already implements the full buyer-side loop: tokenize → trim to 4096 tokens → call Sage → rank against a live `PriceBook` → filter purchasable → sinbin failed candidates → walk the ranked list pinning peers → bill at the seller actually used → observe cache warmth → log everything.

Design choices worth carrying forward: provider and prices switch together; billing uses the seller actually used, not the one requested; cache recall is measured per-peer rather than seeded from conversation history (scoring a hit against the whole prompt read as 46% recall where direct measurement showed 99%); warmth is keyed on prefix hash, not conversation id.

Known limitations that this integration removes or improves on: no streaming (responses are buffered then SSE-replayed); Sage called on every turn regardless of whether the user sent a new message; no unit tests outside dashboard tooling; prices read from a local `buyer.state.json` file; the ranking artifact loaded in-process on the client rather than server-side.

---

## 4. Architecture

### 4.1 Component map

```
┌───────────────────────────────────────────────────────────────────────────┐
│ BUYER (VPR / CLI)                                                         │
│                                                                           │
│   routing-client plugin  — replaces router-local, calls the same libs     │
│                                                                           │
│     STATEFUL (all of it, per user):                                       │
│       · CQT dial                                                          │
│       · per-conversation: current (model, peer), last observed            │
│         cachedInputTokens + promptTokens + timestamp                      │
│       · routing_decisions ledger  →  the savings dashboard                │
│       · cooldown via @antseed/router-core PeerMetricsTracker              │
│                                                                           │
│     GATE:  new user message?  ──no──►  reuse current (model, peer),       │
│                                        never call the peer      (§4.2)    │
│                                 yes                                       │
│                                  ▼                                        │
│       · estimate expected cached tokens per candidate           (§4.3)    │
│       · POST /_antseed/route   [1s hard timeout]                          │
│       · re-filter locally — local has the last word                      │
│       · walk list; stream; fail over only pre-first-token                 │
│       · write ledger row from the returned price snapshot                 │
│       · sign one SpendingAuth per elapsed day                   (§6)      │
└──────────────────────┬────────────────────────────────────────────────────┘
                       │ POST /_antseed/route
                       ▼
        ┌────────────────────────────────────────┐
        │ ROUTING PEER   (capability: 'routing')  │
        │   routing-server plugin → Python sidecar│
        │                                         │
        │   PURE FUNCTION — ZERO RETENTION        │
        │     · own AntSeed node → global prices  │
        │     · λ by cqt, recalibrated every       │
        │       10 min on raw prices               │
        │     · Sage (trimmed last user turn)     │
        │     · rank (model, peer) tuples         │
        │     · return ranking + price snapshot   │
        │     · forget                            │
        └────────────────────────────────────────┘
```

**The rule:** the peer computes and forgets; the client is where all state, history, and savings math live.

### 4.2 The routing gate: only on a new user message

The client calls the routing peer only when the conversation has a new user message. During an agentic loop — tool calls, tool results, assistant turns — the plugin reuses the current `(model, peer)` and makes no call at all.

This has three effects, all favorable:

1. **Sage cost scales with user messages, not turns.** This is what makes heavy agentic usage profitable rather than loss-making (§7).
2. **Latency disappears from the loop.** The routing budget is paid once per user message, not once per iteration.
3. **It matches the right behaviour anyway.** Switching model mid-loop discards the seller's warm cache and re-bills the whole conversation at fresh input rates; staying put is usually correct.

Implementation is a counter, not a cache: track the index or hash of the last user message that triggered a routing decision, and skip the call if the current request's last user message matches.

One refinement worth measuring before building: also re-route when context tokens have grown past some multiple (e.g. 4×) since the last decision, since a long agentic loop can grow the prompt 10× while the routing decision stays fixed.

### 4.3 Cached-token estimation

The client estimates expected cached tokens per candidate and sends the estimate to the peer; the peer never learns cache behaviour itself. This follows directly from the peer being stateless: a forgetful peer cannot learn per-seller cache patterns, so the estimate must come from the side that actually observes billing.

Two distinct quantities are involved:

| Quantity | Question it answers | Whose state |
|---|---|---|
| **Warmth** | How many tokens of *this* conversation does seller S already hold? | The client's — only it knows what it sent and sees `cachedInputTokens` come back |
| **Recall** | When a seller has seen a prefix, what share comes back billed as cached? | Would be global, but a zero-retention peer cannot learn it |

Without global recall learning, the client uses the simplest honest estimator — what happened last turn. AntSeed already reports `cachedInputTokens` per request, so the client observes the truth rather than modelling it:

```
For the (model, peer) currently in use:
    observedRatio  = cachedInputTokens / promptTokens        (from last turn, EMA'd)
    expectedCached = min(previousPromptTokens * observedRatio, currentPromptTokens)
    decay if the last turn is older than the seller's observed cache lifetime

For any (model, peer) not used in this conversation:
    expectedCached = 0
```

The zero case for unused candidates is correct, not a limitation: a candidate that has never seen this conversation holds none of its prefix and will bill fresh-input rates for the whole thing. Pricing it that way produces a natural, correct stickiness toward the incumbent seller that falls out of the cost model rather than being bolted on.

An alternative — sending both prompts and letting the peer compute the shared prefix — was rejected: it sends more conversation text off-device for no gain, since a stateless peer cannot do anything with it the client can't already do itself.

One caveat: a simple ratio over-estimates if the prefix is invalidated (system prompt edited, history truncated, a branch). A cheap local guard — hash the first few messages, reset the estimate if it changes — handles this entirely on-device.

### 4.4 Request/response shape

```jsonc
// POST /_antseed/route          — sent only on a new user message
{
  "v": 1,
  "cqt": 5,
  "sagePrompt": "…trimmed last user turn, head+tail 4096 tok…",
  "contextTokens": 18422,                    // full billable prompt length
  "expectedCachedTokens": [                  // integers only — no hashes
    { "model": "kimi-k3", "peer": "0x…", "tokens": 16000 }
  ],
  "constraints": { "maxInputUsdPerMillion": 25, "minTrustScore": 60,
                   "blockedPeerIds": ["0x…"] }
}

// 200 OK — everything the client needs to do its own savings math
{
  "v": 1,
  "ranked": [
    { "model": "gpt-5.6-luna", "peer": "0x…", "score": 0.91,
      "predictedQuality": 0.93, "predictedCostUsd": 0.0009,
      "price": { "inUsdPerM": 0.2, "outUsdPerM": 1.1, "cachedInUsdPerM": 0.02 } }
  ],
  "baselineSuggestion": { "model": "gpt-5.6-sol", "peer": "0x…",
                          "price": { "inUsdPerM": 1.1, "outUsdPerM": 8.9 } },
  "receipt": { "routerId": "levanto-sage", "artifactVersion": "live8_pf",
               "lambdaVersion": "2026-08-24T09:00Z" }
}
```

`constraints` lets the peer pre-filter its ranking to what this particular buyer can actually purchase — max price, minimum trust, blocked peers, reachability — while staying stateless, since constraints arrive fresh with every call. Because `ranked` is a flat list ordered by score rather than grouped by model, the client's failover walk absorbs anything the constraints miss (a peer that goes unreachable between request and call, a cooldown that fires in the interim): the next entry may be a different seller of the same model or a different model entirely, whichever the objective ranks higher, so a stale constraint degrades the choice rather than breaking it. Peers found unreachable get appended to `blockedPeerIds` over time, reusing the same signal `PeerMetricsTracker` already produces.

The `price` blocks let the client write a complete savings-ledger row without ever holding a price table, and without the peer keeping anything.

### 4.5 The cached-input pricing gap

`sage_model_router`'s `cache_model.py` computes cache economics correctly and exposes `effective_in()`, which blends cached and fresh input prices — but it is never called from the ranking path. Ranking passes one scalar `ctx_tokens` and `PriceBook` carries no cached rate, so every candidate is priced as a cold cache, systematically undervaluing whichever seller already holds the conversation prefix. The fix, now that the client sends per-candidate cache estimates directly (§4.3):

1. `PriceBook.PerToken` gains a cached rate: `(price_in, price_out, price_cached_in)`.
2. `Catalog.book()` stops discarding `cached_in` — it already has it on `Quote`.
3. `rank_candidates_from_vector` accepts per-candidate `expectedCachedTokens` instead of one scalar for all candidates.
4. Cost becomes `expectedCached × price_cached_in + (contextTokens − expectedCached) × price_in + completion × price_out`.
5. λ calibration uses **raw** prices, not the blended rate — see §5.1.

### 4.6 Savings computation — client-side only

```
  Retail baseline (OpenRouter list price for baseline model X)
        │   ← "AntSeed savings"   (already shipped: computeMeasuredSavings)
        ▼
  AntSeed baseline (model X at the AntSeed price at time of inference)
        │   ← "Router savings"    (new — from the returned baselineSuggestion)
        ▼
  Actual paid (routed model at the AntSeed price at time of inference)
```

Both numbers are shown with the middle line visible, or the router appears responsible for savings that actually come from AntSeed's marketplace. Baseline model X is chosen by the user from a dropdown on the savings page (§8.4); savings recompute client-side from the ledger whenever X changes. Savings shown are gross inference-cost savings only — the $17.96/month subscription fee is never subtracted from this figure; it appears as its own separate line item (§8.5).

---

## 5. Plugin integration

### 5.1 Reuse map and extraction refactors

The new plugin calls existing capabilities directly rather than reimplementing them:

| Capability | Call | Status |
|---|---|---|
| Cooldown / failure-streak | `PeerMetricsTracker`, `computeFailureCooldownMs` from `@antseed/router-core` | Direct import |
| Peer scoring | `scoreCandidates`, `DEFAULT_WEIGHTS` from `@antseed/router-core` | Direct import |
| Peers serving a model | `buildNetworkServiceOffers` from `@antseed/node` | Direct import |
| Model-route ranking | `rankModelRoutes` from `@antseed/node` | Direct import |
| Model canonicalisation | `canonicalModelKey` from `@antseed/node` | Direct import |
| Payment / signing, incl. channel-ramp automation | `BuyerPaymentManager.signPerRequestAuth` / `.topUpReserve` | Direct import — confirmed silent already, no new UX work (§6) |

Two capabilities are not reusable as-is, and need small, behaviour-preserving extractions:

| Blocked capability | Where it is stuck | Fix |
|---|---|---|
| Protocol / service compatibility matching | `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` in `apps/cli/src/proxy/routing.ts` — app code, not a package | Move to `@antseed/node` (or a small shared package). No behaviour change |
| Reputation floor + max-price gate | `LocalRouter._effectiveReputation`, `_resolvePeerOfferPrice`, `_resolveBuyerMaxPrice`, `_offerExceedsMaxPrice` — private methods in `plugins/router-local/src/router.ts` | Extract to `@antseed/router-core` as pure functions; `router-local` calls them too |

Both are small, both benefit any future routing peer, and neither changes existing behaviour. These are the only places where reuse is blocked today.

### 5.2 Plugin type: replace, don't coexist

`node.setRouter()` accepts exactly one router, and the buyer proxy reads policy gates off it via `peerAllowedByPolicy` (`buyer-proxy.ts:206-212`). This constrains the options:

| Option | Replaces `router-local` cleanly? | Plugin-system change |
|---|---|---|
| **A. `routing-client` is a `'router'`-type plugin with routing extensions** | Yes, by construction | Optional methods added to `Router` only |
| B. New `'routing'` type + loader enforces mutual exclusion with `'router'` | Yes, but by policing | New type, loader, registry, config, exclusion logic |
| C. New `'routing'` type, both load simultaneously | No — reintroduces coexistence | New type and machinery |

**Decision: A.** `routing-client` implements the existing `Router` interface in full — `allowsPeerForPolicy`, `allowsPeerForPricing`, `onResult` — plus the new routing methods, and registers as a `'router'`-type plugin. It occupies the single router slot, so it replaces `router-local` by construction: the same extracted gate functions (§5.1) back both routers, so the reputation and max-price gates never silently vanish the way they would if `router-local` were simply disabled to avoid coexistence.

The `routing-server` side is unaffected and is modeled on the existing `Prover` pattern: seller-side, serving a reserved path (`/_antseed/route`, alongside `/_antseed/attest`), no models, no token pricing.

**AntSeed ask:** accept the two extractions in §5.1, and accept optional routing methods on the `Router` interface. Neither changes existing behaviour.

---

## 6. Payment mechanism

### 6.1 Two authorisations, two jobs

`ReserveAuth` and `SpendingAuth` are not interchangeable — they authorise different things, and a subscription needs both.

| | `ReserveAuth(channelId, maxAmount, deadline)` | `SpendingAuth(channelId, cumulativeAmount, metadataHash)` |
|---|---|---|
| Authorises | **Locking** funds into a channel | **Spending** funds already locked |
| Consumed by | `reserve()` (open), `topUp()` (raise ceiling) | `settle()`, `topUp()`, `close()` |
| Expires? | Yes — carries a deadline | No deadline, no nonce (`AntseedChannels.sol:460-476`) |
| Semantics | Sets a ceiling | Cumulative running total, monotonic |

The design question is not which to use, but **how large a ceiling each `ReserveAuth` sets** and **how often settlement goes on-chain**.

### 6.2 The daily meter is free

Because `SpendingAuth` is cumulative and never expires, one signature per elapsed day requires no on-chain activity at all. Day 12 of use is a signature for `$0.59 × 12`; `settle()` only accepts a cumulative above what is already settled, so the peer simply discards stale signatures and submits only its newest one. A user who stops using the router for a week just doesn't advance the counter — the next signature is for the correct number of *used* days. Settlement is one transaction regardless of how many days have accumulated; there is no per-day gas and no reconciliation logic.

**Client-side rule:** the client must sign only for days that have elapsed — the cumulative for day *n* never exceeds `$0.59 × n` — plus a user-visible daily cap. Because `SpendingAuth` has no deadline, a signature authorising a higher cumulative could otherwise be settled by the seller at any time, so pre-signing future days is never safe. This is also what makes cancellation clean: stop signing, owe nothing further.

### 6.3 The first-reserve constraint

```solidity
if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
```

`FIRST_SIGN_CAP = 1_000_000` — USDC has 6 decimals, so **$1.00**. This applies unconditionally to every newly opened channel on AntSeed, for every seller, not just the routing peer. At $0.59/day that's 1.7 days of service, so **no channel can open with a full month's ceiling.**

The only way to raise a ceiling is `topUp()`, which requires 85% of the current deposit to already be settled (`TOP_UP_SETTLED_THRESHOLD_BPS = 8500`). This forces a one-time bootstrapping sequence for every new subscriber: open at $1.00, spend through it (~2 days), sign once 85% is used, then `topUp()` raises the ceiling to the monthly amount. After that, the monthly rhythm below applies indefinitely.

**This ramp has no UX cost**, because AntSeed's existing payment infrastructure already automates it. `packages/buyer-core/src/buyer-payment-manager.ts` signs both `SpendingAuth` and `ReserveAuth` with a locally-held key — there is no popup or confirmation dialog anywhere in the desktop or CLI code for either signature type. It already runs a proactive top-up trigger, `_needsTopUp()`, firing at 65% of the ceiling specifically so the on-chain `topUp()` call lands after the contract's 85% gate clears. Every AntSeed buyer already goes through a version of this ramp on their first channel with any new seller; it has simply never been visible.

`routing-client` reuses `topUpReserve()` unmodified. The one implementation detail: `topUpReserve()` computes `newCeiling = prevCeiling + maxReserveAmountUsdc`, where `maxReserveAmountUsdc` is a buyer-wide config defaulting to $1.00. Left unchanged, the routing channel would keep growing $1.00 at a time forever rather than settling into a monthly cadence — reopening the gas problem the monthly design is meant to avoid. The routing channel needs its own larger top-up increment (~$18), either via a per-seller override or a manager instance scoped to the routing plugin. This is a small wiring question, not a UX one, and is confirmed with AntSeed in §10.

A side effect worth noting: the $1.00 cap also bounds Levanto's exposure to unused channels — `lockForChannel` reverts unless the buyer already holds $1.00 of unreserved deposit, so opening spam channels requires genuinely funded accounts.

### 6.4 Reserve sizing: monthly

At $0.59/day, a year of service is $215.35.

| Reserve period | Ceiling | Peak blocked | Avg blocked | On-chain txs/user/yr | Gas budget per tx to stay under 1% of revenue |
|---|---|---|---|---|---|
| ~2 days | $1.18 | $1.18 | $0.59 | ~182 | $0.012 |
| 1 week | $4.13 | $4.13 | $2.07 | ~52 | $0.041 |
| **1 month** | **$17.96** | **$17.96** | **~$9** | **~12** | **$0.18** |
| 1 quarter | $53.88 | $53.88 | ~$27 | ~4 | $0.54 |
| 1 year | $215.35 | $215.35 | ~$108 | ~1 | $2.15 |

The last column avoids guessing Base's actual fee: it's the gas a `topUp` may cost before eating 1% of annual revenue. A `topUp` is a heavy call — two ECDSA recoveries, a USDC transfer, several storage writes — and should be measured on Base before this is locked, but monthly cadence gives roughly an order of magnitude of headroom against any plausible L2 fee.

**Decision: a monthly ceiling.** Twelve transactions per user per year keeps gas comfortably under 1% of revenue without needing batching. Peak blocked capital of $17.96 (average ~$9, since blocked funds are `deposit − settled` and drain daily) is modest against the $45+/month spend the target user has (§9.4), and a 15-minute unilateral exit caps the downside — `requestClose()` is buyer-callable anytime, `TIMEOUT_GRACE_PERIOD` is 15 minutes, then `withdraw()` recovers the headroom. Weekly quadruples gas to save ~$7 of average blocked capital, a bad trade; quarterly saves roughly a dollar a year in exchange for locking $54 and losing a natural monthly renewal beat.

The reserve period and the billing period don't have to match: the ceiling is a ceiling, not a commitment. A user who runs the router 10 days a month takes three times longer to reach the 85% mark and tops up three times less often — so active-day billing (§9.4) composes with a monthly ceiling for free, and light users get cheaper gas as a side effect.

### 6.5 Lifecycle

| Moment | Actor | Call | Amount at $0.59/day |
|---|---|---|---|
| Opt-in | Client | Sign `ReserveAuth($1.00, deadline)` | Ceiling $1.00 — the max `FIRST_SIGN_CAP` allows |
| Opt-in | Peer | `reserve()` | Locks $1.00. 1 tx |
| End of day 1 | Client | Sign `SpendingAuth(cum = $0.59)` | Held by the peer, not submitted |
| End of day 2 | Client | Sign `SpendingAuth(cum = $1.00)` — capped at the ceiling, a partial day | Clears the 85% gate |
| Day 2 | Client | Sign `ReserveAuth($18.96, deadline)` | Ramp complete |
| Day 2 | Peer | `topUp()` — settles $1.00 and raises the ceiling in one call | Locks a further $17.96. 1 tx |
| Days 3–30 | Client | One `SpendingAuth` per elapsed day | No on-chain activity |
| ~Day 30 | Client + Peer | Sign next `ReserveAuth`; `topUp()` settles and extends | 1 tx, then repeat monthly |
| Cancellation | Client | Stop signing | Nothing further owed |
| Cancellation | Peer | `close(finalAmount = last signed cum)` | Releases the unsettled remainder — courtesy, 1 tx |
| Cancellation, peer unresponsive | Client | `requestClose()` → 15 min → `withdraw()` | Unilateral recovery |

Three implementation details worth flagging explicitly:

- **Day 2's signature is a partial day.** `settle()` rejects any cumulative above the deposit, so the client clamps to `min($0.59 × days, ceiling)`. The shortfall isn't lost — it's recovered once the ceiling rises.
- **`topUp` must fire before the ceiling is reached, not after.** Once the cumulative hits the ceiling the client can't sign higher, and the meter stalls silently — the user routes for free and nothing surfaces until the ledger is checked. On an $18.96 ceiling: the 85% gate opens at day 27.3, the scheduler should fire at 95% (day 30.5), hard stop is day 32.1 — a ~5-day window that must be monitored, not assumed.
- **The two signature types must not share a code path.** The daily `SpendingAuth` is silent and automatic; the monthly `ReserveAuth` renewal is where a deliberate consent moment belongs (§6.6). Conflating them risks turning a monthly renewal into something unnoticed.

### 6.6 Signing visibility

Neither signature type requires a visible prompt — both are signed with a locally-held key, with zero UI anywhere in the existing desktop or CLI code. Whether to surface the monthly renewal is therefore a **deliberate product choice**, not a mechanism requirement:

| Moment | Frequency | What the mechanism requires | What we show |
|---|---|---|---|
| Funding the AntSeed deposit | Once | Nothing — AntSeed's onboarding | Nothing new |
| `ReserveAuth` — monthly renewal | ~12/yr, plus the one-time ramp | Nothing — can be fully silent | **Shown anyway:** a one-line "renewed your $17.96/month routing subscription" notice, since this is the one signing moment tied to money the user might not be tracking |
| `SpendingAuth` — daily meter | 365/yr | Nothing — matches existing per-request auto-signing | Stays silent. Bounded by `$0.59 × elapsed days` and the authorised ceiling, so a compromised client caps out at a fraction of a dollar |

### 6.7 Sub-decisions

| Sub-decision | Options | Decision |
|---|---|---|
| Calendar day or active day billing | Calendar = predictable revenue, users pay for idle days. Active = fairer, self-limiting, lumpier revenue | **Open — tied to `D39` (§9.4).** The monthly ceiling supports either without change |
| Signing consent | Silent within a cap, vs. a visible prompt | Silent daily; visible monthly renewal (§6.6) |
| Catch-up window | Unlimited, or capped | Cap at ~30 days; older unsigned days forgiven (the ceiling limits this anyway) |
| Deposit exhausted | Routing stops; how surfaced | Non-modal notice, fall back to timeout behaviour |
| Cross-user bulk settlement | Contract seller wallet, ask AntSeed for `settleMany`, or accept per-user tx | **Not pursuing.** One `topUp` per subscriber per month is already budgeted (§7) and is not worth the added complexity at this scale |

### 6.8 What's retained, precisely

At $0.59/day the peer must know whether a caller is entitled and which days are signed, so "zero retention" is never literal. The precise statement:

- **Retained, permanently:** channel id and peer identity, subscription status, last signed cumulative amount, settlement history, and one daily performance digest (§6.9).
- **Retained, transiently:** the request itself, for as long as it takes to rank it.
- **Never retained:** prompt content, conversation structure, prefix hashes, per-request rows, or anything tying a routing decision to the message that caused it.

The public claim should be "we do not keep your conversations or your routing history" — true and checkable — rather than "we retain nothing."

### 6.9 The daily performance digest

The client already contacts the peer once a day to hand over a signed `SpendingAuth` — authenticated, once-per-day, tied to a paying subscriber, outside the request path. A fixed-size aggregate rides along on that call at no cost of a new endpoint or consent moment:

| Field | Purpose |
|---|---|
| `day`, `cqt`, `artifactVersion`, `lambdaVersion` | Attribute the numbers below to a configuration |
| `routedRequests` | Denominator |
| `actualCostUsd` | What the user actually spent on routed requests |
| `baselineCostUsd` | Same requests priced at the baseline model X, at the prices of the moment |
| `predictedCostUsd` | Calibration signal against `actualCostUsd` for the cost model |
| `modelMix` — `{canonicalModel: count}` | Which models get chosen; feeds catalogue coverage decisions |
| `regenerations`, `overrides` | Cheap tripwire for saving money by degrading answers |
| `failovers`, `timeouts` | Reliability of the ranked list and the peer |

Roughly ten scalars and a short map. No prompts, no per-request rows, no timestamps finer than the day, no conversation structure. Every field is already computed for the user's own dashboard, so the numbers Levanto sees are exactly the numbers the user sees.

With a few hundred subscribers, this turns the savings figure into a measured fleet number rather than a benchmark extrapolation, and lets the cost model be calibrated against live AntSeed prices and this fleet's actual prompt lengths — something benchmarking elsewhere cannot provide. It does **not** enable retraining: with no prompts or labels leaving the device, the quality heads cannot learn from production traffic, and the digest must not grow toward that job.

Because this is per-subscriber daily data accumulating over time, `modelMix` in particular functions as a usage profile even without content. Default on, with one visible toggle to send payment-only, and the UI states plainly what the daily call carries.

---

## 7. Router library and catalogue

**Catalogue coverage is a release blocker; the update cadence is not.** A router that silently declines to route models AntSeed users actually ask for reads as broken. Before release, the model hull must span AntSeed's actual traffic; the coverage surface already exists to show what's missing. Ongoing update ownership and SLA can be decided later.

**`prune` defaults to `False`.** Ranked-list-with-failover wants the full candidate set — dynamic dominance pruning would remove exactly the entries the client falls back to when its local policy rejects the leader.

**Tests are required before the signing path goes live.** The proxy has no coverage outside dashboard tools today. Signing code, the cumulative-day counter, and the `topUp` scheduler all move real money and need coverage before the first paid day.

**`decide()`, `decide_turn()`, and `_select` are deleted.** `_select` passes the raw prompt string where `_predicted_costs` expects a token count (`router.py:547`), which flows into `input_tokens * price_in` at `cost_ridge.py:75` — a `TypeError`, not a wrong number. It only avoids raising on pre-M4 artifacts, where a guard skips the token-count arithmetic entirely; every current trainer stamps `cost_model="ridge_m4"`, so `decide()` raises on every artifact currently shipping. `decide_turn()` inherits the bug since it delegates to `decide()`. The ranked path (`rank_candidates_from_vector`) is unaffected and is the only entry point this integration uses, so both functions are deleted outright rather than patched — a supported surface nothing exercises is how this bug survived undetected. If Levanto has callers of `decide()` outside this integration, fix the one-line argument order and add a regression test instead of deleting.

---

## 8. Product surface

**8.1 — CQT dial.** One slider, five positions, default the middle one. The underlying CQT range still runs 0–10 internally; the five UI positions map onto five fixed points on it. CQT is a relative dial, not a spend target — the UI must not promise "save X%" tied to a specific position.

**8.2 — Per-message routing signal.** A sentinel value in the existing model-selection field (e.g. `"model": "auto"`) means "let the router decide"; a deliberate model choice in the dropdown is always honored, and only the sentinel routes. No separate routing flag — the rest of the client code sees an ordinary model id. Same pattern as OpenRouter's `"openrouter/auto"`. Remaining implementation detail: confirm the exact sentinel string against AntSeed's model-selection UI.

**8.3 — Model disclosure.** The model actually used is printed as metadata at the end of the turn — not before sending, not a blocking label. Enough for trust and for support without turning every message into a routing dashboard.

**8.4 — Savings baseline (model X).** A dropdown on the savings page lets the user choose the reference model that routed costs are compared against. The peer's `baselineSuggestion` (§4.4) can seed the dropdown's options and default. Savings recompute client-side from the ledger whenever X changes. **Open sub-decision:** which model is the default the first time a user opens the savings page — candidates are the pre-opt-in most-used model, the peer's suggestion, or a fixed flagship.

**8.5 — Savings display.** Gross only. The $17.96/month subscription fee is never netted against the savings figure; it's a separate, visible line item.

---

## 9. Business

**9.1 — Fee collection.** One `SpendingAuth` per elapsed day against a channel with the routing peer, held by the peer and settled monthly against the ceiling from §6. No new contracts required; because `SpendingAuth` is cumulative, "stockpiling signatures" while offline is automatic and settlement is always one transaction.

**9.2 — Platform fee.** 2% = $0.0118/day, ~$0.36/month. Ordinary seller, ordinary fee.

**9.3 — Sage cost exposure.** Largely resolved by the new-user-message gate (§4.2): since routing fires per user message rather than per turn, the agentic-usage cost blow-up that would have motivated a fair-use cap mostly disappears. No cap in v1; instrument and revisit.

**9.4 — Is $0.59/day the right price, and for whom?** The sharpest open business question. $0.59/day is $17.96/month (30.44 avg days) or $215.35/year — roughly double an earlier $9/month figure. Breakeven for the user:

| Realised savings | Monthly inference spend needed to break even |
|---|---|
| 60% | $29.93 |
| **40%** | **$44.90** |
| 25% | $71.84 |
| 15% | $119.73 |

At the marketed 40%, the user must already be spending ~$45/month on inference — this is a power-user product, in tension with `G2`'s "feels like a feature" framing at this price. Two things cut in favor of it: users who spend $45+/month are overwhelmingly agentic, and agentic traffic is exactly what the new-message gate (§4.2) serves most cheaply, so price and cost structure are aligned; and **active-day billing changes the picture entirely** — a light user who runs the router 5 days a month pays $2.95 and breaks even at ~$7.40 of spend. Whether billing is calendar-day or active-day (§6.7) is therefore the single decision that determines whether this is a power-user-only product or something a casual user can also switch on. Needs AntSeed's spend distribution to settle (§10).

**9.5 — The savings claim's baseline.** With router-quality evaluation handled outside this document, the remaining question is which baseline the marketed percentage is measured against — now the savings-page dropdown (§8.4) — and keeping it visually distinct from the savings AntSeed already claims against OpenRouter retail, so the two are never silently summed in the user's mind (§4.6).

**9.6 — Grant structure.** Revenue per subscriber roughly doubled from the original $9/month figure, worth reflecting in what the $16k grant plus token allocation is buying. Milestones and disclosure of Levanto holding ANTS while operating the default routing peer remain undefined.

**9.7 — The commons.** Protocol and schema, the `routing-client` plugin, the local ledger and savings computation, dashboard surfaces, the peer template, and the two extracted modules from §5.1 are open. Sage, artifacts, and training data stay Levanto's. The cached-token estimator (§4.3) is client-side and general, so it belongs in the commons — every future routing peer benefits from it.

**9.8 — Exclusivity and default placement.** Time-boxed (6–12 months), disclosed, with a published policy for how the default routing peer changes over time.

**9.9 — Support and SLA.** A hosted service in a latency-sensitive path, charging $18/month, needs a defined SLA before billing begins.

**9.10 — Refunds and proration.** Resolved by the daily signing mechanism itself: stop signing, nothing further is owed (§6.2).

**9.11 — Free month for the first 200 users.** Skip signing for the first 30 days, or use `AntseedFreeUsage`. Being generous rather than exact about the count costs roughly $18/user.

---

## 10. Unit economics

**Revenue:** $0.59/day × 30.44 = **$17.96/month**, less 2% platform fee → **$17.60 net**.

**COGS.** The new-message gate (§4.2) changes the denominator: Sage fires per user message, not per turn.

| | Light (300 user msgs/mo) | Typical (600) | Heavy agentic (1,500) |
|---|---|---|---|
| Sage @ ~$0.0006–0.001/call | $0.18–0.30 | $0.36–0.60 | $0.90–1.50 |
| Routing-peer infra (amortised) | ~$0.20 | ~$0.30 | ~$0.50 |
| Channel gas — 1 `topUp`/month | ~$0.05 | ~$0.05 | ~$0.05 |
| **Gross margin** | **~$17.1** | **~$16.7** | **~$15.6** |

Under a per-turn cost model, a heavy agentic user at 20,000 routed turns/month would have been −$4 to −$12/month. The message-level gate turns the previously worst-margin segment into the second-best one; the margin problem is solved, and the harder remaining question is user value at this price (§9.4).

**Fixed costs the grant offsets:** router R&D, catalogue maintenance, the commons (§9.7), and operating the routing peer.

---

## 11. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Cost model mis-calibrated against live AntSeed prices and prompt lengths | Medium | High | `predictedCostUsd` vs `actualCostUsd` in the daily digest (§6.9) |
| R2 | Catalogue does not cover the models users ask for | Medium | High | Coverage as a release gate (§7) |
| R3 | Digest scope creeps toward prompt-derived fields | Medium | High | Fixed schema, versioned, in `packages/protocol` |
| R4 | $17.96/month exceeds savings for most users | High | High | Active-day billing; spend distribution needed first (§9.4) |
| R5 | Routing blind to cache warmth → wrong picks | High | Medium | Wire the estimator (§4.5) |
| R6 | Pre-signed days settled early after cancellation | Medium | High | Never sign ahead; per-day cap (§6.2) |
| R7 | Routing peer is a single point of failure | High | Medium | Timeout fallback; SLA (§9.9) |
| R8 | Losing streaming is a visible regression | Medium | High | Stream; fail over only pre-first-token |
| R9 | Python sidecar lifecycle problems | Medium | Medium | Fail closed, stop advertising |
| R10 | Per-user λ drift via `OnlineBudgetController` | Medium | Medium | Disable it (§4.5) |
| R11 | Cached-token estimate drifts on prefix invalidation | Medium | Low | Local prefix guard (§4.3) |
| R12 | Channel-open gas as a spam vector | Low | Low | Bounded by `FIRST_SIGN_CAP` + funded-deposit requirement (§6.3) |
| R13 | Gas per subscriber outruns revenue at scale | Medium | Medium | Monthly `topUp` cadence; measure on Base first (§6.4) |
| R14 | Daily digest becomes a usage profile over time | Medium | Medium | Ten scalars, day granularity, visible toggle (§6.9) |
| R15 | Untested code in the money path | Medium | High | Test story before billing (§7) |
| R16 | `topUp` fires late → cumulative hits the ceiling, meter stalls silently | Medium | High | Schedule at ~95% consumed; alert on a stalled cumulative (§6.5) |
| R17 | Monthly `ReserveAuth` renewal read as a surprise charge | Medium | Medium | Frame as a renewal notice; show days used and next ceiling (§6.6) |

---

## 12. Phasing

**Phase 0 — Decide (1 week).** Calendar-vs-active-day billing (`D39`); measure `topUp` gas cost on Base.

**Phase 1 — Plumbing, unpriced (4–6 weeks).**
- *AntSeed:* extract `selectCandidatePeersForRouting` / `resolvePeerRoutePlan` into a package; extract the reputation and max-price gates from `LocalRouter` into `@antseed/router-core`; add `'routing'` capability; `/_antseed/route` schema in `packages/protocol`; optional routing methods on `Router`.
- *Levanto:* `routing-client` plugin in TS — new-user-message gate, cached-token estimator, failover walk, local ledger, policy filter, all calling the extracted libs; `routing-server` plugin + Python sidecar; peer-side AntSeed node; wire cached tokens into ranking; disable `OnlineBudgetController`; reuse `signPerRequestAuth`/`topUpReserve` for the daily meter, with a larger per-channel top-up increment for the routing peer specifically.
- *Joint:* trivial reference routing peer in the template.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 users with the daily digest on. Dial and opt-in in VPR. Two-number savings dashboard off the local ledger. **Gates:** catalogue coverage over the models this cohort actually asks for; cost model calibrated against live prices; tests on the signing path.

**Phase 3 — Launch.** Billing per the §6.5 lifecycle. Tests complete first. Free 30 days for the first 200. Routing-peer picker. Public methodology page.

**Phase 4 — Hardening.** Conformance suite. Default-selection policy.

---

## 13. Open items

**From AntSeed:**

1. Accept optional routing methods on the `Router` interface (§5.2) — the only plugin-system change needed, taking the `'router'` slot and replacing `router-local`.
2. What is the distribution of monthly inference spend per active buyer? (§9.4) At $0.59/day the breakeven is ~$45/month at 40% savings — this decides whether the addressable market exists.
3. Are the two extraction refactors in §5.1 acceptable?
4. Can `maxReserveAmountUsdc` be overridden per seller within one `BuyerPaymentManager`, or does the routing plugin need its own instance? (§6.3) The ramp needs no product decision, but the cleanest wiring for a ~$18 top-up increment (instead of the $1.00 buyer-wide default) needs confirming.
5. Does the commons (§9.7) live in this repo under this licence, including the cached-token estimator?
6. Default-peer policy, Levanto's placement duration, grant disclosure (§9.6, §9.8).

**From Levanto:**

7. Calendar day or active day billing? (§6.7/§9.4) Decides whether the product is power-user-only.
8. Is the daily digest (§6.9) default-on with a toggle, or opt-in?
9. Measure `topUp` gas on Base before fixing the monthly cadence (§6.4).
10. Which models must the hull cover before release? (§7) Needs AntSeed's model-usage mix, pairs with item 2.
11. Which baseline model is the savings-page dropdown default at launch? (§8.4)

**Before any savings number goes public:** state which baseline the percentage is measured against, and keep it visually separate from AntSeed's own savings-versus-retail figure (§9.5).

---

## Appendix — Code references

### AntSeed (`antseed-levanto-router`)

| Concern | Path |
|---|---|
| Plugin interfaces / union | `packages/node/src/interfaces/plugin.ts` |
| `Prover` pattern — model for `routing-server` | `packages/node/src/interfaces/plugin.ts:78-83` |
| `Router` interface | `packages/node/src/interfaces/buyer-router.ts` |
| `LocalRouter` — gates to extract | `plugins/router-local/src/router.ts:136-275` |
| Policy probe in the proxy | `apps/cli/src/proxy/buyer-proxy.ts:206-212, 290-293` |
| `PeerMetricsTracker`, cooldown — exported | `packages/router-core/src/peer-metrics.ts` |
| `scoreCandidates`, `DEFAULT_WEIGHTS` — exported | `packages/router-core/src/peer-scorer.ts` |
| `buildNetworkServiceOffers` | `packages/node/src/discovery/service-catalog.ts:162` |
| `rankModelRoutes`, `chooseBestModelRoute` | `packages/node/src/routing/model-route-ranking.ts:191,202` |
| `selectCandidatePeersForRouting` — extract to a package | `apps/cli/src/proxy/routing.ts:231,281` |
| Cached tokens reported to the buyer | `packages/buyer-core/src/buyer-payment-manager.ts:1225-1235, 1434` |
| Cost computation (cached-input aware) | `packages/buyer-core/src/pricing.ts:41-54` |
| `SpendingAuth` / `ReserveAuth` typehashes | `packages/contracts/payments/AntseedChannels.sol:38-45` |
| `SpendingAuth` has no deadline or nonce | `packages/contracts/payments/AntseedChannels.sol:460-476` |
| `FIRST_SIGN_CAP = $1.00`, enforced on every `reserve()` | `packages/contracts/payments/AntseedChannels.sol:47, 163` |
| Existing silent ramp automation: `topUpReserve()`, `_needsTopUp()` at 65% threshold, `_currentReserveCeiling`, `maxReserveAmountUsdc` | `packages/buyer-core/src/buyer-payment-manager.ts:47-51, 85-86, 1142-1147, 1682-1739` |
| `topUp()` — settles and extends in one call; 85% threshold | `packages/contracts/payments/AntseedChannels.sol:207-244` |
| No cross-user batch entry point | `packages/contracts/payments/AntseedChannels.sol:218, 263` |
| Blocked funds = `deposit − settled` | `packages/contracts/payments/AntseedDeposits.sol:162-207` |
| 15-minute buyer exit: `requestClose` → `withdraw` | `packages/contracts/payments/AntseedChannels.sol:50, 325-345` |
| `AntseedFreeUsage` | `packages/contracts/payments/AntseedFreeUsage.sol` |
| Capability enum, `PeerOffering` | `packages/protocol/src/capability.ts` |
| Reserved-path precedent (attest) | `packages/node/src/seller-request-handler.ts:139-185` |
| Savings vs retail (shipped, local) | `apps/desktop/src/renderer/modules/catalog/measured-savings.ts` |
| VPR preferences (dial precedent) | `apps/desktop/src/renderer/modules/routing/preferences.ts` |

### levanto-router-proxy

| Concern | Path |
|---|---|
| Request lifecycle, ranking, failover walk | `proxy.py:275-437` |
| AntSeed catalog, peer pinning, billing rate | `providers.py:139-205`; `rate_for` at `89-102` |
| Cache model — superseded by the client-side estimator (§4.3) | `cache_model.py`; `effective_in` at `273-276` |
| Runtime, catalog swap, λ recalibration | `routing.py:293-380` |
| Audit schema (14 tables) | `store.py` |
| Stated limitations | `README.md:215-227` |

### sage_model_router @ `rank-from-precomputed-vector`

| Concern | Path |
|---|---|
| Dynamic pricing design + caveats | `DYNAMIC_PRICING.md` |
| `PriceBook` — needs the cached rate | `price_book.py:38-47` |
| `rank_candidates_from_vector` | `router.py:588-638` |
| `set_prices` / `_live_hull` / `_price_for` | `router.py:384-445` |
| λ recalibration | `router.py:463-486`; `lambda_calibration.py:62-67` |
| `OnlineBudgetController` — disable | `router.py:194-216` |
| Sage prompt trimming + the cliff | `prompt_trim.py` |
| `decide()`/`decide_turn()`/`_select` — deleted | `router.py:544-551, 658-708` |
| Bug that motivated deletion: `prompt` passed where `input_tokens` is expected | `router.py:547` |
| Correct call sites (ranked path, kept) | `router.py:586, 603` |
