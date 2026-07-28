/** Redness threshold sent when sensitivity is 0%, guaranteed to exceed any
 *  real redness score (theoretical max ~10000), so detection never fires. */
export const DISABLED_RED_THRESHOLD = 1_000_000;

/** Sensitivity/threshold pair the curve is anchored to, so the long-standing
 *  default behavior (80% → threshold 5.0) is unchanged by the curve shape. */
const ANCHOR_SENSITIVITY = 80;
const ANCHOR_THRESHOLD = 5.0;

/** Exponent shaping the falloff below the anchor. >1 makes the threshold
 *  climb steeply as sensitivity drops, so low settings are much less
 *  sensitive rather than barely different from each other. */
const GAMMA = 3;

/** Default UI sensitivity (80% → threshold 5.0). */
export const DEFAULT_RED_SENSITIVITY = 80;

/**
 * Convert UI sensitivity (0–100%) to backend red_threshold.
 * 0% disables detection entirely; 80% always yields threshold 5.0; below
 * 80% the threshold rises along a power curve, so e.g. 1% is far less
 * sensitive than the old linear mapping produced.
 */
export const sensitivityToThreshold = (sensitivity) => {
  if (sensitivity <= 0) return DISABLED_RED_THRESHOLD;
  const distance = (100 - sensitivity) / (100 - ANCHOR_SENSITIVITY);
  return ANCHOR_THRESHOLD * Math.pow(distance, GAMMA);
};

/** Convert backend red_threshold back to UI sensitivity (0–100%). */
export const thresholdToSensitivity = (threshold) => {
  if (threshold >= DISABLED_RED_THRESHOLD) return 0;
  const distance = Math.pow(threshold / ANCHOR_THRESHOLD, 1 / GAMMA);
  return 100 - distance * (100 - ANCHOR_SENSITIVITY);
};
