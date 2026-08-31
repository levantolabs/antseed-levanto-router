# Subscription Payment: Daily Signing Over Reserve/Spend

## 1. The underlying primitives

Every inference payment is core-client code, driven by two signatures:
`BuyerPaymentManager` (`packages/buyer-core/src/buyer-payment-manager.ts`) signs a `ReserveAuth`
the first time a buyer talks to a new seller, and a `SpendingAuth` each time usage needs
settling; `BuyerPaymentNegotiator` (`buyer-payment-negotiator.ts`) drives 402 negotiation and
channel recovery around those same two signatures. No provider or router plugin ever holds a
reference to either — the host owns all payment signing, by design.

Per-token metered billing drives both signatures from a request: a buyer sends a chat message,
the seller serves it, the resulting cost gets signed and settled. A seller charging a flat
recurring price instead (e.g. "$0.59/day whether or not you send a message that day") needs a
payment that doesn't depend on a request ever happening — a buyer who sends nothing on a given
day must still produce a signature that day.

## 2. Daily signing over the same primitives

Reuse `ReserveAuth`/`SpendingAuth` exactly as they are; add one thin layer above them —
`apps/cli/src/proxy/daily-subscription-signing.ts`'s `signDailyIfNeeded`, driven by a single
per-calendar-day gate (`LevantoRouter.ensureSignedToday`, `plugins/router-levanto/src/router.ts`)
rather than a request:

1. Toggle-on starts a recurring background timer (`scheduleDailySigningChecks`, fires
   immediately on creation, then every 15 minutes) that calls `ensureSignedToday`; toggle-off
   stops it. `selectRoute` calls the same `ensureSignedToday` immediately before every routing
   call, as a pay-first check — both call sites share one piece of state
   (`lastSignedDayKey`), so whichever fires first on a given calendar day does the real work and
   the other is a no-op. There is no second payment mechanism behind this second call site.
2. `ensureSignedToday` signs at most once per calendar day. Bootstrap (no channel with this
   seller yet) opens a channel sized to one day's charge, signs day 1, then tops up once to
   prepare tomorrow's ceiling. Every day after: sign today's cumulative charge, and top up to
   prepare tomorrow's ceiling once the current one is exhausted.
3. A gap with the toggle left on (the buyer's app was closed, or the daemon restarted) is caught
   up on the next tick, capped at 30 days of backlog — not carried forward indefinitely. The
   ceiling is raised (bounded, at most 5 preemptive top-ups per cycle) before signing, not after:
   signing first against an exhausted ceiling would silently clamp to zero and reset the
   elapsed-day clock without capturing the real backlog.

No new signature type and no new contract — every payment on this path is still a plain
`ReserveAuth`/`SpendingAuth` pair. Nothing about this is specific to model routing; any AntSeed
seller offering a flat recurring price can use this same mechanism.

We looked at moving this on-chain — a small `SubscriptionManager` contract with explicit
subscribe/unsubscribe state — and at EIP-3009 batch authorizations, reusing an already-audited
standard. Both are real options, but both add cost this doesn't need: a contract change and its
audit surface for the former, and a payment rail that sidesteps AntSeed's deposit/channel
accounting and fee capture entirely for the latter.
