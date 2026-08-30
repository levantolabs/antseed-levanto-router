import { useMemo } from 'react';
import type { RoutingDecisionRow } from '@antseed/node';
import { computeRouterSavings } from '../../../modules/routing/router-savings';
import { formatSavedUsd } from '../../../modules/catalog/measured-savings';
import styles from './ConversationRoutingHistory.module.scss';

type Props = {
  /** This conversation's own rows, already filtered by conversationKey --
   *  this component does no filtering of its own. */
  rows: RoutingDecisionRow[];
};

/** Per-conversation drill-down into Auto-routing's `routing_decisions` ledger
 *  -- one row per turn, plus this conversation's own "Auto vs retail" figure
 *  (the same computeRouterSavings the aggregate dashboard uses, called on
 *  just this conversation's rows instead of the whole ledger). Reuses
 *  ChatRoutingBadge's table visual language rather than inventing a new one. */
export function ConversationRoutingHistory({ rows }: Props) {
  const savings = useMemo(() => computeRouterSavings(rows), [rows]);
  const sorted = useMemo(() => [...rows].sort((a, b) => b.atMs - a.atMs), [rows]);

  if (rows.length === 0) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>
          {rows.length} routed {rows.length === 1 ? 'turn' : 'turns'} in this chat
        </span>
        {savings && (
          <span
            className={styles.summarySavings}
            title={`Auto vs retail: paid $${savings.actualUsd.toFixed(4)} for usage worth $${savings.baselineUsd.toFixed(4)} at retail reference prices`}
          >
            Saved {formatSavedUsd(savings.baselineUsd - savings.actualUsd)} vs retail
          </span>
        )}
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <colgroup>
            <col className={styles.colWhen} />
            <col className={styles.colModel} />
            <col className={styles.colPeer} />
            <col className={styles.colPrice} />
            <col className={styles.colPrice} />
          </colgroup>
          <thead>
            <tr>
              <th className={styles.headerCell}>When</th>
              <th className={styles.headerCell}>Model</th>
              <th className={styles.headerCell}>Peer</th>
              <th className={styles.headerCell}>Cost</th>
              <th className={styles.headerCell}>Latency</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => (
              <tr key={`${row.atMs}-${index}`}>
                <td className={styles.cell}>
                  {new Date(row.atMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className={styles.cellModel}>{row.actualModel}</td>
                <td className={styles.cellPeer}>{row.actualPeer.slice(0, 8)}</td>
                <td className={styles.cellPrice}>${row.actualUsdcPaid.toFixed(4)}</td>
                <td className={styles.cellPrice}>{row.routingLatencyMs != null ? `${row.routingLatencyMs}ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
