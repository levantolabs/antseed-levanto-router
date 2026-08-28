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

export type ChatRoutingAlternativeRow = {
  /** Omitted when every alternative serves the same model -- the caller
   *  shows that once via `alternativesModelCaption` instead of repeating a
   *  long, near-identical string on every row. */
  model?: string;
  peerId: string;
  price: string;
  /** True for the candidate that was actually used -- highlighted in the
   *  table instead of repeated as its own "current" row. */
  isPicked: boolean;
};

type Props = {
  /** The model that actually served this message. */
  modelLabel: string;
  /** Extra rows (peer, cost, latency, ...) shown once expanded. */
  details?: ChatRoutingDetail[];
  /** The router's top few ranked candidates for this request, in order. */
  alternatives?: ChatRoutingAlternativeRow[];
  /** Shown once above the alternatives table when every row serves this
   *  same model (the common case: same model, different sellers). */
  alternativesModelCaption?: string;
};

/** Collapsed by default -- "Routed to X" is enough at a glance; the rest
 *  (peer, cost, latency, alternatives considered) is one click away instead
 *  of always cluttering the message. */
export function ChatRoutingBadge({ modelLabel, details = [], alternatives = [], alternativesModelCaption }: Props) {
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
      {expanded && (details.length > 0 || alternatives.length > 0) && (
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
          {alternatives.length > 0 && (
            <div className={styles.alternatives}>
              <div className={styles.alternativesTitle}>
                Considered{alternativesModelCaption ? ` — ${alternativesModelCaption}` : ''}
              </div>
              <table className={styles.alternativesTable}>
                <colgroup>
                  {alternativesModelCaption ? (
                    <>
                      <col className={styles.colPeerNoModel} />
                      <col className={styles.colPriceNoModel} />
                    </>
                  ) : (
                    <>
                      <col className={styles.colModel} />
                      <col className={styles.colPeer} />
                      <col className={styles.colPrice} />
                    </>
                  )}
                </colgroup>
                <tbody>
                  {alternatives.map((row, index) => (
                    <tr
                      key={`${row.peerId}-${row.model ?? index}`}
                      className={row.isPicked ? styles.alternativeRowPicked : styles.alternativeRow}
                    >
                      {row.model && <td className={styles.alternativeModel}>{row.model}</td>}
                      <td className={styles.alternativePeer}>{row.peerId.slice(0, 8)}</td>
                      <td className={styles.alternativePrice}>{row.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
