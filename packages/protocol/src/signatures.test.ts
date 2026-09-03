/**
 * Golden vectors pin the on-chain-facing encodings: a change to any of these
 * values breaks compatibility with deployed AntseedChannels contracts and
 * existing peers, so the constants below must never change.
 */

import { describe, it, expect } from 'vitest';
import { AbiCoder, Wallet, verifyTypedData } from 'ethers';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  ZERO_METADATA_HASH,
  CHARGE_TYPE_FLAT_SUBSCRIPTION,
  CHARGE_TYPE_METERED,
  computeChannelId,
  computeMetadataHash,
  encodeMetadata,
  getServiceMetadataId,
  makeChannelsDomain,
  signSpendingAuth,
  signReserveAuth,
  signRouteRequestAuth,
  recoverRouteRequestAuthSigner,
} from './signatures.js';
import { buildConnectionAuthPayload } from './connection-auth.js';
import { signUtf8, verifyUtf8 } from './signing.js';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SELLER = '0x00000000000000000000000000000000000000A1';
const SALT = '0x' + 'ab'.repeat(32);

describe('EIP-712 golden vectors', () => {
  it('pins ZERO_METADATA_HASH', () => {
    // Updated for metadata v4 (chargeType field, appended after
    // cumulativeOutputImages -- see SpendingAuthMetadata's own doc comment
    // for why that position, not v3's, is the safe one). A deliberate
    // version bump, not drift: pin the new value.
    expect(ZERO_METADATA_HASH).toBe('0x571239954c4c9f5d484149eb7ac3ef41646e613374f55d4ca7ace6cb3e115a9d');
  });

  it('pins channelId derivation', () => {
    expect(computeChannelId(wallet.address, SELLER, SALT)).toBe(
      '0x550a5ddb8b12b28ae000a2d110e0ca0fdeac598034bb7dbaa9189a6c82aae71f',
    );
  });

  it('pins serviceId and metadata hashing', () => {
    expect(getServiceMetadataId('claude-sonnet-5')).toBe(
      '0x2bb26595b5228906bc14e673f9ac6900b2c95af3f70aaba08846209e4db9ed9a',
    );
    const metadata = {
      cumulativeInputTokens: 1234n,
      cumulativeOutputTokens: 567n,
      cumulativeRequestCount: 3n,
      services: [],
    };
    expect(computeMetadataHash(metadata)).toBe(
      '0x2ac526507f7691a1575dce0a3cfd9d746a605dd650eb51996550143359895702',
    );
    // Omitted cumulativeOutputImages encodes identically to an explicit zero.
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 0n })).toBe(
      computeMetadataHash(metadata),
    );
    expect(computeMetadataHash({ ...metadata, cumulativeOutputImages: 2n })).not.toBe(
      computeMetadataHash(metadata),
    );
    // Sorted service entries change the hash deterministically.
    const withService = {
      ...metadata,
      services: [{
        serviceId: getServiceMetadataId('claude-sonnet-5'),
        cumulativeAmount: 4200n,
        cumulativeInputTokens: 1234n,
        cumulativeCachedInputTokens: 100n,
        cumulativeOutputTokens: 567n,
        cumulativeRequestCount: 3n,
        cumulativeOutputImages: 2n,
      }],
    };
    expect(encodeMetadata(withService)).not.toBe(encodeMetadata(metadata));
  });

  it('defaults chargeType to metered, and a flat-subscription charge hashes differently', () => {
    const base = { cumulativeInputTokens: 0n, cumulativeOutputTokens: 0n, cumulativeRequestCount: 0n, services: [] };
    expect(computeMetadataHash(base)).toBe(computeMetadataHash({ ...base, chargeType: CHARGE_TYPE_METERED }));
    expect(computeMetadataHash({ ...base, chargeType: CHARGE_TYPE_FLAT_SUBSCRIPTION })).not.toBe(
      computeMetadataHash(base),
    );
  });

  it('never disturbs the legacy 4-word prefix a fixed on-chain decoder reads -- regression guard for the real load-bearing constraint chargeType\'s placement depends on', () => {
    // AntseedStats.sol's _decodeMetadata does a fixed, non-version-aware
    // abi.decode(metadata, (uint256,uint256,uint256,uint256)) -- it reads
    // exactly the first 128 bytes of the head and ignores everything after,
    // regardless of what comes later (dynamic types included, chargeType
    // and services[] both). Any field ever added after cumulativeOutputImages
    // must keep passing this exact check.
    const metadata = {
      cumulativeInputTokens: 111n,
      cumulativeOutputTokens: 222n,
      cumulativeRequestCount: 3n,
      cumulativeOutputImages: 4n,
      chargeType: CHARGE_TYPE_FLAT_SUBSCRIPTION,
      services: [{
        serviceId: getServiceMetadataId('levanto-router-day-pass'),
        cumulativeAmount: 890_000n,
        cumulativeInputTokens: 0n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 0n,
        cumulativeRequestCount: 0n,
        cumulativeOutputImages: 0n,
      }],
    };
    const encoded = encodeMetadata(metadata);
    const [version, inputTokens, outputTokens, requestCount] = AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'uint256', 'uint256', 'uint256'],
      encoded,
    );
    expect(version).toBe(4n);
    expect(inputTokens).toBe(111n);
    expect(outputTokens).toBe(222n);
    expect(requestCount).toBe(3n);
  });

  it('produces recoverable SpendingAuth and ReserveAuth signatures', async () => {
    const channelId = computeChannelId(wallet.address, SELLER, SALT);
    const domain = makeChannelsDomain(8453, '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d');

    const spending = { channelId, cumulativeAmount: 123456n, metadataHash: ZERO_METADATA_HASH };
    const spendingSig = await signSpendingAuth(wallet, domain, spending);
    expect(verifyTypedData(domain, SPENDING_AUTH_TYPES, spending, spendingSig)).toBe(wallet.address);

    const reserve = { channelId, maxAmount: 1_000_000n, deadline: 1900000000n };
    const reserveSig = await signReserveAuth(wallet, domain, reserve);
    expect(verifyTypedData(domain, RESERVE_AUTH_TYPES, reserve, reserveSig)).toBe(wallet.address);
  });
});

describe('RouteRequestAuth (buyer identity proof for /_antseed/route)', () => {
  const domain = makeChannelsDomain(8453, '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d');
  const routingPeer = '0x' + 'aa'.repeat(20);

  it('signs and recovers to the signer address', async () => {
    const msg = {
      buyer: wallet.address,
      routingPeer,
      issuedAt: 1900000000n,
      nonce: '0x' + '11'.repeat(32),
    };
    const sig = await signRouteRequestAuth(wallet, domain, msg);
    expect(recoverRouteRequestAuthSigner(domain, msg, sig)).toBe(wallet.address);
  });

  it('recovers a different address for a tampered field (routingPeer swapped)', async () => {
    const msg = {
      buyer: wallet.address,
      routingPeer,
      issuedAt: 1900000000n,
      nonce: '0x' + '22'.repeat(32),
    };
    const sig = await signRouteRequestAuth(wallet, domain, msg);
    const tampered = { ...msg, routingPeer: '0x' + 'bb'.repeat(20) };
    expect(recoverRouteRequestAuthSigner(domain, tampered, sig)).not.toBe(wallet.address);
  });

  it('recovers a different address under a different domain (chain-scoped, not replayable across chains)', async () => {
    const msg = {
      buyer: wallet.address,
      routingPeer,
      issuedAt: 1900000000n,
      nonce: '0x' + '33'.repeat(32),
    };
    const sig = await signRouteRequestAuth(wallet, domain, msg);
    const otherChainDomain = makeChannelsDomain(1, '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d');
    expect(recoverRouteRequestAuthSigner(otherChainDomain, msg, sig)).not.toBe(wallet.address);
  });
});

describe('connection auth signing', () => {
  it('pins the EIP-191 domain-tagged signature', () => {
    expect(signUtf8(wallet, 'hello|abcd|1|00')).toBe(
      'b8de0027c2c06ce84be01846ada3b3ad3efffe2d6d18b3654844d04306404e2b1ec26b922c187a2e3a05d9795ead163ae7dfbfd213bcba3b9d69343897a99dd41b',
    );
  });

  it('round-trips the hello envelope payload', () => {
    const peerId = wallet.address.slice(2).toLowerCase();
    const payload = buildConnectionAuthPayload('hello', peerId, 1754000000000, '00'.repeat(16));
    expect(payload).toBe(`hello|${peerId}|1754000000000|${'00'.repeat(16)}`);
    const sig = signUtf8(wallet, payload);
    expect(verifyUtf8(peerId, payload, sig)).toBe(true);
    expect(verifyUtf8(peerId, payload + 'tampered', sig)).toBe(false);
  });
});
