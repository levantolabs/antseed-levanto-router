# Model Routing on AntSeed — Architecture and Open Decisions

**Status:** Draft. Sections A–C resolved; pricing model decided (`$0.59/day`); sections D and F still open.
**Scope:** Integrating the Levanto router into AntSeed as a **client-side routing plugin that replaces `router-local`**, talking to a **routing peer** — a new peer role that Levanto would be the first of.

**Sources studied**

| Repo / branch | Role |
|---|---|
| `antseed-levanto-router` @ `main` | AntSeed monorepo — the host |
| `levantolabs/levanto-router-proxy` @ `master` | Working reference implementation of the buyer-side router |
| `levantolabs/sage_model_router` @ `rank-from-precomputed-vector` | The production router library |

---

## 0. How to read this

Sections 1–4 describe the architecture as now decided. Section 4 changed again: **routing now fires only on a new user message** (`D16`), the cached-token math moved to a simple client-side estimator (`D18`), and the ledger is **client-side only** because the routing peer is **zero-retention** (`D27`).

Section 5 is the decision ledger: **5.0** status for everything, **5.1** resolved decisions with consequences, **5.2** the four still needing work, **5.3** newly-created issues, **5.4** sections D–F.

Sections 6–9 cover economics under the new `$0.59/day` model, risks, phasing, and open asks.

---

## 1. Summary

### The shape

- **`routing-client` plugin** (TypeScript, in the buyer). **Replaces `router-local`** — they do not run together. Holds the CQT dial, the per-conversation cached-token estimate, the failover walk, the local ledger, and the final say on policy. Calls the peer **only when there is a new user message**.
- **`routing-server` plugin** (TypeScript shell + Python sidecar, on the routing peer). Runs its own AntSeed node for global price discovery, recalibrates λ globally, calls Sage, ranks `(model, peer)` tuples, returns prices with the ranking, **and forgets everything**.
- **`routing` capability** on the DHT so routing peers are discoverable and replaceable.

**The rule:** the peer is a pure function — conversation in, ranked candidates plus prices out. All state, all history, all savings math lives on the client.

### Pricing

**$0.59/day**, shown as a continuous per-day cost on the opt-in toggle. Under the hood the AntSeed client signs **one `SpendingAuth` per elapsed day** against a channel with the routing peer, catching up on days the client was offline. The peer holds the signatures and settles on-chain monthly.

This works with **today's contracts — no new Solidity** (`D35`), and makes cancellation and proration trivial (stop signing). Because `SpendingAuth` is cumulative and never expires, the daily meter costs **nothing on chain**: the peer submits only its newest signature, so one transaction collects any number of days, and a user who switches the router off simply stops advancing the counter.

`5.4` works the mechanism through and carries the lifecycle spec. The short version: `ReserveAuth` and `SpendingAuth` are not alternatives — one locks funds, the other spends them — and the real knob is the size of the ceiling each `ReserveAuth` sets. `FIRST_SIGN_CAP` is **$1.00**, which is 1.7 days of service and forces a two-step signup (`N9`), after which `topUp()` settles and renews in a single transaction. **Decided: a monthly ceiling** — one transaction per user per month, ~$18 blocked at peak and ~$9 on average, and a 15-minute unilateral exit for the user.

Two things the price changes materially: it roughly **doubles the old $9/month figure to ~$17.96/month**, moving the user breakeven from ~$22.50 to **~$44.90/month of inference spend** at 40% realised savings (`D39`); and because `SpendingAuth` carries **no deadline**, the client must never pre-sign future days (`N7`).

### What is already built

Live dynamic per-peer pricing, ranked `(model, peer)` output, precomputed-vector input, price-independent training, failover with sinbin demotion, multi-turn handling, and a 14-table audit ledger all exist on the production branch plus the proxy.

### What is not

**The cached-input math is built but not wired.** `cache_model.py` computes exactly the right thing and exposes `effective_in()` — which is **never called**. Ranking passes one scalar `ctx_tokens` and `PriceBook` carries no cached rate, so the router prices every candidate as a cold cache. That systematically under-values whichever seller already holds the conversation prefix. `D18` now has a much simpler wiring plan than before, because the client can just report observed cached tokens.

### What still decides viability

Router quality and its evaluation are settled outside this document (`D28`–`D30`, removed). What remains open here is commercial and operational:

1. **Who this is for at $0.59/day** (`D39`). Breakeven is **~$45/month of inference spend** at 40% realised savings, which makes this a power-user product unless billing is per *active* day. That single sub-decision is the difference between a feature a casual user switches on and a subscription only heavy agentic users can justify — and it needs AntSeed's spend distribution to settle.
2. **Catalogue coverage** (`D31`). Not the update cadence, which can wait, but the hull spanning the models AntSeed users actually ask for. A router that declines to route common models reads as broken. **Release blocker.**
3. **The signing path is untested** (`D33`), and must not be the first code that exercises real money. `D34`'s `decide()` bug — which only ever affected a dead entry point, now deleted — is the concrete reason that bar exists.

---

## 2. Goals and non-goals

| # | Goal | How we will know |
|---|---|---|
| G1 | A great model router for AntSeed users | Measured savings at matched quality on **AntSeed's real traffic** |
| G2 | Feels like a feature, not a product | One toggle and one dial in VPR; no new accounts or installs |
| G3 | Open | A third party ships a competing routing peer from public docs |
| G4 | Levanto builds the reusable commons | Client plugin, protocol, ledger, dashboard live in AntSeed packages |
| G5 | Sustainable for Levanto | Subscription plus grant covers R&D, catalogue, commons |

**Non-goals for v1:** other networks; non-text modalities; ensembling or cascading.

---

## 3. What exists today

### 3.1 What `router-local` actually contains

This is the map `D8` asked for. The conclusion: **almost everything valuable is outside the plugin and directly callable.**

| Capability | Where it lives | Callable from a new plugin? |
|---|---|---|
| Cooldown / failure-streak | `PeerMetricsTracker`, `computeFailureCooldownMs` — **exported from `@antseed/router-core`** | **Yes** |
| Peer scoring + weights | `scoreCandidates`, `DEFAULT_WEIGHTS` — **exported from `@antseed/router-core`** | **Yes** |
| Peers able to serve a model | `buildNetworkServiceOffers` — `packages/node/src/discovery/service-catalog.ts:162` | **Yes** |
| Model-route ranking | `rankModelRoutes`, `chooseBestModelRoute` — `packages/node/src/routing/model-route-ranking.ts:191,202` | **Yes** |
| Model name canonicalisation | `canonicalModelKey` — `@antseed/node` model-identity | **Yes** |
| Protocol / service compatibility | `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` — **`apps/cli/src/proxy/routing.ts:231,281`** | **No — app code** |
| Reputation floor + max-price gate | `LocalRouter` **private methods** — `plugins/router-local/src/router.ts:136-275` | **No — private to the plugin** |
| `LocalRouter.selectPeer()` | the plugin | **Dead in production** — the CLI never calls it |

So the plugin's only genuinely unique content is a reputation gate and a price gate, both written as private methods. Two behaviour-preserving extraction refactors make everything reusable — see `5.2 / D8`.

### 3.2 Other relevant AntSeed seams

**Cached tokens are already reported to the buyer.** The seller reports `cachedInputTokens` in the payment negotiation, and the buyer reads it as `reportedCachedInputTokens` (`packages/buyer-core/src/buyer-payment-manager.ts:1225-1235, 1434`). **This is the ground truth the client needs for `D18`** — no new plumbing.

**`SpendingAuth` has no deadline.** `SpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes32 metadataHash)` — no expiry field, unlike `ReserveAuth` which has one. A signature for a higher cumulative amount can be settled by the seller at any time (`N7`).

**`reserve()` is seller-called, requires the seller to be staked, and is capped at `FIRST_SIGN_CAP` = $1.00** (`AntseedChannels.sol:149-163`). The routing peer pays gas to open a channel per subscriber, and channels grow only via `topUp()` (`5.4`).

**Savings UI already ships** and reads local data: `computeMeasuredSavings` compares actual USDC against retail re-pricing, in VPR Home, VPR Activity, and `antseed buyer activity`.

**Payments.** Cumulative channels; `computeCostUsdc` handles `cachedInputUsdPerMillion`; buyer re-verifies against a 1.4× tolerance; 2% platform fee.

### 3.3 The Levanto router-proxy

Implements the whole buyer-side loop: tokenize → trim to 4096 → Sage → rank against a live `PriceBook` → filter purchasable → sinbin → walk the list with `x-antseed-pin-peer` → bill at the seller actually used → observe cache warmth → log everything.

Decisions worth keeping: provider and prices switch together; bill at the seller actually used; recall deliberately **not** seeded from history (scoring a hit against the whole prompt read as 46% recall where measurement showed 99%); warmth keyed on **prefix, not conversation id**.

Limitations: no streaming; Sage on every request; no unit tests outside dashboard tools. Two dependencies this design removes: prices from `buyer.state.json`, and the artifact loaded in-process on the client.

---

## 4. Architecture

### 4.1 Component map

```
┌───────────────────────────────────────────────────────────────────────────┐
│ BUYER (VPR / CLI)                                                         │
│                                                                           │
│   routing-client plugin  — REPLACES router-local, calls the same libs     │
│                                                                           │
│     STATEFUL (all of it, per user):                                       │
│       · CQT dial                                                          │
│       · per-conversation: current (model, peer), last observed            │
│         cachedInputTokens + promptTokens + timestamp                      │
│       · routing_decisions ledger  →  the savings dashboard                │
│       · cooldown via @antseed/router-core PeerMetricsTracker              │
│                                                                           │
│     GATE:  new user message?  ──no──►  reuse current (model, peer),       │
│                                        never call the peer      (D16)     │
│                                 yes                                       │
│                                  ▼                                        │
│       · estimate expected cached tokens per candidate           (D18)     │
│       · POST /_antseed/route   [1s hard timeout]                (D20)     │
│       · re-filter locally — local has the last word             (D9)      │
│       · walk list; stream; fail over only pre-first-token       (D19)     │
│       · write ledger row from the returned price snapshot       (D27)     │
│       · sign one SpendingAuth per elapsed day                   (D35)     │
└──────────────────────┬────────────────────────────────────────────────────┘
                       │ POST /_antseed/route
                       ▼
        ┌────────────────────────────────────────┐
        │ ROUTING PEER   (capability: 'routing')  │
        │   routing-server plugin → Python sidecar│
        │                                         │
        │   PURE FUNCTION — ZERO RETENTION (D27)  │
        │     · own AntSeed node → global prices  │
        │     · λ by cqt, recalibrated every      │
        │       10 min on RAW prices        (N4)  │
        │     · Sage (trimmed last user turn)     │
        │     · rank (model, peer) tuples         │
        │     · return ranking + price snapshot   │
        │     · forget                            │
        └────────────────────────────────────────┘
```

### 4.2 The routing gate: only on a new user message

`D16` replaces the whole Sage-caching question with a rule: **the client calls the routing peer only when the conversation has a new user message.** During an agentic loop — tool calls, tool results, assistant turns — the plugin reuses the current `(model, peer)` and makes no call at all.

Three things follow, and they are all good:

1. **Sage cost collapses for agentic traffic.** Cost scales with user messages, not turns. This is what fixes the heavy-user margin problem in §6.
2. **Latency disappears from the loop.** The 1 s routing budget is paid once per user message, not once per iteration.
3. **It is the correct behaviour anyway.** Switching model mid-loop throws away the seller's warm cache, so the whole conversation gets re-billed at fresh input rates. Staying put is usually right.

The one thing to watch: over a long loop the prompt can grow 10× while the decision stays fixed. *Sub-decision for Levanto:* also re-route when context tokens have grown past some multiple (say 4×) since the last decision. Worth measuring before adding.

Implementation is a counter, not a cache: track the index or hash of the last user message that triggered a routing decision; if the current request's last user message matches, skip.

### 4.3 The cached-token math — client estimates, peer applies

`D18` asked which of two designs to use. **Option 2 — the client sends a per-candidate estimate of expected cached tokens — is the right one**, and `D27`'s zero-retention requirement settles it: a stateless, forgetful peer cannot learn per-seller cache behaviour, so the estimate must come from the side that observes actual billing.

Two quantities were being conflated. To be explicit:

| Quantity | Question it answers | Whose state |
|---|---|---|
| **Warmth** | "How many tokens of *this* conversation does seller S already hold?" | **The client's.** Only it knows what it sent, and only it sees `cachedInputTokens` come back |
| **Recall** | "When a seller has seen a prefix, what share actually comes back billed as cached?" | Would be global — **but zero retention removes it** |

Without global recall learning, the client uses the simplest honest estimator: **what actually happened last turn.** AntSeed already reports `cachedInputTokens` per request, so the client observes the truth rather than modelling it.

```
For the (model, peer) currently in use:
    observedRatio  = cachedInputTokens / promptTokens        (from last turn, EMA'd)
    expectedCached = min(previousPromptTokens * observedRatio, currentPromptTokens)
    decay if the last turn is older than the seller's observed cache lifetime

For any (model, peer) not used in this conversation:
    expectedCached = 0
```

That last line is not a limitation — it is correct, and it produces exactly the right economics. A candidate we have never used holds none of our prefix, so it will bill the whole conversation at fresh input rates. Pricing it that way gives the incumbent a **natural, correct stickiness** that falls out of the cost model rather than being bolted on.

Why not option 1 (send both prompts and let the peer compute the shared prefix): it sends more conversation text off the device for no gain, and a zero-retention peer cannot do anything smarter with it than the client already can.

**One caveat worth handling:** a simple ratio silently over-estimates if the conversation's prefix is invalidated — system prompt edited, history truncated, a branch. A cheap local guard (hash the first few messages, reset the estimate if it changes) costs almost nothing and stays entirely on the device.

### 4.4 Request shape

```jsonc
// POST /_antseed/route          — sent only on a new user message (D16)
{
  "v": 1,
  "cqt": 5,
  "sagePrompt": "…trimmed last user turn, head+tail 4096 tok…",   // D15, D21
  "contextTokens": 18422,                    // full billable prompt length
  "expectedCachedTokens": [                  // integers only — no hashes (D25)
    { "model": "kimi-k3", "peer": "0x…", "tokens": 16000 }
  ],
  "constraints": { "maxInputUsdPerMillion": 25, "minTrustScore": 60,
                   "blockedPeerIds": ["0x…"] }               // N3
}

// 200 OK — everything the client needs to do its own savings math (D27)
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

The `price` blocks are what let the client write a complete ledger row and compute savings without ever holding a price table — and without the peer keeping anything.

### 4.5 The two savings numbers — computed entirely on the client

```
  Retail baseline (OpenRouter list price for baseline model X)
        │   ← "AntSeed savings"   (already shipped: computeMeasuredSavings)
        ▼
  AntSeed baseline (model X at the AntSeed price at time of inference)
        │   ← "Router savings"    (NEW — from the returned baselineSuggestion)
        ▼
  Actual paid (routed model at the AntSeed price at time of inference)
```

Both shown with the middle line visible, or the router appears responsible for savings that come from AntSeed's marketplace.

---

## 5. Decision ledger

### 5.0 Status

| # | Decision | Status | Resolution |
|---|---|---|---|
| D1 | Plugin attachment | **Resolved** | Option A — a `'router'`-type plugin that extends the same interface |
| D2 | `routing` capability | Resolved | Yes. Two plugins: `routing-client`, `routing-server` |
| D3 | Python vs TypeScript | Resolved | Client fully TS; server plugin runs Python in a sidecar |
| D4 | Peer/plugin split | Resolved | Peer does Sage + ranking |
| D5 | Schema ownership | Resolved | `packages/protocol`, versioned, with a conformance template |
| D6 | One router or several | Resolved | One at a time, user-selectable |
| D7 | Models or (model, peer) | Resolved | `(model, peer)` tuples |
| D8 | Reuse vs recode | **Resolved — see 5.2** | Call the same libs; two extraction refactors needed |
| D9 | Local policy | Resolved | Local has the last word |
| D10 | Protocol versioning | Resolved | Move fast, break things |
| D11 | Where prices come from | Resolved | Peer only; global discovery + global λ |
| D12 | Refresh cadence / λ | Resolved | Fixed 10-min interval, λ version in the receipt |
| D13 | Model canonicalisation | Resolved | AntSeed's canonicaliser |
| D14 | Unknown models | Resolved | Surface coverage; alias aggressively |
| D15 | Sage trimming | Resolved | Head+tail to 4096 tokens |
| D16 | When to route | **Resolved** | **Only on a new user message.** No Sage cache needed |
| D17 | Per-request CQT | Resolved | Client config, sent as a param; peer stateless |
| D18 | Cached-token math | **Resolved** | **Option 2** — client estimates from observed metadata |
| D19 | Streaming vs failover | Resolved | Stream; fail over only before the first token |
| D20 | Latency budget | Resolved | 1 s timeout → current model → else a big/top model |
| D21 | What leaves the machine | Resolved | Sage: trimmed last turn. Peer: + integers and constraints |
| D22 | Opt-in granularity | Deferred | Ignore for now |
| D23 | Peer retention | **Resolved** | **Zero retention** |
| D24 | Training on prompts | **Resolved** | No — and see `N5` |
| D25 | Prefix hashes | **Resolved** | None leave the device; none needed at all under `D18` |
| D26 | Router self-dealing | Deferred | Ignore |
| D27 | Ledger location | **Resolved** | **Client-side.** Peer returns prices, then forgets |
| N1 | Ledger vs neutral dashboard | **Closed** | Dissolved by `D27` — client-side ledger is the commons |
| N2 | Outcome feedback channel | **Closed** | Moot under zero retention |
| N3 | Candidate-set mismatch | **Resolved** | Client sends constraints; peer stays stateless; list absorbs the rest |
| N4 | λ vs cache calibration | **Resolved** | λ on raw prices; blending at runtime scoring only |
| N5 | Zero retention vs evidence | **Resolved** | One daily aggregate riding the payment call. No new endpoint |
| N6 | Zero retention vs billing state | **Resolved** | Retention redefined and enumerated — see 5.3 |
| N7 | Pre-signing risk | **Resolved** | Sign in arrears only. `SpendingAuth` has no deadline |
| N8 | Channel gas per subscriber | **Resolved** | See 5.4 — one transaction per user per month |
| N9 | `FIRST_SIGN_CAP` is $1.00 | **NEW — open** | Forces a two-step channel ramp at signup. AntSeed input needed |
| N10 | No cross-user batch settlement | **NEW — open** | Needs a contract seller wallet, or accept per-user transactions |
| D28–D30 | Evidence, quality measurement, shadow sampling | **Removed** | Out of scope — benchmarking happens outside this integration |
| D31 | Catalogue ownership and SLA | **Deferred** | Not now. Catalogue *coverage* is a release blocker |
| D32 | Artifact and `prune` | **Resolved** | `prune = False` |
| D33 | Tests before the money path | **Resolved** | Yes. Blocking |
| D34 | `decide()` raises on every current artifact | **Resolved** | Delete `decide()`/`decide_turn`/`_select` — see 5.6 |
| D35 | Fee collection mechanism | **Resolved** | Daily `SpendingAuth`; **monthly ceiling**; one `topUp`/user/month. Lifecycle in 5.4 |
| D36–D45 | Business | **Mostly resolved by $0.59/day** | See 5.5. `D39` is the live one |
| D46–D51 | Product surface and launch | **Open** | Section F unanswered |

---

### 5.1 Resolved — consequences worth recording

**D16 — routing only on a new user message.** The single highest-leverage decision in this round. It removes the Sage-cache design entirely, collapses agentic COGS (see §6), removes routing latency from the inner loop, and matches the cache-warmth incentive. Implementation is a counter, not a cache.

**D18 + D25 — the client estimates, no hashes anywhere.** Because AntSeed already reports `cachedInputTokens` back to the buyer, the client observes the truth rather than modelling it. That means no prefix hash chain, no `_seen` table, no recall learning — a large simplification against both the proxy's current design and my previous proposal. The wire carries integers.

The remaining router-library work is smaller than before:

1. `PriceBook.PerToken` gains a cached rate: `(price_in, price_out, price_cached_in)`.
2. `Catalog.book()` stops discarding `cached_in` — it already has it on `Quote`.
3. `rank_candidates_from_vector` accepts per-candidate `expectedCachedTokens` instead of one scalar for all candidates.
4. Cost becomes `expectedCached × price_cached_in + (contextTokens − expectedCached) × price_in + completion × price_out`.
5. λ calibration does **not** use the blended rate (`N4`).

**N4 — cache math at runtime, λ on raw prices.** Confirmed. Scoring is `quality − λ · cost`: λ is a global exchange rate, cache blending is a per-candidate cost adjustment, and they compose without λ becoming per-user. Residual effect is a known downward bias in realised spend versus the nominal CQT budget; measure it, and correct globally if it exceeds a few percent. Related: **disable `OnlineBudgetController`** (`router.py:194-216`), which nudges λ from realised spend using in-process state and would reintroduce exactly the per-client drift we are avoiding.

**D27 + D23 + D24 — zero retention.** The peer returns prices with the ranking and keeps nothing. This kills my `N1` concern outright: the ledger is client-side, so the savings dashboard stays neutral and works with any routing peer. It also makes `N2` moot. But it creates `N5` and `N6` below.

**D9 + D20 — fallback order.** On timeout: stay on the current model; if none, a big/top model. Note this is also the `D16` gate's fallback, so the two share one code path.

---

### 5.2 Resolved with detail

---

**D8 — Reuse, don't recode. And can we actually replace `router-local`?**

*Your direction: call the same capabilities wherever possible; highlight where it is not possible; replace `router-local` rather than run alongside it.*

**Reuse map — what the new plugin calls rather than reimplements:**

| Capability | Call | Status |
|---|---|---|
| Cooldown / failure-streak | `PeerMetricsTracker`, `computeFailureCooldownMs` from `@antseed/router-core` | **Direct import** |
| Peer scoring | `scoreCandidates`, `DEFAULT_WEIGHTS` from `@antseed/router-core` | **Direct import** |
| Peers serving a model | `buildNetworkServiceOffers` from `@antseed/node` | **Direct import** |
| Model-route ranking | `rankModelRoutes` from `@antseed/node` | **Direct import** |
| Model canonicalisation | `canonicalModelKey` from `@antseed/node` | **Direct import** |
| Payment / signing | existing buyer payment manager | **Direct import** |

**Where reuse is not possible today — two behaviour-preserving extractions:**

| Blocked capability | Where it is stuck | Fix |
|---|---|---|
| Protocol / service compatibility matching | `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` in `apps/cli/src/proxy/routing.ts` — **app code, not a package** | Move to `@antseed/node` (or a small shared package). No behaviour change |
| Reputation floor + max-price gate | `LocalRouter._effectiveReputation`, `_resolvePeerOfferPrice`, `_resolveBuyerMaxPrice`, `_offerExceedsMaxPrice` — **private methods** in `plugins/router-local/src/router.ts` | Extract to `@antseed/router-core` as pure functions; `router-local` then calls them too |

Both are small, both benefit any future router, and neither changes behaviour. **These are the only places we would otherwise be forced to recode.**

**The replacement question — now settled as Option A.** You asked for replacement, not coexistence, and confirmed the same type and interface, extended, with a different router behind it. That closes `D1` on Option A. The reasoning, kept because it is the load-bearing argument for the plugin shape:

- `node.setRouter()` takes **one** router. The buyer proxy reads policy gates off it via `peerAllowedByPolicy` (`buyer-proxy.ts:206-212`).
- If `routing-client` is a **new type** (`'routing'`), then `router-local` occupies the `'router'` slot independently. Both load. That is exactly the coexistence you rejected — and worse, if the user disables `router-local` to avoid it, the reputation and max-price gates **silently vanish**, because with no router plugin `peerAllowedByPolicy` permits everything.
- If `routing-client` is a **`'router'`-type plugin** that implements `Router` (including `allowsPeerForPolicy` / `allowsPeerForPricing` / `onResult`) plus the new routing methods, it drops into the same slot and **replaces `router-local` by construction**. One router, one config surface, gates preserved.

| Option | Replaces cleanly? | Plugin-system change |
|---|---|---|
| **A. `routing-client` is a `'router'`-type plugin with routing extensions** | **Yes, by construction** | Optional methods on `Router` only — the smallest change of all |
| B. New `'routing'` type + loader enforces mutual exclusion with `'router'` | Yes, but by policing | New type, loader, registry, config, plus exclusion logic |
| C. New `'routing'` type, both load | **No** — you rejected this | New type and machinery |

**Decided: A.** `routing-client` implements the existing `Router` interface in full — `allowsPeerForPolicy`, `allowsPeerForPricing`, `onResult` — plus the new optional routing methods, and registers as a `'router'`-type plugin. It occupies the single `node.setRouter()` slot, so it replaces `router-local` by construction rather than by policing, the policy gates keep working because the same extracted functions back both routers, and the plugin system needs only optional method signatures added to one interface.

The `routing-server` side is unaffected and is best modelled on the existing `Prover` pattern — seller-side, serves a reserved path (`/_antseed/route` alongside `/_antseed/attest`), no models, no token pricing.

**Remaining AntSeed ask:** land the two extractions in the table above, and accept the optional methods on `Router`. Neither changes existing behaviour.

---

**N3 — The peer ranks globally; the client can only buy from a subset. RESOLVED.**

*Your direction: the routing plugin sends these variables to the server, which stays stateless; and the client gets a list anyway, so it can fall back to the next entry.*

Agreed, and the two halves cover the problem completely. The client sends `constraints` in the request (`4.4`): `maxInputUsdPerMillion`, `minTrustScore`, `blockedPeerIds`, and the reachable-peer set. The peer applies them as a **filter on the candidate set for this one request** and retains nothing — constraints arrive with every call, so there is no per-client profile to store and the peer stays a pure function.

The ranked list is the backstop. Anything the constraints miss — a peer that goes unreachable between the request and the call, a cooldown that fires in the interim, a policy the peer version doesn't understand yet — is absorbed by the client walking to the next entry. Because `rank_candidates` returns a **flat list of `(model, peer)` pairs ordered by score** rather than a grouped structure, the next entry may be the same model from a different seller or a different model entirely, whichever the objective actually ranks higher. So a stale constraint degrades the choice rather than breaking it.

Two implementation notes: peers found unreachable get appended to `blockedPeerIds` over time, which is the same signal `PeerMetricsTracker` already produces, so no new tracking is needed; and the client re-filters locally regardless of what the peer did, because `D9` gives local policy the last word.

---

### 5.3 Newly created by these answers

---

**N5 — Evidence under zero retention. RESOLVED: one daily aggregate, carried by the payment call.**

*Your direction: performance data that supports the claim that the product works, but minimal, and not on new calls — for example on the daily payment-authorisation call.*

That is the right hook, and it is a better one than it first appears. The client already has to contact the routing peer once a day to hand over a signed `SpendingAuth` (`D35`). That call is **already authenticated, already once-per-day, already tied to a paying subscriber, and already not in the request path**. Attaching a fixed-size aggregate to it costs no new endpoint, no new connection, no new consent moment beyond the one we have to build anyway, and it is structurally impossible to make it per-request because it fires once a day.

**The digest.** One object per subscriber per UTC day, alongside the signature:

| Field | Why it is needed |
|---|---|
| `day`, `cqt`, `artifactVersion`, `lambdaVersion` | Without these no measurement can be attributed to a configuration |
| `routedRequests` | Denominator |
| `actualCostUsd` | What the user actually spent on routed requests |
| `baselineCostUsd` | Same requests priced at the baseline model (`D49`) at the prices of the moment — **this is the savings claim** |
| `predictedCostUsd` | Against `actualCostUsd`, this is the only calibration signal for the cost model |
| `modelMix` — `{canonicalModel: count}` | Which models actually get chosen. Drives catalogue coverage (`D31`) |
| `regenerations`, `overrides` | The cheapest available signal that the router is not saving money by degrading answers |
| `failovers`, `timeouts` | Reliability of the ranked list and of the peer itself |

Roughly ten scalars and a short map. **No prompts, no per-request rows, no timestamps finer than the day, no prefix hashes, no conversation structure, no peer-level spend detail.** Everything is a sum already computed for the user's own dashboard, so the client is not instrumented twice and the numbers Levanto sees are literally the numbers the user sees.

**What this does and does not buy.**

With a few hundred subscribers reporting `actualCostUsd` against `baselineCostUsd`, the savings figure shown on the dashboard becomes a measured fleet number rather than an extrapolation, and `predictedCostUsd` against `actualCostUsd` tells us whether the cost model is calibrated on real token distributions — which is the one thing benchmarking elsewhere cannot tell us, because it depends on AntSeed's live prices and this fleet's prompt lengths. Regeneration and override rates give a cheap tripwire for the failure mode that matters commercially: saving money by degrading answers.

It does **not** enable retraining, and it is not an evaluation channel. There are no prompts, no features and no labels, so nothing here feeds the quality heads. Router quality is established outside this integration (`D28`–`D30`, removed), and the digest should not grow toward that job — the moment it needs prompt-derived fields, it has become something the user did not agree to.

**Two things to decide.** First, this is per-subscriber daily data accumulating over time, which is a usage profile even without content — `modelMix` is the most identifying field. Second, whether it is mandatory or refusable. *Lean: default on, one visible toggle to send payment-only, and say plainly in the UI what the daily call carries. Bundling it into the payment call makes it honest — there is exactly one daily conversation with Levanto and the user can see what is in it.* Owner: Joint.

---

**N6 — Zero retention versus knowing who has paid. RESOLVED by enumeration.**

At $0.59/day the peer has to know whether a caller is entitled and which days have been signed, so "zero retention" was never literal. Combined with `N5`, the honest statement of what the routing peer stores is:

**Retained, permanently:** channel id and peer identity, subscription status, last signed cumulative amount, settlement history, and the daily digest from `N5`.

**Retained, transiently:** the request itself, for as long as it takes to rank it. Nothing derived from it survives the response.

**Never retained:** prompt content, conversation structure, prefix hashes, per-request rows, which model was chosen for a given request, or anything that ties a routing decision to the message that caused it.

The marketing line should be "we do not keep your conversations or your routing history", which is true and checkable, rather than "we retain nothing", which is not. Owner: Levanto.

---

**N7 — Never pre-sign future days. RESOLVED.**

`SpendingAuth(channelId, cumulativeAmount, metadataHash)` has **no deadline and no nonce** — confirmed at `AntseedChannels.sol:460-476`, where the struct hash covers exactly those three fields. `ReserveAuth` does carry a deadline. So a `SpendingAuth` for a higher cumulative amount is valid forever and can be settled by the seller at any moment.

If the client pre-signed 30 days ahead to reduce prompts, the routing peer could settle the whole month immediately, and a user who cancels on day 2 would already have paid for 30. **The client signs only for days that have elapsed.** Catch-up after an offline period is fine — those days did elapse.

Two guards in the client: a hard rule that the cumulative for day *n* never exceeds `$0.59 × n`, and a user-visible daily cap so a compromised or buggy peer cannot induce an inflated signature. This is also what makes `D45` true: stop signing, owe nothing further.

---

**N8 — Channel gas per subscriber. RESOLVED — see 5.6.** The answer turns out to be one transaction per user per month, and the spam concern is handled by the ramp in `5.6` rather than by a deposit requirement.

---

### 5.4 The payment mechanism — `SpendingAuth`, `ReserveAuth`, and a daily meter

*Your question: tradeoffs between `SpendingAuth` and `ReserveAuth` at one-day, one-week and one-month amounts, keeping a daily on/off switch — covering money blocked, purchasing friction, gas with bulk collection, and technical complexity.*

**First, a reframe: they are not alternatives.** Reading `AntseedChannels.sol` closely, the two authorisations do different jobs and every design needs both.

| | `ReserveAuth(channelId, maxAmount, deadline)` | `SpendingAuth(channelId, cumulativeAmount, metadataHash)` |
|---|---|---|
| Authorises | **Locking** funds into a channel | **Spending** funds already locked |
| Consumed by | `reserve()` (open), `topUp()` (raise ceiling) | `settle()`, `topUp()`, `close()` |
| Expires? | **Yes** — carries a deadline | **No deadline, no nonce** (`:460-476`) |
| Semantics | Sets a ceiling | Cumulative running total, monotonic |
| Effect on the user's money | Makes it unavailable for other purchases | Actually transfers it |

So the choice is not "which one". It is **how large a ceiling each `ReserveAuth` sets**, and **how often we go on-chain to collect** — and those two are much more coupled than they look, for a reason the contract forces on us below.

**The good news first: the daily on/off switch is free.** Because `SpendingAuth` is cumulative and never expires, "one signature per elapsed day" requires *no on-chain activity at all*. Day 12 of use is a signature for `$0.59 × 12`; the peer discards day 11's, since `settle()` only accepts a cumulative above what is already settled (`:264`). A user who switches the router off for a week simply doesn't advance the counter, and the next signature they produce is for the correct number of *used* days. The stockpile self-collapses: the peer only ever submits the newest signature it holds, so **settlement is one transaction no matter how many days accumulated**. There is no per-day gas, no per-day prompt, and no reconciliation logic. This is the part of the design that works out unusually well.

**Now the constraint that decides everything else.**

```solidity
if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();   // :163
```

`FIRST_SIGN_CAP = 1_000_000` — USDC has 6 decimals, so **$1.00**. This check is unconditional inside `reserve()`, meaning it applies to *every newly opened channel*, not just a buyer's first ever. At $0.59/day, **$1.00 is 1.7 days of service**, and there is no way to open a channel with a month in it.

The escape from a small ceiling is `topUp()`, which raises it — but only once **85%** of the current deposit is settled (`TOP_UP_SETTLED_THRESHOLD_BPS = 8500`, checked at `:229-230`). And closing a channel to reopen a bigger one doesn't help, because the new `reserve()` is capped at $1.00 again.

**Three consequences follow, and they are forced rather than chosen:**

1. Each subscriber gets **one long-lived channel**, opened at $1.00 and grown by `topUp`. Channel-per-period is not available.
2. `topUp()` takes a `SpendingAuth` *and* a `ReserveAuth` and does both jobs (`:207-244`) — so **the same single transaction settles the accrued days and extends the ceiling for the next period**. Steady state is one transaction per user per period, not two.
3. New subscribers need a second on-chain step about 40 hours in. That is `N9`.

**How much money is actually blocked.** Less than the ceiling suggests, and this is worth being precise about because it is the user-facing cost of a large reserve. `lockForChannel` does `reserved += amount` (`AntseedDeposits.sol:162-171`), and settlement does `balance -= amount; reserved -= amount`. So although `channel.deposit` only ever grows, **the USDC actually blocked is `deposit − settled` — the unsettled headroom** — which peaks right after a `topUp` and drains daily to near zero before the next one. Average blocked capital is therefore about **half** the reserve period. `close()` releases the remainder (`:297-310`).

And the user is never trapped: `requestClose()` is buyer-callable at any time, `TIMEOUT_GRACE_PERIOD` is **15 minutes**, then `withdraw()` returns the headroom (`:325-345`). *Confirm with AntSeed that the operator relayer covers this path so it stays gasless for the user.* A 15-minute unilateral exit makes larger reserves much less objectionable than a typical crypto lock-up.

**Sizing the reserve.** At $0.59/day, a year is $215.35.

| Reserve period | Ceiling | Peak blocked | Avg blocked | On-chain txs / user / yr | `ReserveAuth` prompts / yr | Gas budget per tx to stay under 1% of revenue |
|---|---|---|---|---|---|---|
| ~2 days | $1.18 | $1.18 | $0.59 | ~182 | ~182 | $0.012 |
| 1 week | $4.13 | $4.13 | $2.07 | ~52 | ~52 | $0.041 |
| **1 month** | **$17.96** | **$17.96** | **~$9** | **~12** | **~12** | **$0.18** |
| 1 quarter | $53.88 | $53.88 | ~$27 | ~4 | ~4 | $0.54 |
| 1 year | $215.35 | $215.35 | ~$108 | ~1 | ~1 | $2.15 |

The last column is the useful one, because it avoids guessing Base's fee: it is what a `topUp` may cost before gas eats 1% of the $215.35 annual revenue. A `topUp` is a heavy call — two ECDSA recoveries, a USDC transfer path, several storage writes — and **should be measured on Base before this is locked**, but a monthly cadence gives roughly an order of magnitude of headroom against any plausible L2 fee, whereas a two-day cadence does not.

**DECIDED: a monthly ceiling.** Twelve transactions per user per year keeps gas comfortably under 1% of revenue without needing batching to work. Peak blocked capital of $17.96 (average ~$9) is modest against the $45+/month inference spend that `D39` says this user has, and the 15-minute exit caps the downside. Weekly quadruples gas to save about $7 of average blocked capital — a bad trade. Quarterly saves perhaps a dollar a year of gas in exchange for locking $54 and, more importantly, removing a renewal moment: a monthly "authorise the next month of routing" prompt is a natural subscription rhythm and a real protection against the user who forgets they subscribed.

**The resulting lifecycle, concretely.** This is the implementation contract for `D35`.

| Moment | Actor | Call | Amounts at $0.59/day |
|---|---|---|---|
| Opt-in | Client | Sign `ReserveAuth(channelId, $1.00, deadline)` | Ceiling $1.00 — the maximum `FIRST_SIGN_CAP` allows |
| Opt-in | Peer | `reserve()` | Locks $1.00. **1 tx** |
| End of day 1 | Client | Sign `SpendingAuth(cum = $0.59)` | Held by the peer, not submitted |
| End of day 2 | Client | Sign `SpendingAuth(cum = $1.00)` — **capped at the ceiling**, so a partial day | Reaches 100% settled, clearing the 85% gate |
| Day 2 | Client | Sign `ReserveAuth(channelId, $18.96, deadline)` | The "start monthly" moment (`N9`) |
| Day 2 | Peer | `topUp()` — settles $1.00 **and** raises the ceiling in one call | Locks a further $17.96. **1 tx** |
| Days 3–30 | Client | One `SpendingAuth` per elapsed day, `cum = $0.59 × days` | No on-chain activity. Blocked capital drains daily |
| ~Day 30 | Client + Peer | Sign next `ReserveAuth`; `topUp()` settles the month and extends | **1 tx**, then repeat monthly |
| Cancellation | Client | Stop signing | Nothing further owed (`N7`, `D45`) |
| Cancellation | Peer | `close(finalAmount = last signed cum)` | Releases the unsettled remainder. **1 tx**, courtesy |
| Cancellation, peer unresponsive | Client | `requestClose()` → 15 min → `withdraw()` | Unilateral. Recovers the remainder |

Three implementation notes that fall out of this and are easy to get wrong:

- **Day 2's signature is a partial day.** `settle()` rejects any cumulative above the deposit (`:265`), so the client must clamp to `min($0.59 × days, ceiling)`. The shortfall is not lost — it is recovered by the next day's cumulative once the ceiling rises.
- **The peer must `topUp` before the ceiling is reached, not after.** Once `cum` hits the ceiling the client cannot sign a higher amount and the meter stalls silently — the user keeps routing for free and the stall is invisible until someone reads the ledger. On an $18.96 ceiling the three marks are: **85% gate opens at day 27.3**, **fire the scheduler at 95%, day 30.5**, **hard stop at day 32.1**. That leaves a ~5-day window to land one transaction, which is generous — but it must be monitored, not assumed (`R18`).
- **Never let the two signatures be produced by the same code path.** The daily `SpendingAuth` is silent and automatic; the monthly `ReserveAuth` is the one consent moment. Conflating them is how a "renew for a month" prompt turns into an unnoticed one.

**One property worth noticing: the reserve period and the billing period do not have to match.** The ceiling is a ceiling, not a commitment. A user who runs the router 10 days a month simply takes three months to reach the 85% mark, and tops up three times less often. So **active-day billing (`D39`) composes with a monthly ceiling for free**, and light users get cheaper gas as a side effect. The reserve sizing decision does not need to wait for `D39`.

**Purchasing friction.** Three distinct moments, and only one of them is frequent:

| Moment | Frequency | Friction |
|---|---|---|
| Funding the AntSeed deposit | Once, and shared with all inference spend | Real, but it is AntSeed's onboarding, not ours — the router adds no new funding step |
| `ReserveAuth` — "authorise the next month" | ~12/yr, plus the `N9` extra in week one | The only visible one. Arguably a feature: a monthly renewal beat |
| `SpendingAuth` — the daily meter | 365/yr | **Should be invisible.** Silent auto-sign within a user-set daily cap, matching how the client already auto-signs per-request inference authorisations |

The daily signature is the one that must not prompt, and it is also the one that is safest to auto-sign: it is bounded by `$0.59 × elapsed days` (`N7`), it is capped by the ceiling the user *did* consciously authorise, and the worst case if the client is wrong is a fraction of a dollar. *Lean: silent daily signing under a user-visible cap; prompt only when the cap changes or the ceiling is renewed.*

**Technical complexity, honestly.** Low, and lower than the previous design. No new contracts, no subscription contract, no proration logic, no per-day on-chain anything. Client side: a daily counter, a signing rule (`N7`), and catch-up on reconnect. Peer side: hold the latest signature per channel, and a scheduler that fires `topUp` when settled crosses 85%. The one genuinely fiddly moment is the ramp in `N9`, where the client must sign a cumulative of exactly the deposit ceiling — a partial day — to reach the 85% threshold and unlock the first `topUp`.

---

**N9 — `FIRST_SIGN_CAP` forces a two-step signup.** *(Open — AntSeed input needed)*

A new subscriber needs a `reserve()` at $1.00, then a second on-chain action and a second `ReserveAuth` prompt roughly 40 hours later. Options:

| Option | Tradeoff |
|---|---|
| **Frame the first $1.00 as a two-day trial, then a single "start monthly" moment** | Turns the constraint into a product beat; two consent moments in week one, which is defensible |
| Ask AntSeed to raise `FIRST_SIGN_CAP` | Owner-settable (`:497`), but it is a global risk parameter for every seller — AntSeed's call, not ours |
| Just accept two prompts in two days | Simplest, slightly clumsy |

*Lean: the first, and ask AntSeed whether the $1.00 cap is intended to be permanent.*

A silver lining: this cap **dissolves the old `N8` spam concern**. Levanto's exposure to a channel that never gets used is one `reserve()`, and `lockForChannel` reverts unless the buyer already holds $1.00 of unreserved deposit (`AntseedDeposits.sol:164-165`), so a spammer needs genuinely funded accounts.

---

**N10 — Bulk collection across users does not exist yet.** *(Open)*

Worth correcting an assumption: **temporal** bulking is automatic and free — cumulative signatures mean one transaction collects arbitrarily many days. **Cross-user** bulking is not available. `settle()` and `topUp()` both require `msg.sender == channel.seller` (`:218`, `:263`) and there is no `settleMany`, so a thousand subscribers means a thousand transactions per period.

| Option | Tradeoff |
|---|---|
| Register the routing peer's seller address as a **contract wallet** that loops over `topUp` internally | One transaction, N settlements — saves the 21k base cost and per-transaction overhead. Needs confirmation that staking and peer-identity binding accept a contract address |
| Ask AntSeed for `settleMany` / `topUpMany` | Useful to every seller with many buyers; a genuine commons improvement |
| Accept per-user transactions | Fine at monthly cadence — this is an optimisation, not a blocker |

*Lean: ship on the third, raise the second with AntSeed as a network-level improvement. Owner: Joint.*

---

### 5.5 Business — updated for $0.59/day

**D35 — How is the fee collected? RESOLVED.**

One `SpendingAuth` per elapsed day against a channel with the routing peer, triggered by the routing plugin, catching up after offline periods, held by the peer and settled monthly against a **monthly ceiling**. The full lifecycle, including the `N9` signup ramp and the three ways to get it wrong, is in **`5.4`**.

This is a genuinely good fit for the existing machinery and **needs no new contracts**, which removes what was the largest single work item in the project. Because `SpendingAuth` is **cumulative**, the peer only ever needs the latest signature to settle everything before it — so "stockpiling signatures" is automatic, and settlement is one transaction regardless of how many days accumulated.

Remaining sub-decisions:

| Sub-decision | Options | Status |
|---|---|---|
| **Calendar day or active day?** | Calendar = true subscription, predictable revenue, but users pay for idle days and will notice. Active = fairer, self-limiting, much better for light users, lumpier revenue | **Open — see `D39`.** Active-day materially changes who this product is for. The monthly ceiling supports either unchanged |
| Ceiling size and settlement cadence | Day / week / month / quarter | **Decided — monthly** (`5.4`). One `topUp` per user per month, which settles and renews in one call |
| Signing consent | Silent auto-sign within a cap, versus a visible prompt | Split by type: daily `SpendingAuth` silent under a user-set cap; monthly `ReserveAuth` is the consent moment |
| Catch-up window | Unlimited, or capped at N days | Cap at ~30 days; older unsigned days are forgiven. Note the ceiling caps it anyway |
| Deposit exhausted | Routing stops; how is it surfaced? | Non-modal notice, fall back to `D20` behaviour |

**D36 — Platform fee.** 2% = **$0.0118/day**, ~$0.36/month. Ordinary seller, ordinary fee.

**D37 — Who pays for Sage? Largely dissolved by `D16`.** Routing fires per user message, not per turn, so the agentic blow-up that motivated a fair-use cap mostly disappears (§6). *Lean: no cap in v1; instrument and revisit.*

**D38 — Free month for the first 200.** Trivial now: skip signing for the first 30 days, or use `AntseedFreeUsage`. Being generous rather than exact on the count costs about $18/user.

**D39 — Is $0.59/day right, and for whom? OPEN, and this is now the sharpest business question.**

$0.59/day is **$17.96/month** (30.44 avg days) or **$215.35/year** — roughly double the previous $9/month. Breakeven for the user:

| Realised savings | Monthly inference spend needed to break even |
|---|---|
| 60% | $29.93 |
| **40%** | **$44.90** |
| 25% | $71.84 |
| 15% | $119.73 |

At the marketed 40%, the user must be spending **~$45/month on inference** — up from ~$22.50 at $9/month. **This is now explicitly a power-user product.** That is in real tension with `G2` ("feels like a feature, low friction"), because a feature priced at $18/month is a product.

Two observations that cut in favour of the pricing:

- The users who spend $45+/month are overwhelmingly **agentic** users — and `D16` means those are exactly the users the router serves most cheaply. Price and cost structure are aligned.
- **Active-day billing would change the picture completely.** A light user who runs the router 5 days a month pays $2.95, not $17.96, and breaks even at ~$7.40 of spend. That single sub-decision determines whether this is a power-user-only product or something a casual user can also switch on.

*This still needs AntSeed's spend distribution to settle (`Q1`). Owner: Joint.*

**D40 — The savings claim.** The bar moved with the price: the number now has to justify $17.96/month rather than $9. With `D28`–`D30` removed, the evidence comes from Levanto's own benchmarking, and the remaining question here is narrower but still real — **which baseline the marketed percentage is measured against**, and keeping it distinct from the savings AntSeed already claims against OpenRouter retail, so the two are not silently added together in the user's mind. `4.5` keeps them as two separate numbers on the dashboard; the marketing line should match. *Lean: state the baseline explicitly wherever the number appears.*

**D41 — Grant structure.** Unchanged, but revenue per subscriber roughly doubled, which is worth reflecting in the conversation about what the $16k plus tokens is buying. Milestones still undefined; disclosure of Levanto holding ANTS while operating the default peer still needed.

**D42 — What is the commons?** Protocol and schema, the `routing-client` plugin, the local ledger and savings computation, dashboard surfaces, the peer template, and the two extracted modules from `D8`. Sage, artifacts and training stay Levanto's. **Note the cached-token estimator (`4.3`) is now client-side, hence in the commons** — it is small and general, and every future router benefits.

**D43 — Exclusivity and default placement.** *Lean: time-boxed (6–12 months), disclosed, published policy for how the default changes.*

**D44 — Support and SLA.** A hosted service in a latency-sensitive path, now charging $18/month. *Blocking before charging.*

**D45 — Refunds and proration. RESOLVED by daily signing.** Stop signing; nothing further is owed. `N7` is what makes this true.

---

### 5.6 Router library and catalogue, and section F

#### D. Router library and catalogue

**D28, D29, D30 — removed.** Router quality, evaluation methodology and shadow sampling are validated outside this integration and are not decisions this document needs to carry. The benchmark caveats previously recorded here have been dropped with them.

One consequence worth stating so it doesn't get lost: `N5`'s daily digest is no longer justified by an evaluation gap, and its scope should not creep back toward one. It exists to show the product is working — savings realised, cost model calibrated, failure rates sane — not to measure router quality.

- **D31 — Catalogue ownership and update SLA. Deferred.** Not a launch-blocking process question. But **catalogue *coverage* is a release blocker**: models the artifact does not know are unroutable, and a router that silently declines to route the models an AntSeed user actually asks for reads as broken rather than conservative. So before release we need the hull to span the models AntSeed traffic actually uses, and `D14`'s coverage surface to show what is missing. The ongoing update cadence can be decided later.

- **D32 — `prune = False`. Resolved.** Confirmed as the default. Ranked-list-with-failover wants the full candidate set, since dynamic dominance pruning would remove exactly the entries the client falls back to when its local policy rejects the leader.

- **D33 — Tests before the money path. Resolved: yes, blocking.** The proxy has no test coverage outside dashboard tools today. Signing code, the cumulative-day counter and the `topUp` scheduler (`5.4`) all move real money and all need coverage before the first paid day.

---

**D34 — `decide()` raises on every artifact the current trainers produce. RESOLVED: delete.**

*You asked for detail. It is worse than "a cost bug", and the reason is a one-line argument-order mismatch.*

The cost helper takes token counts:

```python
def _predicted_costs(self, input_tokens: int, x: list[float],
                     models: list[str] | None = None) -> dict[str, float]:
```

`_select` calls it with the prompt **string** in that first position (`router.py:547`):

```python
costs = self._predicted_costs(prompt, features)   # `prompt` is str, not int
```

That value flows straight through to the M4 estimator (`cost_ridge.py:75`):

```python
return input_tokens * price_in + completion_tokens * price_out
```

`str * float` is a `TypeError` in Python — *"can't multiply sequence by non-int of type 'float'"*. Not a wrong number, an exception.

**Why it has not been noticed.** `_predicted_costs` returns early with flat per-model mean costs when the artifact is not M4 (`router.py:533`):

```python
if self.artifact.cost_model != "ridge_m4" or not self.artifact.ridge_params:
    return flat
```

On that path `input_tokens` is never touched, so the string passes through harmlessly and `decide()` works. But **every current trainer stamps `cost_model="ridge_m4"`** — `train.py:362`, `train_pricefree.py:121`, `train_with_live_model.py:235` — and `router.py:273` says so in a comment. So `decide()` succeeds only on pre-M4 artifacts and raises on everything shipping now. `decide_turn()` inherits this, since it delegates to `decide()` on any non-held turn (`router.py:701`).

**The ranked path is unaffected**, which is why the proxy works: `rank_candidates_from_vector` passes `input_tokens` correctly (`router.py:603`), and `rank_candidates` feeds it `prompt_input_tokens(prompt)` (`router.py:586`).

**Decided: delete `decide()`, `decide_turn()` and `_select`.** The integration uses `rank_candidates_from_vector` exclusively (`4.4`), so this removes an API that cannot work today, plus the `TypeError` waiting for whoever calls it, without touching anything the plugin depends on. `D16` already moved multi-turn stickiness to the client, so `decide_turn`'s TTL mechanism has no role here either — nothing is lost that this architecture uses. The one open condition: if Levanto has external users of `decide()` outside this integration, fix the one-line argument order instead and add a regression test before shipping — a supported surface that nothing exercises is exactly how this drifted in the first place. **Owner: Levanto.**

This is also a small piece of evidence for `D33`: a type error on the primary documented entry point survived because nothing calls it in a test.

#### F. Product surface and launch

- **D46 — Dial: 0–10 or three presets?** *Lean: three presets, "Advanced" reveals 0–10.* **CQT is a relative dial, not a spend target (`D12`) — the UI must not promise otherwise.**
- **D47 — How does the user say "route this"?** *Lean: sentinel model id plus a global preference; never silently override a deliberate choice.*
- **D48 — Which model is shown, and when?** *Lean: after the fact in message metadata.*
- **D49 — Baseline model X.** *Lean: user-selectable, defaulting to pre-opt-in most-used, falling back to the peer's `baselineSuggestion`.*
- **D50 — Negative savings, and netting the fee.** Bigger now: **$17.96/month** has to be visible against gross savings. *Lean: gross prominently, "net of subscription" adjacent, real numbers including negatives in detail view.*
- **D51 — Closed beta, second router, placement, co-branding.** *Lean: 4–6 week instrumented beta — which is also where `N5`'s telemetry exception applies.*

---

## 6. Unit economics under $0.59/day

**Revenue:** $0.59/day × 30.44 = **$17.96/month**, less 2% → **$17.60 net**.

**COGS.** `D16` changes the denominator: Sage fires per **user message**, not per turn.

| | Light (300 user msgs/mo) | Typical (600) | Heavy agentic (1,500) |
|---|---|---|---|
| Sage @ ~$0.0006–0.001 | $0.18–0.30 | $0.36–0.60 | $0.90–1.50 |
| Routing-peer infra (amortised) | ~$0.20 | ~$0.30 | ~$0.50 |
| Channel gas — 1 `topUp`/month (`5.4`) | ~$0.05 | ~$0.05 | ~$0.05 |
| **Gross margin** | **~$17.1** | **~$16.7** | **~$15.6** |

Compare the previous model, where a heavy agentic user at 20,000 routed turns was **−$4 to −$12/month**. `D16` and the price change together turn the worst segment into the second-best one. **The margin problem is solved; the user-value problem got harder** — see `D39`.

**Fixed costs the grant offsets:** router R&D; catalogue maintenance; the commons in `D42`; and operating the routing peer, which `D11` makes Levanto's responsibility.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Cost model mis-calibrated against live AntSeed prices and prompt lengths | Medium | High | `predictedCostUsd` vs `actualCostUsd` in the daily digest (`N5`) |
| R1b | Catalogue does not cover the models users ask for | Medium | **High** | Coverage as a release gate (`D31`) |
| R2 | Digest scope creeps toward prompt-derived fields | Medium | High | Fixed schema, versioned, in `packages/protocol` (`N5`) |
| R3 | $17.96/month exceeds savings for most users | **High** | High | Active-day billing; spend distribution first (`D39`) |
| R4 | Routing blind to cache warmth → wrong picks | **High** | Medium | Wire the estimator (`D18`) |
| R5 | Pre-signed days settled early after cancellation | Medium | High | Never sign ahead; per-day cap (`N7`) |
| R6 | Routing peer is a single point of failure | **High** | Medium | `D20` fallback; `D44` SLA |
| R7 | Losing streaming is a visible regression | Medium | High | Pre-first-token failover cut-off (`D19`) |
| R8 | Plugin coexists with `router-local`, or gates vanish | **Closed** | — | Resolved: `'router'`-type plugin, one slot (`D1`/`D8`) |
| R9 | Python sidecar lifecycle problems | Medium | Medium | Fail closed, stop advertising |
| R10 | Per-user λ drift via `OnlineBudgetController` | Medium | Medium | Disable it (`N4`) |
| R11 | Cached-token estimate drifts on prefix invalidation | Medium | Low | Local prefix guard (`4.3`) |
| R12 | Channel-open gas as a spam vector | Low | Low | Bounded by `FIRST_SIGN_CAP` $1.00 + funded deposit (`N9`) |
| R15 | Gas per subscriber outruns revenue at scale | Medium | Medium | Monthly `topUp` cadence; measure on Base first (`5.4`, `N10`) |
| R16 | Daily digest becomes a usage profile over time | Medium | Medium | Ten scalars, day granularity, visible toggle (`N5`) |
| R13 | Catalogue goes stale | Medium | Medium | Server-side updates; cadence deferred (`D31`) |
| R14 | Untested code in the money path | Medium | High | Test story before billing (`D33`) |
| R17 | `decide()` raises on the shipping artifact | **Closed** | — | Resolved: deleted along with `decide_turn`/`_select` (`D34`) |
| R18 | `topUp` fires late → `cum` hits the ceiling and the meter stalls silently | Medium | **High** | Schedule at ~95% consumed; alert on a stalled cumulative (`5.4`) |
| R19 | Monthly `ReserveAuth` prompt read as a surprise charge | Medium | Medium | Frame as renewal; show days used and next ceiling (`5.4`, `D50`) |

---

## 8. Phasing

**Phase 0 — Decide (1 week).** `D39` calendar-vs-active day; `N9` signup ramp with AntSeed; a measured `topUp` gas cost on Base (`5.4`). `D1`/`D8`, `D34`, `N3` and `N5` are settled and no longer block Phase 1.

**Phase 1 — Plumbing, unpriced (4–6 weeks).**
- *AntSeed:* extract `selectCandidatePeersForRouting` / `resolvePeerRoutePlan` into a package; extract the reputation and max-price gates from `LocalRouter` into `@antseed/router-core`; add `'routing'` capability; `/_antseed/route` schema in `packages/protocol`; optional routing methods on `Router`.
- *Levanto:* `routing-client` plugin in TS — new-user-message gate, cached-token estimator, failover walk, local ledger, policy filter, all calling the extracted libs; `routing-server` plugin + Python sidecar; peer-side AntSeed node; **wire cached tokens into ranking (`D18`)**; disable `OnlineBudgetController`.
- *Joint:* trivial reference routing peer in the template.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 users with the `N5` daily digest on. Dial and opt-in in VPR. Two-number savings dashboard off the local ledger. Streaming decision implemented. **Gates: catalogue coverage over the models this cohort actually asks for (`D31`); cost model calibrated against live prices (`predictedCostUsd` vs `actualCostUsd`); tests on the signing path (`D33`).**

**Phase 3 — Launch.** Billing per the `5.4` lifecycle: `$1.00` open, day-2 ramp, daily `SpendingAuth`, monthly `topUp` scheduler, `close()` on cancellation. Tests on all of it first (`D33`). Free 30 days for the first 200. Routing-peer picker. Public methodology page.

**Phase 4 — Hardening.** Conformance suite. Default-selection policy. Revisit `D22`/`D26`.

---

## 9. What we still need

**From AntSeed:**

1. **Accept optional routing methods on the `Router` interface** (`D1`/`D8`). We are taking the `'router'` slot and replacing `router-local`; this is the only plugin-system change needed.
2. **What is the distribution of monthly inference spend per active buyer?** (`D39`) At $0.59/day the breakeven is **~$45/month** at 40% savings. This decides whether the addressable market exists.
3. **Are the two extraction refactors acceptable?** (`D8`) Both are behaviour-preserving and benefit any future router.
4. **Is `FIRST_SIGN_CAP = $1.00` permanent?** (`N9`) At $0.59/day it is 1.7 days of service, so every subscriber needs a second on-chain step in week one. We can design around it, but we would rather know.
5. **Would you consider `settleMany` / `topUpMany`?** (`N10`) Any seller with many buyers pays one transaction per buyer per period today. Alternatively, confirm that a **contract** seller wallet passes staking and peer-identity binding, which gets us there without a contract change.
6. **Do the commons in `D42` live in this repo under this licence** — now including the cached-token estimator?
7. Default-peer policy, Levanto's placement duration, grant disclosure (`D41`, `D43`).

**From Levanto:**

8. **`D39` — calendar day or active day?** This decides whether the product is power-user-only. Note `5.4` shows the reserve mechanism supports either without change.
9. **`N5` — is the daily digest default-on with a toggle, or opt-in?**
10. **Measure `topUp` gas on Base** before fixing the monthly cadence (`5.4`).
11. **`D31` — which models must the hull cover before release?** Needs AntSeed's model-usage mix, which pairs with question 2.

**And before any number goes public:** state which baseline the percentage is measured against, and keep it separate from AntSeed's own savings-versus-retail figure (`D40`).

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
| **`PeerMetricsTracker`, cooldown — exported** | `packages/router-core/src/peer-metrics.ts` |
| **`scoreCandidates`, `DEFAULT_WEIGHTS` — exported** | `packages/router-core/src/peer-scorer.ts` |
| `buildNetworkServiceOffers` | `packages/node/src/discovery/service-catalog.ts:162` |
| `rankModelRoutes`, `chooseBestModelRoute` | `packages/node/src/routing/model-route-ranking.ts:191,202` |
| **`selectCandidatePeersForRouting` — extract to a package** | `apps/cli/src/proxy/routing.ts:231,281` |
| **Cached tokens reported to the buyer (`D18` ground truth)** | `packages/buyer-core/src/buyer-payment-manager.ts:1225-1235, 1434` |
| Cost computation (cached-input aware) | `packages/buyer-core/src/pricing.ts:41-54` |
| **`SpendingAuth` / `ReserveAuth` typehashes** | `packages/contracts/payments/AntseedChannels.sol:38-45` |
| **`SpendingAuth` has no deadline or nonce (`N7`)** | `packages/contracts/payments/AntseedChannels.sol:460-476` |
| **`FIRST_SIGN_CAP = $1.00`, enforced on every `reserve()` (`N9`)** | `packages/contracts/payments/AntseedChannels.sol:47, 163` |
| **`topUp()` — settles and extends in one call; 85% threshold** | `packages/contracts/payments/AntseedChannels.sol:207-244` |
| **Seller-only settlement, no batch entry point (`N10`)** | `packages/contracts/payments/AntseedChannels.sol:218, 263` |
| **Blocked funds = `deposit − settled`** | `packages/contracts/payments/AntseedDeposits.sol:162-207` |
| **15-minute buyer exit: `requestClose` → `withdraw`** | `packages/contracts/payments/AntseedChannels.sol:50, 325-345` |
| `AntseedFreeUsage` | `packages/contracts/payments/AntseedFreeUsage.sol` |
| Capability enum, `PeerOffering` | `packages/protocol/src/capability.ts` |
| Reserved-path precedent (attest) | `packages/node/src/seller-request-handler.ts:139-185` |
| **Savings vs retail (shipped, local)** | `apps/desktop/src/renderer/modules/catalog/measured-savings.ts` |
| VPR preferences (dial precedent) | `apps/desktop/src/renderer/modules/routing/preferences.ts` |

### levanto-router-proxy

| Concern | Path |
|---|---|
| Request lifecycle, ranking, failover walk | `proxy.py:275-437` |
| AntSeed catalog, peer pinning, billing rate | `providers.py:139-205`; `rate_for` at `89-102` |
| **Cache model — superseded by `4.3`'s estimator** | `cache_model.py`; `effective_in` at `273-276` |
| Runtime, catalog swap, λ recalibration | `routing.py:293-380` |
| Audit schema (14 tables) | `store.py` |
| Stated limitations | `README.md:215-227` |

### sage_model_router @ `rank-from-precomputed-vector`

| Concern | Path |
|---|---|
| Dynamic pricing design + caveats | `DYNAMIC_PRICING.md` |
| `PriceBook` — needs the cached rate (`D18`) | `price_book.py:38-47` |
| `rank_candidates_from_vector` | `router.py:588-638` |
| `set_prices` / `_live_hull` / `_price_for` | `router.py:384-445` |
| λ recalibration | `router.py:463-486`; `lambda_calibration.py:62-67` |
| **`OnlineBudgetController` — disable (`N4`)** | `router.py:194-216` |
| Sage prompt trimming + the cliff | `prompt_trim.py` |
| **`decide()`/`decide_turn()`/`_select` — delete (`D34`)** | `router.py:544-551, 658-708` |
| **Bug that motivated it: `prompt` passed where `input_tokens` is expected** | `router.py:547` |
| Correct call sites (ranked path, kept) | `router.py:586, 603` |
