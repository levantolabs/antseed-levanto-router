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
