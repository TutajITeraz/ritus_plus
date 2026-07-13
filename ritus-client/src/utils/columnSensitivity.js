/** Smallest gap (as a fraction of page width) treated as a real column gutter (most sensitive). */
export const MIN_COLUMN_GAP_RATIO = 0.015;

/** Largest gap (as a fraction of page width) required before splitting columns (least sensitive). */
export const MAX_COLUMN_GAP_RATIO = 0.165;

/** Default UI sensitivity (80% → ratio 0.045, the backend's original hardcoded default). */
export const DEFAULT_COLUMN_SENSITIVITY = 80;

/** Convert UI sensitivity (0–100%) to backend column_gap_ratio (0.015–0.165). */
export const sensitivityToColumnGapRatio = (sensitivity) =>
  MAX_COLUMN_GAP_RATIO - (sensitivity / 100) * (MAX_COLUMN_GAP_RATIO - MIN_COLUMN_GAP_RATIO);

/** Convert backend column_gap_ratio (0.015–0.165) to UI sensitivity (0–100%). */
export const columnGapRatioToSensitivity = (ratio) =>
  ((MAX_COLUMN_GAP_RATIO - ratio) / (MAX_COLUMN_GAP_RATIO - MIN_COLUMN_GAP_RATIO)) * 100;
