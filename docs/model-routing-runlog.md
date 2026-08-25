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
