import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { RouteIcon } from '@hugeicons/core-free-icons';
import { ChatCopyButton } from './ChatCopyButton';
import styles from './ChatRoutingBadge.module.scss';

export type ChatRoutingDetail = {
  label: string;
  value: string;
  /** When set, the row gets a copy button that copies this instead of `value`
   *  (e.g. a full peer ID whose `value` is just a shortened display form). */
  copyValue?: string;
};

type Props = {
  /** The model that actually served this message. */
  modelLabel: string;
  /** Extra rows (peer, cost, latency, ...) shown once expanded. */
  details?: ChatRoutingDetail[];
};

/** Collapsed by default -- "Routed to X" is enough at a glance; the rest
 *  (peer, cost, latency) is one click away instead of always cluttering the
 *  message. */
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
              <span className={styles.detailValueGroup}>
                <span className={styles.detailValue}>{row.value}</span>
                {row.copyValue && (
                  <ChatCopyButton
                    text={row.copyValue}
                    className={styles.detailCopyBtn}
                    copiedClassName={styles.detailCopyBtnCopied}
                    iconSize={11}
                    stopClickPropagation
                    ariaLabel={`Copy ${row.label.toLowerCase()}`}
                    tooltipLabel={`Copy ${row.label.toLowerCase()}`}
                  />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
