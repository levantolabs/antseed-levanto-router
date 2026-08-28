import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { RouteIcon } from '@hugeicons/core-free-icons';
import styles from './ChatRoutingBadge.module.scss';

type Props = {
  /** The model this conversation's most recent response actually routed to. */
  modelLabel: string;
  /** The seller peer that served it, if known. */
  peerName?: string;
};

/** Collapsed by default -- "Routed to X" is enough at a glance; peer detail
 *  is one click away rather than always taking up composer space. */
export function ChatRoutingBadge({ modelLabel, peerName }: Props) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setExpanded(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [expanded]);

  return (
    <div className={styles.badge} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        title="Routing details"
      >
        <HugeiconsIcon icon={RouteIcon} size={13} strokeWidth={1.8} />
        <span className={styles.triggerLabel}>Routed to {modelLabel}</span>
      </button>
      {expanded && (
        <div className={styles.detail} role="dialog">
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Model</span>
            <span className={styles.detailValue}>{modelLabel}</span>
          </div>
          {peerName && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Seller</span>
              <span className={styles.detailValue}>{peerName}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
