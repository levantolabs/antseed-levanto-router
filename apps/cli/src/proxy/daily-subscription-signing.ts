/**
 * Host-side implementation of a `Router`'s `signDailyIfNeeded` callback
 * (model-routing decisions doc SS6.2/SS13 item 11) -- the routing plugin
 * never holds a BuyerPaymentManager or PaymentMux reference directly
 * (software-arch doc SS2.6: that would let plugin code, including
 * third-party routers per SSG3, sign arbitrary messages), so the host
 * builds and owns the actual signing closure and hands it to whichever
 * router requests one via the optional `Router.configureDailySigning`
 * capability.
 *
 * Handles three cases with a single real `BuyerPaymentManager`:
 *  - Bootstrap: no channel with this seller yet -- open one sized to
 *    exactly one day's charge (SS6.3), sign day 1, then top up once to
 *    prepare tomorrow's ceiling in advance (SS6.5's Day-1 row).
 *  - Ordinary day: sign today's cumulative; top up for tomorrow if the
 *    ceiling is now past its 65% trigger.
 *  - Reconnect after a toggle-on gap (SS6.7): the ceiling was never
 *    topped up while the buyer was away, so it's raised by exactly one
 *    day's worth (and reconciled from a real on-chain read) BEFORE
 *    signing -- signCumulativeAuth itself never grants more than one
 *    day per call regardless of how long the gap was (see its own doc
 *    comment), so however many days are actually owed get caught up one
 *    per cycle rather than all at once.
 */
import type { BuyerPaymentManager, ChannelsClient, FlatFeeSigningConfig, PaymentMux } from '@antseed/node'
import { log } from './request-utils.js'

/**
 * Bootstrap fires three PaymentMux SpendingAuth sends back-to-back with no
 * gap (authorizeSpending, then signCumulativeAuth's day-1 signature, then
 * topUpReserve's day-1 prepare-tomorrow top-up). sendSpendingAuth() is
 * fire-and-forget -- no ack is awaited -- and there is no seller->buyer
 * rejection signal on the wire at all (payment:auth-rejected is a
 * seller-local event only, per node.ts), so a corrupted/dropped frame here
 * fails silent: the seller later logs "Invalid ReserveAuth signature:
 * recovered=<garbage> expected=<real address>" and the buyer has no idea
 * anything went wrong until a later request 402s with "Not subscribed".
 * Reproduced live: three back-to-back sends over pure localhost never hit
 * this; the identical sequence over a higher-latency hop (observed: a
 * Windows client through WSL2's forwarded localhost) corrupted a signature
 * on the very first bootstrap. A short flush gap between sends is a real,
 * bounded mitigation for a one-time, per-seller operation -- not a fix for
 * whatever the underlying transport race actually is, which still needs a
 * real seller->buyer rejection signal and retry to be handled properly.
 */
async function flushGap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

export interface DailySubscriptionSigningOptions {
  /** e.g. 590_000n for $0.59/day (6-decimal USDC) -- decisions doc SS1. */
  dailyAmountUsdc: bigint
}

/**
 * The exact slice of `AntseedNode` this module actually uses -- narrower
 * than depending on the concrete class, so tests can supply a lightweight
 * object wrapping real `BuyerPaymentManager`/`ChannelsClient` instances
 * without needing a full P2P node stack. `AntseedNode` itself satisfies
 * this structurally; no adapter needed at the real call site.
 */
export interface DailySigningNode {
  readonly buyerPaymentManager: BuyerPaymentManager | null
  readonly channelsClient: ChannelsClient | null
  getOrConnectPaymentMux(peerId: string): Promise<PaymentMux>
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Bounds the preemptive top-up loop below (SS6.7's catch-up burst normally needs exactly one). */
const MAX_PREEMPTIVE_TOPUPS = 5
/**
 * Renew the reserve deadline once less than this much validity remains, not
 * only once it has already lapsed -- a real signing cycle (this function
 * plus its own async work) takes nonzero time, and the whole point is to
 * never let signCumulativeAuth produce a signature the seller can no longer
 * settle by the time it lands.
 */
const RESERVE_DEADLINE_RENEWAL_MARGIN_MS = 5 * 60 * 1000

/**
 * How long, and how often, to poll for a top-up's on-chain confirmation
 * before giving up for this cycle (see topUpAndReconcile's own doc comment
 * for why polling is necessary at all here). Mirrors the poll/timeout shape
 * of `BuyerPaymentNegotiator._waitForLockConfirmation` (same file's sibling
 * concern -- waiting for a seller-side on-chain action to land -- though
 * that one polls a local ack flag; this one has no ack to poll, so it polls
 * the chain directly).
 */
const TOPUP_POLL_INTERVAL_MS = 500
const TOPUP_CONFIRMATION_TIMEOUT_MS = 30_000

/**
 * Raise the reserve ceiling and resync the client's cached copy from a real
 * on-chain read. Unlike the initial reserve, a top-up gets no dedicated
 * wire acknowledgement at all -- confirmed by reading
 * `BuyerPaymentManager.handleAuthAck`'s own comment: "top-ups remain
 * pending until an on-chain session read observes their ceiling." So this
 * polls the real chain for the seller's `topUp()` to land before
 * reconciling; reading immediately after sending would very likely
 * observe the pre-top-up deposit and reconcile to a stale value, leaving
 * the client's cached ceiling exactly as wrong as if reconcile were never
 * called. A timeout without confirmation is not fatal -- the next signing
 * cycle sees the ceiling still exhausted and retries the whole sequence.
 */
async function topUpAndReconcile(
  node: DailySigningNode,
  sellerPeerId: string,
  incrementUsdc: bigint,
): Promise<void> {
  const buyer = node.buyerPaymentManager
  const channelsClient = node.channelsClient
  if (!buyer) return
  const session = buyer.getActiveSession(sellerPeerId)
  if (!session) return
  const ceilingBeforeTopUp = buyer.getReserveCeiling(sellerPeerId)

  const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)
  // The subscription's own daily amount, never BuyerPaymentManager's generic
  // per-request reserve default -- passing no increment here is the exact
  // bug that let the ceiling balloon by $1.00 per top-up instead of $0.59,
  // which is what made an over-large signCumulativeAuth call signable in
  // the first place. See buyer-payment-manager.ts's topUpReserve doc comment.
  await buyer.topUpReserve(sellerPeerId, paymentMux, incrementUsdc)

  if (!channelsClient) {
    log(`no channelsClient available -- cannot confirm or reconcile the top-up for ${sellerPeerId.slice(0, 12)}...`)
    return
  }
  const deadline = Date.now() + TOPUP_CONFIRMATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const onChain = await channelsClient.getSession(session.sessionId)
    if (onChain.deposit > ceilingBeforeTopUp) {
      await buyer.reconcileReserveAmount(sellerPeerId, onChain.deposit)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, TOPUP_POLL_INTERVAL_MS))
  }
  log(`top-up confirmation timed out for ${sellerPeerId.slice(0, 12)}... -- will retry on the next signing cycle`)
}

/**
 * Builds a `signDailyIfNeeded(sellerPeerId)` closure for a real running
 * buyer process. Generic across any router that needs subscription-style
 * daily signing, not specific to any one router package -- `node` is a real
 * `AntseedNode`, already started, with payments configured.
 */
export function createSignDailyIfNeeded(
  node: DailySigningNode,
  options: DailySubscriptionSigningOptions,
): (sellerPeerId: string) => Promise<void> {
  const flatFeeConfig: FlatFeeSigningConfig = {
    dailyAmountUsdc: options.dailyAmountUsdc,
  }

  return async function signDailyIfNeeded(sellerPeerId: string): Promise<void> {
    const buyer = node.buyerPaymentManager
    if (!buyer) {
      log('daily signing skipped: payments are not configured on this node')
      return
    }
    const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)

    let existingSession = buyer.getActiveSession(sellerPeerId)
    if (existingSession && node.channelsClient) {
      // The local store can say ACTIVE long after the channel was
      // cooperatively closed, settled, or timed out on-chain -- checked
      // before ever signing into it, or a dead channel gets signed into
      // forever with no self-heal (real bug found live: a settled channel
      // kept receiving fresh cumulative signatures on every retry).
      const onChainStatus = await buyer.reconcileOnChainChannelStatus(sellerPeerId, node.channelsClient, paymentMux)
      if (onChainStatus === 'retired') {
        log(`subscription channel with routing peer ${sellerPeerId.slice(0, 12)}... was closed on-chain -- retired locally, opening a fresh one`)
        existingSession = buyer.getActiveSession(sellerPeerId)
      }
    }
    if (!existingSession) {
      // Bootstrap (SS6.3, SS6.5): reserve exactly one day's charge, not
      // maxed at FIRST_SIGN_CAP -- settling 100% of a one-day deposit
      // clears the 85% top-up gate after a single day instead of two.
      log(`opening subscription channel with routing peer ${sellerPeerId.slice(0, 12)}...`)
      await buyer.authorizeSpending(sellerPeerId, paymentMux, 0n, options.dailyAmountUsdc)
      await flushGap()
      buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)
      const { payload } = await buyer.signCumulativeAuth(sellerPeerId, options.dailyAmountUsdc)
      paymentMux.sendSpendingAuth(payload)
      await flushGap()
      // Prepare tomorrow's ceiling now (SS6.5's Day-1 row) -- nothing more
      // is owed today, so this is a top-up only, not a second signature.
      await topUpAndReconcile(node, sellerPeerId, options.dailyAmountUsdc)
      return
    }

    buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)

    // Predict whether the upcoming sign would be ceiling-clamped below
    // what's genuinely owed, using the SAME elapsed-day math
    // signCumulativeAuth applies internally: session.updatedAt mirrors its
    // private _lastFlatFeeSignedAt (confirmed by reading
    // buyer-payment-manager.ts -- both are set together, unconditionally,
    // at the end of every successful signCumulativeAuth call). This can't
    // be decided from topUpNeeded (the POST-sign 65%-threshold flag)
    // instead: signing first, when the ceiling is already exhausted from a
    // prior gap, would still "succeed" as a same-tick no-op that silently
    // resets the elapsed-day clock without ever capturing that one day's
    // charge -- the ceiling needs raising BEFORE that one real sign, not
    // after.
    const currentCumulative = BigInt(existingSession.authMax || '0')
    // Purely informational -- logged below so a long real gap is visible,
    // but never used to size a target or an increment. signCumulativeAuth
    // itself now hard-caps a single call to at most one more day's charge
    // regardless of how many calendar days have actually elapsed (see its
    // own doc comment for the six-day-in-four-hours incident this closes),
    // so the preemptive top-up below only ever needs to cover one more day,
    // never a multi-day backlog.
    const daysSinceLastSign = Math.floor((Date.now() - existingSession.updatedAt) / MS_PER_DAY)
    const trueTarget = currentCumulative + options.dailyAmountUsdc

    let ceiling = buyer.getReserveCeiling(sellerPeerId)
    // The ceiling and the reserve's on-chain deadline are independent -- the
    // ceiling can be perfectly sufficient (no top-up ever triggered by the
    // check below) while the deadline covering it has quietly lapsed, since
    // nothing else refreshes the deadline for a channel with no other
    // per-request activity. signCumulativeAuth has no notion of this at all,
    // so left unchecked it "succeeds" locally while the seller can no longer
    // settle the result.
    let reserveDeadlineExpiring = typeof existingSession.deadline === 'number'
      && existingSession.deadline * 1000 <= Date.now() + RESERVE_DEADLINE_RENEWAL_MARGIN_MS
    let preemptiveTopUps = 0
    while ((trueTarget > ceiling || reserveDeadlineExpiring) && preemptiveTopUps < MAX_PREEMPTIVE_TOPUPS) {
      if (reserveDeadlineExpiring) {
        log(`reserve deadline for ${sellerPeerId.slice(0, 12)}... has lapsed or is about to -- renewing before signing`)
        await buyer.renewReserveDeadline(sellerPeerId, paymentMux)
        reserveDeadlineExpiring = false
      } else {
        log(`ceiling too low to cover one more day for ${sellerPeerId.slice(0, 12)}... (need ${trueTarget}, have ${ceiling}, ${daysSinceLastSign} day(s) since last sign) -- topping up before signing`)
        await topUpAndReconcile(node, sellerPeerId, options.dailyAmountUsdc)
      }
      ceiling = buyer.getReserveCeiling(sellerPeerId)
      preemptiveTopUps += 1
    }

    // Request exactly one more day than what's already on file --
    // signCumulativeAuth would clamp to this anyway even if asked for more
    // (see its own doc comment), but asking honestly for what's actually
    // wanted beats relying on a downstream clamp to hide a wrong request.
    const { payload, topUpNeeded } = await buyer.signCumulativeAuth(sellerPeerId, trueTarget)
    paymentMux.sendSpendingAuth(payload)
    log(`signed daily cumulative for ${sellerPeerId.slice(0, 12)}...: ${payload.cumulativeAmount}`)

    if (topUpNeeded) {
      // Prepare for next time -- not a re-sign; today's cumulative is
      // already on file above.
      await topUpAndReconcile(node, sellerPeerId, options.dailyAmountUsdc)
    }
  }
}

/** The exact slice of `Router` this scheduler needs -- narrower than importing the full interface. */
export interface DailySigningTrigger {
  triggerDailySigningCheck?(): Promise<void>
}

/**
 * Schedules a usage-independent daily-signing check (model-routing decisions
 * doc SS13 item 9): without this, signing only ever fires from inside
 * `selectRoute()`, so billing silently stops the moment the buyer stops
 * sending routable chat requests, even with the toggle still on. Fires once
 * immediately (so a buyer who opts in but never chats that day doesn't wait
 * a full interval for the first signature) and then on `intervalMs`. The
 * router's own `ensureSignedToday`-style bookkeeping (at most one real
 * signature per calendar day) means ticking more often than once a day is
 * free -- the interval only needs to notice a new calendar day within a
 * reasonable window, not fire at a precise instant.
 *
 * A failed check is caught and passed to `onError` -- swallowed, never
 * thrown -- a background tick must never crash the host process; the next
 * tick retries. Returns a cleanup function that stops the timer.
 */
export function scheduleDailySigningChecks(
  router: DailySigningTrigger,
  intervalMs: number,
  onError: (err: unknown) => void = () => {},
): () => void {
  const runCheck = (): void => {
    void router.triggerDailySigningCheck?.().catch(onError)
  }
  runCheck()
  const timer = setInterval(runCheck, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
