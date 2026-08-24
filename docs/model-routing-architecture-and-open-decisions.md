# Model Routing on AntSeed — Architecture and Open Decisions

**Status:** Draft for discussion between AntSeed and Levanto
**Date:** August 2026
**Scope:** Integrating the Levanto router into AntSeed as (a) a **buyer-side routing plugin** built on the existing plugin system, which (b) calls a **routing peer** — a new peer role that Levanto would be the first of.

**Sources studied**

| Repo / branch | Role |
|---|---|
| `antseed-levanto-router` @ `main` | AntSeed monorepo — the host |
| `levantolabs/levanto-router-proxy` @ `master` | **Working reference implementation of the buyer-side router.** Live AntSeed prices, per-peer candidates, cache model, ranked failover, full audit log |
| `levantolabs/sage_model_router` @ `rank-from-precomputed-vector` | **The production router library.** Dynamic pricing, ranked output, price-free training |
| `levantolabs/sage_model_router` @ `main` | Older; superseded — do not use as the reference |

---

## 0. How to read this document

Sections 1–4 describe the target architecture and — importantly — **what is already built**. The router-proxy repo turned out to implement most of the hard parts already, so this document is much less "design a system" and much more "decide where existing pieces go".

Section 5 is the point of the document: **51 open decisions**, grouped by domain, each with options and trade-offs, labelled `D<n>`, marked **Blocking?** and with an **Owner**. Leans are marked as leans.

Sections 6–9 cover unit economics, risks, phasing, and the short list for AntSeed.

---

## 1. Summary

### The proposal

AntSeed gains a **buyer-side routing plugin** — built on the existing plugin system with the smallest possible change — that picks the model for each request. To do that it calls out to a **routing peer**, a new peer role offering model-ranking rather than inference. Levanto operates the first routing peer, powered by Sage, billed at $9/month/user through AntSeed's payment system. The plugin, the peer protocol, and the savings dashboard are router-neutral, so anyone can ship a competing routing peer.

Why the split is right: the parts that must be buyer-side genuinely must be buyer-side. **Live per-peer prices, prompt-cache warmth, failover, and billing reconciliation all depend on what *this* buyer has sent to *which* seller and what it was actually billed.** A remote service cannot know that. The parts that should be remote — the Sage model, the trained heads, the model catalogue — are the parts that need to be updated centrally without shipping an app release.

### What is already built (the big correction)

I initially assessed the `main` branch of `sage_model_router` and concluded that dynamic pricing, cached-input math, ranked output, and multi-turn handling were all missing. **On the production branch plus the router-proxy, most of that is built.**

| Capability | Status | Where |
|---|---|---|
| **Live dynamic AntSeed prices** | **Built** | `PriceWatcher` polls every 60s; `PriceBook` injected via `set_prices()`; λ re-bisected in ~105 ms on every price change |
| **Per-peer pricing (model–peer–price tuples)** | **Built** | `peer_offers()` + `build_alias_plan()` → `model@peer` alias keys with their own rates |
| **Ranked list output** | **Built** | `rank_candidates_from_vector()` returns every `(model, seller)` scored and sorted |
| **Precomputed Sage vector input** | **Built** | Caller owns the Sage call; router ranks from the vector |
| **Price-independent training** | **Built** | Ridge predicts *completion tokens*; price multiplies at serve time (`train_pricefree.py`) |
| **Dynamic hull recomputation** | **Built, default off** | `_live_hull()` re-prunes when prices move; `prune=False` by default |
| **Failover / escalation** | **Built** | Ranked walk with `Sinbin` demotion (90 s fast-fail, 600 s hang), persisted |
| **Multi-turn conversation** | **Built (proxy side)** | Full `messages` forwarded; `ctx_tokens` across all messages + tool schemas; prefix-hash conversation threading |
| **Cached-input cost math** | **Built but NOT WIRED** | `cache_model.py` is complete and empirically calibrated — see below |
| **Audit ledger** | **Built** | 14-table SQLite: `request`, `candidate`, `attempt`, `sage_call`, `price_change`, `sinbin`, … |

### The one thing genuinely missing: cached-input math in the ranking

`cache_model.py` is a serious piece of work — per-(model, peer) prefix-hash warmth tracking, learned recall per age bracket `(30, 120, 600, 1200, 2400)` seconds, an additive per-seller token offset (measured: Fire Ant bills +1757/+1750/+1742 tokens flat, so a *ratio* would be wrong), and a 1024-token minimum cacheable floor found by bisection. It exposes exactly the right function:

```python
def effective_in(self, prefixes, quote) -> float:
    """Blended input price for one offer, given what we expect to be cached."""
    hit = self.hit_rate(prefixes, quote.model, quote.peer)
    return quote.price_in * (1 - hit) + quote.cached_in * hit
```

**`effective_in` is never called anywhere.** The cache model runs *after* routing, for prediction logging and billing reconciliation only. The ranking call is:

```python
cands = router.rank_candidates_from_vector(sr.vector, cqt, input_tokens=ctx_tokens)
```

— a single scalar token count, and `PriceBook` carries only `(price_in, price_out)` with no cached rate. So the router ranks as though every candidate were a cold cache, which **systematically under-values whichever seller already holds the conversation prefix** — exactly the seller you want to stick to in a multi-turn chat or an agentic loop. `tools/score_cache_predictions.py` even notes that effective input price error "is what a ranking would consume", so the intent was there.

This matters more than it sounds. In an agentic coding loop the prompt is mostly a growing shared prefix, cache-read rates are typically ~10× cheaper than fresh input, and the router is currently blind to all of it. Wiring it is the highest-value, best-specified piece of work in the project — see `D18` for the concrete change list.

### The three things that still decide viability

1. **Evidence for the savings claim** (`D28`–`D31`). Unchanged and, if anything, reinforced by Levanto's own README: the shipped `artifact_live9` measures **routing skill ≈ 0** on its Tier-1 slice, against +2.84 pp on the 8-dataset archive mix, and is described as out of distribution on anything else — which is why `artifact_live8_pf` ships instead. Leave-one-dataset-out mean AUC is **0.5243**. AntSeed's traffic is chat and coding agents. **"Save 40%" is not currently supported for AntSeed's workload mix.**

2. **Privacy** (`D22`–`D26`). Routing sends conversation content to `sage.levanto.ai`, in a client called the **Virtual Private Router**. Mitigated somewhat by `prompt_trim` (head+tail to 4096 tokens, sent last-user-turn-only), but the exposure is real.

3. **Subscriptions do not exist in AntSeed** (`D35`–`D38`). `AntseedSubPool` was removed; the CHANGELOG records it. Everything is per-request cumulative `SpendingAuth`.

And one new one, which is a genuine architectural fork:

4. **Streaming versus failover** (`D19`). The proxy sends `stream: false` and buffers, because you cannot walk to the next candidate after you have already streamed half an answer to the client. AntSeed's transport *does* support streaming (`handleRequestStream`, `HttpResponseChunk` frames). Losing streaming in the VPR chat UI would be a very visible regression.

---

## 2. Goals and non-goals

### Goals

| # | Goal | How we will know |
|---|---|---|
| G1 | A great model router for AntSeed users | Measured savings at matched quality on **AntSeed's real traffic**, not benchmarks |
| G2 | Feels like a feature, not a product | One toggle and one dial inside VPR; no new accounts, keys, or installs |
| G3 | Open | A third party ships a competing routing peer from public docs, and appears in the same picker |
| G4 | Levanto builds the reusable commons | Plugin, peer protocol, ledger, dashboard live in AntSeed packages under AntSeed's licence |
| G5 | Sustainable for Levanto | Subscription plus grant covers R&D, catalogue maintenance, commons engineering |

### Non-goals for v1

- Networks other than AntSeed; modalities other than text
- Ensembling, cascading, retry-on-low-confidence
- Replacing peer selection wholesale — though note `D8`, because the router **does** rank per-peer today and that overlaps with `rankModelRoutes()`

---

## 3. What exists today

### 3.1 AntSeed — the relevant seams

**Plugin system.** Types are `'provider' | 'router' | 'verifier' | 'prover'`. Critically, there is already a **duck-typed optional-extension pattern** on the existing `Router` interface, used in production:

```ts
type BuyerPolicyRouter = Router & {
  allowsPeerForPolicy?: (req: SerializedHttpRequest, peer: PeerInfo) => boolean
  allowsPeerForPricing?: (req: SerializedHttpRequest, peer: PeerInfo) => boolean
}
```

`peerAllowedByPolicy()` probes for those methods and falls back when absent. **This is the minimal-change path for a routing plugin** — see `D1`.

**Discovery.** Sellers announce subnet, wildcard, peer, and one capability topic per `PeerOffering`. Buyers filter on signed metadata. `ProviderCapability` is a closed union with no `'routing'` member.

**Wire protocol.** HTTP-over-P2P (`SerializedHttpRequest`, frames `0x20`/`0x21`, streaming `0x22`/`0x23`). Two paths bypass provider matching and payment: `GET /v1/models` and `POST /_antseed/attest/{verifierId}` — the precedent for a routing RPC.

**Model selection today.** The client sends `model`; the proxy canonicalises it and ranks *peers* via `rankModelRoutes()` against `ModelRoutingPreferences`. **No hook asks anything which model to use.**

**Payments.** Cumulative channels; `computeCostUsdc` *does* handle `cachedInputUsdPerMillion`; buyer re-verifies against a 1.4× tolerance; 2% platform fee.

**Metering.** `metering_events` lacks model name and cached split. `payment_channel_service_totals` has `service_id`, cumulative amount, and fresh/cached/output tokens — but cumulative only, no per-request rows, **no price snapshot**.

**Savings UI — already shipped.** `computeMeasuredSavings` compares actual USDC against retail re-pricing, in VPR Home, VPR Activity, and `antseed buyer activity`.

**Price history.** None network-side.

### 3.2 The Levanto router-proxy — a working buyer-side router

This is the important discovery. `levanto-router-proxy` is a standalone Python HTTP service that already does, end to end, what the routing plugin needs to do:

```
OpenAI / Anthropic / Responses request
  → tokenize (tools + tool_calls counted, tokens_version=2)
  → prompt_trim head+tail to 4096 tok → Sage /decide/batch → 30-dim vector
      (SageCache LRU 256 convs dedups agentic loops)
  → rank_candidates_from_vector(vector, cqt, input_tokens=ctx_tokens)
      against a live PriceBook refreshed every 60s
  → filter purchasable, apply Sinbin demotion, log all candidates
  → walk the ranked list: POST localhost:8377/v1/chat/completions
      with x-antseed-pin-peer: <peerId>
      on timeout/refusal → sinbin the pair, continue to next candidate
  → bill at the seller actually used (rate_for(model, peer)), not the cheapest
  → observe cache warmth, log request/candidates/attempts/response
```

Notable engineering decisions already made and worth keeping:

- **Provider and prices switch together** — "never route on one market, bill through another"
- **Bill at the seller actually used**, not the cheapest quote
- **Recall is not seeded from history** — a historic row has no prefix, so scoring a hit against the whole prompt reads as a much worse cache than reality (measured: 46% vs a true 99%)
- **Warmth keyed on prefix, not conversation id** — a conversation id derived from its own history changes every turn and predicted cold on 16 of 17 turns that were in fact warm
- **Trim below the Sage cliff** — Sage answers all ten questions to ~26k tokens and none above ~28k, where `vectorize` silently fills neutral priors

Known limitations stated in the repo: no streaming; Sage called on every request (~$0.0006 floor); no unit tests outside dashboard tools; and a discrepancy where the README says a per-request `cqt` is honoured but `proxy.py` deliberately ignores it so "a client's model string cannot quietly change what we spend".

**Two dependencies that are not production-grade:** prices are read from `~/.antseed/buyer.state.json` — a private file whose format is not a supported API (`D14`) — and the artifact (`artifact_live8_pf.joblib`, 3 MB) is loaded **in-process on the client**, meaning today's architecture has no routing peer at all: only Sage is remote (`D4`).

### 3.3 Gap analysis

| Capability | AntSeed | Levanto stack | Net-new work |
|---|---|---|---|
| Routing plugin hook | ✗ | n/a | **AntSeed — small** (optional method, `D1`) |
| `routing` capability + peer RPC | ✗ | ✗ | AntSeed protocol — small/medium |
| Live per-peer prices into routing | ✓ source | ✓ **built** | Replace file-read with supported API (`D14`) |
| Ranked (model, peer) output | n/a | ✓ **built** | — |
| Failover / sinbin | partial | ✓ **built** | Reconcile with `rankModelRoutes()` (`D8`) |
| Multi-turn conversation | n/a | ✓ **built** | — |
| **Cached-input math in ranking** | ✓ in billing | **built, unwired** | **Levanto — small, high value (`D18`)** |
| Per-request ledger + price snapshot | ✗ | ✓ **built** (SQLite) | Port to AntSeed storage |
| Counterfactual baseline | ✗ | partial (`Board.at(ts)`) | Joint — medium |
| Retail-baseline savings UI | ✓ **shipped** | n/a | Extend only |
| Streaming with failover | ✓ transport | ✗ | **Joint — unsolved (`D19`)** |
| Python router in a Node plugin | n/a | n/a | **Joint — architectural (`D3`)** |
| Subscription billing | ✗ removed | n/a | AntSeed — large, or avoid |
| Entitlements | ✗ | n/a | AntSeed — medium |

---

## 4. Proposed architecture

### 4.1 Component map

```
┌────────────────────────────────────────────────────────────────────────────┐
│ BUYER  (VPR / CLI)                                                         │
│                                                                            │
│  buyer-proxy ──probes──► Router plugin                                     │
│                            · allowsPeerForPolicy?()      ← exists today    │
│                            · allowsPeerForPricing?()     ← exists today    │
│                            · rankModels?()               ← NEW, optional   │
│                                    │                                       │
│  ┌─────────────────────────────────▼──────────────────────────────────┐   │
│  │ @antseed/router-routing  (router-neutral, AntSeed-owned)           │   │
│  │  · assembles candidates: purchasable (model, peer, live prices)    │   │
│  │  · CacheModel: prefix warmth + learned recall per (model, peer)    │   │
│  │  · calls the selected routing peer; timeout → fall back            │   │
│  │  · walks the ranked list, sinbin on failure                        │   │
│  │  · writes routing_decisions with the price snapshot                │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                    │                                    │                  │
│                    │ /_antseed/route                    │ inference        │
└────────────────────┼────────────────────────────────────┼──────────────────┘
                     ▼                                    ▼
        ┌──────────────────────────┐         ┌──────────────────────────┐
        │ ROUTING PEER   ← NEW     │         │ PROVIDER PEER (existing) │
        │ capability: "routing"    │         │ capability: "inference"  │
        │ Sage + heads + hull + λ  │         └──────────────────────────┘
        │ Levanto is the first     │
        └──────────────────────────┘
```

**Why cache warmth must be buyer-side.** `CacheModel` learns from what *this buyer* was billed by *each seller*, keyed on prefix hashes of *this buyer's* conversations. It is per-user, per-seller, privacy-sensitive state that also happens to be the thing that makes multi-turn routing correct. It cannot move to a shared remote service without either leaking conversation structure across users or being wrong. This is an independent argument for the buyer-side-plugin shape.

### 4.2 Request lifecycle

```
1. App sends POST /v1/chat/completions {model: "auto", messages: [...]}
2. Routing enabled? entitled? sentinel model?              ─no→ existing path
3. Plugin assembles candidates from live peer metadata:
     (model, peerId, inputUsdPerM, outputUsdPerM, cachedInputUsdPerM, trust, load)
4. Plugin computes prefix hashes → per-candidate expected cache hit rate
     → effective input price per candidate                        ← D18
5. POST /_antseed/route {conversation-or-vector, candidates, cqt}
     budget ~800ms hard timeout → on timeout, fall back            ← D20
6. Peer returns ranked (model, peer) list + predicted quality/cost + receipt
7. Plugin re-filters against local policy (max price, min trust, block list)
8. Walk the list: dispatch, on failure sinbin the pair and continue
9. Write routing_decisions with chosen model, counterfactual baseline,
     and the price snapshot at decision time
10. Dashboard aggregates into the two savings numbers
```

### 4.3 The two savings numbers

```
  Retail baseline (OpenRouter list price for baseline model X)
        │   ← "AntSeed savings"   (already shipped: computeMeasuredSavings)
        ▼
  AntSeed baseline (model X at the AntSeed price at time of inference)
        │   ← "Router savings"    (NEW: what this project adds)
        ▼
  Actual paid (routed model at the AntSeed price at time of inference)
```

Both must be shown with the middle line visible, or the router appears responsible for savings that come from AntSeed's marketplace. Requires a per-request price snapshot (`D27`).

### 4.4 The minimal plugin change (strawman for `D1`)

Following the existing optional-extension pattern exactly — no new plugin type, no loader change, no registry change:

```ts
// packages/node/src/interfaces/buyer-router.ts — additive, all optional
export interface ModelCandidate {
  model: string
  peerId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
  trustScore?: number
  currentLoad?: number
}

export interface RankedModel {
  model: string
  peerId: string
  score: number
  predictedQuality?: number
  predictedCostUsd?: number
}

export type ModelRankingRouter = Router & {
  rankModels?(
    req: SerializedHttpRequest,
    candidates: ModelCandidate[],
    signal: AbortSignal,
  ): Promise<RankedModel[] | null>   // null = no opinion, use existing path
}
```

The buyer proxy probes for `rankModels` exactly as it probes for `allowsPeerForPolicy`, between `extractRequestedService()` and `selectCandidatePeersForRouting()`. Returning `null` or throwing degrades to today's behaviour. The one genuine change: this method is **async**, whereas `selectPeer` and the policy hooks are synchronous — that is the real cost of the minimal path, and it is confined to one call site.

---

## 5. Open decisions

### A. Plugin, peer, and the split between them

---

**D1 — How does the routing plugin attach to the plugin system?**

The stated constraint is to change the plugin system as little as possible.

| Option | Change surface | Notes |
|---|---|---|
| **A. Optional `rankModels?()` on the existing `Router` interface** | One optional method + one call site in `buyer-proxy.ts` | **Exactly the pattern `allowsPeerForPolicy` already uses.** No new plugin type, no loader/registry/config changes. Requires making one call site async |
| B. New `AntseedRoutingPlugin` (`type: 'routing'`) | Plugin union, loader, CLI registry, config types, templates, docs | Conceptually cleaner; a user could run a routing plugin *and* a policy router plugin simultaneously |
| C. Reuse `provider` type with a magic name | None | Pollutes the model catalogue; brittle |

*Lean: **A**. It satisfies the constraint almost perfectly. The one thing to check is whether AntSeed wants routing policy and model ranking to be separable plugins — if yes, B. Blocking: yes. Owner: AntSeed.*

---

**D2 — Does the routing peer get a `'routing'` capability, and how is it discovered?**

Adding `'routing'` to `ProviderCapability` gives a DHT capability topic and `PeerOffering` discovery for free — a genuinely small, additive change. The alternative (hard-coded URL in plugin config) is smaller still but is not "a new type of peer" in any meaningful sense and kills G3.

*Lean: add `'routing'` to the capability union; the offering carries supported models, artifact version, privacy modes, billing model, and data policy. Blocking: yes. Owner: AntSeed.*

---

**D3 — The router library is Python; AntSeed plugins are TypeScript. How?**

This is unavoidable and currently unaddressed.

| Option | Pros | Cons |
|---|---|---|
| **A. All ML in the routing peer; the plugin is thin TypeScript** | Plugin is idiomatic Node; no Python on the client; catalogue updates are server-side | Every routed turn is a network round trip; peer sees more |
| B. Python sidecar process managed by the plugin | Reuses the proxy almost verbatim | Ship Python + sklearn + a 3 MB artifact to every desktop client; version hell; Electron packaging pain |
| C. Port ranking to TypeScript, keep training in Python | No runtime Python | Reimplement `HistGradientBoosting` inference and ridge in TS, or export to ONNX; artifact still ships to clients |
| D. Keep the proxy as a separate local service the user installs | Zero AntSeed work | Fails G2 completely |

*Lean: **A**, which also resolves `D4`. Blocking: yes — this is the decision that determines what the plugin actually contains. Owner: Joint.*

---

**D4 — Where is the split point: what runs on the peer versus the plugin?**

Today's proxy puts *everything except Sage* on the client. That is the opposite of the proposed architecture and it matters.

| Split | Peer does | Plugin does | Consequence |
|---|---|---|---|
| **A. Peer = Sage only** (today) | Feature vector | Artifact, heads, hull, λ, ranking | **3 MB artifact ships to every client**; catalogue updates need app releases; router IP is on disk |
| **B. Peer = Sage + ranking** | Vector, heads, hull, λ, ranked list | Candidates, cache model, failover, ledger | Catalogue updates are server-side; IP stays server-side; peer sees conversation + candidate prices |
| C. Peer = ranking only | Heads, hull, λ | Sage call + everything else | Two remote hops; no benefit |

Note the interaction with `D18`: under split B the peer needs the per-candidate effective input price, which the plugin computes from local cache state — so the plugin sends `effectiveInputUsdPerMillion` per candidate rather than the raw rate. That is clean and keeps cache state local.

*Lean: **B**. It is the only split where "routing peer" means anything, where the model catalogue can be updated without an app release, and where Levanto's IP is not sitting on every user's disk. Blocking: yes. Owner: Joint.*

---

**D5 — Who owns the peer protocol schema, and under what licence?**

For G3 to be credible the schema must live in `packages/protocol`, versioned like the rest of the spec, with a conformance suite and a `docs/protocol/templates/routing-peer/` template mirroring the existing provider/router templates. *Blocking: yes. Owner: AntSeed.*

---

**D6 — One routing peer, or query several?**

Merging rankings from routers with different objectives is ill-defined, and each adds latency and cost. *Lean: one active peer, user-selectable, with a documented failover peer. Blocking: no. Owner: AntSeed.*

---

**D7 — Does the peer rank models, or (model, peer) tuples?**

The proxy already ranks `(model, peer)` via `model@peer` aliases, and per-peer price dispersion is likely a large share of the savings. But it puts the routing peer in a position to steer traffic to specific sellers.

*Lean: keep `(model, peer)` ranking — it is built and it is where the money is — but the plugin re-validates every candidate against local policy, and realised-vs-predicted savings are monitored per peer as a steering detector (`D26`). Blocking: yes. Owner: Joint.*

---

**D8 — How does peer-aware routing reconcile with `rankModelRoutes()`?**

Two ranking systems now overlap. Options: router proposes the model only and `rankModelRoutes()` picks the peer (loses price dispersion); router proposes `(model, peer)` and `rankModelRoutes()` is bypassed (loses AntSeed's cooldown/failure-streak signals); or router proposes `(model, peer)` and `rankModelRoutes()` filters and re-orders within the router's model choice.

*Lean: the third. Also worth noting the proxy's `Sinbin` and AntSeed's peer cooldown/failure-streak logic are the same idea implemented twice — they should be unified, and AntSeed's is the one to keep. Blocking: yes. Owner: AntSeed.*

---

**D9 — Are local policy constraints hard filters or advisory?**

*Lean: sent as context, re-enforced locally, violations logged as a router quality signal. Blocking: no. Owner: AntSeed.*

---

**D10 — Protocol versioning and deprecation policy.**

Routing peers are third-party services on independent release cycles. Version in request and response, additive-only within a major, documented support window. *Blocking: no, but cheap now and expensive later. Owner: AntSeed.*

---

### B. Data, pricing and the cache model

---

**D11 — Where does the plugin get live prices?**

The proxy reads `~/.antseed/buyer.state.json` and parses `discoveredPeers[].providerPricing`. That is a private file format with no compatibility guarantee — it will break.

| Option | Notes |
|---|---|
| **A. In-process: the plugin already runs inside the buyer and can call `node.discoverPeers()` / `buildNetworkServiceOffers()`** | Correct answer if `D1`-A is chosen; no file, no polling, always current |
| B. Supported local HTTP endpoint on the buyer proxy | Needed only if the router stays an external process (`D3`-D) |
| C. Keep reading `buyer.state.json` | Works today; breaks silently on any format change |

*Lean: **A**. Blocking: yes. Owner: AntSeed.*

---

**D12 — Price refresh cadence and λ recalibration.**

The proxy polls every 60 s and re-bisects λ (~105 ms) whenever the catalog signature changes. In-process this becomes event-driven off peer metadata updates. Open: is λ recalibration on the plugin (needs the calibration cache locally) or the peer (needs the prices)? Under `D4`-B it belongs on the peer, which means the **plugin must send the candidate price table on every request** — a few KB, acceptable.

Also open: `DYNAMIC_PRICING.md` notes there is **no price-movement hysteresis**. On a volatile marketplace this could produce visible model flapping mid-conversation. *Lean: add hysteresis, or lean on TTL stickiness to mask it. Blocking: no. Owner: Levanto.*

---

**D13 — Model name canonicalisation across AntSeed, OpenRouter, and the panel.**

Three naming systems already in play: panel names (`deepseek-v4-flash-0731`), AntSeed service names (`deepseek-v4-flash`), and OpenRouter slugs. Handled today by hardcoded dicts (`ANTSEED_SERVE_AS`, `ANTSEED_COLLECT_ALIAS`) plus `peer_aliases`. AntSeed has its own `canonicalModelKey` / `model-identity`. *Lean: adopt AntSeed's canonicaliser as the single source of truth; delete the hardcoded dicts. Blocking: no. Owner: Joint.*

---

**D14 — What happens to models the router has never seen?**

`purchasable: False` today, so an unknown model is simply unroutable — the user silently loses access to it under routing. Options: fall back to the user's default for unknown models; expose "N of M models on the network are routable"; use the alias mechanism to give unknown models a donor head. *Lean: surface the coverage number honestly in the UI; alias aggressively. Blocking: no. Owner: Joint.*

---

**D15 — Sage prompt trimming: budget and strategy.**

Currently head+tail to 4096 tokens, with a hard cliff at ~26–28k where Sage silently returns *empty* features and `vectorize` fills neutral priors — i.e. the router degrades to "no opinion" without any error. Open: is 4096 right? Should the trim be conversation-aware (keep the system prompt and the last turn rather than head+tail of one string)? Should hitting the cliff be a logged, surfaced failure rather than a silent prior-fill? *Lean: yes to all three; the silent prior-fill is a bug worth fixing before launch. Blocking: no. Owner: Levanto.*

---

**D16 — Is the Sage vector cached, and keyed how?**

`SageCache` is an LRU over 256 conversations keyed on `(conv, last_user, trim_budget)` — it dedups agentic retry loops but not much else. Since Sage is called on every non-deduped request at a ~$0.0006 floor, cache policy is a direct COGS lever (`D37`). *Lean: extend to a content-hash cache with a TTL; measure hit rate before tuning. Blocking: no. Owner: Levanto.*

---

**D17 — Per-request `cqt` override: currently README says yes, code says no.**

`proxy.py` deliberately ignores a per-request `cqt` so "a client's model string cannot quietly change what we spend". That is a defensible security posture that contradicts the docs. Decide and align. *Lean: keep the code's behaviour; fix the README; allow override only via an authenticated settings call. Blocking: no. Owner: Levanto.*

---

**D18 — Wire the cache model into ranking. (Highest-value item.)**

Everything needed exists; it is not connected. The concrete change list:

1. `PriceBook.PerToken` becomes a 3-tuple `(price_in, price_out, price_cached_in)`, or a small dataclass. Currently `tuple[float, float]`.
2. `Catalog.book()` stops discarding `cached_in` — it already has it on `Quote`.
3. `rank_candidates_from_vector` accepts a per-candidate expected hit rate (or a precomputed effective input price), rather than one scalar `input_tokens` for all candidates.
4. `_predicted_costs` / `cost_ridge.predicted_cost` use `effective_in` in place of `price_in`.
5. Lambda calibration (`CalibrationCache.costs_at`) uses the same blended rate, or λ drifts against the new cost scale.
6. `CacheModel.effective_in()` — already written — gets called.

Open sub-decisions: does the *cold-start* case (no observations for a seller, `recall` returns 0) bias against new sellers? It errs toward over-stating cost, which is the safe direction for billing but means a fresh peer never wins the stickiness bonus it deserves. And should the hull/dominance computation use blended or raw input prices — blended makes the hull conversation-dependent, which is more correct and more expensive.

*Lean: do it, before launch, with cold-start behaviour explicitly chosen rather than inherited. Blocking: no for a demo, yes for the savings claim on multi-turn traffic. Owner: Levanto.*

---

**D19 — Streaming versus failover. (Unsolved.)**

The proxy sends `stream: false` because you cannot fail over after streaming half an answer. AntSeed supports streaming end to end. Chat UX without streaming is a very visible regression.

| Option | Trade-off |
|---|---|
| No streaming when routing is on | Simplest; users will notice and complain |
| Stream, but only fail over before the first token | Keeps streaming and most of the failover value; connection errors mid-stream still surface to the user |
| Stream into a buffer, release on first token, fail over only pre-token | Same as above, cleaner to implement against `handleRequestStream` |
| Fail over mid-stream by restarting the response | Visible flicker/duplication; bad |

*Lean: the pre-first-token cut-off. Most failures — refusals, 429s, connection failures, cold peers — occur before the first token. Blocking: yes, if routing is on by default in the VPR chat UI. Owner: Joint.*

---

**D20 — Latency budget and fallback.**

Sage adds ~400–510 ms on a routed turn. Options: hard timeout to the default model (predictable, occasionally loses savings); wait (unbounded tail); prefetch advice for turn N+1 during turn N's generation (hides it entirely for multi-turn, wrong if the next turn is unrelated). *Lean: hard timeout ~800 ms; revisit prefetch in v2. Blocking: yes. Owner: Joint.*

---

### C. Privacy and trust

---

**D21 — What leaves the machine?**

Under `D4`-B the routing peer sees the trimmed last user turn (≤4096 tokens) plus the candidate price table. Under `D4`-A it sees only the trimmed turn. Either way, conversation content reaches `sage.levanto.ai` from a product called the Virtual Private Router.

| Mode | Peer sees | Quality | Cost |
|---|---|---|---|
| **Trimmed last turn (today)** | ≤4096 tokens of the current user message | What the model was trained on | None — built |
| Redacted | Same, PII/secrets stripped client-side | Slightly degraded; redaction is imperfect | Medium |
| Features-only | Nothing — 30-dim vector computed on-device | No content exposure | **High — needs a local Sage, which is the core IP** |
| TEE-attested | Full text inside an attested enclave | Best | High; AntSeed's prover/verifier machinery could carry the attestation |

The uncomfortable observation stands: **features-only fits AntSeed's brand best and destroys Levanto's moat.** Better named now than discovered in month four.

*Lean: v1 ships opt-in trimmed-last-turn with prominent honest disclosure; TEE attestation is the roadmap differentiator. Blocking: yes. Owner: Joint.*

---

**D22 — Opt-in granularity.**

Coding agents carry source the user may not be permitted to send to a third party. *Lean: global default, per-conversation off switch, path-based exclusions for coding contexts. Blocking: no. Owner: AntSeed.*

---

**D23 — What may a routing peer retain, and how is that enforced?**

*Lean: machine-readable data policy in the routing offering, shown in the picker before selection; contractual in v1, attested later. Blocking: yes for launch. Owner: AntSeed.*

---

**D24 — Does Levanto train on AntSeed users' prompts?**

Worth an explicit answer because the incentive to be vague is strong. *Lean: derived features and outcome labels only, never raw text, unless separately opted into. Blocking: yes. Owner: Joint.*

---

**D25 — Cache prefix hashes and conversation identity.**

`prefix_hashes` builds a cumulative SHA-256 chain over message content. These stay local under the proposed architecture — but if any telemetry ships them, they are a conversation fingerprint and a confirmation oracle for known content. *Lean: never leave the device; explicitly excluded from any telemetry. Blocking: no. Owner: Joint.*

---

**D26 — Preventing router self-dealing.**

A routing peer that also runs provider peers, or takes seller payments, can steer traffic profitably. Since the router ranks `(model, peer)` (`D7`), the surface is real. Mitigations: affiliation disclosure in the offering; buyer-side realised-vs-predicted monitoring (cheap, and doubles as a quality metric); shadow sampling (`D30`); contractual separation; attestation.

*Lean: disclosure + realised-savings monitoring in v1, shadow sampling in v2. Blocking: yes for the openness story. Owner: AntSeed.*

---

**D27 — Where does the price snapshot at decision time live?**

The proxy logs `price_change` and reconstructs history via `Board.at(ts)`, but does **not** store the rates on the request row. Reconstruction breaks the moment the change log is trimmed or a poll is missed.

*Lean: a `routing_decisions` table in AntSeed's SQLite storage that stores the chosen candidate, the baseline, and the actual rates used — denormalised on purpose, because this row is the evidence behind a number the user is being charged $9/month for. Blocking: yes. Owner: AntSeed.*

---

### D. Quality, evaluation and the savings claim

---

**D28 — What evidence is required before publishing a savings number?**

The counter-evidence is Levanto's own: LODO mean AUC **0.5243** with 3 of 8 datasets below 0.5; the shipped artifact inverts on 3 of 4 held-out `arenahard` slices; on SWE-bench the archive-panel hull models rank last and second-to-last of eleven; and the proxy README states `artifact_live9` shows **routing skill ≈ 0** on its own Tier-1 slice against +2.84 pp on the 8-dataset mix, and is "unproven until retrained on something broader".

AntSeed's traffic is chat and coding agents. *Lean: no public percentage until measured on AntSeed-representative traffic; closed beta first (`D45`). Blocking: yes for marketing. Owner: Joint.*

---

**D29 — How is quality measured on real traffic with no ground truth?**

Savings alone is trivially gamed by always picking the cheapest model. Options: regeneration and model-switch rate as implicit dissatisfaction (free, decent proxy); LLM-judge on a sample (moderate cost); shadow A/B (best causal estimate, costs the sampled savings). *Lean: regeneration rate always-on, plus a small shadow sample. Blocking: no for v1, yes before scaling. Owner: Joint.*

---

**D30 — Shadow sampling rate.**

At p = 2% the forfeited savings are negligible. *Lean: 2%, disclosed in the methodology page. Blocking: no. Owner: Levanto.*

---

**D31 — Catalogue ownership and update SLA.**

A full Tier-1 collect is 3,198 prompts, roughly **$0.80–$25 in OpenRouter spend** and **20 minutes to 3+ hours** wall time per model; retraining is CPU-seconds. The alias mechanism is free but only valid when quality transfers.

Under `D4`-B, catalogue updates are a server-side deploy — a real advantage over today's client-side artifact. Open: how fast must a newly-popular model become routable, who pays for the collect, and is the supported set published? *Lean: publish the supported set in the offering; commit to a stated SLA. Blocking: no, but it is the main recurring cost the grant is meant to cover. Owner: Levanto.*

---

**D32 — Which artifact ships, and is `prune` on or off?**

`artifact_live8_pf` ships today; `artifact_live9` is explicitly warned against (five heads, no calibration cache, OOD). Separately, `prune` defaults to **off**, so the live hull is the frozen artifact list and dynamic dominance re-pruning — one of the headline features of the dynamic-pricing work — is not actually active by default. `PRUNING.md` reports 100% decision agreement between train-time and serve-time pruning, and that the unrestricted panel wins rank 1 on 39–49% of rows.

*Lean: decide explicitly rather than inheriting the default; the ranked-list-with-failover design argues for `prune=False` so alternates survive. Blocking: no. Owner: Levanto.*

---

**D33 — Test coverage before this is in the money path.**

The router library has real tests (`test_price_book`, `test_peer_aliases`, `test_lambda_calibration`). The proxy states it has **no unit tests** outside dashboard tools and is "verified against live providers". Porting it into AntSeed's buyer path — where AntSeed has a substantial vitest suite — needs a test story. *Blocking: no, but non-negotiable before billing. Owner: Joint.*

---

**D34 — The `decide()` cost bug.**

`_select()` / `decide()` pass the raw `prompt` string where `_predicted_costs` expects `input_tokens`, while `rank_candidates_from_vector` passes the integer correctly. If `decide()` is on any path that matters, its costs are wrong for `cost_model == "ridge_m4"`. *Lean: fix or delete `decide()`; the ranked API is the one in use. Blocking: no. Owner: Levanto.*

---

### E. Business and commercial

---

**D35 — How is $9/month collected, given AntSeed has no subscriptions?**

| Option | Pros | Cons |
|---|---|---|
| **A. Metered per-route call with a monthly cap (~$0.003/route, capped at $9)** | Works with today's contracts; no Solidity; light users pay less | "$9/month" becomes "up to $9/month"; cap enforcement is off-chain |
| B. One $9 `SpendingAuth` at period start | Matches the marketing exactly | Buyer must be online to sign; proration is manual |
| C. Reintroduce a subscription contract | Clean primitive, reusable network-wide | Solidity + audit + deployment; largest single work item |
| D. Off-chain billing (card) | Trivial | Contradicts "use the AntSeed payment system"; adds a Levanto account, breaking G2 |

*Lean: **A** for v1, **C** as the durable answer if AntSeed wants subscriptions generally — in which case Levanto is the design partner for a primitive AntSeed benefits from. Option A also happens to defuse `D39`. Blocking: yes. Owner: AntSeed.*

---

**D36 — Does the 2% platform fee apply?**

$0.18 on $9. Small, but it establishes whether routing peers are ordinary sellers. *Lean: yes, ordinary seller, ordinary fee. Blocking: no. Owner: AntSeed.*

---

**D37 — Who pays for the Sage calls?**

~$0.0006 floor per call, called on every non-deduped request. At 2,000 routed turns/month that is ~$1.20–2.00/user against $9 revenue; a heavy agentic user at 20,000 turns inverts the economics. Levers: `SageCache` policy (`D16`), TTL stickiness, and a short-prompt bypass. *Lean: included up to a fair-use cap, with TTL auto-escalation past the cap rather than extra charges. Blocking: yes for pricing. Owner: Levanto.*

---

**D38 — Free month for the first 200 — mechanism?**

`AntseedFreeUsage` (open/record/close, signature-authorised) exists and may carry this without new contract work. Also: is "first 200" enforced globally (needs a coordinator, and a race) or granted generously? *Lean: reuse `AntseedFreeUsage` if it fits; be generous rather than exact. Blocking: no. Owner: Joint.*

---

**D39 — Is $9/month right, and for whom?**

Breakeven for the user:

| Realised savings | Monthly inference spend to break even |
|---|---|
| 60% | $15.00 |
| 40% | $22.50 |
| 25% | $36.00 |
| 15% | $60.00 |

At the marketed 40%, **a user must spend more than ~$22.50/month on inference for $9 to pay for itself.** Below that it destroys value and those users churn loudly. We do not know AntSeed's spend distribution — **the most important missing number in the business case** (`Q3`).

Alternatives: percentage-of-savings (aligned, harder to verify); tiered by spend; free below a threshold; or `D35`-A metered, which approximates "free for light users" automatically. *Blocking: yes. Owner: Joint.*

---

**D40 — What does "Save 40%" mean precisely, and can we defend it?**

The 42% figure is at cqt=5 against always-GPT-5 on hard multiple-choice benchmarks — a workload AntSeed users do not have. *Lean: no numeric claim until `D28` is satisfied; launch with "pay less for the same quality — see your own numbers", which is honest and lets the product prove itself. Blocking: yes for marketing. Owner: Joint.*

---

**D41 — Grant structure: $16k plus TBD tokens.**

- **Milestones.** "Paid once you're happy" is undefined — tie to pre-agreed criteria (active subscribers, measured savings on real traffic, commons merged and documented)
- **Token amount, vesting, lockup.** Levanto wanting to hold tokens is good alignment; a lockup makes it credible
- **Disclosure.** Levanto holding ANTS while operating the default routing peer must be disclosed publicly
- **What the grant buys.** The commons in `D42` — explicitly *not* the Sage router

*Blocking: yes commercially. Owner: Joint.*

---

**D42 — What is "the commons", and who owns it?**

| Component | Owner | Licence |
|---|---|---|
| Routing peer protocol + schema | AntSeed | Repo licence |
| `rankModels?()` hook + buyer-proxy wiring | AntSeed | Repo licence |
| `@antseed/router-routing` (candidates, cache model, failover, ledger) | AntSeed | Repo licence |
| Savings computation + dashboard surfaces | AntSeed | Repo licence |
| Routing-peer template + conformance tests | AntSeed | Repo licence |
| **Sage API, trained artifacts, training pipeline** | **Levanto** | Proprietary |

Note this now includes the **cache model**, which is a genuinely valuable, empirically-calibrated piece of engineering that every future router would want. Whether Levanto is willing to contribute it to the commons — as opposed to keeping it as a Levanto-plugin advantage — is a real question and materially affects what the grant is buying.

*Blocking: yes. Owner: Joint. This table should be an appendix to the agreement.*

---

**D43 — Exclusivity, default placement, duration.**

Is Levanto the default? For how long? What happens when a second router appears? Permanent default placement would undermine G3. *Lean: time-boxed default (6–12 months) as a launch-partner benefit, disclosed, with a published policy for how it changes. Blocking: yes. Owner: AntSeed.*

---

**D44 — Support, SLA, incident ownership.**

A hosted service in a latency-sensitive path. On-call, uptime commitment, downtime credits, and what the user sees when it is down (`D20`: silent fallback). *Blocking: no for v1, yes before charging. Owner: Levanto.*

---

**D45 — Refunds, cancellation, proration.**

Interacts with `D35`: option B makes mid-month cancellation awkward on-chain; option A makes it trivial. *Blocking: no. Owner: Joint.*

---

### F. Product surface and launch

---

**D46 — Dial: 0–10 or three presets?**

Defaults of 2/5/8 are a three-preset product wearing an eleven-position dial. *Lean: three presets with "Advanced" revealing 0–10, matching the existing VPR slider precedent. Blocking: no. Owner: Joint.*

Related: `cqt` is calibrated against achievable out-of-fold spend on the training distribution, so cqt=5 will not land at the same relative spend on different traffic. Per-user recalibration from their own history ("target 50% of what you were spending") is a real feature with real complexity.

---

**D47 — How does the user say "route this"?**

*Lean: both a sentinel model id (`"auto"`) and a global preference. And: never silently override a deliberate non-sentinel model choice — surface "we'd have picked X, ~$0.004 cheaper" as a nudge instead. Blocking: yes. Owner: Joint.*

---

**D48 — Which model is shown, and when?**

*Lean: after the fact, in message metadata ("answered by GPT-5.6 Luna, saved $0.004"), plus a per-conversation escape hatch. The proxy already logs everything needed, including the full candidate list and escalation depth. Blocking: no. Owner: AntSeed.*

---

**D49 — What is baseline model X, and who picks it?**

This single choice sets the headline number, so it is a marketing decision disguised as a technical one.

| Option | Honesty | Attractiveness |
|---|---|---|
| User picks explicitly | High | Variable |
| Their most-used model before opting in | Highest | Variable; undefined for new users |
| The model the router would pick at cqt=0 | Defensible, per-request accurate | High |
| Most expensive on the network | Low — nobody was going to use it | Highest |

*Lean: user-selectable, defaulting to pre-opt-in most-used, falling back to the cqt=0 pick. Never "most expensive available". Blocking: yes. Owner: Joint.*

---

**D50 — Negative savings, and whether the $9 is netted.**

`computeMeasuredSavings` clamps at zero today — defensible for marketplace-vs-retail, corrosive for a paid product. And "you saved $34" while charging $9 invites angry threads. *Lean: show real numbers including negatives in the detail view; show gross savings prominently with "net of subscription" adjacent. Blocking: no, but decide before launch. Owner: Joint.*

---

**D51 — Closed beta, second router, placement, co-branding.**

- **Beta first?** The cheapest way to resolve `D28` before committing to a number. *Lean: 4–6 weeks, 20–50 instrumented users.*
- **Second routing peer at launch?** Even a trivial reference router ("cheapest above trust T") shipped in the repo would substantiate G3 and validate the interface. *Lean: ship it as part of the template.*
- **Onboarding placement?** Worth more than any launch post, and has a real conversion cost for AntSeed.
- **Co-branding?** "AntSeed Smart Routing" (best for G2) vs "Levanto Router on AntSeed" (best for the marketplace framing). Follows from `D43`.

*Blocking: no. Owner: mixed.*

---

## 6. Unit economics scratchpad

Per user per month. **Revenue:** $9.00 less 2% ($0.18) → **$8.82 net**.

| | Light (300 routed turns) | Typical (2,000) | Heavy agentic (20,000) |
|---|---|---|---|
| Sage calls @ ~$0.0006–0.001 | $0.18–0.30 | $1.20–2.00 | $12.00–20.00 |
| Routing-peer infra (amortised) | ~$0.20 | ~$0.30 | ~$1.00 |
| **Gross margin** | **~$8.3** | **~$6.5–7.3** | **−$4.2 to −$12.2** |

`SageCache` and TTL stickiness are the levers that make the heavy case survivable — which is why `D16` and `D37` are economic decisions, not just optimisations.

**Fixed costs the grant offsets:** router R&D; catalogue maintenance ($0.80–$25/model collect plus retraining, ongoing as models churn); building the commons in `D42`.

**User-side value:** positive only above ~$22.50/month of inference spend at 40% realised savings.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Savings do not transfer from benchmarks to real chat/coding traffic | **High** | **Critical** | Closed beta before any public number; shadow sampling (`D28`, `D29`) |
| R2 | Losing streaming is a visible UX regression | **High** | High | Pre-first-token failover cut-off (`D19`) |
| R3 | Privacy framing collides with the VPR brand | Medium | High | Opt-in, trimmed turn, honest disclosure, TEE roadmap (`D21`) |
| R4 | $9 exceeds savings for most users | Medium | High | Spend distribution first; metered-capped pricing (`D35`-A, `D39`) |
| R5 | Python/TypeScript boundary forces a bad architecture | Medium | High | Put all ML on the peer (`D3`-A, `D4`-B) |
| R6 | Routing blind to cache warmth → wrong picks on multi-turn | **High** | Medium | Wire the cache model (`D18`) |
| R7 | Price volatility causes mid-conversation model flapping | Medium | Medium | Hysteresis or TTL stickiness (`D12`) |
| R8 | Subscription contract becomes the critical path | Medium | High | Ship v1 metered (`D35`) |
| R9 | Router self-dealing accusation | Medium | High | Disclosure, local policy override, realised-savings monitoring (`D26`) |
| R10 | Catalogue goes stale | Medium | Medium | Server-side updates under `D4`-B; published SLA (`D31`) |
| R11 | Heavy agentic users are margin-negative | Medium | Medium | Fair-use cap with TTL escalation (`D37`) |
| R12 | Untested code in the money path | Medium | High | Test story before billing (`D33`) |
| R13 | `buyer.state.json` format change breaks pricing silently | **High** | Medium | Use in-process APIs (`D11`) |

---

## 8. Suggested phasing

**Phase 0 — Decide (2 weeks).** In priority order: `D1`/`D3`/`D4` (plugin shape and split point), `D21` (privacy), `D28`/`D40` (evidence and claim), `D35`/`D39` (billing and price), `D42` (commons boundary).

**Phase 1 — Plumbing, unpriced (4–6 weeks).** Optional `rankModels?()` + buyer-proxy call site; `'routing'` capability; `/_antseed/route` schema and spec page; port the proxy's candidate assembly, cache model, failover and ledger into a TypeScript `@antseed/router-routing`; stand up the Levanto routing peer wrapping `rank_candidates_from_vector`; **wire the cache model into ranking (`D18`)**; trivial reference routing peer. Internal users only, no billing, no UI dial.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 instrumented users. Dial and opt-in in VPR. Two-number savings dashboard. Shadow sampling at 2%. Streaming decision implemented. **Deliverable: a defensible savings-and-quality number on real AntSeed traffic.** This is the gate.

**Phase 3 — Launch.** Billing per `D35`. Free month for the first 200. Routing-peer picker with data-policy disclosure. Public methodology page.

**Phase 4 — Openness and hardening.** Template and conformance suite. Published default-selection policy. TEE attestation track. Network-wide historical price index, if broadly useful.

---

## 9. The short list for AntSeed

1. **Is the minimal plugin change acceptable — an optional async `rankModels?()` on the existing `Router` interface, following the `allowsPeerForPolicy` pattern?** (`D1`) If yes, the plugin-system change is genuinely tiny.
2. **Is a third-party routing peer seeing (trimmed) conversation content acceptable within the VPR privacy positioning, and under what disclosure?** (`D21`)
3. **What is the distribution of monthly inference spend per active AntSeed buyer?** (`D39`) Without it the $9 price is a guess with a hard floor at ~$22.50 of user spend.
4. **Subscriptions: build a primitive, or bill metered-with-a-cap?** (`D35`)
5. **Do the commons packages in `D42` live in this repo under this licence, and is that what the grant buys — including the cache model?** (`D42`)

Plus the default-peer policy, Levanto's placement duration, and grant disclosure (`D43`, `D41`).

And what Levanto owes AntSeed before any number goes public: **evidence the savings hold on AntSeed's traffic mix, not on GPQA** (`D28`).

---

## Appendix — Code references

### AntSeed (`antseed-levanto-router`)

| Concern | Path |
|---|---|
| Plugin interfaces | `packages/node/src/interfaces/plugin.ts` |
| `Router` interface (extension point) | `packages/node/src/interfaces/buyer-router.ts` |
| **Duck-typed optional-extension precedent** | `apps/cli/src/proxy/buyer-proxy.ts:206-212, 290-293` |
| `LocalRouter` policy methods | `plugins/router-local/src/router.ts:136-153` |
| Capability enum, `PeerOffering` | `packages/protocol/src/capability.ts` |
| Peer metadata / announcements | `packages/protocol/src/peer-metadata.ts` |
| HTTP-over-P2P types | `packages/protocol/src/http.ts` |
| Reserved-path precedent (attest, `/v1/models`) | `packages/node/src/seller-request-handler.ts:129-185` |
| DHT topics and announce | `packages/node/src/discovery/dht-node.ts`, `announcer.ts` |
| Model-route ranking | `packages/node/src/routing/model-route-ranking.ts` |
| Cost computation (cached-input aware) | `packages/buyer-core/src/pricing.ts:41-54` |
| Payment contracts | `packages/contracts/payments/AntseedChannels.sol`, `AntseedDeposits.sol`, `AntseedFreeUsage.sol` |
| Metering schema | `packages/node/src/storage/migrations/metering/001_create_tables.ts` |
| Per-service totals (fresh/cached split) | `packages/node/src/storage/migrations/channels/003_create_service_totals.ts` |
| **Savings vs retail (shipped)** | `apps/desktop/src/renderer/modules/catalog/measured-savings.ts` |
| Retail reference prices | `apps/desktop/src/main/billing/openrouter-catalog.ts` |
| VPR preferences (dial precedent) | `apps/desktop/src/renderer/modules/routing/preferences.ts` |
| Protocol spec / templates | `docs/protocol/spec/`, `docs/protocol/templates/` |
| SubPool removal | `CHANGELOG.md:358-360` |

### levanto-router-proxy

| Concern | Path |
|---|---|
| Request lifecycle, ranking call, failover walk | `proxy.py:275-437` |
| AntSeed catalog + peer pinning + billing rate | `providers.py:139-205`, `rate_for` at `89-102` |
| Price polling / change detection | `prices.py` |
| **Cache model (complete, unwired)** | `cache_model.py` — `effective_in` at `273-276` |
| Runtime, catalog swap, λ recalibration | `routing.py:293-380` |
| Router library seam + required API | `router_link.py:21-31` |
| Audit schema (14 tables) | `store.py` |
| Protocol adapters | `anthropic_api.py`, `responses_api.py` |
| Cache prediction scoring | `tools/score_cache_predictions.py` |
| Stated limitations | `README.md:215-227` |

### sage_model_router @ `rank-from-precomputed-vector`

| Concern | Path |
|---|---|
| Dynamic pricing design + caveats | `DYNAMIC_PRICING.md` |
| `PriceBook` (needs cached rate — `D18`) | `price_book.py:38-47`, `mean_cost_at` at `110-125` |
| **`rank_candidates_from_vector`** | `router.py:588-638` |
| `set_prices` / `_live_hull` / `_price_for` | `router.py:384-445` |
| λ recalibration | `router.py:463-486`, `lambda_calibration.py:62-67` |
| Per-peer aliases | `peer_aliases.py:152-159` |
| Sage prompt trimming + the cliff | `prompt_trim.py` |
| Price-free training | `train_pricefree.py:106-129` |
| Pruning rationale | `PRUNING.md` |
| Benchmarks and OOD caveats | `BENCHMARKS.md` (LODO at §8.1) |
