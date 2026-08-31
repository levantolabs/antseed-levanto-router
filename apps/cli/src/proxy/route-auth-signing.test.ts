import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Wallet } from 'ethers'
import { makeChannelsDomain, recoverRouteRequestAuthSigner } from '@antseed/node'
import type { Identity } from '@antseed/node'
import { createSignRouteAuth } from './route-auth-signing.js'

function createTestIdentity(): Identity {
  const privateKeyBytes = randomBytes(32)
  const privateKey = ('0x' + Buffer.from(privateKeyBytes).toString('hex')) as `0x${string}`
  const wallet = new Wallet(privateKey)
  const peerId = wallet.address.slice(2).toLowerCase()
  return { peerId, privateKey: privateKeyBytes, wallet } as unknown as Identity
}

const CHAIN_CONFIG = { evmChainId: 8453, channelsContractAddress: '0x' + 'ab'.repeat(20) }

test('createSignRouteAuth produces a signature that recovers to the identity\'s own address', async () => {
  const identity = createTestIdentity()
  const routingPeerId = 'bb'.repeat(20)
  const signRouteAuth = createSignRouteAuth(identity, CHAIN_CONFIG)

  const auth = await signRouteAuth(routingPeerId)

  assert.equal(auth.buyer, identity.wallet.address)
  const domain = makeChannelsDomain(CHAIN_CONFIG.evmChainId, CHAIN_CONFIG.channelsContractAddress)
  const recovered = recoverRouteRequestAuthSigner(domain, {
    buyer: auth.buyer,
    routingPeer: `0x${routingPeerId}`,
    issuedAt: BigInt(auth.issuedAt),
    nonce: auth.nonce,
  }, auth.signature)
  assert.equal(recovered, identity.wallet.address)
})

test('binds the signature to the specific routing peer -- it does not recover for a different one', async () => {
  const identity = createTestIdentity()
  const signRouteAuth = createSignRouteAuth(identity, CHAIN_CONFIG)
  const auth = await signRouteAuth('bb'.repeat(20))

  const domain = makeChannelsDomain(CHAIN_CONFIG.evmChainId, CHAIN_CONFIG.channelsContractAddress)
  const recoveredForWrongPeer = recoverRouteRequestAuthSigner(domain, {
    buyer: auth.buyer,
    routingPeer: `0x${'cc'.repeat(20)}`, // a different routing peer than the one signed for
    issuedAt: BigInt(auth.issuedAt),
    nonce: auth.nonce,
  }, auth.signature)
  assert.notEqual(recoveredForWrongPeer, identity.wallet.address)
})

test('issues a fresh nonce each call', async () => {
  const identity = createTestIdentity()
  const signRouteAuth = createSignRouteAuth(identity, CHAIN_CONFIG)
  const first = await signRouteAuth('bb'.repeat(20))
  const second = await signRouteAuth('bb'.repeat(20))
  assert.notEqual(first.nonce, second.nonce)
  assert.notEqual(first.signature, second.signature)
})
