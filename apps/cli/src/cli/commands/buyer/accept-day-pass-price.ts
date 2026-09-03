import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { readAgreedDayPassPriceUsd, writeAgreedDayPassPriceUsd } from '../../../proxy/day-pass-consent.js'

const SELLER_PEER_ID_PATTERN = /^(0x)?[0-9a-f]{40}$/i

/**
 * `antseed buyer accept-day-pass-price <sellerPeerId> <priceUsd>` -- the
 * bare-CLI counterpart of desktop's router info dialog. A running
 * `buyer start` daemon reads the agreed price fresh on every day-pass
 * signing cycle (day-pass-signing.ts), so this takes effect on its very
 * next cycle for that seller -- no restart needed.
 */
export function registerBuyerAcceptDayPassPriceCommand(buyerCmd: Command): void {
  buyerCmd
    .command('accept-day-pass-price')
    .description('Accept a router\'s current day-pass price so signing is no longer capped at a lower, previously-agreed price')
    .argument('<sellerPeerId>', 'the routing peer\'s P2P peer id (40-char hex)')
    .argument('<priceUsd>', 'the daily price to accept, in whole USD (e.g. 1.20)')
    .action(async (sellerPeerIdArg: string, priceUsdArg: string) => {
      const globalOpts = getGlobalOptions(buyerCmd)

      const sellerPeerId = sellerPeerIdArg.replace(/^0x/i, '').toLowerCase()
      if (!SELLER_PEER_ID_PATTERN.test(sellerPeerIdArg)) {
        console.error(chalk.red('Error: sellerPeerId must be a 40-character hex peer ID (EVM address).'))
        process.exit(1)
      }

      const priceUsd = Number(priceUsdArg)
      if (!Number.isFinite(priceUsd) || priceUsd < 0) {
        console.error(chalk.red('Error: priceUsd must be a non-negative number.'))
        process.exit(1)
      }

      const previous = await readAgreedDayPassPriceUsd(globalOpts.config, sellerPeerId)
      await writeAgreedDayPassPriceUsd(globalOpts.config, sellerPeerId, priceUsd)

      if (previous === null) {
        console.log(chalk.green(`Agreed day-pass price for ${sellerPeerId.slice(0, 12)}... set to $${priceUsd.toFixed(2)}/day.`))
      } else {
        console.log(chalk.green(`Agreed day-pass price for ${sellerPeerId.slice(0, 12)}... updated from $${previous.toFixed(2)}/day to $${priceUsd.toFixed(2)}/day.`))
      }
      console.log(chalk.dim('Takes effect on this seller\'s next signing cycle -- no restart needed if buyer start is already running.'))
    })
}
