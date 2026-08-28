import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { RouteIcon } from '@hugeicons/core-free-icons';
import styles from './ChatRoutingBadge.module.scss';

export type ChatRoutingDetail = {
  label: string;
  value: string;
};

type Props = {
  /** The model that actually served this message. */
  modelLabel: string;
  /** Extra rows (peer, tokens, cost, latency, ...) shown once expanded. */
  details?: ChatRoutingDetail[];
};

/** Collapsed by default -- "Routed to X" is enough at a glance; the rest
 *  (peer, tokens, cost, latency) is one click away instead of always
 *  cluttering the message. */
export function ChatRoutingBadge({ modelLabel, details = [] }: Props) {
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
      {expanded && details.length > 0 && (
        <div className={styles.detail} role="dialog">
          {details.map((row) => (
            <div className={styles.detailRow} key={row.label}>
              <span className={styles.detailLabel}>{row.label}</span>
              <span className={styles.detailValue}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
