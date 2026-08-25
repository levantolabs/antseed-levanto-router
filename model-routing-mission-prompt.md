# Mission: implement and end-to-end test Levanto's model-routing subscription

This is fully designed already — implement and test it, don't redesign it.

## Ground truth — read first, in `antseed-fork/docs/`

1. `model-routing-architecture-and-open-decisions.md` — the spec; §13 lists what's still open.
2. `model-routing-software-architecture.md` — client/server code architecture, payment mechanics, flow diagrams.
3. `model-routing-system-architecture.md` — deployed components.
4. `model-routing-payment-flow.md` — bootstrap ramp, daily reserve/settle (current default, still open vs. monthly — doc 1 §6.4), toggle-on-gap catch-up burst.

**Never edit these to match what you build.** Deviate or fill a gap as needed, but log what and why in `antseed-fork/docs/model-routing-runlog.md`. Also read `antseed-fork/CLAUDE.md`'s Model Routing section — same rules, wins on conflicts.

## Two repos — read carefully

- **`antseed-fork/`** (public, branch `model-routing`) — `routing-client` buyer plugin, wire-level API/schema contracts (e.g. `/_antseed/route` shape), hooks into existing AntSeed client/CLI/desktop code.
- **`levanto-routing-server/`** (private, freshly scaffolded, empty) — the routing-server's proprietary ranking/pricing logic, anything Sage-related beyond "exists, called locally."

**Never put proprietary ranking logic in `antseed-fork`.** Already happened once this session (a tuned scoring algorithm hit the public repo, since deleted) — don't repeat it. Rule of thumb: if a change can't map to a documented *public-facing* component, it doesn't belong in `antseed-fork`.

`levanto-routing-server` also installs the forked AntSeed client from `antseed-fork` for e2e testing.

Sage itself (`sage_model_router`, separate, already-private) is out of scope — don't integrate the real thing. Build a lightweight mock ranking sidecar in `levanto-routing-server` implementing the same wire contract (doc 2 §4) with simple deterministic scoring, enough to exercise the system end to end.

## Devtooling

Foundry (forge/anvil/cast) is the existing toolchain in `antseed-fork/packages/contracts` — use it, not Hardhat/Truffle. `setup-local-test.sh` deploys the full contract set to local `anvil` but has a hardcoded path from another dev's machine — fix before relying on it.

## What to implement (checklist, not a substitute for reading the docs)

**`antseed-fork`:** routing-client plugin (new-message gate, cached-token estimator, `routing_decisions` ledger, `selectRoute` wired ahead of candidate narrowing, failover walk, `allowedPeerIds` re-filter); daily pay-first signing incl. the toggle-on-gap catch-up burst (two-tx `topUp()`→`settle()`, see payment-flow doc's Lifecycle); new narrow `BuyerPaymentManager` signing method (doc 1 §13 item 2); VPR/CLI UI (Auto model entry, cost/quality control, savings dashboard); daily digest sending.

**`levanto-routing-server`:** `/_antseed/route` handler + subscription gate; digest receiving; mock Sage sidecar; the real (proprietary) ranking/pricing logic.

**On-chain (Foundry/anvil):** full lifecycle against real `AntseedChannels`/`AntseedDeposits` — bootstrap, ordinary daily operation, and especially the two-tx catch-up burst. Verify: `topUp()`'s settlement check uses the *pre-raise* ceiling (`AntseedChannels.sol:224`), so confirm catch-up genuinely needs both calls.

**End-to-end:** buyer client + routing-server (mock Sage) + local anvil through a full subscription lifecycle incl. a simulated multi-day toggle-on gap and catch-up. Also cover, logging your approach in the runlog since the docs don't specify a mechanism: routing peer unreachable/timeout, mock Sage down while the peer's up, and a buyer config with zero eligible candidates.

## Process

Commit locally as you complete meaningful chunks. **Never push to any remote without explicit confirmation** — especially `antseed-fork`'s public GitHub remote. Log deviations to the runlog as you go. Get a thin end-to-end loop working early, then deepen each piece.
