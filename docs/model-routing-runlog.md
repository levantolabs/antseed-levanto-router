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
