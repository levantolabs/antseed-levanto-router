/**
 * CQT (cost/quality tradeoff) dial (model-routing decisions doc SS8.1,
 * software-architecture doc SS4.4). Five discrete UI positions map onto
 * Sage's underlying 0-10 scale at {1, 3, 5, 7, 9}; index 2 (value 5) is the
 * default, "Balanced." The dial is relative, not a spend target -- labels
 * deliberately avoid "save X%" language (SS8.1's own copy constraint).
 *
 * Position labels aren't specified anywhere in the four ground-truth docs
 * beyond the middle one ("Balanced") -- these four are a new, undocumented
 * UI copy decision, logged in the runlog.
 */
export const CQT_POSITIONS: readonly number[] = [1, 3, 5, 7, 9];

export const CQT_LABELS: readonly string[] = [
  'Cheapest',
  'Cheaper',
  'Balanced',
  'Higher quality',
  'Best quality',
];

export const DEFAULT_CQT_POSITION_INDEX = 2;

export function cqtToPositionIndex(cqt: number | undefined): number {
  const index = CQT_POSITIONS.indexOf(cqt ?? CQT_POSITIONS[DEFAULT_CQT_POSITION_INDEX]!);
  return index >= 0 ? index : DEFAULT_CQT_POSITION_INDEX;
}

export function positionIndexToCqt(index: number): number {
  return CQT_POSITIONS[Math.min(CQT_POSITIONS.length - 1, Math.max(0, index))]!;
}

export function cqtLabel(cqt: number | undefined): string {
  return CQT_LABELS[cqtToPositionIndex(cqt)]!;
}
