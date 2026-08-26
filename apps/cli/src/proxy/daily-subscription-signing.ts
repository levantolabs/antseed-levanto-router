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
 *    topped up while the buyer was away, so it's raised (and reconciled
 *    from a real on-chain read) BEFORE signing -- signing first would
 *    silently reset the elapsed-day clock signCumulativeAuth relies on
 *    to compute the real backlog, without actually capturing more than a
 *    same-tick no-op would allow.
 */
import type { BuyerPaymentManager, ChannelsClient, FlatFeeSigningConfig, PaymentMux } from '@antseed/node'
import { log } from './request-utils.js'

export interface DailySubscriptionSigningOptions {
  /** e.g. 590_000n for $0.59/day (6-decimal USDC) -- decisions doc SS1. */
  dailyAmountUsdc: bigint
  /** Backlog cap for a toggle-on gap -- decisions doc SS6.7. */
  catchUpCapDays: number
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
): Promise<void> {
  const buyer = node.buyerPaymentManager
  const channelsClient = node.channelsClient
  if (!buyer) return
  const session = buyer.getActiveSession(sellerPeerId)
  if (!session) return
  const ceilingBeforeTopUp = buyer.getReserveCeiling(sellerPeerId)

  const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)
  await buyer.topUpReserve(sellerPeerId, paymentMux)

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
    catchUpCapDays: options.catchUpCapDays,
  }
  // A single call requesting "everything owed" -- signCumulativeAuth
  // internally clamps to what's actually allowed (real elapsed days,
  // catchUpCapDays, and the current ceiling), so the caller never computes
  // the real target itself (buyer-payment-manager.ts's own doc comment on
  // signCumulativeAuth: "a REQUEST, not a command").
  const requestEverything = options.dailyAmountUsdc * BigInt(options.catchUpCapDays)

  return async function signDailyIfNeeded(sellerPeerId: string): Promise<void> {
    const buyer = node.buyerPaymentManager
    if (!buyer) {
      log('daily signing skipped: payments are not configured on this node')
      return
    }
    const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)

    const existingSession = buyer.getActiveSession(sellerPeerId)
    if (!existingSession) {
      // Bootstrap (SS6.3, SS6.5): reserve exactly one day's charge, not
      // maxed at FIRST_SIGN_CAP -- settling 100% of a one-day deposit
      // clears the 85% top-up gate after a single day instead of two.
      log(`opening subscription channel with routing peer ${sellerPeerId.slice(0, 12)}...`)
      await buyer.authorizeSpending(sellerPeerId, paymentMux, 0n, options.dailyAmountUsdc)
      buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)
      const { payload } = await buyer.signCumulativeAuth(sellerPeerId, options.dailyAmountUsdc)
      paymentMux.sendSpendingAuth(payload)
      // Prepare tomorrow's ceiling now (SS6.5's Day-1 row) -- nothing more
      // is owed today, so this is a top-up only, not a second signature.
      await topUpAndReconcile(node, sellerPeerId)
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
    // resets the elapsed-day clock without ever capturing the real
    // backlog (see topUpAndReconcile's own doc comment) -- SS6.7's
    // catch-up burst needs the ceiling raised BEFORE that one real sign,
    // not after.
    const currentCumulative = BigInt(existingSession.authMax || '0')
    const daysSinceLastSign = Math.max(1, Math.ceil((Date.now() - existingSession.updatedAt) / MS_PER_DAY))
    const trueTarget = currentCumulative
      + options.dailyAmountUsdc * BigInt(Math.min(daysSinceLastSign, options.catchUpCapDays))

    let ceiling = buyer.getReserveCeiling(sellerPeerId)
    let preemptiveTopUps = 0
    while (trueTarget > ceiling && preemptiveTopUps < MAX_PREEMPTIVE_TOPUPS) {
      log(`ceiling too low to cover what's owed for ${sellerPeerId.slice(0, 12)}... (need ${trueTarget}, have ${ceiling}) -- topping up before signing (SS6.7 catch-up burst)`)
      await topUpAndReconcile(node, sellerPeerId)
      ceiling = buyer.getReserveCeiling(sellerPeerId)
      preemptiveTopUps += 1
    }

    const { payload, topUpNeeded } = await buyer.signCumulativeAuth(sellerPeerId, requestEverything)
    paymentMux.sendSpendingAuth(payload)
    log(`signed daily cumulative for ${sellerPeerId.slice(0, 12)}...: ${payload.cumulativeAmount}`)

    if (topUpNeeded) {
      // Prepare for next time -- not a re-sign; today's cumulative is
      // already on file above.
      await topUpAndReconcile(node, sellerPeerId)
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
