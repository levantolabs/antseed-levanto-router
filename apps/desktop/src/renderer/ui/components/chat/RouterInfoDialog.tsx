import { Button, Modal } from '@antseed/ui';
import type { RouterPluginInfo } from '../../../types/bridge';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { subscriptionPriceResource } from '../../../modules/app/vpr-resources';
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
 * dialog copy. The live daily price is a generic AIP-5 Router-interface
 * concept (`/_antseed/subscription-price`), not specific to any one plugin.
 */
export function RouterInfoDialog({ isOpen, plugin, onClose, onConfirm }: Props) {
  const { data: offer } = useCachedResource(subscriptionPriceResource, isOpen);
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
              <span className={styles.priceAmount}>${dailyUsd.toFixed(2)}/day</span>
              <span className={styles.priceSecondary}>
                {' '}(~${(dailyUsd * DAYS_PER_MONTH).toFixed(2)}/month)
              </span>
            </>
          )
          : <span className={styles.priceAmount}>Billed daily</span>}
      </div>
      <p className={styles.paragraph}>
        Charged once per day. Cancel any time from Preferences.
      </p>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm}>Enable {plugin?.displayName ?? 'router'}</Button>
      </div>
    </Modal>
  );
}
