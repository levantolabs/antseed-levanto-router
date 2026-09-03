import { Button, Modal } from '@antseed/ui';
import type { RouterPluginInfo } from '../../../types/bridge';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { dayPassPriceResource } from '../../../modules/app/vpr-resources';
import styles from './RouterInfoDialog.module.scss';

type Props = {
  isOpen: boolean;
  /** The router plugin the user just picked from Preferences' dropdown --
   *  not necessarily the currently-active one, since nothing is active yet
   *  until `onConfirm`. `null` while no option is pending confirmation. */
  plugin: RouterPluginInfo | null;
  onClose: () => void;
  onConfirm: () => void;
};

/** ~30.44 days/month average, not a fixed 30 -- avoids a number that visibly
 *  drifts from "daily x 30" depending on which month it's compared against. */
const DAYS_PER_MONTH = 30.44;

/**
 * "What does Auto do, and what does it cost" dialog for whichever router
 * plugin the user just picked in Preferences. Copy comes from that plugin's
 * own `autoRouteInfo` (packages/node's AntseedRouterPlugin), falling back to
 * its `displayName`/`description` if a plugin doesn't declare dedicated
 * dialog copy. The live daily price comes from `/_antseed/day-pass-price`,
 * a hardcoded admin route on the buyer-proxy (apps/cli/src/proxy/buyer-proxy.ts)
 * reading whatever peer advertises a `type: 'day-pass'` offer -- not
 * (yet) a member of the `Router` TS interface itself.
 */
export function RouterInfoDialog({ isOpen, plugin, onClose, onConfirm }: Props) {
  const { data: offer } = useCachedResource(dayPassPriceResource, isOpen);
  const dailyUsd = offer?.flatUsdPrice;
  const title = plugin?.autoRouteInfo?.title ?? plugin?.displayName ?? 'Model router';
  const body = plugin?.autoRouteInfo?.body ?? plugin?.description ?? '';

  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={title}
    >
      <p className={styles.paragraph}>{body}</p>

      <div className={styles.priceLine}>
        {typeof dailyUsd === 'number'
          ? (
            <>
              <span className={styles.priceAmount}>${dailyUsd.toFixed(2)}</span>
              <span className={styles.priceSecondary}>
                {' '}per day you use it (~${(dailyUsd * DAYS_PER_MONTH).toFixed(2)}/month if used every day)
              </span>
            </>
          )
          : <span className={styles.priceAmount}>Billed per day used</span>}
      </div>
      <p className={styles.paragraph}>
        Charged when you send a message, which unlocks a full day of access -- you won't be charged again until you use it after that day runs out. Turn off any time from Preferences.
      </p>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm}>Enable {plugin?.displayName ?? 'router'}</Button>
      </div>
    </Modal>
  );
}
