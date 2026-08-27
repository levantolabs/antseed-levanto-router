import { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Moon02Icon, Sun02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { routesForSelectedModel } from '../../../modules/catalog/view-models';
import { peerAccessSummaryLabel } from '../../../modules/routing/peer-access';
import { buildVprPeerOptions } from '../../../modules/routing/tools';
import { reputationScaleLabel, sellerMetaLabel, sellerReputationLabel } from '../../../modules/catalog/seller-format';
import { CQT_LABELS, cqtToPositionIndex, positionIndexToCqt } from '../../../modules/routing/cqt';
import { AUTO_SUBSCRIPTION_MIN_TRUST_SCORE } from '../../../modules/routing/levanto-auto';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { activeThemeMode, applyThemeMode, type ThemeMode } from '../../lib/theme';
import { formatUsdShort, VprCard, VprPage, VprSettingRow, VprSlider, VprToggle } from '../vpr/VprKit';
import { VprPeerAccessDialog } from './VprPeerAccessDialog';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprPreferencesView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    preferences: state.vprRoutingPreferences,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
    lastPeers: state.lastPeers,
    floatAutoOpen: state.vprFloatAutoOpen,
    floatShowRoutedPeer: state.vprFloatShowRoutedPeer,
  }), shallowEqual);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => activeThemeMode());
  const [accessOpen, setAccessOpen] = useState(false);

  const peerOptions = useMemo(
    () => buildVprPeerOptions(snap.lastPeers, snap.discoverRows),
    [snap.lastPeers, snap.discoverRows],
  );
  const { allowedPeerIds, blockedPeerIds } = snap.preferences;
  const accessSummary = peerAccessSummaryLabel(allowedPeerIds.length, blockedPeerIds.length);
  // Real gate on the daily subscription and the CQT dial (decisions doc
  // SS14 item 29) -- a standing, explicit toggle, not a proxy for whatever
  // model happens to be selected at this moment.
  const autoSubscriptionEnabled = snap.preferences.autoSubscriptionEnabled ?? false;

  const selectTheme = (mode: ThemeMode) => {
    applyThemeMode(mode);
    setThemeMode(mode);
  };

  const pinnedRoute = useMemo(() => {
    if (snap.selection.mode !== 'pinned-peer' || !snap.selection.peerId) return null;
    const routes = routesForSelectedModel(snap.discoverRows, snap.selection.model);
    return routes.find((route) => route.peerId === snap.selection.peerId) ?? null;
  }, [snap.discoverRows, snap.selection]);

  return (
    <section className={`view view-vpr-preferences view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Preferences" backFallback="home">
      <div className={styles.stack}>
        <p className={styles.lede}>These preferences apply to every model with Auto select turned on</p>

        <div className={styles.settings}>
          <VprSettingRow
            title="Auto select seller"
            caption="(Price + Trust preference)"
            hint="Applies to every model set to Auto. Off pauses routing everywhere - providers stay on their last pick."
            control={(
              <VprToggle
                checked={snap.preferences.autoRouting}
                onChange={(next) => actions.updateVprRoutingPreferences({ autoRouting: next })}
                ariaLabel="Auto select seller"
              />
            )}
          />

          <VprSettingRow
            title="Select model router"
            control={(
              <select
                className={styles.select}
                value={autoSubscriptionEnabled ? 'levanto-auto' : 'none'}
                onChange={(event) => {
                  const next = event.target.value === 'levanto-auto';
                  actions.updateVprRoutingPreferences({
                    autoSubscriptionEnabled: next,
                    ...(next && snap.preferences.minTrustScore < AUTO_SUBSCRIPTION_MIN_TRUST_SCORE
                      ? { minTrustScore: AUTO_SUBSCRIPTION_MIN_TRUST_SCORE }
                      : {}),
                  });
                }}
                aria-label="Select model router"
              >
                <option value="none">None</option>
                <option value="levanto-auto">Levanto Auto (daily subscription)</option>
              </select>
            )}
          />

          {autoSubscriptionEnabled ? (
            <div className={styles.sliderGroup}>
              <div className={styles.sliderHead}>
                <span className={styles.sliderTitle}>Cost / quality tradeoff</span>
                <span className={styles.sliderReadingSmall}>
                  {CQT_LABELS[cqtToPositionIndex(snap.preferences.cqt)]}
                </span>
              </div>
              <VprSlider
                min={0}
                max={CQT_LABELS.length - 1}
                step={1}
                value={cqtToPositionIndex(snap.preferences.cqt)}
                onChange={(next) => actions.updateVprRoutingPreferences({ cqt: positionIndexToCqt(next) })}
                ariaLabel="Cost / quality tradeoff"
              />
              <div className={styles.sliderHint}>
                Only affects requests routed through the selected model router. A relative dial, not a spend target.
              </div>
            </div>
          ) : null}

          <VprSettingRow
            title="Prefer free peers when available"
            hint="Adds a strong routing bonus to zero-cost offers."
            control={(
              <VprToggle
                checked={snap.preferences.preferFreePeers}
                onChange={(next) => actions.updateVprRoutingPreferences({ preferFreePeers: next })}
                ariaLabel="Prefer free peers when available"
              />
            )}
          />

          <div className={styles.sliderGroup}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderTitle}>Minimum trust score</span>
              <span className={styles.sliderReading}>
                <span className={styles.sliderReadingLabel}>Reputation</span>
                <span className={styles.sliderReadingValue}>{reputationScaleLabel(snap.preferences.minTrustScore)}</span>
              </span>
            </div>
            <VprSlider
              min={autoSubscriptionEnabled ? AUTO_SUBSCRIPTION_MIN_TRUST_SCORE : 0}
              max={100}
              step={5}
              value={snap.preferences.minTrustScore}
              onChange={(next) => actions.updateVprRoutingPreferences({ minTrustScore: next })}
              ariaLabel="Minimum trust score"
            />
            <div className={styles.sliderHint}>
              Providers rated below this are never used
              {autoSubscriptionEnabled ? ' — locked to 7.0+ while a model router is selected' : ''}
            </div>
          </div>

          <div className={styles.sliderGroup}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderTitle}>Price preference</span>
              <span className={styles.sliderReadingSmall}>
                {formatUsdShort(snap.preferences.maxInputUsdPerMillion)}/m tok
              </span>
            </div>
            <VprSlider
              min={0}
              max={25}
              step={0.5}
              value={snap.preferences.maxInputUsdPerMillion}
              onChange={(next) => actions.updateVprRoutingPreferences({ maxInputUsdPerMillion: next })}
              ariaLabel="Price preference"
            />
            <div className={styles.sliderHint}>Sellers above this input price receive a strong ranking penalty</div>
          </div>

          <VprSettingRow
            title="Seller access"
            caption={`(${accessSummary})`}
            hint="Block sellers you never want used, or allow a few to use only those."
            control={(
              <button
                type="button"
                className={styles.accessManage}
                onClick={() => setAccessOpen(true)}
              >
                Manage sellers
              </button>
            )}
          />
        </div>

        {pinnedRoute ? (
          <div className={styles.pinnedSection}>
            <span className={styles.pinnedLabel}>Automatically select this seller</span>
            <VprCard>
              <button
                type="button"
                className={styles.pinnedRow}
                onClick={() => actions.clearVprPinnedPeer()}
                title="Unpin this seller"
              >
                <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.pinnedCheck} />
                <span className={styles.pinnedText}>
                  <span className={styles.pinnedName}>
                    {pinnedRoute.peerDisplayName || pinnedRoute.peerLabel || pinnedRoute.peerId}
                  </span>
                  <span className={styles.pinnedMeta}>
                    {sellerMetaLabel(pinnedRoute)}
                    {snap.selection.model?.label ? ` · ${snap.selection.model.label}` : ''}
                  </span>
                </span>
                <span className={styles.pinnedScore}>{sellerReputationLabel(pinnedRoute)}</span>
              </button>
            </VprCard>
          </div>
        ) : null}

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Floating window</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Show on traffic"
              hint="Show the floating window on its own when a connected app starts sending requests."
              control={(
                <VprToggle
                  checked={snap.floatAutoOpen}
                  onChange={(next) => actions.setVprFloatAutoOpen?.(next)}
                  ariaLabel="Show floating window on traffic"
                />
              )}
            />
            <VprSettingRow
              title="Show routed peer"
              hint="Show the seller each chat's requests actually went through in chat lists and next to its model."
              control={(
                <VprToggle
                  checked={snap.floatShowRoutedPeer}
                  onChange={(next) => actions.setVprFloatShowRoutedPeer?.(next)}
                  ariaLabel="Show routed peer"
                />
              )}
            />
          </VprCard>
        </div>

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Appearance</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Theme"
              hint="Applies to every VPR window."
              control={(
                <div className={styles.themeSegment} role="radiogroup" aria-label="Theme">
                  {([
                    { mode: 'light' as const, label: 'Light', icon: Sun02Icon },
                    { mode: 'dark' as const, label: 'Dark', icon: Moon02Icon },
                  ]).map(({ mode, label, icon }) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={themeMode === mode}
                      className={`${styles.themeSegmentButton}${themeMode === mode ? ` ${styles.themeSegmentActive}` : ''}`}
                      onClick={() => selectTheme(mode)}
                    >
                      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            />
          </VprCard>
        </div>
      </div>
      </VprPage>

      <VprPeerAccessDialog
        isOpen={accessOpen}
        onClose={() => setAccessOpen(false)}
        preferences={snap.preferences}
        peerOptions={peerOptions}
        onSetListing={actions.setVprPeerListing}
        onClearAllowlist={() => actions.updateVprRoutingPreferences({ allowedPeerIds: [] })}
      />
    </section>
  );
}
