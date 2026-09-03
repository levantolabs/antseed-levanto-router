import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readAgreedDayPassPriceUsd,
  writeAgreedDayPassPriceUsd,
  usdToUsdc,
  usdcToUsd,
} from './day-pass-consent.js'

const SELLER_PEER_ID = 'cc'.repeat(20)

async function withConfigDir(fn: (configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-day-pass-consent-'))
  const configPath = join(dir, 'config.json')
  try {
    await fn(configPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('reads null when no config file exists yet', async () => {
  await withConfigDir(async (configPath) => {
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), null)
  })
})

test('reads null when the file exists but has no agreed price for this seller', async () => {
  await withConfigDir(async (configPath) => {
    await writeFile(configPath, JSON.stringify({ buyer: { routingPreferences: {} } }))
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), null)
  })
})

test('writes and reads back the agreed price for a seller', async () => {
  await withConfigDir(async (configPath) => {
    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID, 0.89)
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), 0.89)
  })
})

test('lower-cases the stored seller peer id key so reads match regardless of caller casing', async () => {
  await withConfigDir(async (configPath) => {
    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID.toUpperCase(), 1.2)
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), 1.2)
  })
})

test('preserves every other key in the config file untouched', async () => {
  await withConfigDir(async (configPath) => {
    await writeFile(configPath, JSON.stringify({
      identity: { name: 'test-buyer' },
      payments: { crypto: { chainId: 'base-mainnet' } },
      buyer: {
        maxPricing: { defaults: { inputUsdPerMillion: 25 } },
        routingPreferences: { autoDayPassEnabled: true, selectedRouterPackage: '@antseed/router-levanto' },
      },
    }))

    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID, 0.89)

    const raw = JSON.parse(await readFile(configPath, 'utf-8'))
    assert.deepEqual(raw.identity, { name: 'test-buyer' })
    assert.deepEqual(raw.payments, { crypto: { chainId: 'base-mainnet' } })
    assert.deepEqual(raw.buyer.maxPricing, { defaults: { inputUsdPerMillion: 25 } })
    assert.equal(raw.buyer.routingPreferences.autoDayPassEnabled, true)
    assert.equal(raw.buyer.routingPreferences.selectedRouterPackage, '@antseed/router-levanto')
    assert.equal(raw.buyer.routingPreferences.agreedDayPassPricesUsdc[SELLER_PEER_ID], 0.89)
  })
})

test('preserves a different seller\'s own agreed price already on file', async () => {
  await withConfigDir(async (configPath) => {
    const otherSeller = 'dd'.repeat(20)
    await writeAgreedDayPassPriceUsd(configPath, otherSeller, 1.5)
    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID, 0.89)

    assert.equal(await readAgreedDayPassPriceUsd(configPath, otherSeller), 1.5)
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), 0.89)
  })
})

test('overwrites a stale agreed price for the same seller, not appends', async () => {
  await withConfigDir(async (configPath) => {
    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID, 0.89)
    await writeAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID, 1.2)
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), 1.2)
  })
})

test('ignores a malformed agreedDayPassPricesUsdc value instead of throwing', async () => {
  await withConfigDir(async (configPath) => {
    await writeFile(configPath, JSON.stringify({
      buyer: { routingPreferences: { agreedDayPassPricesUsdc: 'not-an-object' } },
    }))
    assert.equal(await readAgreedDayPassPriceUsd(configPath, SELLER_PEER_ID), null)
  })
})

test('usdToUsdc / usdcToUsd round-trip whole-USD prices through 6-decimal USDC base units', () => {
  assert.equal(usdToUsdc(0.89), 890_000n)
  assert.equal(usdcToUsd(890_000n), 0.89)
  assert.equal(usdToUsdc(1.2), 1_200_000n)
  assert.equal(usdcToUsd(usdToUsdc(2.5)), 2.5)
})
