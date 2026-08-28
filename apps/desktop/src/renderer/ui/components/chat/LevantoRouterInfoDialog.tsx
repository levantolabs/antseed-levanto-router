import { Button, Modal } from '@antseed/ui';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { subscriptionPriceResource } from '../../../modules/app/vpr-resources';
import styles from './LevantoRouterInfoDialog.module.scss';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/** ~30.44 days/month average, not a fixed 30 -- avoids a number that visibly
 *  drifts from "daily x 30" depending on which month it's compared against. */
const DAYS_PER_MONTH = 30.44;

export function LevantoRouterInfoDialog({ isOpen, onClose, onConfirm }: Props) {
  const { data: offer } = useCachedResource(subscriptionPriceResource, isOpen);
  const dailyUsd = offer?.flatUsdPrice;

  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title="Levanto Router"
    >
      <p className={styles.paragraph}>
        Levanto Router picks the best model and seller for every message you send, weighing cost
        against quality according to your Cost / quality tradeoff preference. No need to switch
        models by hand as prices and availability change.
      </p>

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
        Charged once per day you use it. Cancel any time from Preferences — nothing further is
        charged once it's off.
      </p>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm}>Enable Levanto Router</Button>
      </div>
    </Modal>
  );
}
