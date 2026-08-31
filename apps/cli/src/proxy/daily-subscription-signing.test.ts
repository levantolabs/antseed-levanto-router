import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Wallet } from 'ethers'
import { BuyerPaymentManager, ChannelStore } from '@antseed/node'
import type { BuyerPaymentConfig, ChannelsClient, Identity, PaymentMux, SpendingAuthPayload } from '@antseed/node'
import { createSignDailyIfNeeded, scheduleDailySigningChecks, type DailySigningNode } from './daily-subscription-signing.js'

/**
 * Real BuyerPaymentManager throughout -- all the clamping/elapsed-day/
 * ceiling logic under test is genuine, not mocked. Only the network-facing
 * edges are faked: an unreachable RPC URL (getBalance()/deposit checks
 * degrade to a logged warning, confirmed by reading topUpReserve's own
 * try/catch -- never blocks), a scripted PaymentMux that just records what
 * was sent instead of transmitting it, and a scripted ChannelsClient whose
 * getSession() reports a controlled "on-chain deposit" this test drives
 * directly, standing in for a real seller's topUp()/reserve() landing.
 */

const DAILY_AMOUNT = 10_000n // matches other test suites' convention
const CATCH_UP_CAP_DAYS = 30
const SELLER_PEER_ID = 'cc'.repeat(20)
const DAY_MS = 24 * 60 * 60 * 1000

function createTestIdentity(): Identity {
  const privateKeyBytes = randomBytes(32)
  const privateKey = ('0x' + Buffer.from(privateKeyBytes).toString('hex')) as `0x${string}`
  const wallet = new Wallet(privateKey)
  const peerId = wallet.address.slice(2).toLowerCase()
  return { peerId, privateKey: privateKeyBytes, wallet } as unknown as Identity
}

function makeBuyerConfig(dataDir: string, maxReserveAmountUsdc: bigint): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1', // deliberately unreachable -- see file header comment
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: '0x' + 'cc'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 500_000n,
    maxReserveAmountUsdc,
    dataDir,
  }
}

/** Records every SpendingAuth sent -- the only PaymentMux method this module calls. */
function createRecordingMux(): PaymentMux & { sent: SpendingAuthPayload[] } {
  const sent: SpendingAuthPayload[] = []
  const mux = {
    sent,
    sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload) },
  }
  return mux as unknown as PaymentMux & { sent: SpendingAuthPayload[] }
}

/**
 * Scripted on-chain deposit, standing in for a real seller's reserve()/
 * topUp() landing. `bumpTo` simulates the seller's transaction confirming;
 * `bumpAfterOneRead` simulates a real confirmation delay (one poll cycle)
 * to prove topUpAndReconcile's polling retry actually retries.
 */
function createScriptedChannelsClient(initialDeposit: bigint) {
  let deposit = initialDeposit
  let pendingBump: bigint | null = null
  let readsSincePendingBump = 0
  // status 1 = ACTIVE (classifyOnChainChannel) -- a genuinely existing,
  // active on-chain channel by default, since reconcileOnChainChannelStatus
  // now consults this on every signDailyIfNeeded call. buyer/seller must be
  // real-looking (non-zero-address) too, or classifyOnChainChannel reads the
  // channel as not existing at all regardless of `status`.
  let status = 1
  const client = {
    getSession: async (_id: string) => {
      if (pendingBump !== null) {
        readsSincePendingBump += 1
        if (readsSincePendingBump > 1) {
          deposit = pendingBump
          pendingBump = null
        }
      }
      return {
        buyer: '0x' + '11'.repeat(20),
        seller: '0x' + '22'.repeat(20),
        deposit,
        settled: 0n,
        metadataHash: '0x0',
        deadline: 0n,
        settledAt: 0n,
        closeRequestedAt: 0n,
        status,
      }
    },
  }
  return {
    client: client as unknown as ChannelsClient,
    bumpTo: (value: bigint) => { deposit = value },
    bumpAfterOneRead: (value: bigint) => { pendingBump = value; readsSincePendingBump = 0 },
    /** Simulate the channel being cooperatively/seller closed on-chain (status 2 = SETTLED). */
    settleOnChain: () => { status = 2 },
  }
}

async function withBuyer(
  maxReserveAmountUsdc: bigint,
  fn: (ctx: { buyer: BuyerPaymentManager; store: ChannelStore; identity: Identity }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-daily-signing-'))
  const store = new ChannelStore(dir)
  const identity = createTestIdentity()
  const buyer = new BuyerPaymentManager(identity, makeBuyerConfig(dir, maxReserveAmountUsdc), store)
  buyer.setSigner(identity.wallet)
  try {
    await fn({ buyer, store, identity })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('bootstrap: opens a channel sized to exactly one day, signs day 1, and tops up once to prepare tomorrow', async () => {
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: DailySigningNode = {
      buyerPaymentManager: buyer,
      channelsClient: scripted.client,
      getOrConnectPaymentMux: async () => mux,
    }
    // Bump the scripted deposit generously so the poll inside
    // topUpAndReconcile confirms on its first read, keeping this test fast
    // and focused on the sign/top-up sequencing rather than the polling
    // mechanics (covered separately below).
    scripted.bumpTo(DAILY_AMOUNT * 10n)

    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })
    await signDailyIfNeeded(SELLER_PEER_ID)

    // Three distinct SpendingAuth-shaped messages, all legitimate:
    // authorizeSpending's own zero-cumulative "reserve proof", the real
    // day-1 signature, and topUpReserve's reserve-fields-carrying message
    // preparing tomorrow's ceiling.
    assert.equal(mux.sent.length, 3)
    assert.equal(BigInt(mux.sent[0]!.cumulativeAmount), 0n, 'reserve proof')
    assert.equal(BigInt(mux.sent[1]!.cumulativeAmount), DAILY_AMOUNT, 'day 1 real signature')
    assert.ok(mux.sent[2]!.reserveMaxAmount, 'the top-up carries reserve fields')

    const session = buyer.getActiveSession(SELLER_PEER_ID)
    assert.ok(session, 'a session now exists')
    assert.equal(BigInt(session!.authMax), DAILY_AMOUNT)
    // The reserve step (authorizeSpending) opened the channel sized to
    // exactly one day (decisions doc SS6.3), not the buyer-wide default --
    // asserted directly against what was actually sent (sent[0].reserveMaxAmount)
    // rather than session.initialReserveAmount, which this test found does
    // not round-trip through ChannelStore the way its own field doc implies
    // (a pre-existing BuyerPaymentManager/ChannelStore behavior, out of
    // scope for this module -- logged in the runlog).
    assert.equal(mux.sent[0]!.reserveMaxAmount, DAILY_AMOUNT.toString())
  })
})

test('ordinary day: signs exactly one more day\'s increment, no top-up when there is comfortable headroom', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap + day 1
    const afterDay1 = mux.sent.length

    // Real elapsed time, not just an immediate second call -- BuyerPaymentManager
    // computes signCumulativeAuth's elapsed-day window from its own private
    // _lastFlatFeeSignedAt map (wall-clock Date.now(), not anything this
    // module can read or mutate directly), so genuinely advancing the fake
    // clock is the only correct way to simulate "a day later."
    t.mock.timers.tick(DAY_MS)

    await signDailyIfNeeded(SELLER_PEER_ID)

    const newAuths = mux.sent.slice(afterDay1)
    // A full day is well past this test's defaultAuthDurationSecs (3600s),
    // so the reserve deadline has genuinely lapsed by "the next day" even
    // though the ceiling itself has comfortable headroom -- the renewal
    // this now correctly triggers is a second, legitimate message
    // alongside the real day-2 sign, not a bug.
    const renewals = newAuths.filter((a) => a.reserveMaxAmount)
    const realSigns = newAuths.filter((a) => !a.reserveMaxAmount)
    assert.equal(renewals.length, 1, 'the lapsed reserve deadline is renewed once')
    assert.equal(realSigns.length, 1, 'ordinary day signs exactly once, no extra ceiling top-up round')
    assert.equal(BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT * 2n, 'exactly one more day, not a bonus day from calling twice')
  })
})

test('repeated same-day calls never ratchet authMax up, even across many retries with zero real usage', async (t) => {
  // Regression for a real bug found live on mainnet: a channel with
  // request_count=0/tokens_delivered=0 throughout (nothing ever actually
  // served) reached an $11.21 authMax purely from ~20 retries of
  // signDailyIfNeeded within about 30 minutes -- each retry's Math.max(1, ...)
  // elapsed-day floor let it grant itself another full day's increment on
  // top of the last, regardless of how little real time had passed. Root
  // cause and full narrative: buyer-payment-manager.ts's signCumulativeAuth.
  t.mock.timers.enable({ apis: ['Date'] })
  // Generous headroom (matches the "ordinary day" test above), and a scripted
  // deposit already at that headroom -- the point of this test is the
  // elapsed-day math, not top-up polling, so nothing here should ever need a
  // real top-up (real setTimeout is NOT mocked; only Date is).
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 10n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap + day 1
    const afterDay1 = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(BigInt(afterDay1.authMax), DAILY_AMOUNT)

    // No clock advance between calls -- the exact shape of the live failure:
    // many retries in quick succession, no real elapsed time, no usage.
    for (let i = 0; i < 20; i++) {
      await signDailyIfNeeded(SELLER_PEER_ID)
    }

    const finalSession = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(
      BigInt(finalSession.authMax), DAILY_AMOUNT,
      'authMax must not grow beyond one real day\'s worth no matter how many times this is retried on the same day',
    )
  })
})

test('catch-up: a multi-day gap tops up before signing, then captures the full backlog in one signature', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  // A tight top-up step (equal to one day) deliberately forces the ceiling
  // to be exhausted by a real multi-day gap, exercising the preemptive
  // top-up-before-sign path -- decisions doc SS6.7.
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    // Bootstrap's own top-up raises the ceiling to 2x daily (one
    // maxReserveAmountUsdc step) -- keep that step's confirmation instant,
    // then deliberately DON'T give any more headroom, so the 9-day gap
    // below genuinely exhausts it and the preemptive top-up path has to fire.
    scripted.bumpTo(DAILY_AMOUNT * 2n)
    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap + day 1 + prepare-tomorrow top-up
    const ceilingAfterDay1 = buyer.getReserveCeiling(SELLER_PEER_ID)
    assert.equal(ceilingAfterDay1, DAILY_AMOUNT * 2n, 'day 1\'s own top-up raised the ceiling by exactly one step')

    // App closed for 9 more days -- toggle never switched off, nothing signed.
    t.mock.timers.tick(9 * DAY_MS)
    // Now let the scripted chain reflect whatever the preemptive top-up(s)
    // below raise the ceiling to, confirmed instantly each time.
    scripted.bumpTo(DAILY_AMOUNT * 100n)

    const beforeCatchUp = mux.sent.length
    await signDailyIfNeeded(SELLER_PEER_ID)
    const catchUpAuths = mux.sent.slice(beforeCatchUp)

    // Exactly one SpendingAuth carrying the real cumulative for the whole
    // backlog -- any preemptive top-up(s) sent alongside it carry reserve
    // fields, not a competing cumulative claim.
    const realSigns = catchUpAuths.filter((a) => !a.reserveMaxAmount)
    assert.equal(realSigns.length, 1, 'the backlog is captured in a single real signature, not split or duplicated')
    assert.equal(BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT * 10n, 'day 1 + 9 missed days = 10 total, independently bounded by real elapsed time')
  })
})

test('on-chain settlement: a channel closed on-chain (local store still says active) is retired and re-bootstrapped', async () => {
  // Regression for a real bug found live: signDailyIfNeeded only ever
  // consulted the LOCAL store (getActiveSession), which still says ACTIVE
  // long after the channel was cooperatively closed on-chain -- it kept
  // signing fresh cumulative amounts into a dead channel forever, with no
  // self-heal, no matter how many retries.
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap + day 1
    const firstSessionId = buyer.getActiveSession(SELLER_PEER_ID)!.sessionId
    const sentBeforeClose = mux.sent.length

    // The seller settles/closes the channel on-chain (cooperative close,
    // seller-side close, or timeout) -- the local store still says ACTIVE
    // until the next on-chain reconcile notices.
    scripted.settleOnChain()

    await signDailyIfNeeded(SELLER_PEER_ID)

    const session = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.notEqual(session.sessionId, firstSessionId, 'a fresh channel was bootstrapped, not the dead one reused')
    assert.equal(BigInt(session.authMax), DAILY_AMOUNT, 'the fresh channel starts at exactly one day, like any ordinary bootstrap')

    const newMessages = mux.sent.slice(sentBeforeClose)
    assert.ok(newMessages.length > 0, 'the rebootstrap actually sent something, not a silent no-op that leaves the buyer stuck')
    assert.equal(BigInt(newMessages[0]!.cumulativeAmount), 0n, 'the rebootstrap starts with a fresh reserve proof, like any ordinary bootstrap')
  })
})

test('reserve deadline renewal: an expired deadline with a healthy ceiling renews before signing, without re-charging the already-signed day', async (t) => {
  // Regression for a real bug found live on mainnet: the reserve ceiling and
  // its on-chain deadline are independent, and only the ceiling was checked
  // before signing. A channel with comfortable ceiling headroom but a
  // lapsed deadline never got the deadline refreshed at all -- signCumulativeAuth
  // has no notion of the reserve deadline, so it "succeeded" locally while
  // the seller could no longer settle the result. This must renew the
  // reserve WITHOUT re-charging the day that was already correctly signed.
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap + day 1
    const sentAfterDay1 = mux.sent.length
    assert.equal(BigInt(buyer.getActiveSession(SELLER_PEER_ID)!.authMax), DAILY_AMOUNT)
    const ceilingAfterDay1 = buyer.getReserveCeiling(SELLER_PEER_ID)

    // Past the reserve's defaultAuthDurationSecs (3600s in this test config)
    // but nowhere near a full day -- the ceiling has 5x headroom, so the
    // pre-existing ceiling-only check would never trigger anything here.
    t.mock.timers.tick(2 * 60 * 60 * 1000) // 2 hours
    const sessionWithLapsedDeadline = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.ok(
      sessionWithLapsedDeadline.deadline * 1000 <= Date.now(),
      'sanity: the reserve deadline has genuinely lapsed by now',
    )

    await signDailyIfNeeded(SELLER_PEER_ID)

    const newMessages = mux.sent.slice(sentAfterDay1)
    const renewalMessages = newMessages.filter((m) => m.reserveMaxAmount)
    const realSigns = newMessages.filter((m) => !m.reserveMaxAmount)

    assert.equal(renewalMessages.length, 1, 'exactly one reserve renewal went out')
    assert.equal(
      renewalMessages[0]!.reserveMaxAmount, ceilingAfterDay1.toString(),
      'the renewal keeps the ceiling unchanged -- only the deadline moves, this is not a top-up',
    )

    assert.equal(realSigns.length, 1, 'signCumulativeAuth still runs exactly once')
    assert.equal(
      BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT,
      'still exactly one day\'s worth -- renewing the reserve must not re-charge or double-count the day already signed',
    )

    assert.ok(
      buyer.getActiveSession(SELLER_PEER_ID)!.deadline * 1000 > Date.now(),
      'the deadline is valid again after renewal',
    )
  })
})

test('topUpAndReconcile genuinely waits for on-chain confirmation before reconciling (does not reconcile to a stale deposit)', async () => {
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: DailySigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignDailyIfNeeded(node, { dailyAmountUsdc: DAILY_AMOUNT, catchUpCapDays: CATCH_UP_CAP_DAYS })

    // The first getSession() read during bootstrap's own top-up will see
    // the OLD deposit (bumpAfterOneRead delays the raise by one read) --
    // proving the poll loop retries rather than reconciling prematurely.
    scripted.bumpAfterOneRead(DAILY_AMOUNT * 2n)

    await signDailyIfNeeded(SELLER_PEER_ID)

    const ceiling = buyer.getReserveCeiling(SELLER_PEER_ID)
    assert.ok(ceiling > DAILY_AMOUNT, 'ceiling was raised only after the polled read observed the real increase')
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('scheduleDailySigningChecks fires once immediately, without waiting for the first interval tick', async () => {
  let calls = 0
  const stop = scheduleDailySigningChecks({ triggerDailySigningCheck: async () => { calls += 1 } }, 60_000)
  try {
    await sleep(10)
    assert.equal(calls, 1)
  } finally {
    stop()
  }
})

test('scheduleDailySigningChecks fires again on the interval', async () => {
  let calls = 0
  const stop = scheduleDailySigningChecks({ triggerDailySigningCheck: async () => { calls += 1 } }, 20)
  try {
    await sleep(70) // immediate + a few 20ms ticks
    assert.ok(calls >= 3, `expected at least 3 calls, got ${calls}`)
  } finally {
    stop()
  }
})

test('scheduleDailySigningChecks stops ticking once its cleanup function is called', async () => {
  let calls = 0
  const stop = scheduleDailySigningChecks({ triggerDailySigningCheck: async () => { calls += 1 } }, 15)
  await sleep(40)
  stop()
  const callsAtStop = calls
  await sleep(60)
  assert.equal(calls, callsAtStop, 'no further ticks after stop()')
})

test('scheduleDailySigningChecks passes a failed check to onError instead of throwing (a background tick must never crash the process)', async () => {
  const errors: unknown[] = []
  const stop = scheduleDailySigningChecks(
    { triggerDailySigningCheck: async () => { throw new Error('signing failed') } },
    60_000,
    (err) => errors.push(err),
  )
  try {
    await sleep(10)
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof Error && errors[0].message === 'signing failed')
  } finally {
    stop()
  }
})

test('scheduleDailySigningChecks is a safe no-op for a router that does not implement triggerDailySigningCheck', async () => {
  const stop = scheduleDailySigningChecks({}, 60_000)
  await sleep(10)
  stop() // must not throw
})
