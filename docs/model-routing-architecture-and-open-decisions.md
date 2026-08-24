# Model Routing on AntSeed — Architecture and Open Decisions

**Status:** Draft. Sections A–C resolved 24 Aug 2026; sections D–F still open.
**Scope:** Integrating the Levanto router into AntSeed as **two new plugins** — a client-side routing plugin that consumes a routing service, and a server-side plugin that offers one — communicating over a new **routing peer** capability that Levanto would be the first of.

**Sources studied**

| Repo / branch | Role |
|---|---|
| `antseed-levanto-router` @ `main` | AntSeed monorepo — the host |
| `levantolabs/levanto-router-proxy` @ `master` | Working reference implementation of the buyer-side router |
| `levantolabs/sage_model_router` @ `rank-from-precomputed-vector` | The production router library |

---

## 0. How to read this document

Sections 1–4 describe the architecture as now decided. Section 4 is a substantial rewrite: the answers to `D3`, `D4`, `D11`, `D21` and `D27` moved almost everything to the routing peer and left a deliberately thin client.

Section 5 is the decision ledger. **5.0** is a status table for all 51 decisions. **5.1** covers resolved decisions whose consequences are worth writing down. **5.2** covers the five that were sent back for more work. **5.3** covers four issues the answers newly created — including one that conflicts with a stated product goal, and one you flagged yourself. **5.4** is sections D–F, still open.

Sections 6–9 cover economics, risks, phasing, and what we still need from AntSeed.

---

## 1. Summary

### The shape, as decided

Two plugins and one new peer role:

- **`routing-client` plugin** (TypeScript, runs in the buyer). Holds the CQT dial, the conversation's cache-warmth state, the failover walk, and the final say on local policy. Sends a small request to the routing peer per turn.
- **`routing-server` plugin** (TypeScript shell around a Python sidecar, runs on the routing peer). Runs its own AntSeed node for global peer and price discovery, recalibrates λ globally every N minutes, calls Sage, ranks `(model, peer)` tuples, and keeps the ledger.
- **`routing` capability** on the DHT, so routing peers are discoverable like any other peer and a third party can ship a competing one.

The division follows a clean rule: **anything global goes on the peer; anything about *this user's* conversation stays on the client.** Prices, λ, the model catalogue, and — as it turns out — cache *recall* are all global. The CQT setting and which prefixes this user has sent to which seller are not.

### What is already built

Most of the hard parts exist. The `rank-from-precomputed-vector` branch plus the router-proxy already deliver live dynamic per-peer pricing (`PriceWatcher` polls every 60 s, λ re-bisected in ~105 ms on any price change), ranked `(model, peer)` output, precomputed-vector input, price-independent training, failover with sinbin demotion, multi-turn conversation handling, and a 14-table audit ledger.

### What is not

**The cached-input math is built but not wired.** `cache_model.py` is a serious, empirically-calibrated piece of work — prefix-hash warmth per `(model, peer)`, recall learned per age bracket, an *additive* per-seller token offset, a 1024-token cacheable floor found by bisection. It exposes exactly the right function:

```python
def effective_in(self, prefixes, quote) -> float:
    hit = self.hit_rate(prefixes, quote.model, quote.peer)
    return quote.price_in * (1 - hit) + quote.cached_in * hit
```

**`effective_in` is never called.** It runs after routing, for logging and billing reconciliation only. The ranking call passes one scalar `ctx_tokens`, and `PriceBook` carries no cached rate. So the router ranks as though every candidate were a cold cache, systematically under-valuing whichever seller already holds the conversation prefix — precisely backwards for agentic loops, where the prompt is mostly a growing shared prefix and cache reads are typically ~10× cheaper than fresh input. `D18` has the wiring plan.

The good news from your `D11` answer: moving recall learning to the peer makes it **global across all users**, which is strictly better than the per-user learning the proxy does today and largely dissolves the cold-start problem I raised. See `5.1 / D18`.

### What still decides viability

Sections D–F are unanswered, and they contain the three things that decide whether this ships as described:

1. **Evidence for the savings claim** (`D28`–`D31`). Levanto's own proxy README says the shipped-adjacent `artifact_live9` measures **routing skill ≈ 0** on its Tier-1 slice against +2.84 pp on the 8-dataset archive mix, and is "unproven until retrained on something broader". LODO mean AUC is **0.5243**. AntSeed's traffic is chat and coding agents. **"Save 40%" is not currently supported for AntSeed's workload mix.**
2. **Subscriptions do not exist in AntSeed** (`D35`–`D39`). `AntseedSubPool` was removed; the CHANGELOG records it.
3. **$9/month needs a user spending >$22.50/month** at 40% realised savings to break even (`D39`). We still do not know AntSeed's spend distribution.

And one conflict the answers created: **`D27` puts the savings ledger on Levanto's server, which breaks the neutral-dashboard goal.** See `5.3 / N1` for a dual-write proposal that gets you the data without that cost.

---

## 2. Goals and non-goals

| # | Goal | How we will know |
|---|---|---|
| G1 | A great model router for AntSeed users | Measured savings at matched quality on **AntSeed's real traffic** |
| G2 | Feels like a feature, not a product | One toggle and one dial in VPR; no new accounts or installs |
| G3 | Open | A third party ships a competing routing peer from public docs |
| G4 | Levanto builds the reusable commons | Client plugin, peer protocol, ledger, dashboard live in AntSeed packages |
| G5 | Sustainable for Levanto | Subscription plus grant covers R&D, catalogue, commons |

**Non-goals for v1:** other networks; non-text modalities; ensembling or cascading.

---

## 3. What exists today

### 3.1 AntSeed — the relevant seams

**Plugin system.** Types are `'provider' | 'router' | 'verifier' | 'prover'`. Per `D1` we add two more rather than extending the existing `Router`.

**What the existing `router-local` plugin actually contains** (this matters for `D8`, and the answer is reassuring):

| Piece | Where it lives | Reachable without the plugin? |
|---|---|---|
| `PeerMetricsTracker`, `computeFailureCooldownMs` | `packages/router-core/src/peer-metrics.ts` — **exported** | **Yes**, plain import |
| `scoreCandidates`, `DEFAULT_WEIGHTS` | `packages/router-core/src/peer-scorer.ts` — **exported** | **Yes** |
| `buildNetworkServiceOffers` | `packages/node/src/discovery/service-catalog.ts` | **Yes** |
| `rankModelRoutes`, `chooseBestModelRoute` | `packages/node/src/routing/model-route-ranking.ts` | **Yes** |
| `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` | `apps/cli/src/proxy/routing.ts` | **No — app code, not a package** |
| Buyer proxy's own peer-health state | `apps/cli/src/proxy/buyer-proxy.ts` | Internal to the proxy |
| `LocalRouter.selectPeer()` | the plugin | **Dead in production** — the CLI never calls it |
| `allowsPeerForPolicy` / `allowsPeerForPricing` | the plugin | Thin wrappers: reputation floor + max-price config |
| `onResult` | the plugin | Forwards to its own `PeerMetricsTracker` |

So the plugin holds a reputation gate, a price gate, and a *second, private* metrics tracker. Everything valuable is elsewhere and importable.

**Discovery.** Sellers announce subnet, wildcard, peer, and one capability topic per `PeerOffering`. `ProviderCapability` is a closed union with no `'routing'` member — additive change.

**Wire protocol.** HTTP-over-P2P (`SerializedHttpRequest`, frames `0x20`/`0x21`, streaming `0x22`/`0x23`). `POST /_antseed/attest/{verifierId}` is the precedent for a non-inference RPC.

**Payments.** Cumulative channels; `computeCostUsdc` handles `cachedInputUsdPerMillion`; buyer re-verifies against a 1.4× tolerance; 2% platform fee.

**Savings UI — already shipped.** `computeMeasuredSavings` compares actual USDC against retail re-pricing, in VPR Home, VPR Activity, and `antseed buyer activity`. **It reads local data.**

### 3.2 The Levanto router-proxy

A standalone Python service that already implements the whole buyer-side loop: tokenize (tools counted, `tokens_version=2`) → trim to 4096 → Sage → rank against a live `PriceBook` → filter purchasable → sinbin demotion → walk the ranked list with `x-antseed-pin-peer` → bill at the seller actually used → observe cache warmth → log everything.

Engineering decisions worth keeping: provider and prices switch together ("never route on one market, bill through another"); bill at the seller actually used, not the cheapest; recall deliberately **not** seeded from history (scoring a hit against the whole prompt read as 46% recall where direct measurement showed 99%); warmth keyed on **prefix, not conversation id** (a conversation id derived from its own history changes every turn and predicted cold on 16 of 17 turns that were in fact warm).

Stated limitations: no streaming; Sage on every request (~$0.0006 floor); no unit tests outside dashboard tools.

Two dependencies that do not survive this design: prices read from `~/.antseed/buyer.state.json` (a private format — removed by `D11`), and the artifact loaded **in-process on the client** (removed by `D4`).

---

## 4. Architecture

### 4.1 Component map

```
┌─────────────────────────────────────────────────────────────────────────┐
│ BUYER (VPR / CLI)                                                       │
│                                                                         │
│   buyer-proxy ──hook──► routing-client plugin   (TS, type:'routing')    │
│                                                                         │
│     STATEFUL, per user:                                                 │
│       · CQT dial (config, changeable any time)                          │
│       · warmth table: (model, peer) → last prefix seen, tokens, age     │
│       · conversation prefix chain (hashes stay local — N3)              │
│       · local routing_decisions ledger (see N1)                         │
│     PER REQUEST:                                                        │
│       · assemble warmth integers + constraints + cqt                    │
│       · call routing peer  (1s hard timeout, D20)                       │
│       · re-filter against local policy — local has last word (D9)       │
│       · walk ranked list; stream, fail over only pre-first-token (D19)  │
│       · report outcome back to the peer (feedback channel — N2)         │
└───────────────┬──────────────────────────────────────┬──────────────────┘
                │ POST /_antseed/route                 │ inference
                ▼                                      ▼
┌──────────────────────────────────────┐   ┌──────────────────────────┐
│ ROUTING PEER   (capability:'routing')│   │ PROVIDER PEER (existing) │
│   routing-server plugin (TS shell)   │   │ capability: 'inference'  │
│        └─► Python sidecar            │   └──────────────────────────┘
│                                      │
│   GLOBAL, stateless across clients:  │
│     · own AntSeed node → all peers   │
│       and prices                     │
│     · λ by cqt, recalibrated every   │
│       N minutes on RAW prices (N4)   │
│     · cache recall + token offset,   │
│       learned across ALL users       │
│     · Sage call (trimmed last turn)  │
│     · rank_candidates_from_vector    │
│     · ledger / analytics / billing   │
└──────────────────────────────────────┘
```

**The rule:** global state on the peer, per-conversation state on the client. This is what makes the peer stateless across clients while still doing the cache math.

### 4.2 Why the cache split lands where it does

Cache-aware pricing needs two quantities, and they have opposite homes:

| Quantity | Meaning | Home | Why |
|---|---|---|---|
| **Warmth** | Has seller S seen a prefix of *this* conversation, how many tokens, how long ago? | **Client** | Inherently per-user. Only this client knows what it sent |
| **Recall** | Of prefix tokens a seller has seen, what share comes back billed as cached, at this age? | **Peer, global** | A property of the *seller*, not the user. Learning it across all users is strictly better |
| **Token offset** | Tokens a seller adds to every request (its own system prompt) | **Peer, global** | Same reasoning — measured at +1757/+1750/+1742 flat for one seller |

So the client sends integers, the peer supplies the learned rates, and `hit_rate = (warm / total) × recall(model, peer, age_bucket)` is computed on the peer. **No prefix hashes leave the device** (`5.2 / D25`).

### 4.3 Request shape (strawman)

The client does not know the candidate set — the peer does. So the client sends its **whole warmth table**, bounded by how many `(model, peer)` pairs it has ever used (tens), and the peer joins against its candidate set.

```jsonc
// POST /_antseed/route
{
  "v": 1,
  "cqt": 5,                              // client config, sent per request (D17)
  "sagePrompt": "…trimmed last user turn, head+tail 4096 tok…",   // D15, D21
  "contextTokens": 18422,                // full billable prompt length
  "warmth": [                            // integers only — no hashes (D25)
    { "model": "kimi-k3", "peer": "0x…", "warmTokens": 16000, "ageSec": 240 }
  ],
  "constraints": {                       // peer pre-filters; client re-filters (D9)
    "maxInputUsdPerMillion": 25,
    "minTrustScore": 60,
    "blockedPeerIds": ["0x…"]
  }
}

// 200 OK
{
  "v": 1,
  "ranked": [
    { "model": "gpt-5.6-luna", "peer": "0x…", "score": 0.91,
      "predictedQuality": 0.93, "predictedCostUsd": 0.0009,
      "priceSnapshot": { "inUsdPerM": 0.2, "outUsdPerM": 1.1,
                         "cachedInUsdPerM": 0.02, "effectiveInUsdPerM": 0.06 } }
  ],
  "baselineSuggestion": { "model": "gpt-5.6-sol", "peer": "0x…" },  // for savings (D49)
  "receipt": { "routerId": "levanto-sage", "artifactVersion": "live8_pf",
               "lambdaVersion": "2026-08-24T09:00Z", "decisionId": "…" }
}
```

`priceSnapshot` in the response is what lets the client write a complete ledger row without holding a price table (`N1`).

### 4.4 Request lifecycle

```
 1. App sends {model: "auto", messages: [...]}
 2. Routing enabled? entitled?                          ─no→ existing path
 3. Client: trim last user turn (head+tail 4096)
 4. Client: build warmth table from local prefix state
 5. POST /_antseed/route          [1s hard timeout]
      timeout → stay on current model
              → if none, default to a big/top model      (D20)
 6. Peer: pre-filter by constraints → Sage → rank (model, peer) → return
 7. Client: re-filter against local policy (last word)   (D9)
 8. Client: walk the list. Stream. Fail over only before the first token (D19)
 9. Client: write routing_decisions locally + report outcome to peer
10. Dashboard reads local rows → two savings numbers
```

### 4.5 The two savings numbers

```
  Retail baseline (OpenRouter list price for baseline model X)
        │   ← "AntSeed savings"   (already shipped: computeMeasuredSavings)
        ▼
  AntSeed baseline (model X at the AntSeed price at time of inference)
        │   ← "Router savings"    (NEW)
        ▼
  Actual paid (routed model at the AntSeed price at time of inference)
```

Both shown with the middle line visible, or the router appears responsible for savings that come from AntSeed's marketplace.

---

## 5. Decision ledger

### 5.0 Status

| # | Decision | Status | Resolution |
|---|---|---|---|
| D1 | Plugin attachment | **Resolved** | **B** — new plugin type, not an extension of `Router`; hooks in the client |
| D2 | `routing` capability | **Resolved** | Yes. **Two** plugins: `routing-client` and `routing-server` |
| D3 | Python vs TypeScript | **Resolved** | Client fully TS; server plugin runs the Python router in a **sidecar** |
| D4 | Peer/plugin split point | **Resolved** | **B** — peer does Sage + ranking |
| D5 | Schema ownership | **Resolved** | `packages/protocol`, versioned, with a conformance template |
| D6 | One router or several | **Resolved** | One at a time, user-selectable, user-configurable |
| D7 | Models or (model, peer) | **Resolved** | `(model, peer)` tuples |
| D8 | Reconcile with `rankModelRoutes()` | **Expanded — see 5.2** | Mapping requested; answer is reassuring |
| D9 | Local policy hard or advisory | **Resolved** | **Local has the last word** |
| D10 | Protocol versioning | **Resolved** | Move fast, break things |
| D11 | Where prices come from | **Resolved** | **A, but on the peer only.** Global discovery + global λ |
| D12 | Refresh cadence / λ | **Open — see 5.2** | Tradeoffs requested |
| D13 | Model name canonicalisation | **Resolved** | AntSeed's canonicaliser as single source of truth |
| D14 | Unknown models | **Resolved** | Surface coverage honestly; alias aggressively |
| D15 | Sage trimming | **Resolved** | Head+tail to 4096 tokens |
| D16 | Sage vector caching | **Open — see 5.2** | Explanation requested |
| D17 | Per-request CQT | **Resolved** | Client config, stateful; sent as a request param; peer stateless |
| D18 | Wire cache into ranking | **Clarified — see 5.2** | Cold-start question was misread; re-explained |
| D19 | Streaming vs failover | **Resolved** | Stream; fail over only before the first token |
| D20 | Latency budget | **Resolved** | 1 s hard timeout → current model → else a big/top model |
| D21 | What leaves the machine | **Resolved** | Sage sees trimmed last turn; peer also gets cache metadata |
| D22 | Opt-in granularity | **Deferred** | Ignore for now |
| D23 | Peer retention | **Open — see 5.2** | "Tell me what" — specified below |
| D24 | Training on user prompts | **Resolved** | No — but see `N2`, this conflicts with `D28` |
| D25 | Prefix hashes | **Open — see 5.2** | "Why do we need this" — answer: we don't send them |
| D26 | Router self-dealing | **Deferred** | Ignore |
| D27 | Price snapshot / ledger | **Resolved, but see N1** | On the Levanto peer — conflicts with G3/G4 |
| N1 | Ledger location vs neutral dashboard | **NEW — open** | Dual-write proposed |
| N2 | Outcome feedback channel | **NEW — open** | Required by global recall learning |
| N3 | Candidate-set mismatch (peer's view vs client's) | **NEW — open** | Constraints in request |
| N4 | λ vs cache calibration | **NEW — answered** | You flagged it. λ on raw prices; blending at scoring only |
| D28–D34 | Quality, evaluation, savings claim | **Open** | Section D unanswered |
| D35–D45 | Business and commercial | **Open** | Section E unanswered |
| D46–D51 | Product surface and launch | **Open** | Section F unanswered |

---

### 5.1 Resolved — consequences worth recording

**D1 + D2 + D3 — Two plugins, and what that costs.**

Adding a plugin type touches: the `AntseedPlugin` union, `plugin-loader.ts`, `PluginInstanceConfig.type`, the CLI trusted registry, config types, and the protocol templates. That is more than the optional-method path but it is all mechanical, and it buys real separation: a user can run the routing plugin *and* keep `router-local`'s policy gates.

The `routing-server` plugin is a TypeScript shell that supervises a Python sidecar. Worth specifying early: process lifecycle and restart policy, the local IPC contract (HTTP on loopback is simplest), health checks, and how a sidecar crash surfaces — the peer should fail closed and stop advertising rather than return unranked garbage.

**D4 + D11 — The peer runs its own AntSeed node.**

This removes the `buyer.state.json` dependency entirely and is a significant simplification: one machine discovers peers and prices, calibrates λ globally, and every client stays thin. It also means the model catalogue updates as a server-side deploy rather than an app release.

The cost is that the peer's candidate set is the *global* network, not this client's. Handled by sending constraints in the request (`N3`).

**D9 — Local has the last word.**

The client re-filters the ranked list against `maxInputUsdPerMillion`, `minTrustScore`, and block lists before dispatching. If that empties the list, fall back per `D20`. Violations are worth logging as a router quality signal even though `D26` defers self-dealing detection — it is nearly free and it is the same code path.

**D17 + D20 — Client stateful, peer stateless.**

CQT lives in client config and ships as a request param. Note the consequence for the router library: `OnlineBudgetController` nudges λ from realised spend every 100 requests using **in-process** state. On a stateless peer serving many clients that becomes a global controller over mixed traffic, letting one heavy user drag everyone's λ. **Disable it** and rely on the every-N-minutes recalibration (`D12`).

`D20`'s "stay on the current model" is also the TTL-stickiness mechanism, now client-side — which is cleaner than the library's in-process `_sessions` dict and is the main COGS lever (`D16`, `D37`).

**D18 — Wiring the cache model, and the cold-start question re-explained.**

The concrete change list is unchanged:

1. `PriceBook.PerToken` gains a third rate: `(price_in, price_out, price_cached_in)`. Currently `tuple[float, float]`.
2. `Catalog.book()` stops discarding `cached_in` — it already has it on `Quote`.
3. `rank_candidates_from_vector` accepts a per-candidate hit rate (or effective input price) instead of one scalar for all candidates.
4. `_predicted_costs` / `cost_ridge.predicted_cost` use the blended rate.
5. `CacheModel.effective_in()` — already written — gets called.
6. λ calibration does **not** use the blended rate (`N4`).

**On the cold-start question — I asked this badly, and it is not about peer reputation.** `CacheModel.recall()` returns `0.0` until a `(model, peer)` pair has at least 3 observed warm repeats. Returning zero means "predict no cache discount", so that candidate is priced at its full list input rate and looks more expensive than a seller whose cache we have already measured. The risk is a lock-in loop: never route to a new seller → never observe its cache → it stays penalised. That is entirely separate from reputation filtering, which asks whether a peer is *trustworthy*; this asks whether we have *measured* it yet.

**Your `D11` answer largely solves this.** Once recall is learned on the peer across all users, a `(model, peer)` pair is cold only until *any* user has used it three times — not until *this* user has. For a popular seller that is immediate. The residual case is a genuinely new seller, where a small optimism prior (back off to the population mean recall for that model, or for that seller's provider family) is enough. Worth choosing explicitly rather than inheriting `0.0`.

**D21 + D24 — What Sage sees versus what the peer sees.**

Sage receives only the trimmed last user turn. The routing peer additionally receives warmth integers, context token count, CQT, and constraints — no conversation text beyond what goes to Sage. Model catalogues, hull membership, and price tables are not sensitive and can be public.

---

### 5.2 Sent back for more work

---

**D8 — How does peer-aware routing reconcile with `rankModelRoutes()`?**

*You asked: can we bypass the current plugin, and which of its components do we actually need?*

**Short answer: bypassing `router-local` loses almost nothing.** The table in §3.1 has the detail. The specific things you were worried about:

| Capability you named | Actually lives in | Available to a new plugin? |
|---|---|---|
| "List of peers able to serve a given model" | `buildNetworkServiceOffers()` in `packages/node/src/discovery/service-catalog.ts`, over `node.discoverPeers()` | **Yes** — plain import, nothing to do with `router-local` |
| Cooldown / failure-streak | `PeerMetricsTracker` + `computeFailureCooldownMs`, **exported from `@antseed/router-core`** | **Yes** — import and instantiate |
| Peer scoring weights | `scoreCandidates` + `DEFAULT_WEIGHTS`, exported from the same package | **Yes** |
| Reputation floor / max-price gate | `LocalRouter.allowsPeerForPolicy` — the only real logic in the plugin | Trivial to reimplement, and `D9` says the client must own this anyway |
| Protocol/service compatibility matching | `selectCandidatePeersForRouting`, `resolvePeerRoutePlan` in **`apps/cli/src/proxy/routing.ts`** | **No — app code, not a package** |

That last row is the one concrete blocker: those two functions decide whether a peer can actually serve a request in the right API protocol, and they are not importable from a plugin today. **They should move into `@antseed/node` (or a small shared package) as part of this work.** That is a refactor with no behaviour change and it benefits any future router.

One more finding worth knowing: **there are already two independent cooldown trackers.** `LocalRouter` owns a private `PeerMetricsTracker`, and the buyer proxy maintains its own peer-health state which it feeds into `rankModelRoutes` as `peerCooldownUntil` / `peerFailureStreak`. Adding the proxy's `Sinbin` would make three. Consolidating on one — the buyer proxy's, since it is on the live dispatch path — is worth doing while we are here.

**Options, now that the map is clear:**

| Option | What you keep | What you lose |
|---|---|---|
| **A. Bypass `router-local`; new plugin imports `router-core` + `service-catalog` directly** | Peer discovery, cooldown, scoring, all of it | The reputation/max-price gate, which you must reimplement anyway per `D9`. Needs the `routing.ts` refactor |
| B. Run both plugins; routing plugin picks `(model, peer)`, `router-local` still gates | No reimplementation of the gate | Two config surfaces for the same policy; user confusion; the double-cooldown problem gets worse |
| C. Router proposes model only; `rankModelRoutes()` picks the peer | Zero new peer-selection code | Loses per-peer price dispersion — likely a large share of the savings, and contradicts `D7` |

*Lean: **A**, with the `apps/cli/src/proxy/routing.ts` → package refactor as an explicit line item, and cooldown consolidated onto the buyer proxy's tracker. Blocking: yes. Owner: AntSeed.*

---

**D12 — Refresh cadence and λ recalibration, given `D11`.**

Under `D11` both prices and λ live on the peer, so this collapses to two parameters and one real tradeoff.

**Cadence.** The peer's node sees peer metadata updates continuously (sellers re-announce roughly every 5 minutes). Recalibrating λ costs ~105 ms.

| Cadence | Pros | Cons |
|---|---|---|
| Event-driven, on any price change | Always current | On a busy network this is near-continuous; λ becomes a moving target and identical requests seconds apart get different answers |
| **Fixed interval, 5–15 min** | Predictable; λ is versioned and quotable in the receipt; cheap | Up to 15 min of staleness after a big price move |
| Hourly or slower | Very stable | Misses real price movements; the whole point of dynamic pricing erodes |

*Lean: **fixed 10-minute interval**, with the λ version stamped in the response receipt so a decision can be audited against the exact λ that produced it. Add an out-of-band trigger for large moves (say, any hull model's output price changing more than 20%).*

**Hysteresis.** `DYNAMIC_PRICING.md` notes there is none. With a fixed interval the flapping risk drops a lot — λ only moves at boundaries. The remaining risk is a model crossing the hull boundary and the user seeing the model switch mid-conversation. `D20`'s "stay on the current model" stickiness already masks most of this. *Lean: fixed interval plus client-side stickiness is enough; revisit if flapping is observed.*

**The real tradeoff you should weigh:** a single global λ means a user whose traffic is unlike the calibration set will not hit their nominal CQT budget. That is the price of not doing per-user calibration, and it is the right price to pay — but it means **CQT is a *relative* dial, not a spend target**, and the UI should not promise otherwise (`D46`).

---

**D16 — What exactly should we cache, and when?**

*You said: we will never have exactly the same conversation, turns always change.*

**You are right about conversations, but the cache key is not the conversation.** What goes to Sage is only `trim(last_user_turn, 4096)`. The rest of the conversation is invisible to Sage. So the key should be `hash(trimmed_last_user_turn)` and nothing else — the proxy's current `(conv, last_user, trim_budget)` key is strictly worse, because including `conv` prevents hits that would otherwise land.

Where hits actually come from:

| Source | Frequency | Why the last user turn is unchanged |
|---|---|---|
| **Agentic tool loops** | **High** in coding agents | The model calls a tool, the result is appended as a tool/assistant message, and the model is called again. The last *user* turn has not changed for many iterations |
| **Regeneration / retry** | Moderate | User hits retry on the same message |
| Failover within one request | n/a | Already computed once per request — not a cache concern |
| Cross-user identical prompts | Low but nonzero | Boilerplate and common questions; only reachable if the peer caches globally, which `D23` permits |
| Ordinary chat, new turn each time | **Zero** | Correct — and this is your point |

So: on pure chat the hit rate is near zero; on agentic traffic it can be very high. Since agentic traffic is also where the token volume is, this is worth doing.

**A precise distinction that matters:** in an agentic loop the last user turn is unchanged but the conversation *grows*, so `contextTokens` and warmth change every iteration. **Cache the Sage vector; never cache the ranking.** The vector is a function of the last user turn only; the ranking is a function of the vector *and* the current costs.

*Lean: key on `hash(trimmed_last_user_turn)` alone; TTL of ~1 hour; cache on the peer so it is global; instrument the hit rate before tuning size. And note that the larger COGS lever is `D20`'s stickiness, which skips the call entirely.*

---

**D23 — What should the routing peer retain?**

*You said: retain what you need, tell me what, should be a lot.*

Proposed, per routed request:

| Retain | Why | Sensitivity |
|---|---|---|
| Sage 30-dim vector + CQT | The routing input; needed to debug and improve ranking | Derived, not text |
| Candidate set with price snapshot | Savings math, λ audit, price history | Public data |
| Ranked output + which was chosen | Was the ranking good? | Low |
| **Realised outcome**: model, peer, prompt/completion/cached tokens, actual cost, latency, success/failure | **The training signal for cost prediction, and the ledger** | Low |
| Cache observations: `(model, peer, warm_tokens, cached_tokens, age)` | Global recall learning (`4.2`) | Low |
| Failure events per `(model, peer)` | Reliability / sinbin | Low |
| λ version, artifact version, decision id | Auditability | None |

**Do not retain:** raw prompt text, and no prefix hashes (`D25` — they never arrive).

**One conflict to resolve.** `D24` says no training on user prompts. But the Sage *vector* is derived from the prompt, and vector + realised outcome is exactly the training pair for the quality heads. If "no training on prompts" means "no raw text", the table above is fine and the router can improve on AntSeed's real traffic. If it means "no derived features either", then **the router can never learn from production traffic — which directly conflicts with `D28`**, where the whole open question is whether the model works on AntSeed's workload mix. Please confirm which you meant.

---

**D25 — Why do we need prefix hashes?**

*Short answer: under this architecture, we don't need to send them anywhere.*

Their purpose is to answer one question: *has seller S already seen a prefix of this conversation, and how many tokens of it?* The alternatives are to send the actual conversation text (worse) or to skip cache math entirely (loses the savings).

But per `4.2`, the client can answer that question **itself** — it holds `_seen[(model, peer, prefix_hash)] = (timestamp, tokens)` and can compute `warm_match()` locally. It then sends the peer two integers per pair: `warmTokens` and `ageSec`. The peer supplies globally-learned `recall` and computes the hit rate.

**So hashes stay on the device and the wire carries only integers.** That is simpler, cheaper, and removes the whole question.

For completeness, the options if you ever did want to send them:

| Option | Tradeoff |
|---|---|
| **Send nothing; client computes warmth (recommended)** | Zero exposure. Client must hold ~24 hashes per conversation — trivial |
| Send raw hashes | Peer can dictionary-attack known strings. **System prompts are the first link in the chain and are often published or guessable**, so the peer could identify which product or agent the user is running |
| Send hashes salted with a client-held secret | Peer can still match a user's own prefixes across turns — all cache math needs — but cannot dictionary-attack. Nearly free if you need server-side warmth for some reason |

*Lean: the first. It is also the only one that keeps the client's conversation structure entirely private, which is worth something given the VPR positioning.*

---

### 5.3 Newly opened by these answers

---

**N1 — The ledger is on Levanto's server, which breaks the neutral dashboard.** *(Open — needs your call)*

`D27` puts the price snapshot and decision ledger in the Levanto routing peer. That gives Levanto the data it needs, but it costs three things:

1. **The savings dashboard stops being neutral.** It would have to call Levanto's API. `G4` says the dashboard is reusable commons; a dashboard that only works with one router is not.
2. **Every future routing peer must build a ledger** to appear in that dashboard. That is a large barrier to `G3`.
3. **It diverges from what AntSeed already does.** `computeMeasuredSavings` reads *local* per-service usage totals. A second, remote, differently-shaped savings source is confusing and will drift.

Plus: a user's complete per-request billing history sitting on a third-party server is a harder privacy story than anything else in this design, in a product called the Virtual Private Router.

**Proposal: dual-write.** The client writes a `routing_decisions` row locally — it has everything at decision time, and `priceSnapshot` comes back in the response (`4.3`). The peer keeps its own copy for analytics, training, and billing. The local table is the commons and powers the neutral dashboard; the peer's copy is Levanto's business asset. Marginal cost is one small SQLite insert per routed request.

*Owner: Joint. Blocking: yes for `G3`/`G4`.*

---

**N2 — Global recall learning needs a feedback channel.** *(Open)*

Recall is learned from what the client was **actually billed** — `cached_tokens` versus the warm prefix it sent. Under `4.2` recall lives on the peer, so the client must report outcomes back after each request: `(model, peer, warmTokens, ageSec, promptTokens, cachedTokens, completionTokens, costUsd, latencyMs, ok)`.

Open questions: is this a second RPC, or piggybacked on the next `/route` call (cheaper, but delays learning and loses the last turn of a conversation)? What happens when a client never reports — does it still benefit from others' learning (yes, and that is a free-rider problem worth noting)? And this is the same payload that feeds `D23`'s retention and the savings ledger, so it should be designed once.

*Lean: piggyback on the next `/route` request with a flush on session end. Owner: Joint.*

---

**N3 — The peer ranks over the global network; the client can only buy from a subset.** *(Open)*

The peer's candidate set is every peer it discovers. The client may have blocked peers, a lower max price, a higher trust floor, or simply be unable to reach some peers. If the peer ranks the global set, `D9`'s local filter may strip the top candidates and the client walks down a list that was optimised for someone else.

| Option | Tradeoff |
|---|---|
| **Client sends constraints; peer pre-filters** | Better ranking; still stateless (constraints are request params). Slightly larger request. Recommended, and reflected in `4.3` |
| Peer ranks globally; client filters after | Simplest; wasteful when the client's policy is restrictive |
| Client sends its full reachable candidate set | Best fidelity; largest request; re-introduces client-side price discovery, which `D11` removed |

A second-order issue: **reachability**. The peer cannot know which peers this client can actually connect to. The client should feed reachability failures into the constraint list over time — which is the same signal as the cooldown tracker in `D8`.

*Lean: constraints in the request, plus locally-derived unreachable peers appended to `blockedPeerIds`. Owner: Joint.*

---

**N4 — Does the cache model corrupt λ calibration?** *(You flagged this. Answer: no, if we keep them separate.)*

Your words: *"Only problem is if cache impacts λ calibration, that would fuck everything because we don't want per user calibration."*

**It does not have to, and the separation is clean.**

λ is calibrated by bisecting until mean spend over the calibration row set hits a budget target per CQT, where cost is `prompt_tokens × price_in + completion_tokens × price_out`. If `price_in` were cache-blended, it would be per-user and per-conversation, and λ would become per-user. That is the failure you are worried about.

The fix is that these are separable concerns. Scoring is `score = quality − λ · cost`. **λ is a scalar exchange rate between quality and dollars — a global property. Cache blending is a per-candidate cost adjustment — a local property.** Changing `cost` per candidate does not require changing λ; it just moves where the argmax lands, which is exactly the intended effect.

**So: calibrate λ on raw list prices, globally, every 10 minutes. Apply cache blending only at per-request scoring time.**

The one residual effect is a **known downward bias**: because real costs are lower than the calibration assumed, realised spend will run below the nominal CQT budget by roughly the population mean cache discount. Two ways to handle it:

- **Accept it.** Spending under budget is the safe direction, and `D12` already establishes that CQT is a relative dial rather than a spend target.
- **Correct it globally.** Compute the population mean hit rate on the peer — which it has, from `N2`'s feedback — and apply one scalar correction alongside each λ recalibration. Still global, still one number for all users, refreshed on the same 10-minute cycle.

*Lean: ship with the bias, measure it, add the global correction if it exceeds a few percent. Either way, **no per-user calibration**. Owner: Levanto.*

Related, and worth doing at the same time: disable `OnlineBudgetController` (`5.1 / D17`), which would otherwise reintroduce exactly the per-client λ drift you want to avoid — except spread across mixed traffic, which is worse.

---

### 5.4 Sections D–F — still open

You have not answered these, and they contain the decisions that determine whether the product ships as pitched. Recorded here unchanged.

#### D. Quality, evaluation and the savings claim

- **D28 — Evidence required before publishing a savings number.** LODO mean AUC **0.5243**, 3 of 8 datasets below 0.5; the shipped artifact inverts on 3 of 4 held-out `arenahard` slices; on SWE-bench the archive-panel hull models rank last and second-to-last of eleven; the proxy README puts `artifact_live9` routing skill at **≈ 0** on its own Tier-1 slice. AntSeed's traffic is chat and coding agents. *Lean: no public percentage until measured on AntSeed traffic. Blocking: yes for marketing.*
- **D29 — Measuring quality with no ground truth.** Regeneration rate (free, decent proxy); LLM-judge on a sample; shadow A/B (best causal estimate, costs the sampled savings). *Lean: regeneration rate always-on plus a small shadow sample.*
- **D30 — Shadow sampling rate.** *Lean: 2%, disclosed.*
- **D31 — Catalogue ownership and update SLA.** A full Tier-1 collect is 3,198 prompts, ~$0.80–$25 and 20 min–3 h per model. Under `D4`-B, updates are a server-side deploy. Open: how fast must a new model become routable, who pays, is the supported set published?
- **D32 — Which artifact ships, and is `prune` on or off?** `artifact_live8_pf` ships; `live9` is warned against. `prune` defaults to **off**, so dynamic dominance re-pruning is not actually active. *Lean: decide explicitly; ranked-list-with-failover argues for `prune=False`.*
- **D33 — Test coverage before this is in the money path.** The library has real tests; the proxy has none outside dashboard tools. *Blocking before billing.*
- **D34 — The `decide()` cost bug.** `decide()` passes the raw prompt string where `_predicted_costs` expects `input_tokens`. *Lean: fix or delete it; the ranked API is the one in use.*

#### E. Business and commercial

- **D35 — How is $9/month collected?** `AntseedSubPool` was removed. Options: **(A)** metered per-route with a monthly cap — works today, no Solidity, light users pay less; (B) one $9 `SpendingAuth` per period; (C) reintroduce a subscription contract; (D) off-chain billing, which breaks `G2`. *Lean: A for v1, C as the durable answer.*
- **D36 — Does the 2% platform fee apply?** $0.18 on $9. *Lean: yes, ordinary seller.*
- **D37 — Who pays for the Sage calls?** ~$0.0006 floor per call. At 2,000 routed turns/month, ~$1.20–2.00 against $9; at 20,000 the economics invert. Levers: `D16` caching, `D20` stickiness, short-prompt bypass. *Lean: fair-use cap with stickiness escalation past it.*
- **D38 — Free month for the first 200.** `AntseedFreeUsage` may carry this without new contract work. *Lean: reuse it; be generous rather than exact on the count.*
- **D39 — Is $9 right, and for whom?** Breakeven: 60% savings → $15.00/mo spend; **40% → $22.50**; 25% → $36.00; 15% → $60.00. **We still do not know AntSeed's spend distribution — the most important missing number in the business case.**
- **D40 — What does "Save 40%" mean precisely?** The 42% figure is at cqt=5 against always-GPT-5 on hard multiple-choice benchmarks. *Lean: no numeric claim until `D28` is satisfied.*
- **D41 — Grant structure ($16k + tokens).** Milestones undefined; token amount, vesting and lockup open; disclosure of Levanto holding ANTS while operating the default peer; and an explicit statement that the grant buys the commons in `D42`, not the Sage router.
- **D42 — What is "the commons"?** Protocol and schema, the `routing-client` plugin, the local ledger and savings computation, dashboard surfaces, and the peer template — all AntSeed-owned. Sage API, artifacts and training pipeline stay Levanto's. **Open: does the cache model go in the commons?** It is valuable, general, and every future router would want it.
- **D43 — Exclusivity and default placement.** *Lean: time-boxed (6–12 months), disclosed, with a published policy for how the default changes.*
- **D44 — Support, SLA, incident ownership.** A hosted service in a latency-sensitive path. *Blocking before charging.*
- **D45 — Refunds, cancellation, proration.** Interacts with `D35`: option A makes this trivial, B does not.

#### F. Product surface and launch

- **D46 — Dial: 0–10 or three presets?** Defaults of 2/5/8 are a three-preset product wearing an eleven-position dial. *Lean: three presets, "Advanced" reveals 0–10.* **Note `D12`: CQT is a relative dial, not a spend target — the UI must not promise otherwise.**
- **D47 — How does the user say "route this"?** *Lean: sentinel model id plus a global preference; never silently override a deliberate model choice.*
- **D48 — Which model is shown, and when?** *Lean: after the fact in message metadata, plus a per-conversation escape hatch.*
- **D49 — What is baseline model X?** Sets the headline number, so it is a marketing decision disguised as a technical one. *Lean: user-selectable, defaulting to their pre-opt-in most-used model, falling back to the cqt=0 pick. Never "most expensive available".* The peer already returns `baselineSuggestion` (`4.3`).
- **D50 — Negative savings, and whether the $9 is netted.** *Lean: show real numbers including negatives in detail view; gross prominently with "net of subscription" adjacent.*
- **D51 — Closed beta, second router, placement, co-branding.** *Lean: 4–6 week instrumented beta; ship a trivial reference routing peer in the template to substantiate `G3`.*

---

## 6. Unit economics

Per user per month. **Revenue:** $9.00 less 2% → **$8.82 net**.

| | Light (300 routed turns) | Typical (2,000) | Heavy agentic (20,000) |
|---|---|---|---|
| Sage calls @ ~$0.0006–0.001 | $0.18–0.30 | $1.20–2.00 | $12.00–20.00 |
| Routing-peer infra (amortised) | ~$0.20 | ~$0.30 | ~$1.00 |
| **Gross margin** | **~$8.3** | **~$6.5–7.3** | **−$4.2 to −$12.2** |

Note the heavy column is agentic traffic — which is also where `D16`'s Sage-vector cache has its highest hit rate, because the last user turn is unchanged across tool iterations. `D16` and `D20` are therefore economic controls, not just optimisations.

**Fixed costs the grant offsets:** router R&D; catalogue maintenance ($0.80–$25/model collect plus retraining); the commons in `D42`; and now the routing-peer infrastructure itself, which `D11` makes Levanto's responsibility to operate.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Savings do not transfer to real chat/coding traffic | **High** | **Critical** | Closed beta before any public number (`D28`) |
| R2 | Routing blind to cache warmth → wrong picks on multi-turn | **High** | Medium | Wire the cache model (`D18`) |
| R3 | Ledger on Levanto's server undermines the openness story | **High** | Medium | Dual-write (`N1`) |
| R4 | Routing peer is a single point of failure for all users | **High** | Medium | `D20` fallback is the mitigation; `D44` needs an SLA |
| R5 | $9 exceeds savings for most users | Medium | High | Spend distribution first; metered-capped pricing (`D35`-A, `D39`) |
| R6 | Losing streaming is a visible UX regression | Medium | High | Pre-first-token failover cut-off (`D19`) |
| R7 | Python sidecar lifecycle problems on the peer | Medium | Medium | Fail closed, stop advertising (`5.1 / D3`) |
| R8 | Per-user λ drift via `OnlineBudgetController` | Medium | Medium | Disable it (`N4`) |
| R9 | CQT dial does not hit the spend users expect | Medium | Medium | Frame as relative, not a target (`D12`, `D46`) |
| R10 | `D24` read strictly → router can never learn from production | Medium | High | Confirm derived features are permitted (`D23`) |
| R11 | Catalogue goes stale | Medium | Medium | Server-side updates under `D4`-B; published SLA (`D31`) |
| R12 | Heavy agentic users are margin-negative | Medium | Medium | Fair-use cap with stickiness (`D37`) |
| R13 | Untested code in the money path | Medium | High | Test story before billing (`D33`) |

---

## 8. Phasing

**Phase 0 — Decide (1–2 weeks).** Sections D–F, in priority order: `D28`/`D40` (evidence and claim), `D35`/`D39` (billing and price), `D42` (commons boundary, including the cache model). Plus the four new items: `N1` (ledger location), `N2` (feedback channel), `N3` (constraints), and confirmation on `D23`/`D24`.

**Phase 1 — Plumbing, unpriced (5–7 weeks).**
- AntSeed: two plugin types + loader/registry/config; `'routing'` capability; `/_antseed/route` schema in `packages/protocol`; **refactor `apps/cli/src/proxy/routing.ts` into a package** (`D8`); consolidate the cooldown trackers.
- Levanto: `routing-client` plugin in TS (warmth table, failover walk, local ledger, policy filter); `routing-server` plugin + Python sidecar; peer-side AntSeed node for global discovery; **wire the cache model into ranking (`D18`)**; move recall learning to the peer; disable `OnlineBudgetController`.
- Joint: trivial reference routing peer in the template.

Internal users only, no billing, no UI dial.

**Phase 2 — Closed beta (4–6 weeks).** 20–50 instrumented users. Dial and opt-in in VPR. Two-number savings dashboard off the local ledger. Streaming decision implemented. Shadow sampling. **Deliverable: a defensible savings-and-quality number on real AntSeed traffic.** This is the gate.

**Phase 3 — Launch.** Billing per `D35`. Free month for the first 200. Routing-peer picker. Public methodology page.

**Phase 4 — Hardening.** Conformance suite. Published default-selection policy. Revisit `D22`/`D26`, deferred here.

---

## 9. What we still need

**From AntSeed — the answers in sections D–F**, and specifically:

1. **What is the distribution of monthly inference spend per active buyer?** (`D39`) Without it the $9 price is a guess with a hard floor at ~$22.50 of user spend.
2. **Subscriptions: build a primitive, or bill metered-with-a-cap?** (`D35`)
3. **Do the commons in `D42` live in this repo under this licence — and does that include the cache model?** (`D42`)
4. **Default-peer policy, Levanto's placement duration, and grant disclosure.** (`D41`, `D43`)

**Decisions still needed from Levanto:**

5. **`N1`** — is dual-write acceptable, so the savings dashboard stays neutral?
6. **`D23`/`D24`** — does "no training on prompts" permit retaining derived vectors plus outcomes? If not, the router cannot improve on AntSeed traffic, which conflicts with `D28`.

**And what Levanto owes AntSeed before any number goes public:** evidence the savings hold on AntSeed's traffic mix, not on GPQA (`D28`).

---

## Appendix — Code references

### AntSeed (`antseed-levanto-router`)

| Concern | Path |
|---|---|
| Plugin interfaces / union | `packages/node/src/interfaces/plugin.ts` |
| Plugin loader (new types go here) | `packages/node/src/config/plugin-loader.ts` |
| `Router` interface | `packages/node/src/interfaces/buyer-router.ts` |
| `LocalRouter` — the whole plugin | `plugins/router-local/src/router.ts` |
| **`PeerMetricsTracker`, cooldown curve — exported** | `packages/router-core/src/peer-metrics.ts` |
| **`scoreCandidates`, `DEFAULT_WEIGHTS` — exported** | `packages/router-core/src/peer-scorer.ts` |
| `buildNetworkServiceOffers` | `packages/node/src/discovery/service-catalog.ts:162` |
| `rankModelRoutes`, `chooseBestModelRoute` | `packages/node/src/routing/model-route-ranking.ts:191,202` |
| **`selectCandidatePeersForRouting` — needs to move to a package** | `apps/cli/src/proxy/routing.ts:231,281` |
| Buyer proxy peer-health state | `apps/cli/src/proxy/buyer-proxy.ts:1284-1620, 2441-2442` |
| Capability enum, `PeerOffering` | `packages/protocol/src/capability.ts` |
| Reserved-path precedent (attest) | `packages/node/src/seller-request-handler.ts:139-185` |
| Cost computation (cached-input aware) | `packages/buyer-core/src/pricing.ts:41-54` |
| **Savings vs retail (shipped, local)** | `apps/desktop/src/renderer/modules/catalog/measured-savings.ts` |
| VPR preferences (dial precedent) | `apps/desktop/src/renderer/modules/routing/preferences.ts` |
| `AntseedFreeUsage` | `packages/contracts/payments/AntseedFreeUsage.sol` |
| SubPool removal | `CHANGELOG.md:358-360` |

### levanto-router-proxy

| Concern | Path |
|---|---|
| Request lifecycle, ranking call, failover walk | `proxy.py:275-437` |
| AntSeed catalog, peer pinning, billing rate | `providers.py:139-205`; `rate_for` at `89-102` |
| Price polling / change detection | `prices.py` |
| **Cache model (complete, unwired)** | `cache_model.py`; `effective_in` at `273-276`; `hit_rate` at `215-230`; `recall` at `232-250` |
| Runtime, catalog swap, λ recalibration | `routing.py:293-380` |
| Router library seam | `router_link.py:21-31` |
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
| `OnlineBudgetController` — disable (`N4`) | `router.py:194-216` |
| Per-peer aliases | `peer_aliases.py:152-159` |
| Sage prompt trimming + the cliff | `prompt_trim.py` |
| Price-free training | `train_pricefree.py:106-129` |
| Benchmarks and OOD caveats | `BENCHMARKS.md` §8.1 (LODO) |
