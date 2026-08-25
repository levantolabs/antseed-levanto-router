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

**Ground truth reference:** software-architecture doc §2.1's `selectRoute` signature and
type block (`docs/model-routing-software-architecture.md:40-62`) present `ConversationIdentity`
as if it were already cleanly importable into `packages/node` — it wasn't; the doc doesn't
mention this layering constraint or that the type needs to move.
