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

**$0.59/day**, shown as a continuous per-day cost on the opt-in toggle. Under the hood the AntSeed client signs **one `SpendingAuth` per elapsed day** against a channel with the routing peer, catching up on days the client was offline. The peer batches signatures and settles on-chain periodically.

This works with **today's contracts — no new Solidity** (`D35`), and makes cancellation and proration trivial (stop signing). Two things it changes materially: it roughly **doubles the old $9/month figure to ~$17.96/month**, which moves the user breakeven from ~$22.50 to **~$44.90/month of inference spend** at 40% realised savings (`D39`); and because `SpendingAuth` carries **no deadline**, the client must never pre-sign future days (`N7`).

### What is already built

Live dynamic per-peer pricing, ranked `(model, peer)` output, precomputed-vector input, price-independent training, failover with sinbin demotion, multi-turn handling, and a 14-table audit ledger all exist on the production branch plus the proxy.

### What is not

**The cached-input math is built but not wired.** `cache_model.py` computes exactly the right thing and exposes `effective_in()` — which is **never called**. Ranking passes one scalar `ctx_tokens` and `PriceBook` carries no cached rate, so the router prices every candidate as a cold cache. That systematically under-values whichever seller already holds the conversation prefix. `D18` now has a much simpler wiring plan than before, because the client can just report observed cached tokens.

### The two things that still decide viability

Sections D and F are unanswered, and D is the one that matters:

1. **Evidence.** Levanto's own proxy README puts `artifact_live9` routing skill at **≈ 0** on its Tier-1 slice against +2.84 pp on the 8-dataset archive mix, "unproven until retrained on something broader". LODO mean AUC is **0.5243**. AntSeed's traffic is chat and coding agents. At **$17.96/month** the claim has to clear a higher bar than it did at $9.
2. **Zero retention makes that evidence harder to get** (`N5`). If the peer forgets everything, Levanto never observes production outcomes and can never validate or improve on AntSeed's real workload mix. That is a direct conflict with `D28`, and the closed beta will need an explicit, opt-in, time-boxed exception.

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

**`reserve()` is seller-called and requires the seller to be staked** (`AntseedChannels.sol:149-158`). The routing peer pays gas to open a channel per subscriber (`N8`).

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
| D1 | Plugin attachment | **Reopened — see 5.2** | `D8`'s "replace, don't coexist" points back at the `router` type |
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
| N3 | Candidate-set mismatch | Open | Constraints in the request |
| N4 | λ vs cache calibration | **Resolved** | λ on raw prices; blending at runtime scoring only |
| N5 | Zero retention vs evidence | **NEW — open** | Conflicts with `D28` |
| N6 | Zero retention vs billing state | **NEW — open** | Entitlement must persist somewhere |
| N7 | Pre-signing risk | **NEW — open** | `SpendingAuth` has no deadline |
| N8 | Channel-open gas per subscriber | **NEW — open** | `reserve()` is seller-paid |
| D28–D34 | Quality, evaluation, savings claim | **Open** | Section D unanswered |
| D35–D45 | Business | **Mostly resolved by $0.59/day** | See 5.4 |
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

### 5.2 Resolved with detail, and one reopened

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

**Now the part that needs re-deciding.** You asked for replacement, not coexistence — and that pulls against `D1`'s "new plugin type". Here is why:

- `node.setRouter()` takes **one** router. The buyer proxy reads policy gates off it via `peerAllowedByPolicy` (`buyer-proxy.ts:206-212`).
- If `routing-client` is a **new type** (`'routing'`), then `router-local` occupies the `'router'` slot independently. Both load. That is exactly the coexistence you rejected — and worse, if the user disables `router-local` to avoid it, the reputation and max-price gates **silently vanish**, because with no router plugin `peerAllowedByPolicy` permits everything.
- If `routing-client` is a **`'router'`-type plugin** that implements `Router` (including `allowsPeerForPolicy` / `allowsPeerForPricing` / `onResult`) plus the new routing methods, it drops into the same slot and **replaces `router-local` by construction**. One router, one config surface, gates preserved.

| Option | Replaces cleanly? | Plugin-system change |
|---|---|---|
| **A. `routing-client` is a `'router'`-type plugin with routing extensions** | **Yes, by construction** | Optional methods on `Router` only — the smallest change of all |
| B. New `'routing'` type + loader enforces mutual exclusion with `'router'` | Yes, but by policing | New type, loader, registry, config, plus exclusion logic |
| C. New `'routing'` type, both load | **No** — you rejected this | New type and machinery |

*Lean: **A**, which is where `D1` originally leaned. It satisfies "replace, don't coexist" without any enforcement machinery, and the new plugin still calls the extracted gate functions rather than reimplementing them. The `routing-server` side is unaffected and is best modelled on the existing `Prover` pattern — seller-side, serves a reserved path (`/_antseed/route` alongside `/_antseed/attest`), no models, no token pricing.*

**Blocking: yes — this reopens `D1`. Owner: AntSeed.**

---

**N3 — The peer ranks globally; the client can only buy from a subset.** *(Open)*

The peer sees the whole network. This client may have blocked peers, a lower max price, a higher trust floor, or simply be unable to reach some peers. If the peer ranks the global set, `D9`'s local filter may strip the top candidates.

*Lean: client sends `constraints` in the request (already in `4.4`) so the peer pre-filters; client still re-filters. Peers found unreachable get appended to `blockedPeerIds` over time — the same signal the cooldown tracker already produces. Owner: Joint.*

---

### 5.3 Newly created by these answers

---

**N5 — Zero retention means Levanto never learns whether this works.** *(Open — the important one)*

`D23`/`D24`/`D27` are internally consistent and good for privacy. But they mean the routing peer observes no outcomes: not which model was chosen, not what it cost, not whether the user regenerated, not whether predicted savings materialised.

That collides with `D28`, where the whole open question is whether the router helps on AntSeed's workload mix. With zero retention:

- The savings claim can never be validated on real traffic — only on Levanto's own benchmark collects
- Cost prediction can never be recalibrated against production token distributions
- The quality heads can never be retrained on chat or agentic workloads, which is the specific gap `D28` identifies
- Shadow sampling (`D29`) produces data that only ever exists on the user's machine

Options:

| Option | Tradeoff |
|---|---|
| **Time-boxed, opt-in beta telemetry** | Resolves `D28` for launch; needs explicit consent and a stated end date. Recommended |
| Client-side aggregates only, voluntarily shared | Weak signal, but non-zero; no raw content leaves |
| Keep zero retention absolutely | Cleanest privacy story; **the router cannot improve after launch** |
| User opts in for a discount on the daily fee | Aligns incentives; adds billing complexity |

*Lean: zero retention as the steady state, with an explicit, consented, time-boxed exception for the closed beta (`D51`) — otherwise `D28` has no path to being answered. Owner: Joint. Blocking: yes for the savings claim.*

---

**N6 — Zero retention versus knowing who has paid.** *(Open)*

At $0.59/day the peer has to know whether a caller is entitled, and which days have been signed. "Zero retention" cannot be literal. The minimum durable state is: peer identity or channel id → subscription status → last signed cumulative amount → last settlement.

That is small and categorically different from conversation data, but it should be stated explicitly so "we retain nothing" is accurate rather than aspirational. *Lean: define retention as "no conversation or routing data"; billing state is exempt and enumerated. Owner: Levanto.*

---

**N7 — Never pre-sign future days.** *(Open — security)*

`SpendingAuth(channelId, cumulativeAmount, metadataHash)` has **no deadline field** (unlike `ReserveAuth`, which does). A signature authorising a higher cumulative amount can be settled by the seller at any moment.

So if the client pre-signs, say, 30 days ahead to reduce prompts, the routing peer can settle the whole month immediately — and a user who cancels on day 2 has already paid for 30. **The client must sign only for days that have elapsed.** Catch-up on reconnect is fine: those days did elapse.

This is also what makes cancellation clean — stop signing, owe nothing further.

*Lean: hard rule in the client, plus a per-day cap so a compromised or buggy peer cannot inflate the cumulative. Owner: Joint.*

---

**N8 — Channel-open gas per subscriber.** *(Open)*

`reserve()` is called by the **seller** and requires the seller to be staked (`AntseedChannels.sol:149-158`). So the routing peer pays gas to open a payment channel for every subscriber, before collecting anything. On Base this is small per user but it is a real per-signup cost and a spam vector — someone can make Levanto pay to open channels that never get used.

*Lean: require a minimum buyer deposit or a first-day signature before opening the channel; batch settlement so gas is amortised across many days and users. Owner: Levanto.*

---

### 5.4 Business — updated for $0.59/day

**D35 — How is the fee collected? RESOLVED.**

One `SpendingAuth` per elapsed day against a channel with the routing peer, triggered by the routing plugin, catching up after offline periods, batched by the peer for bulk on-chain settlement.

This is a genuinely good fit for the existing machinery and **needs no new contracts**, which removes what was the largest single work item in the project. Because `SpendingAuth` is **cumulative**, the peer only ever needs the latest signature to settle everything before it — so "stockpiling signatures" is automatic, and settlement is one transaction regardless of how many days accumulated.

Remaining sub-decisions:

| Sub-decision | Options | Lean |
|---|---|---|
| **Calendar day or active day?** | Calendar = true subscription, predictable revenue, but users pay for idle days and will notice. Active = fairer, self-limiting, much better for light users, lumpier revenue | **Open — see `D39`.** Active-day materially changes who this product is for |
| Signing consent | Silent auto-sign within a cap, versus a visible prompt | Silent within a user-set daily cap; prompt only on cap change |
| Catch-up window | Unlimited, or capped at N days | Cap at ~30 days; older unsigned days are forgiven |
| Settlement cadence | Per-user threshold, or fixed schedule | Whichever amortises gas (`N8`) |
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

**D40 — The savings claim.** Unchanged in substance, but the bar moved: the claim now has to justify $17.96/month rather than $9. *Lean: no numeric claim until `D28` is satisfied — and `N5` currently blocks the only path to satisfying it.*

**D41 — Grant structure.** Unchanged, but revenue per subscriber roughly doubled, which is worth reflecting in the conversation about what the $16k plus tokens is buying. Milestones still undefined; disclosure of Levanto holding ANTS while operating the default peer still needed.

**D42 — What is the commons?** Protocol and schema, the `routing-client` plugin, the local ledger and savings computation, dashboard surfaces, the peer template, and the two extracted modules from `D8`. Sage, artifacts and training stay Levanto's. **Note the cached-token estimator (`4.3`) is now client-side, hence in the commons** — it is small and general, and every future router benefits.

**D43 — Exclusivity and default placement.** *Lean: time-boxed (6–12 months), disclosed, published policy for how the default changes.*

**D44 — Support and SLA.** A hosted service in a latency-sensitive path, now charging $18/month. *Blocking before charging.*

**D45 — Refunds and proration. RESOLVED by daily signing.** Stop signing; nothing further is owed. `N7` is what makes this true.

---

### 5.5 Sections D and F — still open

#### D. Quality, evaluation and the savings claim

- **D28 — Evidence required before publishing a number.** LODO mean AUC **0.5243**, 3 of 8 datasets below 0.5; the artifact inverts on 3 of 4 held-out `arenahard` slices; SWE-bench puts the archive hull models last and second-to-last of eleven; the proxy README puts `artifact_live9` routing skill at ≈ 0 on its own slice. **`N5` currently blocks the path to answering this.**
- **D29 — Measuring quality with no ground truth.** Regeneration rate; LLM-judge on a sample; shadow A/B. Under zero retention all of this is client-local (`N5`).
- **D30 — Shadow sampling rate.** *Lean: 2%.*
- **D31 — Catalogue ownership and update SLA.** ~$0.80–$25 and 20 min–3 h per model for a full Tier-1 collect. Server-side deploys under `D4`.
- **D32 — Which artifact ships, and is `prune` on or off?** `artifact_live8_pf` ships; `prune` defaults to **off**, so dynamic dominance re-pruning is not actually active. *Lean: ranked-list-with-failover argues for `prune=False`.*
- **D33 — Test coverage before the money path.** Proxy has none outside dashboard tools. *Blocking before billing.*
- **D34 — The `decide()` cost bug.** Passes the raw prompt string where `_predicted_costs` expects `input_tokens`. *Lean: delete it; the ranked API is the one in use.*

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
| Channel gas, amortised (`N8`) | ~$0.05 | ~$0.05 | ~$0.05 |
| **Gross margin** | **~$17.1** | **~$16.7** | **~$15.6** |

Compare the previous model, where a heavy agentic user at 20,000 routed turns was **−$4 to −$12/month**. `D16` and the price change together turn the worst segment into the second-best one. **The margin problem is solved; the user-value problem got harder** — see `D39`.

**Fixed costs the grant offsets:** router R&D; catalogue maintenance; the commons in `D42`; and operating the routing peer, which `D11` makes Levanto's responsibility.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Savings do not transfer to real chat/coding traffic | **High** | **Critical** | Closed beta before any number (`D28`) |
| R2 | **Zero retention blocks ever validating or improving** | **High** | **Critical** | Time-boxed opt-in beta telemetry (`N5`) |
| R3 | $17.96/month exceeds savings for most users | **High** | High | Active-day billing; spend distribution first (`D39`) |
| R4 | Routing blind to cache warmth → wrong picks | **High** | Medium | Wire the estimator (`D18`) |
| R5 | Pre-signed days settled early after cancellation | Medium | High | Never sign ahead; per-day cap (`N7`) |
| R6 | Routing peer is a single point of failure | **High** | Medium | `D20` fallback; `D44` SLA |
| R7 | Losing streaming is a visible regression | Medium | High | Pre-first-token failover cut-off (`D19`) |
| R8 | Plugin coexists with `router-local`, or gates vanish | Medium | High | Make it a `'router'`-type plugin (`D8`/`D1`) |
| R9 | Python sidecar lifecycle problems | Medium | Medium | Fail closed, stop advertising |
| R10 | Per-user λ drift via `OnlineBudgetController` | Medium | Medium | Disable it (`N4`) |
| R11 | Cached-token estimate drifts on prefix invalidation | Medium | Low | Local prefix guard (`4.3`) |
| R12 | Channel-open gas as a spam vector | Medium | Low | Deposit or first signature before opening (`N8`) |
| R13 | Catalogue goes stale | Medium | Medium | Server-side updates; published SLA (`D31`) |
| R14 | Untested code in the money path | Medium | High | Test story before billing (`D33`) |

---

## 8. Phasing

**Phase 0 — Decide (1 week).** `D1`/`D8` plugin type (blocking Phase 1); `N5` telemetry exception (blocking `D28`); `D39` calendar-vs-active day; section D generally.

**Phase 1 — Plumbing, unpriced (4–6 weeks).**
- *AntSeed:* extract `selectCandidatePeersForRouting` / `resolvePeerRoutePlan` into a package; extract the reputation and max-price gates from `LocalRouter` into `@antseed/router-core`; add `'routing'` capability; `/_antseed/route` schema in `packages/protocol`; optional routing methods on `Router`.
- *Levanto:* `routing-client` plugin in TS — new-user-message gate, cached-token estimator, failover walk, local ledger, policy filter, all calling the extracted libs; `routing-server` plugin + Python sidecar; peer-side AntSeed node; **wire cached tokens into ranking (`D18`)**; disable `OnlineBudgetController`.
- *Joint:* trivial reference routing peer in the template.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 instrumented users, with the `N5` telemetry exception active and time-boxed. Dial and opt-in in VPR. Two-number savings dashboard off the local ledger. Streaming decision implemented. **Gate: a defensible savings-and-quality number on real AntSeed traffic.**

**Phase 3 — Launch.** Daily signing per `D35`. Free 30 days for the first 200. Routing-peer picker. Public methodology page.

**Phase 4 — Hardening.** Conformance suite. Default-selection policy. Revisit `D22`/`D26`.

---

## 9. What we still need

**From AntSeed:**

1. **`D1`/`D8` — is `routing-client` a `'router'`-type plugin?** This is the cleanest way to get "replace, don't coexist" and it unblocks Phase 1.
2. **What is the distribution of monthly inference spend per active buyer?** (`D39`) At $0.59/day the breakeven is **~$45/month** at 40% savings. This decides whether the addressable market exists.
3. **Are the two extraction refactors acceptable?** (`D8`) Both are behaviour-preserving and benefit any future router.
4. **Do the commons in `D42` live in this repo under this licence** — now including the cached-token estimator?
5. Default-peer policy, Levanto's placement duration, grant disclosure (`D41`, `D43`).

**From Levanto:**

6. **`N5` — will you accept a time-boxed, opt-in telemetry exception for the beta?** Without it there is no path to answering `D28`, and no way to improve the router after launch.
7. **`D39` — calendar day or active day?** This decides whether the product is power-user-only.
8. **`N6`** — enumerate the billing state that is exempt from "zero retention", so the claim is accurate.

**And before any number goes public:** evidence the savings hold on AntSeed's traffic mix, not on GPQA (`D28`).

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
| **`SpendingAuth` — no deadline (`N7`)** | `packages/contracts/payments/AntseedChannels.sol:38-40` |
| **`reserve()` seller-called, staked (`N8`)** | `packages/contracts/payments/AntseedChannels.sol:149-158` |
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
| Benchmarks and OOD caveats | `BENCHMARKS.md` §8.1 (LODO) |
