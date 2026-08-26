# Model Routing on AntSeed — Architecture and Open Decisions

**Status:** Architecture, plugin integration, the payment mechanism, and the product surface are decided. What's left is a short list of implementation-level confirmations from AntSeed, plus measuring `topUp` gas on Base before locking the reserve cadence (§13).

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

**Pricing.** $0.59/day, shown to the user as a continuous per-day cost. Mechanically, the client signs one cumulative `SpendingAuth` per elapsed day against a payment channel with the routing peer; the peer holds signatures and settles on-chain daily via `topUp()`, raising the ceiling by exactly one more day's charge each time — the default for now, not locked against a monthly alternative (§6.4, item 4). No new smart contracts are needed. Full mechanism in §6.

**Reused vs. built.** Peer discovery, peer scoring, model-route ranking, model canonicalisation, and the entire payment/signing stack are called directly from existing AntSeed packages. Two small extraction refactors move currently-private logic into shared packages so both `router-local` and `routing-client` can call it (§5). On the router-library side, dynamic per-peer pricing, ranked output, precomputed-vector input, failover with sinbin demotion, and multi-turn handling already exist in `sage_model_router` and `levanto-router-proxy`; the one gap is that cached-input pricing is computed but never wired into ranking (§4.4 fixes this).

**What's still open.**

1. **Catalogue coverage.** The model hull must span the majority of what actually generates traffic on AntSeed before release (§7); the ongoing update cadence can wait.
2. **Tests on the money path**, required before the signing code goes live (§7).

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

**Subagents.** A subagent session gets its own new-user-message gate and its own routing decision — it is not simply pinned to the parent chat's `(model, peer)` — unless the subagent-creation call itself already specifies a model, in which case that explicit choice is honored and no routing call is made for that subagent at all. This mirrors the sentinel rule in §8.2: an explicit model always wins; only the absence of one triggers routing.

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
    decay to 0 if the last turn is older than 3 minutes         (flat timeout, all providers)

For any (model, peer) not used in this conversation:
    expectedCached = 0
```

The 3-minute figure is a flat timeout applied uniformly regardless of provider or seller — not a per-provider constant, and not something learned. Revisit once real per-provider/per-seller cache-lifetime data exists.

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
                   "allowedPeerIds": ["0x…"], "blockedPeerIds": ["0x…"] }
}

// 200 OK — everything the client needs to do its own savings math
{
  "v": 1,
  "ranked": [
    { "model": "gpt-5.6-luna", "peer": "0x…", "score": 0.91,
      "predictedQuality": 0.93, "predictedCostUsd": 0.0009,
      "predictedInputTokens": 18422, "predictedCachedInputTokens": 16000, "predictedOutputTokens": 450,
      "price": { "inUsdPerM": 0.2, "outUsdPerM": 1.1, "cachedInUsdPerM": 0.02 } }
  ],
  "baselineSuggestion": { "model": "gpt-5.6-sol", "peer": "0x…",
                          "price": { "inUsdPerM": 1.1, "outUsdPerM": 8.9 } },
  "receipt": { "routerId": "levanto-sage", "artifactVersion": "live8_pf",
               "lambdaVersion": "2026-08-24T09:00Z" }
}
```

`constraints` lets the peer pre-filter its ranking to what this particular buyer can actually purchase — max price, minimum trust, blocked peers, reachability — while staying stateless, since constraints arrive fresh with every call. Because `ranked` is a flat list ordered by score rather than grouped by model, the client's failover walk absorbs anything the constraints miss (a peer that goes unreachable between request and call, a cooldown that fires in the interim): the next entry may be a different seller of the same model or a different model entirely, whichever the objective ranks higher, so a stale constraint degrades the choice rather than breaking it. Peers found unreachable get appended to `blockedPeerIds` over time, reusing the same signal `PeerMetricsTracker` already produces.

**`allowedPeerIds` is a client-side re-filter, not a ranking restriction.** Sage keeps ranking broadly across the whole network — an allowlist would otherwise narrow the ranking input back toward the old fixed-model pipeline's "pick a seller for one decided model" shape, which cuts against cross-model routing. Instead the client walks the returned ranked list as usual and skips any candidate outside the allowlist, exactly as it already does for `blockedPeerIds`. If the walk exhausts the ranked list without finding a candidate inside the allowlist, the client falls back to the allowed peers directly rather than giving up. Both lists apply together: allow first, then exclude anything also blocked.

The `price` blocks let the client write a complete savings-ledger row without ever holding a price table, and without the peer keeping anything.

**`predictedInputTokens`/`predictedCachedInputTokens`/`predictedOutputTokens`** feed the daily digest's calibration fields (§6.9) — not derivable from `predictedCostUsd` and `price` alone, since that's one equation with three unknowns. Genuinely new fields on the ranked entry, not already present.

**Global reputation floor.** The routing peer enforces a single global minimum reputation score, `minTrustScore ≥ 0.70` on the 0–100 scale (the same `computeOnChainReputationScore(p) ?? p.reputationScore` `LocalRouter` already uses for `minReputation`, `plugins/router-local/src/router.ts:18`), applied consistently in three places: which peers' prices build the live `PriceBook` fed into λ calibration, which peers are eligible ranked candidates at all, and as a floor under the buyer's own `constraints.minTrustScore`. A buyer can only tighten this floor — requesting a stricter threshold is honored server-side against the received config value — never loosen it; the global minimum always wins. This closes the gap where an untrusted or spam peer's advertised price could otherwise feed straight into λ calibration and appear as a ranked candidate.

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

Both are small, both benefit any future routing peer, and neither changes existing behaviour. These are the only places where reuse is blocked today. **Confirmed acceptable to AntSeed, conditional on each extraction being fully documented and landing in its own commit, separate from any `routing-client`/`routing-server` code.**

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

Because `SpendingAuth` is cumulative and never expires, one signature per day requires no on-chain activity at all. Day 12 is a signature for `$0.59 × 12`; `settle()` only accepts a cumulative above what is already settled, so the peer simply discards stale signatures and submits only its newest one. Billing tracks the toggle, not activity (§6.7): a user who switches the router off in settings for a week owes nothing for that week, full stop. A user who leaves the toggle on but simply isn't using the app — device off, app closed, no messages sent — still owes those days once they reconnect, since the toggle itself was never switched off; the client resolves this as a backlog on reconnect, capped at ~30 toggle-on days (§6.7). Settlement of an ordinary day, with no backlog to resolve, is one transaction regardless of how many prior days were already settled; there is no per-day gas.

**Client-side rule (pay-first):** the client signs today's cumulative — `$0.59 × n` for day *n* — **before** making any routing calls that day, not after using it. The routing peer requires that day's signature to already be on file before it will serve a routing request; without it, routing is refused (§3.3 of the software architecture doc). This is a deliberate inversion of the usual "sign what you already used" pattern: it removes the routing peer's free-rider exposure (a buyer using the service for a day and never paying for it) at the cost of a small, symmetric risk moved onto the buyer instead — sign today, cancel five minutes later, and that day is paid for but barely used. Both risks are capped at one day, ~$0.59; this trade deliberately favors the seller bearing zero risk over the buyer bearing a small one. Pre-signing *beyond* today remains unsafe for the same reason as before — `SpendingAuth` has no deadline, so a signature for day *n+2* could be settled by the seller at any time even after the buyer stops routing — the rule is "sign today, not ahead," never "sign however far ahead." Cancellation is still clean: stop signing, routing is refused from that point on, nothing further is owed.

### 6.3 The first-reserve constraint

```solidity
if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();
```

`FIRST_SIGN_CAP = 1_000_000` — USDC has 6 decimals, so **$1.00**. This applies unconditionally to every newly opened channel on AntSeed, for every seller, not just the routing peer. At $0.59/day that's 1.7 days of service, so **no channel can open with a full month's ceiling.**

The only way to raise a ceiling is `topUp()`, which requires 85% of the current deposit to already be settled (`TOP_UP_SETTLED_THRESHOLD_BPS = 8500`). This forces a one-time bootstrapping sequence for every new subscriber — but the ceiling doesn't need to be maxed at $1.00 to clear it: reserving exactly one day's charge ($0.59) instead means day 1's `SpendingAuth(cum=$0.59)` settles at 100% of a $0.59 deposit, clearing the 85% gate immediately rather than needing a second day at a $1.00 ceiling (59% settled after day 1, requiring a partial-day top-off on day 2 to reach 100%). Open at $0.59, spend through it (1 day), sign once, then `topUp()` raises the ceiling by exactly one more day's charge — to $1.18. After that, the same rhythm applies indefinitely: every day looks like day 1, just one day further along (§6.4).

**This ramp has no UX cost**, because AntSeed's existing payment infrastructure already automates it. `packages/buyer-core/src/buyer-payment-manager.ts` signs both `SpendingAuth` and `ReserveAuth` with a locally-held key — there is no popup or confirmation dialog anywhere in the desktop or CLI code for either signature type. It already runs a proactive top-up trigger, `_needsTopUp()`, firing at 65% of the ceiling specifically so the on-chain `topUp()` call lands after the contract's 85% gate clears. Every AntSeed buyer already goes through a version of this ramp on their first channel with any new seller; it has simply never been visible.

`routing-client` reuses `topUpReserve()` unmodified. The one implementation detail: `topUpReserve()` computes `newCeiling = prevCeiling + maxReserveAmountUsdc`, where `maxReserveAmountUsdc` is a buyer-wide config defaulting to $1.00 — already comfortably covers the $0.59/day the daily default needs (it slightly over-reserves by ~$0.41 each day, never a correctness problem, since the ceiling is a maximum, not a spend commitment). A per-seller override only becomes necessary if the monthly alternative (§6.4) is chosen instead, where the needed increment is ~$18 rather than $1; confirmed with AntSeed in §13, item 1.

A side effect worth noting: the reserve amount also bounds Levanto's exposure to unused channels — `lockForChannel` reverts unless the buyer already holds at least that amount of unreserved deposit. Reserving $0.59 rather than maxing at the $1.00 cap lowers this bar somewhat (a spam channel needs $0.59 funded rather than $1.00) — a minor trade against reaching the 85% gate a day sooner.

### 6.4 Reserve sizing: daily by default, monthly the alternative

At $0.59/day, a year of service is $215.35.

| Reserve period | Ceiling | Peak blocked | Avg blocked | On-chain txs/user/yr | Gas budget per tx to stay under 1% of revenue |
|---|---|---|---|---|---|
| **1 day** | **$0.59** | **$0.59** | **~$0.30** | **~365** | **$0.006** |
| ~2 days | $1.18 | $1.18 | $0.59 | ~182 | $0.012 |
| 1 week | $4.13 | $4.13 | $2.07 | ~52 | $0.041 |
| 1 month | $17.96 | $17.96 | ~$9 | ~12 | $0.18 |
| 1 quarter | $53.88 | $53.88 | ~$27 | ~4 | $0.54 |
| 1 year | $215.35 | $215.35 | ~$108 | ~1 | $2.15 |

The last column avoids guessing Base's actual fee: it's the gas a `topUp` may cost before eating 1% of annual revenue. A `topUp` is a heavy call — two ECDSA recoveries, a USDC transfer, several storage writes — and should be measured on Base before any reserve period here is locked in (item 3).

**Default for now, not locked: daily.** Every ordinary day looks exactly like the bootstrap day in §6.3 — sign a `SpendingAuth` for today, sign a fresh `ReserveAuth` for one more day's ceiling, the peer's `topUp()` settles yesterday and extends by exactly one more day (§6.5). Day to day, one mechanism covers the whole subscription lifetime — no separate "ramp, then settle into a different rhythm" distinction — buyer blocked capital sits at its lowest possible average (~$0.30 vs. ~$9 for monthly), and the seller collects real revenue every day instead of holding valid-but-uncollected signatures for up to a month. The exception is a toggle-on-but-unsigned gap (app closed, device off): daily's ceiling tracks actual use so closely that it can't absorb a multi-day gap the way monthly's pre-loaded ceiling does, so reconnecting after one needs a dedicated two-transaction catch-up burst (§6.7) — a real, if rare, second mechanism daily needs that monthly mostly avoids. The routine cost is gas: ~365 transactions/user/year against monthly's ~12, so the per-`topUp` budget to hold the same 1%-of-revenue bar drops from $0.18 to $0.006 — nearly two orders of magnitude tighter, and not yet measured against Base's actual fee (item 3). That measurement is what could overturn this choice: if real `topUp` cost lands meaningfully above $0.006, monthly (or something between the two) becomes the better trade. This is exactly why item 4 stays open rather than resolving here — daily is the working default, not the locked answer.

Weekly or ~2-day reserve periods don't win either way: they land between daily and monthly on both axes without daily's "one mechanism, ever" simplicity or monthly's gas headroom, so they're not carried forward as a third candidate.

Under the daily default, the reserve period and the billing period are the same thing — each `topUp()` reserves exactly the next billed day, nothing more. This decoupling only matters if the monthly alternative is chosen instead: there the ceiling is a ceiling, not a commitment, while billing stays calendar-day regardless (§6.7) — a user who leaves the router switched off for stretches of the month simply signs fewer days and reaches the 85% top-up mark more slowly, with lighter usage getting cheaper gas as a side effect.

### 6.5 Lifecycle

| Moment | Actor | Call | Amount at $0.59/day |
|---|---|---|---|
| Opt-in | Client | Sign `ReserveAuth($0.59, deadline)` | Ceiling $0.59 — exactly one day's charge, well under the $1.00 `FIRST_SIGN_CAP` |
| Opt-in | Peer | `reserve()` | Locks $0.59. 1 tx |
| Start of day 1 | Client | Sign `SpendingAuth(cum = $0.59)`, before routing | Settles 100% of the $0.59 deposit — clears the 85% gate immediately |
| Day 1 | Peer | Serve routing requests | Gated on today's signature already being on file (§3.3 of the software architecture doc) |
| Day 1 | Client | Sign `ReserveAuth($1.18, deadline)` | One more day's ceiling — ramp complete, day 1 already looks like every day after |
| Day 1 | Peer | `topUp()` — settles $0.59, raises the ceiling by one more day | Locks a further $0.59. 1 tx |
| Every day *n* after | Client | Sign `SpendingAuth(cum = $0.59 × n)`, before routing; sign fresh `ReserveAuth($0.59 × (n+1), deadline)` | Today's charge, plus tomorrow's ceiling |
| Every day *n* after | Peer | `topUp()` — settles day *n−1*, raises the ceiling by one more day | 1 tx/day |
| Cancellation | Client | Stop signing | Nothing further owed |
| Cancellation | Peer | `close(finalAmount = last signed cum)` | Releases the unsettled remainder — courtesy, 1 tx |
| Cancellation, peer unresponsive | Client | `requestClose()` → 15 min → `withdraw()` | Unilateral recovery |

Three implementation details worth flagging explicitly:

- **Partial-day clamping only exists under monthly.** Under the daily default the ceiling always exactly matches the day's cumulative — there is nothing to clamp. If monthly is chosen instead, `settle()` rejects any cumulative above the deposit, so the client clamps day 2's signature to `min($0.59 × days, ceiling)`; the shortfall isn't lost, it's recovered once the ceiling rises.
- **`topUp` must fire before the ceiling is reached, not after — now on a daily rhythm rather than a monthly one.** Once the cumulative hits the ceiling the client can't sign higher, and the meter stalls silently until the next `topUp()` lands. `_needsTopUp()`'s existing 65%-of-ceiling trigger (§6.3) still fires with margin to spare — the whole cycle is one day, not thirty — but daily cadence also means 365 chances a year for a `topUp` to land late instead of 12; R16's monitoring matters just as much, at a different rhythm.
- **The two signature types must not share a code path, even though both now happen daily.** `ReserveAuth` and `SpendingAuth` authorize different things regardless of cadence (§6.1); keeping them separate in code is what lets §6.6's visibility choices be made independently of the mechanism.

### 6.6 Signing visibility

Neither signature type requires a visible prompt — both are signed with a locally-held key, with zero UI anywhere in the existing desktop or CLI code. Whether to surface either one is a **deliberate product choice**, not a mechanism requirement — though daily `ReserveAuth` removes the natural checkpoint monthly gave this decision:

| Moment | Frequency | What the mechanism requires | What we show |
|---|---|---|---|
| Funding the AntSeed deposit | Once | Nothing — AntSeed's onboarding | Nothing new |
| `ReserveAuth` | 365/yr under the daily default (~12/yr if monthly is chosen instead), plus the one-time ramp | Nothing — can be fully silent | **Open.** Monthly gave this signature a natural once-a-month "renewed your $17.96/month routing subscription" moment (§9.4, R17) tied to money the user might not be tracking. Daily removes that checkpoint — same frequency as the silent `SpendingAuth` below — without a replacement proposed yet. Revisit once item 4 (daily vs. monthly) is settled. |
| `SpendingAuth` — daily meter | 365/yr | Nothing — matches existing per-request auto-signing | Stays silent. Bounded by `$0.59 × elapsed days` and the authorised ceiling, so a compromised client caps out at a fraction of a dollar |

### 6.7 Sub-decisions

| Sub-decision | Options | Decision |
|---|---|---|
| Calendar day or active day billing | Calendar = predictable revenue, users pay for idle days. Active = fairer, self-limiting, lumpier revenue | **Calendar day, for every day the router toggle is switched on.** Not usage-based — a day is billed regardless of whether a routing call actually fired that day, but only while the toggle is on; turning it off stops signing immediately (§6.2) |
| Signing consent | Silent within a cap, vs. a visible prompt | Silent for the daily meter; `ReserveAuth`'s visibility re-opens under the daily default — see §6.6 |
| Catch-up window | Unlimited, or capped | Cap at ~30 toggle-on days; older unsigned days forgiven. Applies the same way under either cadence — it's a backlog-billing question, not a ceiling-sizing one. See below for the daily default's two-transaction mechanism |
| Deposit exhausted | Routing stops; how surfaced | Non-modal notice, fall back to timeout behaviour |
| Cross-user bulk settlement | Contract seller wallet, ask AntSeed for `settleMany`, or accept per-user tx | **Not pursuing.** Daily `topUp` cadence is already budgeted (§10) and this isn't worth the added complexity at this scale |

**The catch-up edge case, precisely.** Calendar-day billing (§6.7 above, §9.1) means every day the toggle is on is owed, whether or not the app was even open that day — the only free days are ones where the toggle was explicitly switched off in settings. So a buyer who leaves the toggle on but doesn't have the app running for a stretch — device off, app closed, no messages sent — comes back owing a real backlog, not just "today." The client tracks toggle on/off transitions locally (not just the last signed day), so only genuinely toggle-on days count toward this; toggle-off spans are free regardless of length. The owed backlog is capped at ~30 toggle-on days — anything older is forgiven rather than billed, the same rule regardless of whether daily or monthly cadence is chosen, since this is a backlog-billing question, not a ceiling-sizing one.

Settling a capped backlog under the daily default takes exactly two on-chain calls, both seller-paid, because of a real ordering constraint in the contract: `topUp()` checks the submitted `cumulativeAmount` against the *current* (pre-raise) ceiling before applying the raise (`AntseedChannels.sol:224`), so a backlog cumulative that exceeds today's small ceiling can't be settled in the same call that raises it to cover it.

1. `topUp()` — raises the ceiling straight to `backlogCumulative + $0.59` (the full backlog, plus one more day's headroom, landing the channel back in its normal steady state). The 85% settled-threshold gate is already satisfied for free here, since the ceiling being raised is the small one from the last normal day, already settled to ~100% by routine operation before the gap began — this call carries no real settlement, it exists purely to raise the ceiling ahead of what's about to be claimed.
2. `settle()` — submits the actual backlog `SpendingAuth(cum = backlogCumulative)`, now that the raised ceiling comfortably covers it.

This is mechanically the same shape as the original bootstrap ramp (§6.3) — a small step, then one larger jump — just triggered by a reconnect instead of day 1, and bounded to at most ~$18.55 (30 days × $0.59, plus one day's headroom) by the 30-day cap, which happens to land in the same range as monthly's own ceiling. Routing stays refused (§3.3's subscription gate) until this completes, the same way it's refused before day 1's first signature — the client should treat catch-up as a blocking reconnect step, not something to run in the background while already routing.

This is a real cost the daily default carries that monthly mostly avoids: monthly's ~30-day pre-loaded ceiling already covers a mid-cycle gap without any special-cased burst, since the ceiling was sized for a month up front regardless of whether every day gets used — it only needs this same two-call mechanism if the gap is long enough to run past the current ceiling and hit its own catch-up cap. Daily's ceiling tracks actual use closely instead (its whole appeal — lowest blocked capital, one mechanism day-to-day), which is exactly why a toggle-on-but-unsigned gap needs this burst as a second, less frequent mechanism.

### 6.8 What's retained, precisely

At $0.59/day the peer must know whether a caller is entitled and which days are signed, so "zero retention" is never literal. The precise statement:

- **Retained, permanently:** channel id and peer identity, subscription status, last signed cumulative amount, settlement history, and one daily performance digest (§6.9).
- **Retained, transiently:** the request itself, for as long as it takes to rank it.
- **Never retained:** prompt content, conversation structure, prefix hashes, per-request rows, or anything tying a routing decision to the message that caused it.

The public claim should be "we do not keep your conversations or your routing history" — true and checkable — rather than "we retain nothing."

### 6.9 The daily performance digest

The client already contacts the peer once a day to hand over a signed `SpendingAuth` — authenticated, once-per-day, tied to a paying subscriber, outside the request path. A fixed-size aggregate rides along on that daily cadence — same timing, not the same wire message: `SpendingAuthMetadata` (`packages/protocol/src/signatures.ts:150`) is a fixed, protocol-versioned type meant for verified per-request usage commitments, not a place to smuggle unrelated analytics, and `PaymentMux`'s message types are a closed, network-wide enum — adding one there is real protocol surgery, not a cheap addition. Sent instead as its own request over the reserved-path infrastructure §5.2/§3 already builds for routing itself — no new *protocol*, reusing infrastructure being built anyway rather than literally zero new endpoint.

| Field | Purpose |
|---|---|
| `period` | Which aggregation window these numbers belong to — currently always one calendar day, tied to §6.2's billing cadence |
| `routedRequests` | Denominator for everything else |
| `predictedCostUsd` | The router's predicted cost, summed — from the ranked response's `predictedCostUsd` (§4.4), not Sage's quality model specifically |
| `observedCostUsd` | What the user actually spent on routed requests — calibration signal against `predictedCostUsd` |
| `predictedInputTokens`, `predictedCachedInputTokens`, `predictedOutputTokens` | What the router expected, split fresh/cached — new fields on §4.4's `ranked` entry, not previously present |
| `observedInputTokens`, `observedCachedInputTokens`, `observedOutputTokens` | What actually happened — already on the local ledger (§4.6); diffed against predicted for cache-estimator accuracy, and lets Levanto compute cost at any reference model's price after the fact, not just one buyer's own dashboard baseline choice |
| `modelMix` — `{canonicalModel: count}` | Which models get chosen; feeds catalogue coverage decisions |
| `regenerations` | User hit regenerate — the tripwire for saving money by degrading answers, since no per-request cost signal exists to catch this under flat-fee pricing |
| `overrides` | User manually picked a model instead of trusting Auto — revealed-preference signal that Auto got it wrong |
| `failovers`, `timeouts` | Reliability of the ranked list and the peer in practice, not just in theory |
| `avgRoutingLatencyMs` | Time the routing call itself took — a UX cost with no other visibility |
| `cqtDistribution` — `{cqtValue: count}` | Which of the five dial positions served how many requests that period |

Not all of this is free. `predictedInputTokens`/`predictedCachedInputTokens`/`predictedOutputTokens` need the §4.4 schema extension above. `regenerations`/`overrides` need a new signal from the VPR/CLI UI that nothing currently produces. `failovers`/`timeouts` need new counters on the client's failover walk. `avgRoutingLatencyMs` needs new timing instrumentation around the routing call. `cqtDistribution` needs per-decision CQT tracking on the local ledger. Everything else — `period`, `routedRequests`, `predictedCostUsd`, `observedCostUsd`, the observed token fields, `modelMix` — is already produced somewhere for the user's own dashboard or the local ledger, so those numbers Levanto sees are exactly the numbers the user sees; the rest is genuinely new work, not just forwarding.

With a few hundred subscribers, this turns the savings figure into a measured fleet number rather than a benchmark extrapolation, and lets the cost model be calibrated against live AntSeed prices and this fleet's actual prompt lengths — something benchmarking elsewhere cannot provide. It does **not** enable retraining: with no prompts or labels leaving the device, the quality heads cannot learn from production traffic, and the digest must not grow toward that job.

Because this is per-subscriber daily data accumulating over time, `modelMix` in particular functions as a usage profile even without content. **Default on, with no opt-out: using the router means the daily digest is sent.** There is no payment-only mode. The UI states plainly what the daily call carries.

**Anonymization.** The digest is keyed by `hash(buyerPeerId)`, not the raw peer id. This lets Levanto connect a subscriber's digests across days — needed for the fleet-calibration and per-subscriber-trend value the digest exists for — without being able to tell which AntSeed peer that subscriber is. Retained permanently under the hash; the raw `buyerPeerId` never appears in the stored digest.

---

## 7. Router library and catalogue

**Catalogue coverage is a release blocker; the update cadence is not.** A router that silently declines to route models AntSeed users actually ask for reads as broken. Before release, the model hull must span the majority of what makes up traffic on AntSeed; the coverage surface already exists to show what's missing. Ongoing update ownership and SLA can be decided later.

**`prune` defaults to `False`.** Ranked-list-with-failover wants the full candidate set — dynamic dominance pruning would remove exactly the entries the client falls back to when its local policy rejects the leader.

**Tests are required before the signing path goes live.** The proxy has no coverage outside dashboard tools today. Signing code, the cumulative-day counter, and the `topUp` scheduler all move real money and need coverage before the first paid day.

**`decide()`, `decide_turn()`, and `_select` are deleted.** `_select` passes the raw prompt string where `_predicted_costs` expects a token count (`router.py:547`), which flows into `input_tokens * price_in` at `cost_ridge.py:75` — a `TypeError`, not a wrong number. It only avoids raising on pre-M4 artifacts, where a guard skips the token-count arithmetic entirely; every current trainer stamps `cost_model="ridge_m4"`, so `decide()` raises on every artifact currently shipping. `decide_turn()` inherits the bug since it delegates to `decide()`. The ranked path (`rank_candidates_from_vector`) is unaffected and is the only entry point this integration uses, so both functions are deleted outright rather than patched — a supported surface nothing exercises is how this bug survived undetected. If Levanto has callers of `decide()` outside this integration, fix the one-line argument order and add a regression test instead of deleting.

---

## 8. Product surface

**8.1 — CQT dial.** One slider, five positions, mapped to CQT values **1, 3, 5, 7, 9** on the underlying 0–10 range, default the middle position (5, "Balanced"). CQT is a relative dial, not a spend target — the UI must not promise "save X%" tied to a specific position.

**8.2 — Per-message routing signal.** A sentinel value in the existing model-selection field (e.g. `"model": "auto"`) means "let the router decide"; a deliberate model choice in the dropdown is always honored, and only the sentinel routes. No separate routing flag — the rest of the client code sees an ordinary model id. Same pattern as OpenRouter's `"openrouter/auto"`. Remaining implementation detail: confirm the exact sentinel string against AntSeed's model-selection UI.

**8.3 — Model disclosure.** The model actually used is printed as metadata at the end of the turn — not before sending, not a blocking label. Enough for trust and for support without turning every message into a routing dashboard.

**8.4 — Savings baseline (model X).** A dropdown on the savings page lets the user choose the reference model that routed costs are compared against. **The option set is a fixed, curated list of models**, not one that grows dynamically from observed `baselineSuggestion` values — this bounds how much per-model price data the `routing_decisions` ledger needs to retain per row. **Default: the most expensive, most capable flagship model available at the time — the top GPT or Claude model.** Savings recompute client-side from the ledger whenever X changes.

**8.5 — Savings display.** Gross only. The $17.96/month subscription fee is never netted against the savings figure; it's a separate, visible line item.

---

## 9. Business

**9.1 — Fee collection.** One `SpendingAuth` per elapsed day against a channel with the routing peer, held by the peer and settled daily by default against the ceiling from §6 (item 4). No new contracts required; because `SpendingAuth` is cumulative, "stockpiling signatures" while offline is automatic and settlement is always one transaction.

**9.2 — Platform fee.** 2% = $0.0118/day, ~$0.36/month. Ordinary seller, ordinary fee.

**9.3 — Sage cost exposure.** Largely resolved by the new-user-message gate (§4.2): since routing fires per user message rather than per turn, the agentic-usage cost blow-up that would have motivated a fair-use cap mostly disappears. No cap in v1; instrument and revisit.

**9.4 — Is $0.59/day the right price, and for whom?** The sharpest open business question. $0.59/day is $17.96/month (30.44 avg days) or $215.35/year — roughly double an earlier $9/month figure. Breakeven for the user:

| Realised savings | Monthly inference spend needed to break even |
|---|---|
| 60% | $29.93 |
| **40%** | **$44.90** |
| 25% | $71.84 |
| 15% | $119.73 |

At the marketed 40%, the user must already be spending ~$45/month on inference — this is a power-user product, in tension with G2's "feels like a feature" framing at this price. Billing is calendar-day, for every day the toggle is on (§6.7) — the one lever that would soften this (charging only for days actually used) is not in the design. What cuts in favor of the price as-is: users who spend $45+/month are overwhelmingly agentic, and agentic traffic is exactly what the new-message gate (§4.2) serves most cheaply, so price and cost structure are aligned. Whether the addressable market at this breakeven is large enough is a real risk (R4) — Levanto is proceeding without AntSeed's spend distribution to confirm it first, accepting the risk rather than resolving it.

**9.5 — The savings claim's baseline.** With router-quality evaluation handled outside this document, the remaining question is which baseline the marketed percentage is measured against — now the savings-page dropdown (§8.4) — and keeping it visually distinct from the savings AntSeed already claims against OpenRouter retail, so the two are never silently summed in the user's mind (§4.6).

**9.6 — The commons.** The `routing-client` plugin, the protocol/schema, the local ledger and savings computation, dashboard surfaces, the peer template, and the two extracted modules from §5.1 live in the AntSeed monorepo, open, under its licence — any future routing peer can be built against them. The cached-token estimator (§4.3) is client-side and general, so it belongs there too. **`routing-server` — the actual Levanto Sage-router implementation of a routing peer (Python sidecar, Sage calls, artifacts, training data) — lives in a separate Levanto-owned repo**, not in this monorepo. It is one implementation of the open `routing-server` role, not part of the commons; a third party would write their own `routing-server` against the same protocol rather than fork Levanto's.

**9.7 — Support and SLA.** A hosted service in a latency-sensitive path, charging $18/month, needs a defined SLA before billing begins.

**9.8 — Refunds and proration.** Resolved by the daily signing mechanism itself: stop signing, nothing further is owed (§6.2).

**9.9 — Free month for the first 200 users.** Skip signing for the first 30 days, or use `AntseedFreeUsage`. Being generous rather than exact about the count costs roughly $18/user.

---

## 10. Unit economics

**Revenue:** $0.59/day × 30.44 = **$17.96/month**, less 2% platform fee → **$17.60 net**.

**COGS.** The new-message gate (§4.2) changes the denominator: Sage fires per user message, not per turn.

| | Light (300 user msgs/mo) | Typical (600) | Heavy agentic (1,500) |
|---|---|---|---|
| Sage @ ~$0.0006–0.001/call | $0.18–0.30 | $0.36–0.60 | $0.90–1.50 |
| Routing-peer infra (amortised) | ~$0.20 | ~$0.30 | ~$0.50 |
| Channel gas — ~30 `topUp`/month at the daily default (§6.4) | ~$1.50 | ~$1.50 | ~$1.50 |
| **Gross margin** | **~$15.6** | **~$15.2** | **~$14.1** |

At the monthly alternative's 1 `topUp`/month, channel gas drops to ~$0.05 and gross margin returns to roughly ~$17.1/~$16.7/~$15.6 — the same ~$1.4–1.5/month this table shows daily costing is exactly what item 4 (daily vs. monthly, §6.4) is weighing against daily's lower blocked capital and same-day settlement.

Under a per-turn cost model, a heavy agentic user at 20,000 routed turns/month would have been −$4 to −$12/month. The message-level gate turns the previously worst-margin segment into the second-best one; the margin problem is solved, and the harder remaining question is user value at this price (§9.4).

**Fixed costs the grant offsets:** router R&D, catalogue maintenance, the commons (§9.6), and operating the routing peer.

---

## 11. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Cost model mis-calibrated against live AntSeed prices and prompt lengths | Medium | High | `predictedCostUsd` vs `actualCostUsd` in the daily digest (§6.9) |
| R2 | Catalogue does not cover the models users ask for | Medium | High | Coverage as a release gate (§7) |
| R3 | Digest scope creeps toward prompt-derived fields | Medium | High | Fixed schema, versioned, in `packages/protocol` |
| R4 | $17.96/month exceeds savings for most users | High | High | Calendar-day billing is decided (§6.7); accepted without AntSeed's spend distribution to size the addressable market first — not blocking launch on it (§9.4) |
| R5 | Routing blind to cache warmth → wrong picks | High | Medium | Wire the estimator (§4.5) |
| R6 | Buyer signs today, cancels almost immediately — pays for a day barely used | Medium | Low | Capped at one day, ~$0.59, by construction (§6.2); a deliberate trade, not a bug — the alternative moves the same bounded risk onto the seller as a free-rider exposure instead |
| R7 | Routing peer is a single point of failure | High | Medium | Timeout fallback; SLA (§9.7) |
| R8 | Losing streaming is a visible regression | Medium | High | Stream; fail over only pre-first-token |
| R9 | Python sidecar lifecycle problems | Medium | Medium | Fail closed, stop advertising |
| R10 | Per-user λ drift via `OnlineBudgetController` | Medium | Medium | Disable it (§4.5) |
| R11 | Cached-token estimate drifts on prefix invalidation | Medium | Low | Local prefix guard (§4.3) |
| R12 | Channel-open gas as a spam vector | Low | Low | Bounded by `FIRST_SIGN_CAP` + funded-deposit requirement (§6.3) |
| R13 | Gas per subscriber outruns revenue at scale | Medium | Medium | Daily `topUp` cadence by default has a far tighter margin than monthly ($0.006/tx vs. $0.18/tx to hold 1% of revenue, §6.4) — measuring real Base gas is what item 3/4 exist to resolve |
| R14 | Daily digest becomes a usage profile over time | Medium | Medium | Ten scalars, day granularity, digest keyed by `hash(buyerPeerId)` rather than raw peer id (§6.9) |
| R15 | Untested code in the money path | Medium | High | Test story before billing (§7) |
| R16 | `topUp` fires late → cumulative hits the ceiling, meter stalls silently | Medium | High | The existing 65%-of-ceiling `_needsTopUp()` trigger (§6.3) carries proportionally more margin under the daily default, since the whole cycle is one day rather than thirty — but daily also means 365 chances a year for a `topUp` to land late instead of 12, so alerting on a stalled cumulative still matters (§6.5) |
| R17 | `ReserveAuth` renewal read as a surprise charge | Medium | Medium | Under monthly, frame as a renewal notice showing days used and next ceiling; daily removes the natural moment to attach this to and is unresolved until item 4 is settled (§6.6) |
| R18 | Untrusted or spam peer prices feed into λ calibration or appear as a ranked candidate | Medium | Medium | Global reputation floor, buyer can only tighten it (§4.4) |

---

## 12. Phasing

**Phase 0 — Decide (1 week).** Measure `topUp` gas cost on Base (§13); confirm the routing channel's top-up increment wiring with AntSeed (§13).

**Phase 1 — Plumbing, unpriced (4–6 weeks).**
- *AntSeed:* extract `selectCandidatePeersForRouting` / `resolvePeerRoutePlan` into a package; extract the reputation and max-price gates from `LocalRouter` into `@antseed/router-core`; add `'routing'` capability; `/_antseed/route` schema in `packages/protocol`; optional routing methods on `Router`.
- *Levanto:* `routing-client` plugin in TS — new-user-message gate, cached-token estimator, failover walk, local ledger, policy filter, all calling the extracted libs; `routing-server` plugin + Python sidecar; peer-side AntSeed node; wire cached tokens into ranking; disable `OnlineBudgetController`; reuse `signPerRequestAuth`/`topUpReserve` for the daily meter, with a larger per-channel top-up increment for the routing peer specifically.
- *Joint:* trivial reference routing peer in the template.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 users with the daily digest on. Dial and opt-in in VPR. Two-number savings dashboard off the local ledger. **Gates:** catalogue coverage over the models this cohort actually asks for; cost model calibrated against live prices; tests on the signing path.

**Phase 3 — Launch.** Billing per the §6.5 lifecycle. Tests complete first. Free 30 days for the first 200. Routing-peer picker. Public methodology page.

**Phase 4 — Hardening.** Conformance suite. Default-selection policy.

---

## 13. Open items

Everything else in this document is decided. What's left:

**From AntSeed:**

1. Can `maxReserveAmountUsdc` be overridden per seller within one `BuyerPaymentManager`, or does the routing plugin need its own instance? (§6.3) Not needed under the daily default — the $1.00 buyer-wide default already comfortably covers the $0.59/day increment. Only becomes a real question if monthly (§6.4) is chosen instead, where the needed increment is ~$18 rather than $1.
2. `BuyerPaymentManager` needs a new, narrower public method for the daily meter — sign + persist + update-the-internal-cumulative-map + check-topup, given an externally-supplied `cumulativeAmount`, without the per-request cost computation `signPerRequestAuth` (buyer-payment-manager.ts:1162) does first. §5.1 currently describes `signPerRequestAuth` as a direct-import reuse for signing, but it's built around metered `responseStats` from a completed request and has no way to accept a flat externally-computed amount. The routing plugin should own 100% of the when/how-much decision (§6.2's daily cadence, §6.7's catch-up backlog); this method is the only new surface needed for the actual signing, since `_needsTopUp()` reads a private `_cumulativeAmount` map that only `signPerRequestAuth` currently updates — bypassing it externally would silently break the `topUpReserve()` reuse in item 1.

**From Levanto:**

3. Measure `topUp` gas on Base before locking in daily over monthly, or vice versa (§6.4).
4. Daily (default, §6.4) vs. monthly reserve cadence — not locked either way. Daily needs measured `topUp` gas near $0.006/tx to hold the same 1%-of-revenue bar monthly holds at $0.18/tx (item 3); if real Base gas lands meaningfully higher, monthly (or something between the two) is the better trade despite losing daily's simplicity, lowest average blocked capital, and same-day seller revenue. If monthly is chosen instead, its own sizing question resurfaces: should the first `topUp()` after the one-day bootstrap ramp jump straight to a full month's ceiling, or raise it by less (e.g. a week) and grow only once a subscriber shows they'll stick around? §6.4's table only weighs gas cost against average blocked capital — it doesn't weigh the risk of locking $18.55 of ceiling on a brand-new subscriber's very first successful day. Not a loss-of-funds risk — the ceiling is a maximum, not spent money, and `requestClose()`/`withdraw()` recovers it within 15 minutes — but blocked capital sitting unused until a subscriber notices and cancels is still a real cost. **A further, independent point in daily's favor, from `AntseedDeposits.sol`'s real credit-limit math (not previously weighed here): a brand-new buyer starts at exactly the $10 `BASE_CREDIT_LIMIT`, zero bonuses. Monthly's own bootstrap jump to ~$18.55 exceeds that limit outright — a brand-new buyer literally cannot complete monthly's bootstrap ramp until they've accrued credit-limit bonuses first. Daily's $0.59–$1.18 initial ceiling fits comfortably under $10 for any buyer, day one.**
5. How does versioning work for `routing-client`/`routing-server` in general, beyond the wire-protocol `"v": 1` field (§4.4), which only covers the request/response schema? Does `routing-server`'s own code version (distinct from Sage's `artifactVersion`) need tracking; does `routing-client`'s version matter given it's potentially third-party code (§G3) talking to a peer that might be a different version; how are `routing-server`/Sage deployments and rollouts sequenced without breaking in-flight requests? (The digest sub-question this originally raised is resolved: `artifactVersion`/`lambdaVersion` are dropped from the digest's field list — the routing peer stores its own λ/price calibration history directly, since it isn't user-related data, and correlates against `predictedCostUsd`/`observedCostUsd` by `period` instead.)
6. How does the buyer learn the correct daily subscription price? Nothing in §6 specifies discovery — `dailyAmountUsdc` (§6.2/§6.3) is a bare constant the buyer side is configured with, and the subscription gate (software-architecture doc §3.3) accepts whatever cumulative was signed each day without checking the amount, so the seller doesn't enforce or publish a canonical figure either. Contrast with ordinary per-token model pricing, which sellers advertise via peer metadata and the routing peer surfaces on every ranked candidate (§4.4) — the buyer can see what it will be charged before committing. The subscription fee has no equivalent: no field in the `/_antseed/route` response carries a current price, so a routing peer changing its price has no wire mechanism to communicate that, and buyer/seller configuration of the same number can silently drift out of sync with no way for either side to detect it. Genuinely unresolved — no direction chosen.
7. The cached-token estimator's exact formula (§4.3) is invented, not validated: an exponentially-weighted moving average of the observed cache-hit ratio per (conversation, model, peer) with `alpha=0.5`, plus a flat 3-minute decay window standing in for real provider prompt-cache TTL behavior. Neither the smoothing factor nor the decay window is grounded in measured cache-expiry data from any real provider — both were picked as reasonable defaults, not derived. Needs validation (or at least provider-specific tuning) against real cache-hit telemetry before the estimate can be trusted to meaningfully affect routing decisions.
8. `sagePrompt` (§4.4's wire schema) is currently sent as literal, raw last-user-turn text (head+tail trimmed for size) — not a feature vector or embedding. But the real Sage integration's own ranking entry point (`rank_candidates_from_vector` in `sage_model_router`) expects a **precomputed vector**, not raw text — its own name says so. Nothing built so far performs that conversion anywhere; the mock sidecar sidesteps the question entirely by faking quality scores mostly from the model name, barely touching `sagePrompt`'s actual content. Open question, genuinely unresolved: should feature extraction happen client-side (the buyer computes a vector locally and sends *that* instead of raw text — meaningfully more private, since prompt content would never leave the device) or server-side (the routing peer receives raw text and vectorizes it before calling Sage)? Whichever is chosen changes what actually crosses the wire in §4.4's `sagePrompt` field.
9. The toggle-on-gap catch-up burst's worst-case backlog happens to always fit within a buyer's `AntseedDeposits` credit limit under today's constants, but this isn't a structurally guaranteed relationship — worked through the actual numbers: credit limit at `K` days since first channel is `$10 + $0.50×K` (ignoring the seller-diversity bonus, worst case); worst-case catch-up backlog is `min(K, 30) × $0.59` (capped at $17.70 by `catchUpCapDays`). Checking both branches (K≤30 and K>30), the credit limit covers the worst-case backlog for every K under the current constants — so the catch-up mechanism never actually hits the credit-limit wall as things stand today. But `BASE_CREDIT_LIMIT`/`TIME_BONUS`/`MAX_CREDIT_LIMIT` are generic, protocol-wide AntSeed constants, set independently of Levanto's $0.59/day rate or 30-day catch-up cap — nothing structurally ties them together. If either side's constants ever change on their own (AntSeed lowers `TIME_BONUS`, Levanto raises its daily rate or `catchUpCapDays`), this safe margin isn't protected and needs re-checking, not assumed to still hold.

**Implemented since the list above was written:** the `allowedPeerIds` fallback model source, the usage-independent daily signing trigger, `baselinePrices` population, the real host-side `signDailyIfNeeded` wiring, `routing_decisions` ledger persistence, `Router.onResult` requestId correlation, pinned-continuation ledger rows, the subscription gate's `authMax` check, routing-peer-unreachable error handling, the sidecar-down generic error revert, the durable digest payment-history store, the digest's `/_antseed/route/digest` path suffix, and the CQT dial's Auto-selected visibility gate — see §14 and the runlog for what each one actually does and why.

**Before any savings number goes public:** state which baseline the percentage is measured against, and keep it visually separate from AntSeed's own savings-versus-retail figure (§9.5).

---

## 14. Decisions confirmed during implementation

The sections above left the following mechanisms unspecified. Each was filled in during
implementation and reviewed; they're additive to, not a replacement for, the rest of this
document.

1. **The ranking model's local call is a private implementation detail, not part of the
   `/_antseed/route` contract.** The routing peer talks to its ranking model (Sage, or a
   stand-in for it) over a single local endpoint, `POST /rank`, taking `{models: string[],
   contextTokens: number, cqt: number}` and returning `{qualities: Record<model, number>}` — a
   flat per-model quality score in [0, 1]. This lives entirely inside the routing-server's own
   process boundary and has no bearing on the public `/_antseed/route` schema (§4.4).

2. **`ConversationIdentity` lives in `packages/node`, not `apps/cli`.** `Router.selectRoute` —
   part of the public `Router` interface any router plugin, including third-party ones,
   implements — takes `conversation: ConversationIdentity | null`. The type has to live
   alongside `Router` in `packages/node` for that signature to typecheck without `packages/node`
   depending on the CLI app; `apps/cli` re-exports it from `@antseed/node` for its own call
   sites.

3. **`/_antseed/route` registration mirrors the existing `Prover`/`/_antseed/attest` pattern.**
   A seller-side plugin claims the reserved routing path the way a `Prover` claims the attest
   path: a generic `RoutingServerHandler` interface, a `registerRoutingServerHandler()` method
   on `AntseedNode` (a single slot, not a list — a seller runs at most one routing-server), and
   a dispatch branch in the seller request handler that 404s if nothing is registered and
   otherwise delegates entirely, forwarding the response as-is. `packages/node` carries none of
   the actual routing/ranking logic — only this generic registration and dispatch. The real
   handler (subscription gating, calling the ranking model, computing the ranked response) is
   instantiated and registered by the routing-server implementation itself, before the node
   starts.

4. **The new-user-message gate is keyed `${tool}:${sessionKey}`, not `parentSessionKey`.** A
   tool-loop continuation (the same last user message repeating through a tool-call/tool-result
   round trip) reuses the last routing decision with no network call; a genuinely new user
   message re-routes.

5. **A conversation with no `ConversationIdentity` to key on always routes — no content-hash
   fallback.** The gate can only pin a decision when it has something to key on; without a
   `ConversationIdentity` at all, it can't tell a tool-loop continuation apart from a genuinely
   new message, so every call routes fresh. A content-hash-based key (keying by a hash of the
   message text instead of session identity) was considered and rejected: even where it could
   pin correctly, a decision reached that way has no real conversation to attribute it to,
   which means the `routing_decisions` ledger row for it would need different handling than an
   identity-backed row — added complexity not justified just to save one network round trip on
   an edge case, versus the current behavior's simplicity and its one real cost (never silently
   skipping billing-relevant routing).

6. **A digest submission is distinguished from a routing request by an explicit
   `/_antseed/route/digest` path suffix, not body shape.** The caller states its intent via the
   URL; there is no shape-based guessing, and no ambiguity for a genuinely malformed routing
   request that happens to be missing `sagePrompt`. `packages/node`'s dispatch
   (`ANTSEED_ROUTE_PATH`) also matches `ANTSEED_ROUTE_DIGEST_PATH`, both delegating to the same
   `RoutingServerHandler.handleRoute` — no new interface method, no new plugin type, no new
   `PaymentMux` message type, no new codec; the private routing-server handler distinguishes the
   two via `req.path`, which was already part of every call. The subscription gate runs before the
   body is parsed at all for a routing request, since telling a digest apart from a routing
   request no longer requires reading the body first.

7. **The daily digest reports the day that just closed (yesterday), not a running today-so-far
   tally.** §2.7 says the digest fires on the same daily cadence as signing but doesn't say
   which day's numbers it should carry. At the moment it fires (the first routing call of a
   new calendar day), today's own ledger rows don't exist yet — and §3.6's retention model
   treats each day's digest as a permanent, accumulating record, which only makes sense as a
   closed day's tally rather than a partial one that would look different depending on when
   during the day it happened to send.

8. **A failed digest send is caught and swallowed, never surfaced or allowed to block the
   routing call it rides alongside.** Directly implements §2.7's own principle ("not required
   for correct routing to work") as code: a send failure just gets retried on the next
   `selectRoute` call rather than erroring or getting permanently stuck, and never delays or
   breaks the user's actual chat request.

9. **CQT dial position labels: "Cheapest," "Cheaper," "Balanced," "Higher quality," "Best
   quality."** §8.1 only names the middle, default position ("Balanced") — the other four
   needed some label for the UI to be usable. Kept plain and literal, respecting §8.1's own
   copy constraint that the dial is relative, not a spend target (no "save X%" language).

10. **Model disclosure's streaming-path gap (§4.6/§8.3) is fixed.** `attachStreamingAntseedHeaders`
    now attaches `x-antseed-provider`/`x-antseed-service`, resolved the same way the
    non-streaming path already does — closing the exact gap the software-architecture doc
    itself names ("a real gap... in the streaming path specifically"). The desktop UI already
    read `provider`/`service` into its per-message metadata; it just never had real streaming
    data to read, and never rendered it even when present. One line added to the existing
    per-message meta row, no new UI component.

11. **`actionSelectVprModel` special-cases `"levanto-auto"` and dispatches through
    `handleServiceChange` with no explicit peer id, instead of going through the normal
    `resolveVprChatOption` peer-scoring path.** That normal path would always return null for
    the sentinel, since no real seller advertises `"levanto-auto"` as a model. Confirmed by
    tracing the real code — not assumed — that `handleServiceChange` already treats an absent
    peer id as "no pin," falling to `'auto'` route mode with the conversation's peer left
    unset, which is exactly the "no fixed peer, buyer-proxy's `selectRoute` picks both"
    behavior Auto needs. This already existed for an unrelated reason (peer-less dropdown
    picks on other models) — no new peer-resolution or IPC machinery was actually required,
    contrary to an earlier assumption.

12. **"Levanto Auto" is pulled out of `VprModelDropdown`'s normal favoriting/recommending
    computation and rendered by its own bespoke row, in its own slot above Favorites/
    Recommended.** §4.3 explicitly asks for a dedicated slot and its own component, since
    Auto is a flat subscription with no per-token price — mixing it into the shared
    ranked/favorited list would need special-casing inside logic built for real catalog
    entries, or show a broken-looking blank price line. Reuses the dropdown's existing CSS
    classes rather than new markup.

13. **The savings dashboard's data reaches the desktop UI over the existing localhost-HTTP
    pattern (`resolveProxyPort` + `fetch` against buyer-proxy's own reserved-path admin API),
    not new IPC.** The desktop main process already talks to the buyer daemon this way for
    other data (discover-rows, metering) — added `/_antseed/routing-decisions` (GET)
    alongside those existing handlers, reading `router.getRoutingDecisions?.() ?? []`. An
    earlier pass had assumed this needed genuinely new IPC machinery; tracing how the
    existing data already reaches the desktop found the transport already there.

14. **New optional `Router.getRoutingDecisions?(): RoutingDecisionRow[]` on the shared `Router`
    interface (`packages/node`).** A router implements it if it keeps a local
    `routing_decisions` ledger; `RoutingDecisionRow` itself moved to `packages/node` too
    (previously duplicated inside `router-levanto`) so any router package can reference the
    same type without depending on Levanto's specifically. Optional and additive — a router
    that doesn't implement `selectRoute` has no reason to implement this either, so no existing
    router plugin changes. Without it, the host's savings-dashboard endpoint would have no
    generic way to read a router's ledger without hardcoding a dependency on one specific
    router package.

15. **`computeRouterSavings` implements §4.6's middle savings tier literally: actual paid vs.
    one fixed reference model's real AntSeed price at the time of each decision.** Reads
    `RoutingDecisionRow.baselinePrices` (populated per §7 in the list below) directly, keyed by
    an explicit `baselineModel` parameter that defaults to `DEFAULT_ROUTER_SAVINGS_BASELINE_MODEL`
    (`'claude-opus-5'`) until the §8.4 dropdown exists to let a buyer choose a different one. An
    earlier pass of this computation compared each row's own actual model against today's retail
    price instead, as a stand-in for this exact field not existing yet — see the runlog for that
    history; this description covers current behavior only.

16. **"Router savings" renders as its own `VprStatTile`, separate from and never combined with
    the existing "Saving"/"Saved" tile, on both `VprHomeView.tsx` and `VprActivityView.tsx`.**
    Both are actual-paid-vs-retail-reference savings by the same underlying math — Router
    savings is just scoped to the requests Auto actually routed, not all buyer usage. §4.6's
    own diagram requires them shown together, never netted into one combined number, "otherwise
    the router looks responsible for savings that actually come from AntSeed's marketplace."
    Renders only when `computeRouterSavings` returns non-null — nothing shown (not a zero or
    dash) for a buyer who's never used Auto, rather than implying the feature applies to them.

17. **`allowedPeerIds`'s re-filter fallback model is `defaultRoutedModel`** (the pre-existing
    "antseed" alias's currently-resolved target, `buyer.state.json`), passed to `selectRoute` as
    a host-owned parameter the same way `conversation` already is — not `baselineSuggestion`,
    which has no real connection to a buyer's allowlist.
18. **A routing peer that's unreachable, timed out, or responded with a non-OK status throws a
    `RoutingPeerError` from `selectRoute` instead of returning `null`.** `null` is reserved for
    exactly one case: the request's model isn't the Auto sentinel at all.
19. **The ranking-sidecar failure path returns a generic error, not a distinguishable status.**
    `/_antseed/route`'s caller is never told which internal component failed.
20. **The subscription gate additionally requires the channel's currently-signed cumulative
    (`StoredChannel.authMax`) to be nonzero**, closing the window where `reserve()`'s
    zero-amount "reserve proof" alone let a channel pass the gate.
21. **The digest submission path is an explicit `/_antseed/route/digest` URL suffix**, not
    body-shape sniffing — `packages/node`'s dispatch matches either path, both delegating to the
    same `RoutingServerHandler.handleRoute`.
22. **The routing peer keeps a durable payment-history record, separate from live
    `SellerPaymentManager` session state, so a buyer can still submit a final digest after
    closing their channel.** Recorded whenever a routing request clears the subscription gate;
    no anonymization (unlike the digest itself — decisions doc §6.8 permits retaining
    subscription status with raw peer identity).
23. **`RoutingDecisionRow.baselinePrices` is populated from a hardcoded curated model list**
    (`DEFAULT_BASELINE_MODELS = ['claude-opus-5', 'gpt-5.6-sol']` — placeholder names, pending
    the real model hull), collapsed across peers to the cheapest input-price offer per model.
24. **The `routing_decisions` ledger persists to disk as an append-only JSON-lines file** when a
    data directory is configured, surviving a buyer process restart.
25. **`Router.onResult` correlates by requestId, not peer**, so two concurrent requests routed
    to the same peer can no longer mis-pair predicted vs. actual outcomes.
26. **A pinned tool-loop continuation writes its own `routing_decisions` row**, reusing the
    predicted fields of the real decision it was pinned to, with `routingLatencyMs: null`.
27. **Daily signing has a real host-side implementation in `apps/cli`, wired via
    `Router.configureDailySigning`, and a usage-independent trigger via
    `Router.triggerDailySigningCheck`** on a background interval — both new, generic, optional
    `Router` capabilities, not specific to `router-levanto`. Handles bootstrap, ordinary days,
    and the toggle-on-gap catch-up burst (including the two-call top-up-then-settle sequence);
    full mechanics and the two design corrections this surfaced are in the runlog, not repeated
    here.
28. **The CQT dial is visible only when "Levanto Auto" is the currently selected model.**

See the runlog for the full implementation history behind items 17–28 above — what each one
actually does, why, and what alternatives were considered.

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
