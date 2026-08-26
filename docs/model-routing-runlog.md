# Model Routing — Runlog

Ground truth for this work is `docs/model-routing-architecture-and-open-decisions.md`,
`docs/model-routing-software-architecture.md`, `docs/model-routing-system-architecture.md`,
and `docs/model-routing-payment-flow.md`. Those docs are never edited to match what actually
got built — this file is where that gap gets recorded instead.

Log an entry here whenever implementation:

- **Deviates** from something the ground truth docs say, because reality on the ground
  (a library constraint, a contract behavior, a test result) made the documented approach
  wrong or impossible as written.
- **Decides** something the docs are silent on — a genuinely unspecified detail, or one of
  the still-open items in the decisions doc's §13, resolved along the way rather than
  blocking on it.

Each entry: what was decided, why, and what in the ground truth it diverges from or fills
in. Newest entries at the top.

---

## [2026-08-26] A second, distinct blocker found live: the desktop-spawned buyer daemon isn't reliably running current code

Investigating a real symptom the user hit trying Auto routing live (`model_not_found` on a genuine
chat message) surfaced a second, separate problem from the DHT/NAT-hairpin one logged above —
found with direct process inspection, not inferred:

- The buyer daemon actually serving traffic on port 8377 was an **orphan**: `~/.antseed/buyer.state.json`
  claimed `state: 'stopped'`, `pid: 2261944`, while the process genuinely answering requests was a
  different, long-lived pid the desktop app's own tracking had lost. Every desktop restart today
  (multiple, across several forks' work) spawned a fresh child that found port 8377 already held and
  gracefully deferred to it ("Proxy port 8377 already in use; reusing existing local proxy") — meaning
  none of today's fixes (`router: 'levanto'`, the `LEVANTO_ROUTING_PEER_URL`/`LEVANTO_SELLER_PEER_ID`
  env vars) were ever reaching the process actually handling the user's chat requests.
- Killed the orphan and confirmed port 8377 freed. But the *next* process the live desktop app itself
  spawned (pid 2444591, `/proc/2444591/cmdline` and `/proc/2444591/environ` both checked directly)
  **also** came up with no `--router` flag and none of the `LEVANTO_*` env vars from `main.ts`'s
  current source — despite that source (`router: 'levanto'` at `main.ts:326`) being real, committed,
  and surviving a full desktop restart earlier today. A separately, correctly-configured buyer process
  spawned manually against the same identity (proven working: real router-levanto load, real 10 USDC
  deposit, real P2P connect) lost the race for port 8377 to this misconfigured one and never served
  anything.
- Root cause of *why* the currently-running Electron process is still spawning children without the
  current `main.ts` code not fully pinned down in the time available — the source fix is real, but
  something between it and the live process (stale compiled `dist/main` output not reloaded into the
  running Electron main process, since Electron's main process does not hot-reload the way its
  renderer does, is the leading theory) is not reflecting it. This needs a real desktop app restart to
  clear, which was intentionally not done here (out of scope for this pass — the live app has a user
  looking at it).

Net effect: two independent, stacked problems currently block a real end-to-end Auto-routing demo,
not one. Getting a genuinely current buyer process running (via a real desktop restart) is necessary
but not sufficient — the DHT/NAT-hairpin issue logged in the entry below would still need solving on
top of that for a real subscribe-and-route request to succeed.

---

## [2026-08-26] Daily subscription price advertised for real, closing decisions doc §13 item 6

Implements the design worked through in conversation: advertising and serving are separable, so
the daily subscription price can ride the network's existing announce → discovery →
service-catalog pipeline (the same one ordinary per-token model pricing already uses) without
touching how routing requests actually get served (still the reserved `/_antseed/route` path,
unchanged). Two precedents grounded this: image generation already gets its own
`NetworkServiceOffer.type: 'image'` alongside `'text'`, proving a third type is architecturally
consistent, not a stretch; and AntSeed's own attestation feature (`Prover`/`/_antseed/attest`)
already establishes that a non-inference seller capability can live outside `Provider.handleRequest`
entirely, and specifically outside the standard per-request metered billing gate, which doesn't fit
a flat daily fee at all (no per-token cost to compute for a routing decision).

**antseed-fork (generic protocol/type support, no Levanto business logic):**
- `packages/protocol/src/service-api.ts`: new `antseed-subscription` protocol value in
  `WELL_KNOWN_SERVICE_API_PROTOCOLS`. Not a real HTTP request shape -- a seller advertising a
  service on it is publishing a flat, non-metered price, not something `Provider.handleRequest`
  ever actually answers.
- `packages/api-adapter/src/types.ts`: same value added to this package's *independently
  duplicated* copy of the same constant (confirmed via `tsc` failing with a type-assignability
  error otherwise -- this package deliberately doesn't depend on `@antseed/protocol`, so the two
  lists have to be kept in sync by hand; not something to "fix" by adding a dependency here).
- `packages/node/src/discovery/service-catalog.ts`: `NetworkServiceOffer.type` becomes
  `'text' | 'image' | 'subscription'`. New `flatUsdPrice?: number` field -- on the wire it rides
  the same generic `inputUsdPerMillion` numeric field ordinary token pricing uses (no dedicated
  flat-price field exists in the announce/metadata-codec protocol, and adding one was judged out
  of scope for this pass since the existing field is already fully generic, untyped-beyond-"a
  number" wire plumbing); exposed under its own name so no caller needs to know that convention.
  `comparableOfferPrice` returns `+Infinity` for `type: 'subscription'` so a flat daily fee can
  never sort as "cheapest" against real per-token model offers.
- `packages/node/src/health/model-health-checker.ts`: `supportsHealthProbe` now excludes
  `antseed-subscription`, same as `openai-images`. This was the safety-critical piece: without it,
  the health checker's blind synthetic-completion probe would hit the pseudo-service, fail every
  sweep (nothing answers a fake chat completion for a billing placeholder), and after 3 consecutive
  failures auto-remove it from `provider.services` -- silently un-advertising a correctly working
  price. New test file `model-health-checker.test.ts` (didn't exist before this) proves it's never
  probed and never removed across repeated sweeps, and that an ordinary text service on the same
  provider is still probed and can still be removed -- the exclusion is narrow, not a checker-wide
  bypass.

**levanto-routing-server (the actual advertisement, proprietary):**
- `src/local-peer-daemon.ts`: new `SubscriptionPriceAdProvider`, registered on the same node
  identity as the existing `FakeModelProvider` and `RoutingServerHandler` -- one process, one
  identity, now three roles. `pricing.defaults.inputUsdPerMillion = 0.59` (the documented daily
  default, decisions doc §6.3, same value the real on-chain e2e test signs). `handleRequest` is a
  deliberate 501 stub, not a silent no-op or a crash: nothing should ever legitimately call it
  (real routing traffic goes through `/_antseed/route`; the health checker now skips this protocol
  entirely), so if something unexpected does call it, it fails loudly and says why. Confirmed
  staking is per-identity (`registerProvider` just appends to an array; on-chain stake gating is
  keyed by the seller's wallet address, not by which `Provider` object registered which services)
  -- no separate staking needed for the second provider.

**Client-side (showing the real price):** neither of the two existing renderer-facing catalog
pipes fit -- `apps/cli/src/proxy/network-models.ts`'s `buildNetworkModels` (feeds `/v1/models` and
the chat model picker) and `apps/desktop/src/main/chat/service-catalog.ts` are both deliberately
scoped to real, pickable models and correctly exclude `type: 'subscription'` (the former needed an
explicit filter added -- `canonicalModelKey` already excluded it implicitly, made explicit instead
of left implicit; the latter already excludes it for free via its own independent protocol
whitelist). So a new, narrow, single-purpose path was added instead, mirroring the existing
`/_antseed/routing-decisions` → `chat:ai-list-routing-decisions` precedent exactly: a new
`GET /_antseed/subscription-price` endpoint on `buyer-proxy.ts` (reads `buildNetworkServiceOffers`
generically, returns the first `type: 'subscription'` offer or `null`), a matching
`chat:ai-get-subscription-price` IPC handler in `apps/desktop`'s main process, and a
`subscriptionPriceResource` (`createCachedResource`, same convention as `routingDecisionsResource`)
consumed by `VprPreferencesView.tsx` to interpolate the real price into the Levanto Auto toggle's
disclosure copy ("starts a real $0.59/day USDC subscription charge") when one's been discovered,
falling back to the pre-existing generic copy otherwise.

**Not observed live, and said so rather than claimed otherwise:** discovering this specific routing
peer's advertised price over real P2P from a real desktop buyer is gated on the separate, already
-logged P2P peer-discovery gap (decisions doc §13 item 9) -- not this pass's concern to fix. What's
verified for real: `packages/node`, `apps/cli`, `apps/desktop` (renderer + main), `plugins
/router-levanto`, and `levanto-routing-server` all typecheck and pass their full test suites with
this change in place (1018/1018, 453/453, 358+253/611, 61/61, 35/35 respectively -- zero
regressions); the local-peer-daemon starts cleanly with the new provider registered and no runtime
errors; and the announce/serialization path (`announcer.ts`'s `_buildSignedMetadata`) reads
`Provider.pricing`/`serviceApiProtocols` fully generically, with no per-provider special-casing,
the same way it already does for `FakeModelProvider`.

---

## [2026-08-26] P2P peer-discovery root cause found: NAT hairpinning on a same-machine devnet, not a DHT bug

Investigated why a buyer on this local devnet can never discover/connect to the local routing-peer
daemon over P2P — the blocker preventing any real end-to-end subscribe-and-route demo. Root cause,
confirmed with direct evidence (not inferred): it is **not** a bug in AntSeed's DHT/discovery code.

Reproduced twice with a real, freshly-configured `apps/cli buyer start --router levanto` process
(`ANTSEED_DEBUG=1`, fresh data dir, correct `LEVANTO_ROUTING_PEER_URL`/`LEVANTO_SELLER_PEER_ID` env
vars) against the live routing-peer daemon (`levanto-routing-server/src/local-peer-daemon.ts`,
which correctly configures `publicAddress: '127.0.0.1:6892'`):

- `findPeer`'s per-peer DHT topic lookup **succeeds** — it finds exactly one endpoint announcing
  under the routing peer's topic. The DHT infohash mechanism itself works correctly.
- But the endpoint address the DHT hands back is `86.148.105.51:6892` — this machine's real public
  WAN IP — not `127.0.0.1`, despite the daemon's explicit local `publicAddress` config. This is
  inherent to how Kademlia/BitTorrent-style DHT announce works: remote DHT nodes record the
  *observed source address* of the announce packet (there's no other way for a NAT'd node's peers
  to learn its address), not an application-supplied claim. The buyer's bootstrap list included
  real public AntSeed bootstrap nodes, so the seller's announcement was relayed through them and
  observed from the public internet side.
- `MetadataResolver` then fails to fetch `http://86.148.105.51:6892/metadata: network error` —
  the machine cannot connect back to its own public IP. This is classic NAT hairpin/loopback
  failure, common on consumer routers and near-universal under WSL2, which adds its own additional
  NAT layer between the Linux guest and the Windows host network.
- Wildcard fallback (611 and 324 real endpoints across two runs) confirms the buyer genuinely
  reached the live public AntSeed DHT swarm — this machine is not network-isolated, it's just
  unable to hairpin back to itself.

Attempted fix: restrict the buyer's bootstrap list to only the routing peer's local DHT port
(`network.bootstrapNodes: ["127.0.0.1:6891"]` in a test config), to keep the whole discovery
exchange on loopback and avoid the public-relay NAT-observation path entirely. This did **not**
fully work as tried — the process still reported "3 bootstrap node(s)" instead of 1 and still
resolved the public IP, meaning something beyond `apps/cli`'s `buildBuyerBootstrapEntries` is
injecting additional bootstrap nodes that this pass didn't fully trace. Not fixed; flagged
precisely rather than claimed complete.

No existing direct-connect/manual-peer-address mechanism was found anywhere in the codebase that
bypasses DHT-based address resolution (searched for `staticPeer`/`knownPeer`/`directPeer`/similar
— nothing). Building one — "buyer knows peer X is reachable at this exact address, skip DHT
resolution" — would be the correct general-purpose fix for same-machine/LAN devnet testing, but is
real new plumbing and wasn't built in this pass; a real fix needs either that, or fully tracing and
suppressing the extra bootstrap-node injection found above so a purely-local exchange never touches
the public swarm at all.

No regression test written: there is no fix yet to protect, and a test asserting "this currently
fails" has low value. `local-peer-daemon.ts` was not modified. Test buyer processes started during
this investigation were run from fresh temp data dirs, fully cleaned up (killed, temp dirs
removed) — the live desktop-app-spawned buyer daemon and the routing-peer daemon were left
untouched throughout.

---

## [2026-08-26] A dedicated Preferences toggle now gates the daily subscription, not "Auto selected" — and closes a real, live consent gap it found

User direction, verbatim: a completely separate toggle in Preferences to even enable the feature,
clearly stating it starts a daily subscription; the CQT slider shows only when it's on; enabling it
locks minimum reputation to 7.0+. Supersedes decisions doc §14 item 28 ("CQT dial visible only when
Levanto Auto is the currently selected model") — see §14 item 30 for the corrected description;
item 28's own text is left as originally written, not rewritten.

**The reputation-scale mapping**, needed to get "7 or higher" right: `VprPreferencesView.tsx`'s
minimum-trust-score slider stores 0–100 but displays it through `reputationScaleLabel()`
(`modules/catalog/seller-format.ts`, `score / 10`) as 0.0–10.0. "7" on the display scale is
`minTrustScore: 70` on the stored scale — the new `AUTO_SUBSCRIPTION_MIN_TRUST_SCORE` constant in
`modules/routing/levanto-auto.ts`. While the toggle is on, the slider's `min` prop becomes 70
(snapped up immediately on enable if the buyer's current value was lower); turning the toggle back
off un-clamps the slider without lowering whatever value was left, since nothing asked for a
"restore the prior value" feature and inventing one wasn't worth the extra state.

**A real, pre-existing gap this closed, not just a UI addition**: before this change,
`LevantoRouter.ensureSignedToday()` (the method that actually produces a real signed daily
SpendingAuth) only checked that `signDailyIfNeeded` and `sellerPeerId` were configured — nothing
checked any user consent state at all. Once `router-levanto` became the active router and a
routing-peer identity was configured (both true in this session's own local demo setup, see the
"real, running local routing-peer daemon" entry below), the host's background
`triggerDailySigningCheck()` timer would have attempted to sign — and therefore genuinely spend —
on an interval, with zero gating, regardless of whether "Levanto Auto" had ever actually been
selected as a model. Verified this hadn't yet cost anything only because of the unrelated P2P
peer-discovery bug logged in that same entry, not because of any consent check; that bug is not a
gate this design is allowed to depend on.

**The wiring**, since `ensureSignedToday`/`triggerDailySigningCheck` are called from a background
timer with no per-request `routingPreferences` parameter to read: the desktop renderer already has
a live bridge carrying `cqt`/`minTrustScore`/etc. from persisted preferences into the running buyer
daemon process — `buyerModelRoutingPreferences()` writes into `buyer.routingPreferences` in
`config.json` via IPC (`bridge.updateConfig`), and `apps/cli`'s `buyer-proxy.ts` watches that file
and reloads `this._routingPreferences` on change. Extended that same bridge rather than inventing a
new transport: added `autoSubscriptionEnabled?: boolean` to the shared `ModelRoutingPreferences`
type (`packages/node/src/routing/model-route-ranking.ts`, default `false`), and a new optional
`Router.updateRoutingPreferences(preferences)` hook (`packages/node/src/interfaces/buyer-router.ts`)
that `buyer-proxy.ts` now calls on every config reload and once at construction, alongside the
existing per-`selectRoute`-call parameter. `LevantoRouter` caches whichever arrives most recently
(`cachedRoutingPreferences`) so the background-timer path always has a real, current answer instead
of stale or absent state; `ensureSignedToday()` now refuses to sign unless that cache says
`autoSubscriptionEnabled === true` — absent/unknown is treated as `false`, never as consent by
default. New tests in `router.test.ts` prove both directions (blocks when off or unset, unblocks
once explicitly turned on via either `selectRoute`'s parameter or `updateRoutingPreferences`).

Existing tests asserting on `ModelRoutingPreferences`/`VprRoutingPreferences` object shapes needed
the new field added to their fixtures (`router.test.ts`, `preferences.test.ts`, `loader.test.ts`);
one of those (`config-io.test.ts`) was already stale before this change (missing `cqt` too, a
leftover from an earlier pass) — fixed alongside rather than left half-broken next to a fix for the
same root cause.

Full test suites, run clean after: `router-levanto` 61/61 (was 56, +5 new gate tests),
`apps/desktop` renderer 355/355 (was 354, +1), `apps/desktop` main 253/253 (was 252/253 — the
stale `config-io.test.ts` fix), `apps/cli` 453/453. `packages/node`, `router-levanto`, `apps/cli`,
and `apps/desktop`'s renderer and main process all typecheck clean.

---

## [2026-08-26] New infrastructure: a real, running local routing-peer daemon

Nobody had ever built the process that actually runs a Levanto routing peer.
`AntseedNode.registerRoutingServerHandler()` (packages/node) was defined but
called nowhere in the whole antseed-fork repo; every existing test drove
`LevantoRoutingServerHandler.handleRoute()` directly in-process, bypassing
real P2P/transport entirely. This wasn't a decided-and-unimplemented item —
it's genuinely new scope, prompted by wanting to see the feature actually
running end to end, not just passing tests.

**What got built, in `levanto-routing-server` (proprietary logic stays out
of the public repo, per this project's own public/private split):**

- `src/local-peer-daemon.ts` — one process, one identity, two roles: a real
  `AntseedNode` (role: seller, real DHT/signaling ports, real payments
  config against a real chain) with a canned `FakeModelProvider` registered
  (3 models matching `sidecar/mock_sage.py`'s known-quality table, real
  prices, real OpenAI-chat-completions-shaped responses, no real LLM call —
  needed so ranked candidates have somewhere real to route actual
  completions to without requiring a real provider API key), plus a plain
  HTTP listener (`http-server.ts`'s `startHttpServer`) serving
  `/_antseed/route`/`/_antseed/route/digest` via the same
  `LevantoRoutingServerHandler`, backed by the node's real
  `SellerPaymentManager`.
- `scripts/setup-local-routing-peer.sh` — extends
  `antseed-fork/scripts/setup-local-test.sh`'s proven local-devnet pattern
  (same `base-local` chain, same deterministic contract addresses) to also
  fund, register, and stake the routing-peer identity.

**A real transport finding, not previously documented anywhere:**
`router-levanto`'s actual client (`plugins/router-levanto/src/router.ts`)
does a bare `fetch()` to `LevantoRouterConfig.routingPeerUrl` for
`/_antseed/route` — not a P2P-authenticated call. So `http-server.ts`'s
plain-HTTP listener, previously commented as "for testing outside the full
AntSeed P2P/PaymentMux transport," IS the real transport for this specific
request, not a stand-in for something else. The daily subscription
SpendingAuth is different — that genuinely does travel over real
P2P/PaymentMux (confirmed by reading
`apps/cli/src/proxy/daily-subscription-signing.ts`'s
`node.getOrConnectPaymentMux`), so the routing peer still needs to be a
real, P2P-connected `AntseedNode`, just for a different reason than the
routing query itself.

**A genuinely open gap this surfaced, not resolved here:** the plain HTTP
`/_antseed/route` call carries no buyer identity at all in the wire
protocol as built — no header, nothing. Without one, the subscription gate
has no `buyerPeerId` to check `hasSession`/`getChannelByPeer` against. Added
`LevantoRouterConfig.buyerPeerId` (sent as `x-antseed-buyer-peer-id`) as a
stopgap so this could be demoed at all — explicitly NOT a real
authentication mechanism (an unverified, client-supplied header; anyone who
can reach `routingPeerUrl` could claim to be any buyer). How this channel
gets authenticated for real is unresolved; flagged in the decisions doc
alongside item 6 (price discovery), which has the same "no wire mechanism
exists" shape.

**A second real gap: no public getter for a seller's `SellerPaymentManager`
on `AntseedNode`.** `packages/node/src/node.ts` exposes
`get buyerPaymentManager()` but no seller-side counterpart, so
`local-peer-daemon.ts`'s `SubscriptionSource` reads the `_sellerPaymentManager`
private field directly (TS `private`, not a real runtime-private `#field`,
so this works, just relies on an internal implementation detail). Not
proprietary or routing-specific — a real fix is a two-line symmetric getter
next to the existing buyer one.

**A separate, pre-existing bug this surfaced and fixed:** `apps/desktop`'s
main process (`apps/desktop/src/main/main.ts`) hardcoded `router: 'local'`
in the `StartOptions` it passes when spawning the embedded buyer daemon —
there was no settings/config path that ever selected anything else, so the
desktop app could never have used router-levanto regardless of whether a
routing peer existed. Flipped to `router: 'levanto'` with the routing
peer's URL/peer id passed as env vars, explicitly commented as a deliberate
temporary stand-in (no real router-selection UI exists yet), not a finished
design decision.

**What's real and verified, end to end:** real anvil chain, real contract
deployment, real on-chain staking (50 USDC) and buyer deposit (10 USDC) via
`cast`; the daemon's real `AntseedNode` starts, binds real DHT/signaling
ports, and the real mock Sage sidecar subprocess responds with real
per-model quality scores; the real `apps/cli buyer start --router levanto`
loads router-levanto for real (after fixing a stale global-plugin symlink at
`~/.antseed/plugins/node_modules/@antseed/router-levanto` that was pointing
at an unrelated, several-days-stale package build from outside this
session's work — not this project's code, but it was silently shadowing it),
connects to real P2P, and initializes a real `BuyerPaymentManager` that
correctly reads the real 10 USDC on-chain deposit; a direct `curl` to
`/_antseed/route` correctly returns 402 "not subscribed" before any payment
exists, proving the subscription gate is reading real (not stubbed) seller
payment state.

**What's NOT verified — a real, unresolved blocker, not a shortcut:** the
daily SpendingAuth never successfully reached the routing peer over P2P.
`node.getOrConnectPaymentMux(sellerPeerId)` triggers a DHT `findPeer` for
the routing peer's peer id; logs show `per-peer topic empty; falling back
to wildcard scan`, then a wildcard scan across hundreds of real public DHT
endpoints (mostly timeouts), ending in `Peer ... could not be found on the
network.` Added the routing peer's local DHT port
(`127.0.0.1:6891`) to the buyer's `network.bootstrapNodes` — this fixed
general P2P connectivity (bootstrap node count went from 2 to 3) but did
not fix per-peer-topic discovery specifically, which appears to need the
routing peer to have successfully announced itself into that DHT topic
first — not confirmed either way given time spent. This is exactly the kind
of "how does a buyer actually discover the routing peer over the real AntSeed
network" question that hasn't come up before now because nothing before
this daemon ever exercised real P2P peer discovery for a fresh, previously
unknown peer id — worth a focused follow-up, not a guess made under time
pressure here.

Closes decisions doc §13 item 8 (formerly), now §14 item 29. Checked `sage_model_router`'s own
reference integration point directly: `rank_candidates(prompt: str)` (router.py:555-586) is the
wrapper meant for exactly this situation — it calls Sage itself, vectorizes the result, then
calls `rank_candidates_from_vector`. Its docstring states the reason a proxy would want this
shape: "A proxy wants Sage's raw response for its audit log, so it calls Sage itself and hands
the vector here rather than making a second, unlogged call." The routing peer is that proxy.

So: no client-side change. `sagePrompt` continues to carry raw, trimmed last-user-turn text
exactly as already built. The routing peer is responsible for calling Sage and vectorizing
before ranking. `levanto-routing-server`'s current mock sidecar (`ranking.ts`) doesn't do this —
it fakes quality scores from the model name and barely touches `sagePrompt`'s content — but that
was already true before this question came up, and wiring a real Sage call into the sidecar is
separate, later work, not something this resolution requires.

---

## [2026-08-26] Final verification pass: full test suites, decisions doc cleanup, real on-chain suite reconfirmed

Closing pass after implementing everything with a decided direction from the runlog walkthrough
(§13 items 8, 9, 10, 11, 12, 13, 14, 15a, 16, 17, 19, 20, 21 -- items 6 and 18 stay open, no decided
direction to implement against).

**Full test suites, run clean:** `antseed-fork/plugins/router-levanto` 56/56, `antseed-fork/apps/desktop`
renderer 354/354, `antseed-fork/apps/cli` 453/453 (`node --test`, real build), `antseed-fork/packages/node`
1013/1013 across 92 files, `levanto-routing-server` 35/35 including the real on-chain e2e suite
(2/2, genuinely re-run against a fresh anvil chain + freshly deployed contracts, not just previously
cached). Also fixed one unrelated pre-existing test gone stale against an earlier segment's CQT dial
work (`apps/cli/src/config/loader.test.ts`), found only by running the full suite rather than
targeted subsets.

**Did not extend the real on-chain e2e suite with a new test specific to task #26's host-side
wiring**, despite that being the original ask, for two concrete reasons rather than time pressure
alone: (1) `apps/cli` has no `exports`/`main` field and isn't designed to be imported as a library,
so `createSignDailyIfNeeded` can't be pulled into `levanto-routing-server`'s test without adding a
cross-repo dependency that inverts the existing architecture (levanto-routing-server is the
seller-side implementation; apps/cli is the buyer-side CLI application, not a shared library); (2)
the anvil instance this suite already spawns has no `--block-time` flag, i.e. it auto-mines
instantly, so a new test wrapping the same `BuyerPaymentManager` calls in `createSignDailyIfNeeded`'s
exact sequence would exercise the polling/retry logic no differently than task #26's own scripted-mock
test already does (both would confirm on the first read) -- it would prove the sequence type-checks
against real `BuyerPaymentManager` types, which the existing two on-chain tests plus task #26's nine
scripted tests already jointly establish. The existing on-chain suite was re-run and reconfirmed
clean after every change in this implementation pass, including the two changes that touch
`LevantoRoutingServerHandler.handleRoute` directly (items 19's payment-history recording and item
20's path-based dispatch, both exercised for real by this suite's own `handler.handleRoute` calls).

**Decisions doc cleanup:** removed the now-implemented items from §13's "what's left" list (it had
grown to include items whose direction was decided and then actually built, which would mislead a
reader into thinking they were still open) and added summary entries 17-28 to §14, each pointing to
this runlog for full detail rather than re-explaining what's already written here. Rewrote §14 item
15 (`computeRouterSavings`) to describe current behavior plainly rather than as a forward-looking
"once item 10 lands" note, per this project's own rule that spec prose states the design as it is,
not as a change log. §13 now keeps only: items 1-5 (original AntSeed/Levanto asks, still open),
item 6 (subscription price discovery -- no decided direction), item 7 (cached-token estimator
formula, needs real telemetry to validate -- not something "decided" so much as flagged as
unvalidated), item 8 (`sagePrompt` raw-text-vs-vector -- no decided direction), and item 9 (the
credit-limit/catch-up-backlog coincidence, a standing observation rather than an actionable item).

Both repos committed locally after this pass (see commit messages for the exact file lists) -- no
push, per standing instruction.

---

## [2026-08-26] Implemented: usage-independent daily signing trigger (decisions doc §13 item 9)

Before this, daily signing only ever fired from inside `selectRoute()` -- a buyer who leaves the
Auto toggle on but stops chatting would silently stop accruing real signed days (and the digest
gate would eventually 402 them) even though the toggle itself was never switched off, contradicting
SS6.2's "billing tracks the toggle, not activity."

**New `Router.triggerDailySigningCheck?(): Promise<void>`** (`packages/node/src/interfaces/buyer-router.ts`),
same additive/generic pattern as `configureDailySigning`/`getRoutingDecisions`. `LevantoRouter`
implements it as a one-line call into the same private `ensureSignedToday()` `selectRoute()` already
calls internally -- the "at most one real signature per calendar day" bookkeeping (`lastSignedDayKey`)
is genuinely shared, not duplicated, so a background tick and a real chat request on the same day
correctly defer to whichever ran first, in either order.

**New `scheduleDailySigningChecks(router, intervalMs, onError)`** (`apps/cli/src/proxy/daily-subscription-signing.ts`,
alongside task #26's signing closure -- same file, same concern) -- fires once immediately (so a
buyer who opts in but never chats that day doesn't wait a full interval for the first signature),
then on `intervalMs`; returns a cleanup function. Errors are caught and handed to `onError`, never
thrown -- a failed background tick must never crash the host process, and the next tick retries.
Extracted as its own small, directly-testable pure function (taking a narrow `DailySigningTrigger`
interface, not the concrete router) specifically so this piece has real test coverage without
needing a live P2P node -- `apps/cli/src/cli/commands/buyer/start.ts`'s own `.action()` callback is
otherwise established (by `start.test.ts`'s existing scope, confirmed by reading it) as
too-imperative-to-unit-test plumbing; this logic was worth pulling out rather than leaving inline
and untested there.

Wired into `start.ts` right alongside `configureDailySigning`, at a 15-minute interval (`.unref()`'d
so it never keeps the process alive on its own), with cleanup registered via the existing
`setupShutdownHandler`. 15 minutes is arbitrary and not from any doc -- the router's own
once-per-day gate makes the exact interval a tradeoff between "how promptly a new calendar day gets
noticed" and "how often a needless call happens on an already-signed day," not a correctness
question; a background tick against an unconfigured/no-op router costs one cheap function call.

**Tests**: five new `node:test` cases in `daily-subscription-signing.test.ts` for
`scheduleDailySigningChecks` (immediate fire, repeated ticking, cleanup actually stops ticking,
errors reach `onError` instead of throwing, safe no-op for a router without the capability) using
real short intervals rather than faked timers -- this piece is pure scheduling/error-handling logic,
not calendar-day-sensitive like task #26's signing closure, so real short intervals are simpler and
sufficient. Four new tests in `plugins/router-levanto/src/router.test.ts` for
`configureDailySigning`/`triggerDailySigningCheck`, including both orderings of "a background tick
and a real chat request land on the same day" to directly prove the shared-gate claim above, not
just assert it in a comment. Full suites re-run clean: `apps/cli` (453/453), `router-levanto`
(35/35), `packages/node`, `levanto-routing-server`, and `apps/desktop`'s renderer typecheck all
unaffected.

---

## [2026-08-26] Implemented: real host-side daily signing wired into apps/cli (decisions doc §13 item 11)

The single biggest remaining gap: `signDailyIfNeeded` had a real implementation on
`BuyerPaymentManager` (`signCumulativeAuth`, `configureFlatFeeSigning`, `topUpReserve`,
`reconcileReserveAmount` — all built and proven on real anvil in an earlier segment) but nothing in
a real running buyer process ever called any of it. It's wired now, end to end.

**New `Router.configureDailySigning?(signDailyIfNeeded)` optional interface method**
(`packages/node/src/interfaces/buyer-router.ts`), same additive pattern as `getRoutingDecisions?()`
— generic across any router that needs subscription-style signing, not specific to
`router-levanto`. `LevantoRouter` implements it by mutating `config.signDailyIfNeeded` in place
(construction happens before the node starts; the real closure needs `node.buyerPaymentManager`,
which only exists once payments are configured, so it has to arrive later via this setter).

**Two small additions to `AntseedNode`** (`packages/node/src/node.ts`): `getOrConnectPaymentMux(peerId)`
(connects if needed, mirroring `requestChannelClose`'s own find-then-`connectToPeer` pattern; there
was no public way to get a `PaymentMux` for an arbitrary peer otherwise) and a `channelsClient`
getter (needed to read real on-chain state after a top-up — see below). Also added `LEVANTO_SELLER_PEER_ID`
to `router-levanto`'s configSchema (the routing peer's P2P identity is distinct from its HTTP URL;
neither existed as a configured value before this, so `signDailyIfNeeded`'s `sellerPeerId` guard in
`ensureSignedToday()` was unconditionally a no-op even before today). Added several previously-missing
exports to `packages/node/src/index.ts` (`PaymentMux`, `FlatFeeSigningConfig`, `PerRequestAuthResult`,
`SpendingAuthPayload`, `AuthAckPayload`) — discovered because `apps/cli`'s tsconfig does NOT exclude
`*.test.ts` from typecheck (unlike `router-levanto`/`levanto-routing-server`, which do), so writing a
real, typechecked test for this surfaced several types that existing e2e tests elsewhere import from
`@antseed/node` without ever actually being typechecked against it.

**New `apps/cli/src/proxy/daily-subscription-signing.ts`** — `createSignDailyIfNeeded(node, options)`
builds the actual closure. Takes a narrow `DailySigningNode` interface (`buyerPaymentManager`,
`channelsClient`, `getOrConnectPaymentMux`) rather than the concrete `AntseedNode` class, specifically
for testability; `AntseedNode` satisfies it structurally, no adapter needed at the real call site
(`apps/cli/src/cli/commands/buyer/start.ts`, wired in right after `node.start()` succeeds, gated on
`router.configureDailySigning && paymentsConfig?.enabled`). Handles three cases:

- **Bootstrap** (no existing session): `authorizeSpending` reserves exactly one day's charge (SS6.3,
  not `FIRST_SIGN_CAP`), signs day 1, then one top-up prepares tomorrow's ceiling (SS6.5's Day-1 row)
  — a top-up, not a second signature.
- **Ordinary day**: one `signCumulativeAuth` call, requesting `dailyAmountUsdc × catchUpCapDays`
  ("everything owed") every time — `signCumulativeAuth` internally clamps to what's actually allowed
  (real elapsed days since its own private last-sign timestamp, `catchUpCapDays`, and the current
  ceiling), so the caller never computes the real target itself. A top-up fires afterward only to
  prepare for next time, gated on the post-sign 65%-threshold flag `signCumulativeAuth` already
  returns.
- **Catch-up after a toggle-on gap** (SS6.7): the ceiling may already be exhausted from the gap.
  Hardest part, and where two real design corrections happened during implementation (both caught by
  writing real tests against a real `BuyerPaymentManager`, not assumed correct from reading code):
  1. **Whether to top up before or after signing genuinely matters, and can't be decided from
     `topUpNeeded` alone.** `topUpNeeded` is only available *after* a sign call, but signing first
     when the ceiling is already exhausted doesn't fail — it silently succeeds as a same-tick no-op
     (nothing new fits under the exhausted ceiling) that still touches
     `BuyerPaymentManager`'s private last-sign timestamp, permanently losing the real backlog depth
     for every subsequent call. So the module predicts, from public state only
     (`session.updatedAt`, which mirrors that private timestamp — both are set together,
     unconditionally, at the end of every real `signCumulativeAuth` call), whether the upcoming sign
     would be ceiling-clamped below what's genuinely owed, and tops up first when it would be.
  2. **A top-up gets no wire acknowledgement at all**, confirmed by reading
     `BuyerPaymentManager.handleAuthAck`'s own comment ("top-ups remain pending until an on-chain
     session read observes their ceiling"). Reading `channelsClient.getSession()` immediately after
     sending a top-up would very likely observe the pre-top-up deposit and reconcile to a stale
     value — worse than not reconciling at all, since it looks like a real resync. The module polls
     (500ms interval, 30s timeout, mirroring `BuyerPaymentNegotiator._waitForLockConfirmation`'s
     shape for the same underlying concern — waiting for a seller-side on-chain action to land —
     though that one polls a local ack flag and this one has no ack to poll) until the real deposit
     increase is observed before reconciling. A timeout isn't fatal: the next signing cycle sees the
     ceiling still exhausted and retries the whole sequence.

**$0.59/day, 30-day catch-up cap hardcoded in `start.ts`**, not configurable per-router yet — no wire
mechanism exists for a buyer to learn the correct price from the routing peer itself (decisions doc
SS13 item 6, explicitly out of scope for this pass, no decided direction).

**Tests**: `apps/cli/src/proxy/daily-subscription-signing.test.ts` (new, real `node:test`, genuinely
typechecked) uses a real `BuyerPaymentManager` throughout — all the clamping/elapsed-day/ceiling logic
under test is genuine — with an unreachable RPC URL (deposit checks degrade to a logged warning,
confirmed by reading `topUpReserve`'s own try/catch, never blocks) and a scripted `PaymentMux`/
`ChannelsClient` standing in for the network edges. Four tests cover bootstrap, an ordinary day (real
fake-clock time advance via `node:test`'s built-in `t.mock.timers`, not a hand-rolled substitute —
an earlier version of this test mutated `session.updatedAt` directly, which doesn't work: that field
is a fresh read from the channel store each call, not something mutating one returned object
round-trips through, and doesn't touch `BuyerPaymentManager`'s own private last-sign timestamp
either — the resulting false-pass is exactly why real fake-clock control replaced it), the catch-up
scenario (this is what caught design correction #1 above), and the top-up polling/retry behavior
(caught #2 above). Full suites re-run clean after every change in this entry: `apps/cli` (448/448),
`packages/node` (1013/1013 across 92 files), `levanto-routing-server` (33/33 + the real on-chain e2e
suite, unaffected by anything in this entry). Also fixed one unrelated pre-existing test
(`apps/cli/src/config/loader.test.ts`) that had gone stale against the CQT dial's default routing
preferences from an earlier segment of this project, found only because this entry's work was the
first time the full `apps/cli` suite was run end to end during this implementation pass.

---

## [2026-08-26] Implemented: digest wire mechanics switched to an explicit path suffix (decisions doc §13 item 20)

Added `ANTSEED_ROUTE_DIGEST_PATH = '/_antseed/route/digest'` alongside the existing
`ANTSEED_ROUTE_PATH` (`packages/node/src/interfaces/plugin.ts`). `seller-request-handler.ts`'s
dispatch now matches either path, both delegating to the same `RoutingServerHandler.handleRoute` --
no new interface method, no new plugin type, no new `PaymentMux` message type: `req.path` was
already part of every `SellerRequest`, so the handler distinguishes the two itself.
`LevantoRoutingServerHandler.handleRoute` (`levanto-routing-server`) now checks `req.path` first and
routes to `handleDigest` directly, instead of parsing the body and checking for an absent
`sagePrompt` field. `router.ts`'s `sendDailyDigestIfNeeded` now POSTs to `${routingPeerUrl}/_antseed/route/digest`
instead of the shared routing path.

**Gate-ordering side effect eliminated, as anticipated by item 20's own text:** since telling a
digest apart from a routing request no longer requires parsing the body first, the subscription
gate for a routing request now runs *before* any JSON parsing happens again -- restoring the
original intended order (§14 item 6's body-sniffing choice had forced body-parsing first, which
meant a malformed body from an unsubscribed buyer returned 400 instead of 402; that's fixed as a
direct consequence of this change, not a separate fix).

Updated `docs/model-routing-architecture-and-open-decisions.md` §14 item 6 in place to describe the
current mechanism plainly (per this project's own rule: the decisions doc states the design as it
is, never as a change log -- that rule is for spec prose in general, not just this one file).
Deliberately left §13 item 20 itself (and the other now-resolved §13 items from this pass) as
written for now rather than renumbering/pruning the open-items list piecemeal after every task --
that cleanup happens once, coherently, in the final verification pass (task #27) rather than
repeatedly across many small edits that risk breaking cross-references between items.

Also widened `levanto-routing-server/src/http-server.ts`'s thin test-only HTTP harness (used by
`thin-loop.test.ts`'s real-HTTP e2e coverage) to accept both paths, matching production dispatch.
Updated `routing-server-handler.test.ts`'s digest-related tests to send to the new suffix path via
a new `digestReq()` helper (distinct from the existing `req()`, which stays on the routing path),
and added a dedicated test asserting the digest send actually hits `/_antseed/route/digest` in
`router.test.ts`.

**Left as a pre-existing gap, not introduced by this change:** `packages/node`'s
`seller-request-handler.ts` dispatch logic has no dedicated unit test anywhere in either repo --
the widened `if` condition is covered only indirectly, through `levanto-routing-server`'s thin HTTP
harness (which reimplements a simplified version of the same dispatch, not the real
`SellerRequestHandler` class). Building real test scaffolding for `SellerRequestHandler` (a large
class with `PeerConnection`/`PaymentMux`/`ProxyMux` dependencies) was judged disproportionate to
this one-line dispatch change; flagged here rather than silently skipped.

---

## [2026-08-26] Implemented: durable payment-history store for the digest gate (decisions doc §13 item 19)

New `levanto-routing-server/src/payment-history-store.ts`: a `PaymentHistoryStore` interface
(`recordPaidDay(buyerPeerId, day)` / `hasEverPaid(buyerPeerId)`), an `InMemoryPaymentHistoryStore`
for tests, and a real file-backed `FilePaymentHistoryStore` for production -- a single JSON object
keyed by buyer peer id, written atomically (tmp + rename), mirroring `ConversationStore`'s
established pattern (`antseed-fork/apps/cli/src/proxy/conversation-store.ts`) rather than
`RoutingLedger`'s append-only JSONL log (task #19): this is a small, upsert-heavy keyed record --
one entry per distinct buyer, updated in place -- not an ever-growing append log, so the whole-file
rewrite pattern fits better here.

`LevantoRoutingServerHandler.handleRoute` now calls `paymentHistory.recordPaidDay(buyerPeerId,
todayKey())` immediately after `isSubscribedToday` passes -- serving a routing request IS proof
this buyer had a real, non-bootstrap signed cumulative on file today (task #14's `authMax > 0`
check already verified that), so this needs no new signal, just recording one that already exists.
`handleDigest`'s gate changed from `hasSession(buyerPeerId)` alone to `hasSession(buyerPeerId) ||
paymentHistory.hasEverPaid(buyerPeerId)`: `SellerPaymentManager.hasSession()`/`getChannelByPeer()`
only ever see the buyer's currently-ACTIVE channel, so a buyer who closed their channel after
genuinely paying and using the service could never submit a final digest for that last real period
-- exactly the gap item 19 describes. The "not an open write endpoint for an arbitrary
never-subscribed peer id" guarantee is preserved: a peer with neither an active session nor any
recorded payment history is still rejected with 402.

**No anonymization/hashing here, unlike the digest store** -- decisions doc SS6.8's own retention
list explicitly allows "subscription status" to be retained with raw peer identity permanently; the
hashing requirement is specific to the digest (SS6.9, usage-profile-adjacent data), not to coarse
payment-history records.

**Scope boundary respected:** stayed entirely within `levanto-routing-server`; did not add a new
query method to `SellerPaymentManager`/`ChannelStore` in `packages/node` even though `ChannelStore`
likely already retains closed-channel rows durably in SQLite (a query surfacing that data could
have replaced this new store). The software-architecture doc explicitly keeps subscription-gate
ownership inside the routing-server plugin, not `packages/node` ("kept here... per that doc's
explicit ownership" -- `subscription-gate.ts`'s own header comment); adding a new public query
surface to a shared, foundational package for one plugin's need would cut against that established
boundary, so a self-contained store scoped to this plugin was the better-fitting choice even though
it duplicates data `ChannelStore` may already hold.

Added `payment-history-store.test.ts` (new file, real filesystem tests, no mocking -- proves
persistence survives a simulated process restart) and four new tests in
`routing-server-handler.test.ts` covering: a served routing request records payment history, a
gate-failed request does not, a digest is accepted for a closed-channel buyer with payment history,
and a digest is still rejected for a peer with neither signal.

---

## [2026-08-26] Implemented: RoutingDecisionRow.baselinePrices populated; computeRouterSavings rewritten to use it (decisions doc §13 item 10, §14 item 15 superseded)

`RoutingDecisionRow` (`packages/node/src/interfaces/buyer-router.ts`) gained `baselinePrices:
Record<string, {inUsdPerM, outUsdPerM, cachedInUsdPerM}>`. `router.ts`'s `selectRoute` computes it
once per ranked response via a new `computeBaselinePrices()` (`plugins/router-levanto/src/router.ts`),
filtering to a hardcoded `DEFAULT_BASELINE_MODELS` curated list and collapsing across peers to the
cheapest input-price offer per model. The value is duplicated onto every `PinnedDecision` built from
that response (same pattern already used for `cqt`, since it's a per-response, not per-candidate,
value) and threaded through the allowedPeerIds fallback branch and the pinned/reused continuation
path (task #21) so every ledger row -- real decision or reused dispatch -- carries it.

**Placeholder model names, not final:** `DEFAULT_BASELINE_MODELS = ['claude-opus-5', 'gpt-5.6-sol']`
-- picked from this codebase's own existing catalog code (`apps/desktop/.../catalog/recommended.ts`
already treats these as distinct "notable variant" flagship slots), not invented fresh, matching
SS8.4's "the most expensive, most capable flagship — the top GPT or Claude model." Real names will
follow the actual model hull (§7) once it exists, per the user's own note when this item was
discussed.

**"Best available offer" collapsing rule, not specified in the ground truth:** lowest `inUsdPerM`
wins when a curated model has multiple sellers in one ranked response. Chosen because there's no
fixed token mix available at this layer to combine input and output into one true total cost, and
input price is the simplest, most defensible single-axis tiebreaker — logged as a decision, not
treated as obviously correct.

**Scope extension beyond the literal task:** also rewrote `computeRouterSavings`
(`apps/desktop/src/renderer/modules/routing/router-savings.ts`) to consume `baselinePrices`
directly, per §14 item 15's own forward note ("Once this lands, computeRouterSavings should be
rewritten to sum the real, stored baselinePrices per row directly instead of approximating... that
removes the approximation entirely"). It now implements SS4.6's middle tier literally -- actual
paid vs. one fixed reference model's real AntSeed price *at the time of each decision* -- instead of
the previous stand-in (actual vs. today's retail price for each row's own actual model, reusing
`computeMeasuredSavings`'s math). Signature changed: drops the `OpenRouterReferenceMap` parameter
entirely (no longer needed -- the row's own `baselinePrices` snapshot replaces it) and gains an
optional `baselineModel` parameter defaulting to `DEFAULT_ROUTER_SAVINGS_BASELINE_MODEL =
'claude-opus-5'` (duplicated from, not imported from, `router-levanto`'s list -- that package is
buyer/Node-side with an `fs` dependency now, no cross-boundary import into renderer UI code is
intended). No SS8.4 dropdown UI exists yet to let a buyer choose a different reference model; the
parameter exists so that UI, whenever built, has something to plug a selection into rather than
needing another signature change. Updated both call sites (`VprHomeView.tsx`, `VprActivityView.tsx`)
and rewrote `router-savings.test.ts` for the new semantics.

---

## [2026-08-26] Implemented: pinned tool-loop continuations get their own ledger row (decisions doc §13 item 14)

`PinnedDecision` (`plugins/router-levanto/src/conversation-state.ts`) gained the predicted fields
(`predictedCostUsd`, `predictedInputTokens`, `predictedCachedInputTokens`, `predictedOutputTokens`,
`cqt`) alongside the routing/pricing fields it already carried. `selectRoute`'s new-user-message
gate's pinned-reuse branch now calls `ledger.recordPending(req.requestId, {...})` before returning
the reused candidate, reading those fields straight off the pinned decision (same model, same
predicted cost/tokens/cqt as the real decision it's pinned to) with `routingLatencyMs: null` --
matching `RoutingDecisionRow.routingLatencyMs`'s own field doc ("null when the gate skipped the
call entirely"). Each reused dispatch still gets its own `requestId` (a real HTTP request, just one
that skipped the network call to the routing peer), so it still resolves through the normal
`onResult` -> `recordResult` flow (task #20's requestId-keyed correlation) and produces its own row
with its own real actual outcome, joined against the reused predicted fields.

Simplified `selectRoute`'s real-decision path as a side effect: since each ranked candidate now
carries its own predicted fields directly, the separate `predictedByPeer` lookup map (built once,
read once, right before the final `recordPending` call) became redundant and was removed --
`winner.predictedCostUsd` etc. read directly instead.

Added a new test in `router.test.ts`'s ledger describe block that drives a real decision followed
by a real pinned continuation on the same conversation, and asserts the second dispatch's row
carries the first decision's predicted fields but its own distinct actual outcome and a null
`routingLatencyMs`.

---

## [2026-08-26] Implemented: routing_decisions ledger persists to disk (decisions doc §13 item 12)

`RoutingLedger` (`plugins/router-levanto/src/ledger.ts`) now optionally persists as
`routing-decisions.jsonl` in a buyer data directory -- one JSON row appended per line, per resolved
decision -- and reloads them synchronously on construction so a fresh `LevantoRouter` instance
continues where a prior process left off. Chosen format/pattern: mirrors `ConversationStore`'s
established local-state convention (`apps/cli/src/proxy/conversation-store.ts` -- sync load in the
constructor, corrupt-input tolerance, a serialized write queue with a `flush()` for tests) but as an
append-only JSON-lines log rather than a whole-file rewrite: `ConversationStore`'s pattern fits a
small, bounded, frequently-*mutated* set of records; `routing_decisions` is the opposite shape --
unbounded, write-once-per-row, read-mostly -- so rewriting the entire file on every new decision
would get slower over time for no benefit. No new dependency: plain `node:fs`, not SQLite (unlike
`ChannelStore`) -- `router-levanto` had zero runtime dependencies before this pass, and the access
pattern here (append a row, read all rows back, no querying) doesn't need a real database.

`LevantoRouterConfig` gained an optional `dataDir` field; omitting it keeps the ledger exactly as
in-memory-only as before this pass (no regression for existing callers/tests). The generic plugin
loader path (`index.ts`'s `createRouter`) also gained an optional `LEVANTO_DATA_DIR` config key
for the same purpose, though the real host wiring (task #26) will likely construct `LevantoRouter`
directly rather than through that generic string-config path.

**Left open, not decided here:** no retention/pruning policy exists for this ledger -- the file
grows indefinitely. Nothing in the decisions or software-architecture docs specifies a retention
window for `routing_decisions` (unlike the daily digest's fixed daily cadence), so inventing a cap
would be guessing rather than implementing something decided. Whoever builds the real savings
dashboard against this data should either confirm unbounded retention is fine at expected scale, or
this needs its own explicit decision.

Added `plugins/router-levanto/src/ledger.test.ts` (new file) -- real filesystem tests (temp
directories, no mocking) covering: persists and reloads across a simulated process restart,
accumulates multiple rows via real appends, tolerates a corrupt trailing line on reload without
losing the rows around it, and the no-`dataDir` in-memory-only path still works unchanged.

---

## [2026-08-26] Implemented: Router.onResult correlates by requestId, not peer (decisions doc §13 item 13)

`Router.onResult` (`packages/node/src/interfaces/buyer-router.ts`) gained an optional
`requestId?: string` field on its result object -- the same id `selectRoute` already receives via
`req.requestId` (`SerializedHttpRequest`, stable across a peer walk for one client request). Both
`buyer-proxy.ts` call sites now pass `requestId: requestForPeer.requestId` through. Only
`LevantoRouter` implements `onResult` meaningfully (checked -- `router-local` doesn't implement
`selectRoute`/`onResult`'s ledger-correlation path at all), so this is the only router affected in
practice.

`RoutingLedger`'s pending-decision map (`plugins/router-levanto/src/ledger.ts`) is now keyed by
requestId instead of peerId -- `recordPending`/`recordResult` renamed their parameter accordingly;
`recordResult` gained a separate `peerId` parameter since the ledger row still needs `actualPeer`
independent of the correlation key. `LevantoRouter.onResult` silently drops (no ledger write, no
throw) a result carrying no `requestId` at all -- an honest "nothing to correlate against," not a
guess, matching how the project has handled other no-signal cases (e.g. the unkeyable-conversation
gate). Added a new regression test in `router.test.ts` that reproduces item 13's exact scenario --
two different conversations both routed to peer `0xAAA` before either resolves, results arriving
out of order -- and asserts each one's actual outcome pairs with its own request's predicted
fields, not the other's; this would have failed under the old peerId-only keying.

---

## [2026-08-26] Implemented: selectRoute throws a clear RoutingPeerError instead of returning null (decisions doc §13 item 16)

`LevantoRouter.selectRoute` no longer returns `null` when the routing peer is unreachable, times
out, or responds with a non-OK status (including 402 "not subscribed today") — all three now throw
a new exported `RoutingPeerError` (`kind: 'unreachable' | 'rejected'`, plus `statusCode` for the
rejected case, with the message read from the peer's own JSON error body when present). `null` is
now reserved for exactly one case: the request's model isn't the Auto sentinel at all.

Scope note: decisions doc item 16's own text is framed around "unreachable/timeout," but its
justification explicitly treats the 402 "not subscribed" case as already sharing the same intended
behavior — the software-architecture doc (§2.2's note) independently already asserts the
not-subscribed branch "is meant to reject cleanly," which the implementation had never actually
matched (it silently returned `null` same as everything else in the `!res.ok` branch). Fixing both
failure classes together, rather than only the literally-named one, closes a real inconsistency
between that doc and the code instead of leaving a documented-but-false claim about current
behavior in place.

Investigated whether it's safe to let this throw propagate up through `buyer-proxy.ts`'s
`selectRoute` call site (the task's own instruction): confirmed yes — `_handleRequest`'s caller
already wraps the whole method in a catch-all that turns any uncaught error into a 502 with the
error's own message (`buyer-proxy.ts`, around the `createServer` callback), so no new plumbing was
needed there. Deliberately did **not** add a `RoutingPeerError`-specific catch in `buyer-proxy.ts`
to render a nicer JSON error shape for this one plugin's error type — the exact same code block
already carries the comment "Host code carries no knowledge of any sentinel string; that's entirely
the plugin's business" (decisions doc §G3, open ecosystem), and special-casing one plugin's error
class by name in host code would contradict that. The generic 502 fallback is host-agnostic and
already works uniformly for any third-party router plugin that throws, not just this one.

---

## [2026-08-26] Implemented: allowedPeerIds fallback uses defaultRoutedModel (decisions doc §13 item 8)

`Router.selectRoute` (`packages/node/src/interfaces/buyer-router.ts`) gained an optional 5th
parameter, `defaultRoutedModel?: string | null` — the pre-existing "antseed" alias's currently
resolved target, host-owned state (`buyer.state.json`'s `defaultRoutedModel`, already tracked
in-memory by `buyer-proxy.ts` as `this._defaultRoutedModel`), passed the same way `conversation`
already is. No filesystem access needed in the plugin — the host was already holding this value in
memory at the one real `selectRoute` call site (`buyer-proxy.ts`'s fixed-model peer-narrowing
replacement), so it's threaded straight through as a new argument. `LevantoRouter.selectRoute`'s
`allowedPeerIds` re-filter fallback (§4.4) now synthesizes candidates using `defaultRoutedModel`
instead of Sage's `baselineSuggestion.model` — the two have no real connection; `baselineSuggestion`
is Sage's own cheap/simple pick, not necessarily a model this buyer has actually allowlisted a
peer for. Synthesized candidates carry `null` for `inputUsdPerMillion`/`outputUsdPerMillion` (no
real price data exists for an arbitrary defaultRoutedModel/peer pair), and the fallback now
correctly gives up (returns `null` from `selectRoute`, matching the existing empty-ranked-list
path) when `defaultRoutedModel` isn't set, rather than silently using an unrelated model. Updated
existing fallback tests in `router.test.ts` and added a new one for the no-default-route case.

---

## [2026-08-26] Implemented: CQT dial gated on Auto being the selected model (decisions doc §13 item 21)

`VprPreferencesView.tsx`'s cost/quality slider now renders only when `vprRouteSelection.model` is the
"Levanto Auto" entry — previously unconditional regardless of selection. Added a null-safe
`isLevantoAutoSelected(model)` helper next to the existing `isLevantoAutoEntry` in
`apps/desktop/src/renderer/modules/routing/levanto-auto.ts` (the raw entry check doesn't accept
`null`, and `vprRouteSelection.model` is `null` before any model is chosen). Unit-tested the pure
helper directly rather than full-rendering the connected view component: this repo's view tests
(`ImageGenerationPlaceholder.test.tsx`) use `renderToStaticMarkup` with no jsdom dependency, but
`VprPreferencesView` calls `document.body` at render time via `activeThemeMode()`, which throws
under Vitest's default node environment — adding a jsdom dependency for one small gate wasn't
justified, so the gating logic moved to a plain, directly-testable function instead, following the
same pattern `isLevantoAutoEntry` already established in this exact module.

---

## [2026-08-26] Implemented: sidecar-down error reverted to generic (decisions doc §13 item 17)

`LevantoRoutingServerHandler.handleRoute`'s try/catch around `sidecar.rank()` — which returned a
distinguishable `503 sidecar_unavailable` — is removed. The failure now propagates as a thrown
error, caught generically by `seller-request-handler.ts`'s routing dispatch branch (production) or
`http-server.ts`'s catch-all (the thin test harness), both already returning a generic 500. Matches
the user's explicit call: a third-party `routing-client` caller shouldn't be handed which internal
component failed. Replaced the old 503-specific test with one asserting `handleRoute` rejects rather
than returning a distinguishable status.

---

## [2026-08-26] Implemented: subscription gate now requires authMax > 0 (decisions doc §13 item 15a)

`isSubscribedToday` (`levanto-routing-server/src/subscription-gate.ts`) closed the bootstrap-reserve
loophole: `reserve()`'s zero-amount "reserve proof" SpendingAuth bumped `updatedAt` to today without
any real day ever being paid for, and the gate didn't check the signed amount at all. Added
`authMax: string` to `SubscriptionSource.getChannelByPeer`'s return type (real `StoredChannel` already
carries this field, so the production `SellerPaymentManager`-backed source needed no changes) and a
`BigInt(channel.authMax || '0') > 0n` check alongside the existing `updatedAt is today` check. Item
15b (checking the signed amount actually matches what's owed) remains unimplemented — still blocked
on item 6's price-discovery gap, which is out of scope for this pass (no decided direction).

Updated `routing-server-handler.test.ts` (new `RESERVED_BUT_UNPAID` fixture + regression test),
`thin-loop.test.ts`'s inline fixtures, and `full-lifecycle.test.ts`'s real end-to-end bootstrap test —
that last one now asserts, with a real `SellerPaymentManager`, that routing stays blocked immediately
after `reserve()` and only unblocks once day 1's real cumulative is actually signed and accepted.

---

## [2026-08-26] Correction: `topUpReserve()`'s fixed-step ceiling raise is client-side, not on-chain

**Type:** Correction to the entry directly below ("Real on-chain e2e"), not an edit to it — that
entry stays as originally written; this appends the fix instead of rewriting history.

**What was wrong:** that entry's "Two real on-chain constraints discovered" heading mislabeled
both findings as on-chain. Only the second one (`AntseedDeposits`'s `BASE_CREDIT_LIMIT`) actually
is. The first — `topUpReserve()`'s ceiling raise being a fixed step
(`prevCeiling + config.maxReserveAmountUsdc` per call, not a target amount) — is a client-side
JS implementation detail of that one `BuyerPaymentManager` method. The on-chain `topUp()`
function itself accepts whatever `newMaxAmount` it's given; nothing about the contract enforces
a fixed step. Confirmed by reading `packages/contracts/payments/AntseedChannels.sol`'s `topUp()`
directly.

**Why it matters beyond correcting the record:** whoever eventually builds the real host-side
catch-up wiring (this file's "routing-client remaining pieces" entry; decisions doc §13 item 11)
needs to account for this specifically as a *client method* limitation — either size
`maxReserveAmountUsdc` generously enough that one `topUpReserve()` call always covers the
worst-case backlog, or call it more than once for a very long gap. That's a real constraint on
future work regardless of the mislabeling; only the "on-chain" framing was wrong.

**Ground truth reference:** none — this corrects an inaccuracy in this runlog's own prior entry,
not a deviation from or new decision about the ground-truth docs.

---

## [2026-08-26] Real on-chain e2e: the subscription lifecycle proven against a genuinely live anvil chain

**Type:** New test coverage, not a design change — but it surfaced one real gap in the
existing mocked coverage and two real on-chain constraints worth recording for whoever writes
the next payment-related test against a live chain.

**What's new.** `levanto-routing-server/src/e2e/full-lifecycle-onchain.test.ts` runs the same
subscription lifecycle `full-lifecycle.test.ts` already covers, but for real: a real `anvil`
node, the real protocol contract set deployed via `antseed-fork/packages/contracts/script/Deploy.s.sol`
(the same script `setup-local-test.sh` uses), a real staked seller identity, and
`BuyerPaymentManager`/`SellerPaymentManager` with **no `channelsClient` mocking** — every
`reserve()`, `topUp()`, and `settle()` in the two tests below is a genuine transaction,
verified afterward by reading the deployed `AntseedChannels` contract's actual state back
(`ChannelsClient.getSession()`), not by trusting the JS layer's own bookkeeping.

**Real gap this surfaced, not previously exercised:** the existing mocked
`full-lifecycle.test.ts` calls `authorizeSpending(sellerPeerId, buyerMux, DAILY_AMOUNT,
undefined)` — passing `undefined` for the explicit reserve amount, which makes
`authorizeSpending` reserve the buyer's *entire configured `maxReserveAmountUsdc`* ($10)
upfront, not the documented $0.59 bootstrap amount (decisions doc SS6.3). Because of that,
its catch-up-burst scenario never actually needs `topUpReserve()` — the $5.90 backlog fits
inside the already-$10 ceiling from day one, so `seller.channelsClient.topUp` (mocked in that
file) is never called at all despite being mocked, and the "proves the two-tx sequence" claim
in that test's own doc comment was true only at the raw-contract level (`AntseedChannels.t.sol`'s
Foundry tests), not through the actual `BuyerPaymentManager`/`SellerPaymentManager` JS
integration layer. This new test bootstraps with the real, documented $0.59 amount instead,
so its catch-up scenario genuinely needs and exercises `buyer.topUpReserve()` (raises the
on-chain ceiling via a real `topUp()` tx) followed by `buyer.reconcileReserveAmount()` (syncs
the client's cached ceiling from an on-chain read) before a fresh `signCumulativeAuth()` can
sign the backlog — confirmed by first watching it fail with the backlog silently clamped to
the *stale* pre-topUp ceiling, then fixing it, not assumed correct on the first try.

**Two real on-chain constraints discovered while wiring the buyer side up, both by hitting
real reverts and reading the contract, not by inspection alone:**
- `topUpReserve()`'s ceiling raise is a **fixed step** (`prevCeiling + config.maxReserveAmountUsdc`
  per call, confirmed by reading `buyer-payment-manager.ts`), not a target amount — the test's
  buyer config sizes that step ($8) to comfortably clear the worst-case backlog in one call.
- `AntseedDeposits.getBuyerCreditLimit()` caps a **fresh buyer's total deposit at
  `BASE_CREDIT_LIMIT`** ($10, before any channel history exists to earn
  `PEER_INTERACTION_BONUS`/`TIME_BONUS`) — a real `CreditLimitExceeded()` revert, not a bug in
  this test's harness. Neither ground-truth doc mentions this limit; it's on-chain behavior
  from `AntseedDeposits.sol`, logged here since it constrains how big a bootstrap+catch-up
  scenario a fresh buyer identity can exercise at all without first building channel history.

**Environment finding, not a code defect:** the same `forge script --broadcast` that runs in
under 1 second standalone took 280s+ and made `anvil` drop transactions
("Some transactions were discarded by the RPC node") when run inside this vitest suite's
`beforeAll`, eventually crashing Foundry's broadcaster with an upstream divide-by-zero panic.
Root cause, isolated by bisection (a minimal reproduction file, then adding pieces back one at
a time): `anvil` was spawned with `stdio: ['ignore', 'pipe', 'pipe']` and a `.on('data', ...)`
listener forwarding every line to `console.error` for debugging — piping and reading a
chatty child process's stdout from inside a vitest worker measurably starved the process
enough to make `anvil` unreliable under this sandbox's resource constraints. Fixed by spawning
both `anvil` and the mock-Sage sidecar with `stdio: 'ignore'` — nothing in this file needs
their console output. Confirmed the fix isn't a vitest-concurrency artifact: the suite passes
identically under the default worker pool and constrained to a single thread. No permanent
`vitest.config.ts` change was needed. Logged in case a future e2e file here reaches for
verbose child-process logging again — this sandbox appears to punish it specifically for
long-lived, chatty subprocesses.

**Verification:** 4 consecutive clean runs of the new file (both default worker pool and
single-threaded), then the full `levanto-routing-server` suite: 22/22 passing, no regressions.

**Ground truth reference:** decisions doc SS6.2/SS6.3/SS6.7 (bootstrap amount, catch-up
burst), payment-flow doc's Lifecycle section (`topUp()` then `settle()`) — now proven against
a real chain, not just mocked RPC and a separate raw-contract Foundry suite. The credit-limit
and fixed-step-size findings are new, undocumented on-chain behavior, not deviations from
anything the docs specify.

---

## [2026-08-26] Follow-up: Auto model-picker entry and savings dashboard actually built

**Type:** Completes the two pieces the previous entry below scoped down. Revisiting after
tracing the exact blocking code more deeply (rather than stopping at "this looks like it
needs new peer-resolution/IPC machinery") found both were smaller, more surgical fixes than
the earlier entry assumed — logged here rather than editing that entry's history.

**Auto model-picker entry (SS4.3), actually wired end-to-end:**
- `apps/desktop/src/renderer/modules/routing/levanto-auto.ts` (new): the `(levanto,
  levanto-auto)` sentinel pair, a full `VprModelCatalogEntry` for it (all pricing fields
  null -- a flat subscription has no per-token price), and `withLevantoAutoCatalogEntry`,
  prepended idempotently at all 3 of `controller.ts`'s `uiState.vprModelCatalog` assignment
  sites.
- **The real fix wasn't in `resolveVprChatOption` at all.** Re-tracing `actionSelectVprModel`
  (`app.ts:264`) found `handleServiceChange` (`controller.ts:2712`) already treats an empty/
  absent `explicitPeerId` as "no pin" — `nextRouteMode` falls to `'auto'` and
  `activeConversation.peerId` stays `undefined` — this is exactly the "no fixed peer, buyer-
  proxy's `selectRoute` picks both" behavior Auto needs, already built for a different reason
  (peer-less dropdown picks). `actionSelectVprModel` now special-cases `isLevantoAutoEntry(entry)`
  before it ever reaches `resolveVprChatOption`'s peer-scoring lookup (which would always
  return null for a sentinel no real seller advertises) and calls `handleServiceChange`
  directly with `encodeChatServiceSelection(entry.serviceId, entry.provider)` and no peerId.
  Newly exposed `encodeChatServiceSelection` on `ChatModuleApi` for this one caller.
  Traced the full downstream path by reading the real code (not assumed): `createVprRouteSelection(entry, null)`
  → `mode: 'auto'` → `createConversationForSelection`/`getSelectedChatServiceSelection` both
  correctly resolve to `{id: 'levanto-auto', provider: 'levanto'}` with no peerId →
  `bridge.chatAiCreateConversation('levanto-auto', 'levanto', undefined, 'auto')` — confirmed
  by reading `resolveVprChatOption`'s and `getSelectedChatServiceSelection`'s actual fallback
  branches, not inferred.
- `VprModelDropdown.tsx`: Auto pulled out of the ranking/favoriting computation (`selectFavoriteVprCatalog`/
  `selectRecommendedVprCatalog` operate on real per-seller catalog entries; Auto isn't one)
  and rendered by its own bespoke row (`renderLevantoAutoEntry`) in its own slot above
  Favorites/Recommended, reusing the dropdown's existing CSS classes rather than new markup.
- Real unit tests for the pure catalog-entry logic (`levanto-auto.test.ts`); the selection/
  dispatch wiring itself is verified by tracing, not by an Electron click-through (still not
  available in this environment) — flagged, not silently claimed as visually confirmed.

**Savings dashboard (SS4.5), the missing IPC turned out to already half-exist:**
- Tracing how the desktop main process reaches the buyer daemon at all (for the *existing*
  discover-rows/metering data) found it's plain localhost HTTP to buyer-proxy's own
  `/_antseed/...` reserved-path surface (`resolveProxyPort` + `fetch`), the exact same
  mechanism `/_antseed/route`/`/_antseed/attest` use on the seller side — not a bespoke IPC
  protocol needing to be invented. Added `/_antseed/routing-decisions` (GET) to
  `buyer-proxy.ts` alongside the existing `/_antseed/buyer-usage`/`/_antseed/metering`
  handlers, reading `this._node.router?.getRoutingDecisions?.() ?? []`.
- New optional `Router.getRoutingDecisions?(): RoutingDecisionRow[]` on the public `Router`
  interface (`packages/node/src/interfaces/buyer-router.ts`) — `RoutingDecisionRow` itself
  moved here from being defined twice (it was previously duplicated inside
  `router-levanto/src/ledger.ts`, now that file imports it from `@antseed/node`). Optional and
  additive: a router that doesn't implement `selectRoute` has no reason to implement this
  either, and nothing about existing routers changes.
- `LevantoRouter.getRoutingDecisions()` returns a copy of `this.ledger.all()`.
- Desktop main process: `chat:ai-list-routing-decisions` IPC handler (`engine.ts`, same
  fetch-then-JSON pattern as the neighboring handlers) + `chatAiListRoutingDecisions` preload
  bridge method + `DesktopBridge` type entry.
- Renderer: `routingDecisionsResource` (new shared `createCachedResource`, same pattern as
  `buyerConversationsResource`/`systemProxyResource`, so both Home and Activity views share
  one poll rather than fetching twice, matching how `computeMeasuredSavings`'s doc-cited call
  sites already work).
- `computeRouterSavings` (`modules/routing/router-savings.ts`) — real, tested pure module.
  **Deliberate deviation from SS4.6's literal middle tier, not silently approximated**: the
  doc's middle tier compares each decision against one *fixed* reference model's AntSeed
  price *at the time of that decision* (`RoutingDecisionRow.baselinePrices`, SS2.5) — that
  field is still omitted from the ledger (needs the SS8.4 fixed baseline dropdown, which has
  no VPR config surface to pick or persist a selection from, and wasn't built this pass
  either). Rather than hardcode a guessed "current flagship" model name into the calculation
  itself, `computeRouterSavings` reuses `computeMeasuredSavings`'s exact retail-vs-actual math
  (already real, already tested) but scoped to the `routing_decisions` ledger instead of
  aggregate buyer usage — each routed row's *own* actual model against *today's* retail price
  for that model, not a fixed baseline at the time of inference. A real, honestly-labeled
  approximation of the middle tier, not the literal SS8.4-dependent version.
- UI: a "Router savings" `VprStatTile` added to both `VprHomeView.tsx` and
  `VprActivityView.tsx`, alongside (never replacing or netting against) the existing "Saving"/
  "Saved" tile — matching SS4.6's "both numbers shown together" requirement. Renders only when
  `computeRouterSavings` returns non-null (i.e., only for a buyer who has actually used
  Levanto Auto) rather than showing a zero/dash for everyone else.

**A real, unrelated environment bug found and fixed along the way, not a code bug:** every
"test hang" investigated this session (`buyer-proxy.test.ts` appearing to hang for 35+
minutes, then `router-savings.test.ts`/the full desktop suite appearing to hang after
finishing all tests) traced back to `NODE_OPTIONS` globally injecting VSCode's JS-debug
bootloader (`--require .../js-debug/bootloader.js`) into every spawned `vitest` worker
process, which throws `ERR_INSPECTOR_NOT_ACTIVE` repeatedly and corrupts the worker pool's
IPC, hanging collection/teardown non-deterministically. Not a defect in any code touched this
session — confirmed by rerunning identical commands with `NODE_OPTIONS=` cleared, which fixed
every instance instantly (`apps/cli`'s test suite also uses `node --test` against built
`dist/`, not raw `vitest`, for unrelated reasons — a second, real invocation mistake caught
and fixed the same way, logged for whoever debugs this repo's tests next).

**Verification:** `packages/node` (rebuilt) → `plugins/router-levanto` (rebuilt) →
`apps/cli` (rebuilt, `node --test dist/proxy/*.test.js`: 256/256) → `apps/desktop` renderer
+ main typecheck clean, `vitest run src/renderer/`: 350/350 → `levanto-routing-server`:
20/20. Every suite green with `NODE_OPTIONS=` cleared.

**Ground truth reference:** decisions doc §4.3/§4.5/§4.6/§8.4, software-architecture doc
§2.1/§2.5/§4.1/§4.3 — the Auto entry and savings-dashboard *plumbing* now match the docs;
the router-savings *calculation* is a logged approximation of §4.6's middle tier pending
§8.4's still-unbuilt baseline dropdown.

---

## [2026-08-25] VPR/CLI UI (SS4): CQT dial and model disclosure shipped; Auto model-picker entry and savings dashboard scoped down with concrete blockers found

**Type:** Mixed — two pieces implemented and tested end-to-end at the logic level (no
Electron runtime available in this environment to visually verify, noted below); two
pieces investigated deeply enough to find the real integration points, then deliberately
not attempted, since the fix touches live chat-dispatch code this pass can't test.

**Shipped: CQT dial (SS8.1/software-arch SS4.4).** Added `cqt?: number` to
`ModelRoutingPreferences` (`packages/node/src/routing/model-route-ranking.ts`), default `5`;
`LevantoRouter.selectRoute` now reads `routingPreferences?.cqt ?? 5` instead of a hardcoded
`5`. Threaded through the *entire existing* preferences pipeline with no new plumbing --
`VprRoutingPreferences` already extends `ModelRoutingPreferences`, `updateVprRoutingPreferences`
already accepts a `Partial<VprRoutingPreferences>` patch generically, and
`syncBuyerRoutingPreferences`/`updateDashboardConfig` already ship the whole object over
existing IPC. Only 3 places needed a real (small) edit: `loadVprRoutingPreferences`/
`buyerModelRoutingPreferences` in `apps/desktop/src/renderer/modules/routing/preferences.ts`
(load/forward the new field, with a `{1,3,5,7,9}`-only validator so a corrupted/future value
can't reach the wire), and a new `VprSlider` row in `VprPreferencesView.tsx` mapping 5 UI
positions to those 5 values via a new small pure module,
`apps/desktop/src/renderer/modules/routing/cqt.ts`. Position labels ("Cheapest" / "Cheaper" /
"Balanced" / "Higher quality" / "Best quality") are a new, undocumented UI copy decision --
the docs only name the middle one ("Balanced") and set the copy constraint (no "save X%"
language, honored). Tested: `packages/node`, `router-levanto`, and `preferences.ts`/`cqt.ts`
all have real unit coverage; typechecked clean end-to-end (`packages/node` → rebuilt →
`plugins/router-levanto`, `apps/cli`, `apps/desktop` renderer all typecheck against it).

**Deviation, logged:** the dial is shown unconditionally in Preferences rather than "visible
once the subscription is active" (SS4.4's literal wording) -- gating that requires a
renderer-visible signal for "is router-levanto currently the active buyer router AND is a
subscription live," and confirmed by grep that nothing like that exists in the renderer today
(router selection is a main-process/CLI-flag concept, `apps/desktop/src/main/runtime/process-manager.ts`,
never surfaced to renderer state). Building that signal is itself a small new IPC surface,
out of scope for this pass. Showing the dial unconditionally is harmless -- it's inert until
both a Levanto subscription exists and "Levanto Auto" is the selected model -- just not
spec-exact.

**Shipped: model disclosure (SS8.3/software-arch SS4.6), including the real gap it named.**
The doc's own audit was right: `attachStreamingAntseedHeaders` (`apps/cli/src/proxy/telemetry.ts`)
attached peer identity but never `x-antseed-provider`/`x-antseed-service`, so a normal
*streamed* chat response (the common case) had no way for the client to know which model
answered — only the rarely-used non-streaming path carried that. Fixed by extending its
signature to take the resolved `request` (the already-substituted one, `withRoutedModel`,
per the one call site in `buyer-proxy.ts:~3034`) and resolving provider/service the same way
`computeResponseTelemetry` already does (`pickProviderForPeer`/`extractRequestedService`).
**Turned out the desktop UI already had everywhere else needed for this** --
`AssistantMeta.provider`/`.service` (`chat-shared.ts`) were already read from `msg.meta`, just
never rendered. Added one line to the existing `buildChatMetaParts` (same per-message meta
row that already shows peer/tokens/cost/latency) rather than inventing a new UI element —
`ChatBubble.tsx` needed zero changes, since it already renders whatever `buildChatMetaParts`
returns. Both the header fix and the disclosure line have real unit tests
(`apps/cli/src/proxy/telemetry.test.ts`, `apps/desktop/.../chat-shared.test.ts`).

**Scoped down, with concrete blockers found (not just "not started"): "Levanto Auto" model-picker
entry (SS4.3).** Traced the actual selection path before writing any UI code, since the doc's
own SS4.1 flags this as a new, separate axis from the existing "auto select seller" mechanism.
Found two real, specific blockers, both in live chat-dispatch code:

1. `actionSelectVprModel` (`apps/desktop/src/renderer/app.ts:263-265`) does
   `findCatalogEntry(uiState.vprModelCatalog, provider, serviceId)` and returns immediately if
   not found — a synthetic "Levanto Auto" entry handed only to the dropdown component would
   never actually select anything; it has to be inserted into the real, live `vprModelCatalog`
   array wherever that's constructed (network-discovery-derived, not found yet in this pass).
2. Even with a catalog entry, `resolveVprChatOption` (`apps/desktop/src/renderer/modules/chat/projection.ts:49`)
   resolves a chat dispatch by finding a concrete peer offering the exact `(provider, serviceId)`
   pair via `routesForSelectedModel` (live network discovery) — for `levanto-auto`, that's
   always empty, since no real seller advertises that model. It falls back to
   `findChatOptionForVprSelection`, which needs a matching `ChatServiceOptionEntry` — which, for
   every other model, carries one fixed `peerId` used to *pin* the dispatch. Auto's entire
   design is the opposite: no fixed peer, model AND peer both chosen per-request by the routing
   peer (confirmed by re-reading `buyer-proxy.ts`'s wiring from earlier this pass — `selectRoute`
   only runs inside `if (!explicitPeerId && requestedService)`, i.e. only when nothing pinned a
   peer already). A `ChatServiceOptionEntry` with a real `peerId` for "Auto" would silently pin
   a peer and never reach `selectRoute` at all — worse than not selecting anything, since it
   would look like Auto but route like a fixed model.

Fix needs a genuinely new "no fixed peer" selection mode threaded through
`ChatServiceOptionEntry`/`resolveVprChatOption`/whatever ultimately sets a chat request's
`explicitPeerId`, not just a new dropdown entry. That's real surgery to live, currently-working
chat-dispatch code with no Electron runtime available in this environment to click through and
verify the result — the wrong kind of change to make on inference alone. Left unbuilt rather
than shipped half-correct (an Auto entry that either silently no-ops or, worse, silently pins a
peer and defeats the entire routing feature). `LEVANTO_AUTO_MODEL_ID = 'levanto-auto'` isn't
even defined as a shared constant yet outside `router-levanto`'s own hardcoded check — next
attempt should start there.

**Scoped down: savings dashboard (SS4.5/§4.6's three-tier diagram).** `routing_decisions`
ledger data (`RoutingLedger.all()`, task #9) lives inside the `router-levanto` plugin instance,
which runs inside the buyer CLI/daemon process — a separate OS process from the Electron
renderer that would show `VprHomeView.tsx`/`VprActivityView.tsx`. There is currently no channel
carrying *any* plugin-internal data from that process to the desktop UI (the existing
`updateDashboardConfig`/`syncBuyerRoutingPreferences` IPC flows the other direction, config
into the daemon, not data out). Building this needs: (a) some export surface on the daemon side
(a new IPC handler, or a polled file/socket) exposing ledger rows or a pre-aggregated summary,
(b) a `computeRouterSavings`-equivalent to `computeMeasuredSavings` (`measured-savings.ts`)
operating on those rows against the SS8.4 fixed baseline dropdown, (c) new UI on both existing
views per SS4.5. All three are real, separate, substantial pieces — not attempted this pass.
The router-side data this would consume (the ledger, `predictedCostUsd`/price-snapshot fields)
is real and already tested (task #9's runlog entry) — only the cross-process transport and the
UI on top are missing.

**Ground truth reference:** decisions doc §8.1/§8.3/§8.4/§8.5/§4.6, software-architecture doc
§4.1–§4.6 — CQT dial and model disclosure implemented as specified (dial visibility gate
deviated, logged above); the Auto model-picker entry and savings dashboard are genuinely
unbuilt, with the specific blocking code identified above rather than left as a vague gap.

---

## [2026-08-25] Daily digest: sending (client) and receiving (server)

**Type:** New decisions (ground truth silent on several mechanics) implementing decisions
doc §6.9 / software-architecture doc §2.7 (sending) and §3.6 (receiving).

**Wire mechanics, decided:** software-arch doc §3.6 offered two options for distinguishing
a digest submission from a §4.4 routing request on the same reserved path -- body-sniffing
(no `sagePrompt` field) or a `/_antseed/route/digest` path suffix -- and said either is
fine. Chose body-sniffing: `LevantoRoutingServerHandler.handleRoute`
(`levanto-routing-server/src/routing-server-handler.ts`) parses the body once, then checks
`'sagePrompt' in parsed` before deciding which shape to treat it as. This means zero changes
to `packages/node`'s dispatch (`ANTSEED_ROUTE_PATH` stays a single exact-match path) --
picked over the suffix specifically to avoid touching the public repo's generic plumbing a
second time for the same feature. Digest fields (`DigestSubmissionBody`,
`levanto-routing-server/src/digest-store.ts`) are a local duplicate of the client's
`DailyDigestBody` (`plugins/router-levanto/src/digest.ts`), same reasoning as the existing
`RouteRequestBody` duplication noted elsewhere in this file.

**No `v` field on the digest body.** Decisions doc's own open item 5 explicitly leaves
digest versioning unresolved ("the digest sub-question... is resolved [for artifactVersion/
lambdaVersion]" but general versioning stays open) -- didn't invent an answer to a
still-open question; the digest body carries only the §6.9 field list, nothing else.

**Client-side send timing, decided:** §2.7 says "same daily cadence" as the SpendingAuth
signature but doesn't say which day's numbers a given send reports. Chose: report the day
that just closed (yesterday, relative to when the send fires), not today-so-far -- because
at the moment this fires (the first `selectRoute` of a new calendar day, same trigger as
`ensureSignedToday`), today's own ledger rows don't exist yet, and §3.6's retention model
("each day's digest accumulates... a single overwritten snapshot couldn't answer...")
implies a digest is a closed day's tally, not a live partial one. `LevantoRouter.sendDailyDigestIfNeeded`
(`plugins/router-levanto/src/router.ts`) is called right after `ensureSignedToday()` in
`selectRoute`, same call site, at most once per calendar day. No signing key involved (unlike
§2.6's daily payment), so the plugin sends this directly with its own `fetchImpl` rather than
needing a host-mediated method -- matches system-architecture doc's ownership line
("[routing-client] owns... sending the daily digest") literally.

**Best-effort, never blocks routing:** a failed digest send is caught and swallowed --
`lastDigestSentDayKey` only advances on a successful (`res.ok`) send, so a failure is
retried on the next `selectRoute` call rather than lost or surfaced as a routing error.
Matches §2.7's "not required for correct routing to work" directly.

**Server-side gate, new decision:** a digest submission is gated on `hasSession(buyerPeerId)`
only, not the full `isSubscribedToday` freshness check §3.3 uses for routing requests --
reasoning: a digest isn't consuming today's paid routing service, and a client flushing
yesterday's finished tally shortly after midnight (before today's signature lands) should
still be able to deliver it. Requiring *some* known channel still keeps this from being an
open write endpoint for an arbitrary peer id. Ground truth doesn't specify this gate at all.

**Side effect on gate ordering (routing requests):** to sniff the body shape before deciding
which gate applies, `handleRoute` now parses JSON *before* the `isSubscribedToday` check,
reversed from before this change (gate first, then parse). A malformed body from an
unsubscribed buyer now returns 400 instead of 402 -- a minor, non-security-relevant behavior
change (both are error responses, no additional data disclosed), required by the shape-sniffing
approach chosen above, not otherwise motivated.

**Retention/anonymization, implemented as specified:** `InMemoryDigestStore`
(`levanto-routing-server/src/digest-store.ts`) accumulates one entry per `period` per
`hash(buyerPeerId)` (sha256, lowercased first) rather than overwriting -- matches §3.6's
retention model. In-memory only, no durable persistence yet, consistent with the rest of
this project's storage layer (subscriptions, ledger) being unpersisted in this pass --
not logged as a new gap, same accepted limitation already on record.

**Scoped down, per §2.7's own table:** `regenerations`, `overrides`, `failovers`, `timeouts`
are always `0` -- the doc itself says these need signals that don't exist yet (VPR/CLI UI
for the first two, task #10, not started; failover-walk counters for the last two, no
counting currently exists on the walk buyer-proxy already does). Not fabricated data --
`buildDigest` (`plugins/router-levanto/src/digest.ts`) computes real sums/tallies for every
other field from the existing `routing_decisions` ledger, which is the actual source §2.7's
own table cites for most fields ("already there").

**Verified genuinely end-to-end, not just unit-level:** added a real-process e2e test
(`levanto-routing-server/src/e2e/thin-loop.test.ts`, new describe block) -- a real
`LevantoRouter` posting over real HTTP to a real `LevantoRoutingServerHandler`, asserting the
digest actually lands in an injected `InMemoryDigestStore` keyed by hash. Caught a real bug
in the process: the e2e test initially failed silently (empty digest store) because
`levanto-routing-server`'s `@antseed/router-levanto` dependency resolves through that
package's built `dist/`, not live `src/` -- the same class of gotcha logged earlier this
project for `ConversationIdentity` (apps/cli picking up packages/node's dist). The plugin's
`src/router.ts`/`src/digest.ts` changes were invisible to the e2e test until `npx tsc` was
re-run in `plugins/router-levanto` to refresh `dist/`. Worth remembering for any future
cross-repo change here: edit `src/`, rebuild, then trust the e2e result -- an e2e pass
against a stale `dist/` proves nothing.

**Ground truth reference:** decisions doc §6.9 (field list, "default on, no opt-out"),
software-architecture doc §2.7 (sending) and §3.6 (receiving, retention, anonymization) --
implemented as specified where the doc states a mechanism; the send-timing choice, the
server-side gate, and the body-sniffing-over-suffix pick are new decisions the docs leave
open.

---

## [2026-08-25] Three unformalized failure modes: routing-peer timeout, sidecar-down, zero-eligible-candidates

**Type:** New decisions (ground truth silent) — the mission brief explicitly calls these
three out as not covered by any of the four docs and asks for a logged approach.

**1. Routing peer unreachable or hung (client side).**
`LevantoRouter.selectRoute` (`plugins/router-levanto/src/router.ts`) now wraps its fetch to
`/_antseed/route` in an `AbortController` with a configurable `routeTimeoutMs` (default
3000ms, new `LevantoRouterConfig` field). A refused connection and a hung/never-responding
one both surface identically — the abort fires the same way fetch's own rejection would —
and both are handled by returning `null` from `selectRoute`, exactly like a clean 402: the
existing buyer-proxy pipeline falls through to `selectCandidatePeersForRouting`'s normal
narrowing rather than surfacing a routing-specific error to the end user. Covered by a new
test using a `fetchImpl` mock that only resolves/rejects when its `AbortSignal` fires,
configured with a short `routeTimeoutMs` so the test doesn't wait out the real default.

**2. Mock Sage sidecar down while the routing peer itself is up (server side).**
`LevantoRoutingServerHandler.handleRoute` (`levanto-routing-server/src/routing-server-handler.ts`)
now wraps the `sidecar.rank(...)` call in its own try/catch, returning a distinct `503` with
`error.type: 'sidecar_unavailable'` — rather than letting the exception propagate uncaught to
`seller-request-handler.ts`'s generic dispatch wrapper, which would otherwise return an
indistinguishable generic `500 routing_error` for this case and any other internal bug. The
client currently treats any non-OK status the same (decline, per failure mode 1 above), so
this doesn't change client behavior yet — the value is purely in making the seller-side
response/logs diagnostic. Covered by a new test with a `SidecarClient` fake whose `rank()`
throws.

**3. Buyer config with zero eligible candidates.**
No change needed — already correct. `handleRoute` filters the catalog by constraints first;
if the filtered set is empty it returns a normal `200` with `ranked: []` and
`baselineSuggestion: null` before ever touching the sidecar (lines ~89-96, pre-existing).
Confirmed by the pre-existing `'returns an empty ranked list rather than erroring when every
candidate is filtered out'` test in `routing-server-handler.test.ts` — no gap here, just
verifying and recording it as covered under this task.

**Ground truth reference:** None — the mission prompt itself names these three as gaps the
docs don't specify a mechanism for, and asks that the approach be logged here rather than
filled in silently.

---

## [2026-08-25] The subscription gate doesn't distinguish a bootstrap reserve from a real day's payment

**Type:** Observation surfaced while building the full-lifecycle e2e test
(`levanto-routing-server/src/e2e/full-lifecycle.test.ts`) -- not a code change, the gate
already matches its spec exactly; flagging because the test's own first draft assumed
otherwise and was wrong.

**Context:** Testing that routing stays blocked between "buyer opts in (`reserve()`)" and
"buyer signs day 1's real cumulative" -- expected a 402 in between, using a real
`BuyerPaymentManager` + real `SellerPaymentManager` (on-chain calls mocked, same pattern as
`packages/node/tests/payment-flow-integration.test.ts`).

**Finding:** That in-between state is NOT blocked. `reserve()`'s own bootstrap step signs a
`SpendingAuth(cumulativeAmount=0)` as "reserve proof" (`AntseedChannels.sol`'s own doc
comment on `reserve()`) -- and that signature alone bumps `StoredChannel.updatedAt` to
today, which is 100% of what the gate checks ("hasSession && updatedAt is today",
software-architecture doc SS3.3, verbatim). The gate has no amount check anywhere in any of
the four docs, so this isn't a bug relative to spec -- it's a real, verified consequence of
building the gate exactly as documented: a channel that was JUST opened today, with nothing
real ever signed for it, already reads as "subscribed today."

**Why this doesn't necessarily matter in practice:** the documented lifecycle (decisions doc
SS6.5) always signs day 1's real cumulative before the first routing call ever happens, same
calendar day -- so a real buyer following the intended flow never actually exercises this
gap window. It only shows up if something (a crash, a race, third-party routing-client code
per SSG3) lets a routing call reach the gate between `reserve()` and the first real
`signCumulativeAuth`.

**Not changed:** this is exactly what "hasSession && updatedAt is today" says to build, and
none of the four docs ask for an amount check. Flagging for awareness, not fixing
unprompted — a stricter gate (e.g. requiring `cumulativeAmount > 0`) would be a real design
change beyond what's specified.

---

## [2026-08-25] routing-client remaining pieces: what's real, what's scoped down

**Type:** New decisions (ground truth silent) + honest scope notes, batched from one pass
implementing the gate, cached-token estimator, allowedPeerIds re-filter, daily-signing call
ordering, and the routing_decisions ledger in `plugins/router-levanto`.

**Real and tested (27 tests, `plugins/router-levanto/src/{router,conversation-state}.test.ts`):**
- New-user-message gate (decisions doc §4.2): keyed `${tool}:${sessionKey}` (not
  parentSessionKey-preferred), pins and reuses the last decision with no network call on a
  tool-loop continuation.
- Cached-token estimator (§4.3): EMA'd observed ratio per (conversation, model, peer), 3-minute
  flat decay, zero for an unseen candidate — matches the formula in the doc exactly.
- `allowedPeerIds` client-side re-filter (§4.4), including the "walk exhausts the list, fall
  back to the allowed peers directly" case, using `baselineSuggestion`'s model for the fallback
  (the doc doesn't specify what model the fallback should use — this is the one reasonable
  candidate the wire response actually offers).
- Pay-first daily signing call ordering (§6.2): `signDailyIfNeeded` called at most once per
  calendar day, before the first real routing call of that day, never for a pinned reuse.
- `routing_decisions` ledger (software-architecture doc §2.5): row shape matches the doc's
  `RoutingDecisionRow` type field-for-field (minus `baselinePrices`, see below). `Router.onResult`
  extended additively (`freshInputTokens`/`cachedInputTokens`/`outputTokens`/`estimatedCostUsd`,
  all optional) per §1's own description of this as safe ("nothing new to compute, just forward
  what's already there") — wired into both `buyer-proxy.ts` call sites from
  `computeResponseTelemetry`, confirmed against the existing 121-test buyer-proxy suite (all
  still passing) and packages/node's typecheck.

**Scoped down, logged rather than silently assumed complete:**
- `signDailyIfNeeded` and `recordObservedCache` are narrow injection points the plugin calls —
  the actual host-side implementations (calling the real `BuyerPaymentManager.signCumulativeAuth`
  + sending over `PaymentMux`; calling `recordObservedCache` after each response) are **not
  wired up**. Building that means touching the CLI's plugin-instantiation code and exposing a
  buyer-side PaymentMux-sending capability to it — a real, separate integration task, not
  something the plugin can do by importing `BuyerPaymentManager` directly (would violate the
  "plugin never holds the signing key" boundary, software-arch doc §2.6).
- The ledger is in-memory only — no persistence (SQLite/file) yet, and `getLedgerRows()` has no
  caller (the VPR savings dashboard, task #10, doesn't exist yet).
- `RoutingDecisionRow.baselinePrices` is omitted — needs the §8.4 fixed dropdown list threaded
  in from VPR config, which doesn't exist yet either.
- Correlating `onResult` back to the `selectRoute` decision that caused it is done by `peerId`
  alone (no `requestId` or conversation key available on `Router.onResult`'s existing signature).
  A second concurrent request to the same peer before the first resolves would mis-pair. Accepted
  for this pass; real traffic here isn't meaningfully concurrent per peer, but this is a genuine
  simplification, not a proven-safe design.
- A pinned tool-loop continuation doesn't currently write its own ledger row, even though the
  row shape's own `routingLatencyMs: number | null` comment ("null when the gate skipped the
  call entirely") implies it should. Doing this properly needs predicted-field data carried on
  `PinnedDecision` too, which the current implementation doesn't thread through.
- Conversations with no `ConversationIdentity` (content-hash fallback, per earlier design
  discussion) always route rather than being gated by a derived fallback key — safe (never
  silently skips billing-relevant routing) but not the fuller fallback that was discussed.

**Ground truth reference:** decisions doc §4.2/§4.3/§4.4/§6.2, software-architecture doc §1/§2.5 —
implemented as specified where noted; the scoped-down items above are this pass's own honest
limitations, not contradictions of anything the docs say.

---

<!-- Template for a new entry:

## [YYYY-MM-DD] Short title

**Type:** Deviation from ground truth / New decision (ground truth silent)

**Context:** What was being built when this came up.

**Decision:** What was actually done.

**Why:** The reason it had to differ, or the reasoning behind the unspecified call.

**Ground truth reference:** e.g. "decisions doc §6.3" or "none — item was open" or
"contradicts software-architecture doc §2.4, which assumed X"

-->

## [2026-08-25] Mock Sage sidecar's internal API (routing-server plugin <-> sidecar)

**Type:** New decision (ground truth silent)

**Context:** Scaffolding `levanto-routing-server`'s mock ranking sidecar for end-to-end
testing, standing in for the real Sage process.

**Decision:** The sidecar is a standalone Python HTTP process (mirrors real Sage's actual
deployment shape) exposing one internal endpoint, `POST /rank`, taking
`{ models: string[], contextTokens: number, cqt: number }` and returning
`{ qualities: Record<model, number> }` — a flat per-model quality score in [0, 1]. Quality
values come from a small fixed lookup table for known model names, falling back to a
stable hash-derived score in [0.4, 0.8) for unknown models, so results are deterministic
across test runs without being a real quality predictor.

**Why:** system-architecture.md documents that Sage "lives in its own repo... communicates
with it locally" but never specifies the wire shape of that local call — it's an
implementation detail of the (proprietary) routing-server plugin, not part of the public
`/_antseed/route` contract (decisions doc §4.4), which is a separate, external-facing
schema this sidecar has nothing to do with directly.

**Ground truth reference:** None — the sidecar's internal API isn't specified anywhere in
the four docs; this is a genuinely new, unspecified detail filled in during
implementation.

## [2026-08-25] Moved `ConversationIdentity` from apps/cli into packages/node

**Type:** Deviation from ground truth

**Context:** Adding `selectRoute` to the `Router` interface in
`packages/node/src/interfaces/buyer-router.ts`, per software-architecture doc §2.1 —
its signature takes `conversation: ConversationIdentity | null`.

**Decision:** `ConversationIdentity` was defined in `apps/cli/src/proxy/conversation-identity.ts`.
Moved just the type (not `extractConversationIdentity` or any of its header/body-parsing
logic, which is legitimately CLI-specific) to a new file,
`packages/node/src/routing/conversation-identity.ts`, exported from `packages/node`'s
index alongside the new `RouteCandidate` type. `apps/cli/src/proxy/conversation-identity.ts`
now imports and re-exports it from `@antseed/node` instead of defining it locally, so no
existing import site needed to change. Verified with a real build: `packages/node`
typechecks clean, then `apps/cli` typechecks clean against the rebuilt `dist/` (workspace
packages resolve through `dist/`, not live `src/`, so the node package needs a build before
apps/cli picks up a new export — confirmed by trying it both ways).

**Why:** `Router` (and now `selectRoute`) is part of `packages/node`'s public interface —
router plugins (including third-party ones) implement it without depending on the CLI app.
`ConversationIdentity` living in `apps/cli` would mean `packages/node`'s own interface file
importing from `apps/cli`, backwards from the actual dependency direction (apps depend on
packages, not the reverse) and not something the workspace's module resolution supports
anyway. `ModelRoutingPreferences` (the sibling type the same `selectRoute` signature takes)
was already correctly placed in `packages/node` — this makes `ConversationIdentity`
consistent with it.

## [2026-08-25] signCumulativeAuth bounds itself independently, not just by the caller's number

**Type:** Deviation from ground truth (closes a gap the docs left open) / New decision

**Context:** Implementing decisions doc §13 item 2 — the new narrow `BuyerPaymentManager`
method for daily flat-fee signing (`packages/buyer-core/src/buyer-payment-manager.ts`).

**Decision:** `signCumulativeAuth(sellerPeerId, requestedCumulativeAmount)` does not sign
whatever `requestedCumulativeAmount` the caller passes. It independently computes its own
bound — `dailyAmountUsdc × min(calendar days elapsed since it last signed for this seller,
catchUpCapDays)`, using its own clock and its own persisted `_lastFlatFeeSignedAt` state,
then clamps the request down to that bound (and further to the reserve ceiling, and never
below the previous cumulative). `dailyAmountUsdc`/`catchUpCapDays` are set once via a new
`configureFlatFeeSigning(sellerPeerId, config)` host-level call, not passable by the plugin
per signing call. Covered by 8 new tests in `packages/node/tests/buyer-payment-manager.test.ts`
(day-one bound, day-to-day advancement, catch-up cap, monotonicity, ceiling, and the two
missing-setup error cases) — all pass, plus the full existing 64-test suite for this file
still passes unchanged.

**Why:** Earlier in this project's design conversation (not itself part of the four ground-
truth docs, but directly relevant), it was noted that `signPerRequestAuth` never trusts a
caller's claimed cost either — it independently computes `verifiedCost` and bounds signing
via `_maxSignableForVerified`, specifically so a compromised or buggy plugin sharing the
process can't get the manager to sign more than what's actually been verified. The originally
described narrow method (software-architecture doc §2.6, "given an amount the plugin already
decided") would have bypassed that invariant entirely for the one signing path where it
matters most for a third-party plugin (decisions doc §G3: routing-client can be third-party
code) — a subscription fee has no per-response usage data to verify against, but "calendar
days actually elapsed" is something the manager can verify itself, from its own clock,
without trusting the plugin's word for it. Implementing this now, rather than leaving the
gap and logging it as still-open, since a working, testable fix was straightforward once the
actual code was in front of me.

**Ground truth reference:** software-architecture doc §2.6 describes the new method as
"given an amount the plugin already decided" with no independent bound — this implementation
adds one. Decisions doc §13 item 2 only asks for the method to exist; the bound is new.

## [2026-08-25] Generic RoutingServerHandler dispatch, not a hardcoded route

**Type:** New decision (ground truth silent)

**Context:** Wiring the reserved `/_antseed/route` path (decisions doc §4.4, software-arch
doc §3) into `packages/node/src/seller-request-handler.ts`.

**Decision:** Followed the exact precedent already in this file for `/_antseed/attest`:
that path is NOT hardcoded attestation logic — it's a generic dispatch to whatever `Prover`
plugin the host registered via `AntseedNode.registerProver()`, looked up by name and stored
in `SellerRequestHandlerDeps.provers`. Did the same for routing: a new, generic
`RoutingServerHandler` interface (`handleRoute(req): SellerResponse`) in
`packages/node/src/interfaces/plugin.ts`, a `registerRoutingServerHandler()` method on
`AntseedNode` (single instance, not an array — one routing peer identity per seller node,
unlike provers which are looked up by name), threaded into
`SellerRequestHandlerDeps.routingServerHandler`, and a new dispatch branch in
`seller-request-handler.ts` that 404s if nothing's registered, otherwise delegates entirely
to the handler and forwards its response. No routing/ranking logic of any kind lives in
`packages/node` — the actual `RoutingServerHandler` implementation (subscription gating,
calling the ranking sidecar, computing the §4.4 response) is instantiated and registered by
`levanto-routing-server` (private), before `node.start()` — same ordering requirement
`registerProver` already has, since `_deps` is only assembled once, inside `start()`.

**Why:** None of the four docs specify HOW a seller-side plugin registers a custom reserved
HTTP path in the current plugin architecture — they describe what `/_antseed/route` does,
not the registration mechanism. The existing plugin taxonomy (`provider` = seller
inference, `router` = buyer peer selection, `verifier`/`prover` = TEE attestation) has
nothing that fits "a seller plugin serving a custom reserved path." Without this decision,
implementing `/_antseed/route` would have meant either hardcoding routing-server logic
directly into `packages/node` (exactly the public/private leak the mission is meant to
avoid) or inventing something bespoke. Reusing the `Prover`/attest pattern keeps
`packages/node` limited to generic plumbing and puts 100% of the actual routing-server
logic in the private repo, consistent with how attestation already does this for a
structurally identical problem.

**Ground truth reference:** None directly — system-architecture.md describes the
routing-server plugin as owning "the reserved-path `/_antseed/route` handler" without
saying how that path gets registered into a seller node; software-architecture doc §3
describes the handler's *behavior* (subscription gate, then Sage) but not this wiring.

**Ground truth reference:** software-architecture doc §2.1's `selectRoute` signature and
type block (`docs/model-routing-software-architecture.md:40-62`) present `ConversationIdentity`
as if it were already cleanly importable into `packages/node` — it wasn't; the doc doesn't
mention this layering constraint or that the type needs to move.
