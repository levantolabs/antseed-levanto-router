/**
 * Persists which day-pass price this buyer has actually agreed to, per
 * seller peer id -- `VprRoutingPreferences.agreedDayPassPricesUsdc`
 * (packages/node's ModelRoutingPreferences), read and written directly
 * against the raw config file rather than through `loadConfig`/`saveConfig`.
 * Those merge every other `buyer.routingPreferences` field through a
 * narrower, explicitly-enumerated shape (`mergeBuyerRoutingPreferences`)
 * that doesn't yet cover `selectedRouterPackage`/`autoRouting` -- a
 * load-then-save round trip through them would silently drop whatever a
 * desktop user (or this module) had written there. Reading and writing only
 * the one key this module owns, preserving everything else in the file
 * byte-for-byte, avoids that entirely -- the same reasoning
 * `apps/desktop/src/main/runtime/process-manager.ts`'s own raw
 * `readFileSync`/`JSON.parse` of this same file already applies to
 * `selectedRouterPackage`.
 *
 * This file's own state can be written concurrently by a completely
 * separate OS process (the desktop app's main process, via its own
 * `updateDashboardConfig` IPC handler, while a connect-mode buyer daemon is
 * already running). Reading fresh immediately before writing narrows that
 * race to the single read-modify-write below rather than eliminating it --
 * proportionate for a value that changes at most a few times ever, matching
 * every other piece of config handling in this codebase, none of which
 * takes a file lock either.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Mirrors config/loader.ts's own private resolveConfigPath (~ expansion, default path) -- not exported from there, so duplicated here rather than reworking that module's exports for one caller. */
function resolveConfigPath(configPath: string | undefined): string {
  if (!configPath || configPath.trim().length === 0) {
    return join(homedir(), '.antseed', 'config.json')
  }
  if (configPath.startsWith('~')) {
    return resolve(homedir(), configPath.slice(2))
  }
  return resolve(configPath)
}

async function readRawConfig(resolvedPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(resolvedPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

function readAgreedPricesMap(config: Record<string, unknown>): Record<string, number> {
  const buyer = config['buyer']
  if (!buyer || typeof buyer !== 'object') return {}
  const routingPreferences = (buyer as Record<string, unknown>)['routingPreferences']
  if (!routingPreferences || typeof routingPreferences !== 'object') return {}
  const prices = (routingPreferences as Record<string, unknown>)['agreedDayPassPricesUsdc']
  if (!prices || typeof prices !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [peerId, price] of Object.entries(prices as Record<string, unknown>)) {
    if (typeof price === 'number' && Number.isFinite(price) && price >= 0) out[peerId] = price
  }
  return out
}

/** Whole-USD agreed price for a seller peer id, or `null` if none has ever been recorded. */
export async function readAgreedDayPassPriceUsd(
  configPath: string | undefined,
  sellerPeerId: string,
): Promise<number | null> {
  const resolvedPath = resolveConfigPath(configPath)
  const config = await readRawConfig(resolvedPath)
  const prices = readAgreedPricesMap(config)
  return prices[sellerPeerId.toLowerCase()] ?? null
}

/**
 * Records the agreed price for one seller, preserving every other key in
 * the config file untouched (including any other seller's own agreed
 * price already in this same map).
 */
export async function writeAgreedDayPassPriceUsd(
  configPath: string | undefined,
  sellerPeerId: string,
  priceUsd: number,
): Promise<void> {
  const resolvedPath = resolveConfigPath(configPath)
  const config = await readRawConfig(resolvedPath)
  const buyer = (config['buyer'] && typeof config['buyer'] === 'object' ? config['buyer'] : {}) as Record<string, unknown>
  const routingPreferences = (buyer['routingPreferences'] && typeof buyer['routingPreferences'] === 'object'
    ? buyer['routingPreferences']
    : {}) as Record<string, unknown>
  const prices = readAgreedPricesMap(config)
  prices[sellerPeerId.toLowerCase()] = priceUsd

  const merged = {
    ...config,
    buyer: {
      ...buyer,
      routingPreferences: {
        ...routingPreferences,
        agreedDayPassPricesUsdc: prices,
      },
    },
  }
  await mkdir(dirname(resolvedPath), { recursive: true })
  await writeFile(resolvedPath, JSON.stringify(merged, null, 2), 'utf-8')
}

/** 6-decimal USDC base units -> whole USD, for comparing against/storing alongside the UI's own price display convention. */
export function usdcToUsd(baseUnits: bigint): number {
  return Number(baseUnits) / 1_000_000
}

/** Whole USD -> 6-decimal USDC base units, rounding to the nearest base unit. */
export function usdToUsdc(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000))
}
