/** Max redness threshold passed to the backend (least sensitive). */
export const MAX_RED_THRESHOLD = 25.0;

/** Default UI sensitivity (80% → threshold 5.0). */
export const DEFAULT_RED_SENSITIVITY = 80;

/** Convert UI sensitivity (0–100%) to backend red_threshold (0–25). */
export const sensitivityToThreshold = (sensitivity) =>
  MAX_RED_THRESHOLD * (1 - sensitivity / 100);

/** Convert backend red_threshold (0–25) to UI sensitivity (0–100%). */
export const thresholdToSensitivity = (threshold) =>
  (1 - threshold / MAX_RED_THRESHOLD) * 100;
