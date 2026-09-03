/**
 * Host-side implementation of a `Router`'s `configureRouteAuthSigning`
 * callback (model-routing decisions doc SS13 item 8, previously
 * unresolved) -- the routing plugin never holds a signing key directly
 * (software-arch doc SS2.6: that would let plugin code, including
 * third-party routers, sign arbitrary messages), so the host builds the
 * actual signing closure from the buyer's real `Identity` and hands it to
 * whichever router requests one.
 *
 * Deliberately independent of payments being configured: proving "this
 * request really comes from PeerId X" is useful to any router (rate
 * limiting, abuse handling, a future non-day-pass pricing model), not
 * just a day-pass-priced one, and the buyer's P2P `Identity` (and its
 * wallet) exists before payments are ever set up.
 */
import {
  makeChannelsDomain,
  signRouteRequestAuth,
  type Identity,
  type RouteAuthHeaders,
} from '@antseed/node'
import { hexlify, randomBytes } from 'ethers'

export interface RouteAuthSigningChainConfig {
  evmChainId: number
  channelsContractAddress: string
}

/**
 * Builds a `signRouteAuth(routingPeerId)` closure for a real buyer
 * `Identity`. `routingPeer`'s address is derived from its PeerId directly
 * (`'0x' + routingPeerId`) -- PeerId IS the EVM address
 * (`@antseed/protocol`'s peer-id.ts), no lookup needed. Reuses the same
 * EIP-712 domain as ReserveAuth/SpendingAuth (`makeChannelsDomain`) purely
 * for its existing, audited typed-data shape and chain-scoped domain
 * separation -- this signature is never submitted on-chain.
 */
export function createSignRouteAuth(
  identity: Identity,
  chainConfig: RouteAuthSigningChainConfig,
): (routingPeerId: string) => Promise<RouteAuthHeaders> {
  const domain = makeChannelsDomain(chainConfig.evmChainId, chainConfig.channelsContractAddress)
  return async (routingPeerId: string): Promise<RouteAuthHeaders> => {
    const issuedAt = BigInt(Math.floor(Date.now() / 1000))
    const nonce = hexlify(randomBytes(32))
    const buyer = identity.wallet.address
    const signature = await signRouteRequestAuth(identity.wallet, domain, {
      buyer,
      routingPeer: `0x${routingPeerId}`,
      issuedAt,
      nonce,
    })
    return { buyer, issuedAt: Number(issuedAt), nonce, signature }
  }
}
