import { useEffect, useRef, useState } from "react";

/**
 * Rough "seconds per page" estimate for a polled background job, derived
 * purely from wall-clock time observed in this browser tab (the server does
 * not report per-page timing for batch jobs). Resets whenever the job
 * transitions into "running" from something else, so resuming an interrupted
 * job starts a fresh estimate instead of counting time it was paused.
 *
 * @param {boolean} isRunning
 * @param {number} current - pages completed so far, per the polled job status
 * @returns {number|null} average seconds per page, or null until there is
 *   at least one completed page to measure against
 */
export function useJobPacing(isRunning, current) {
  const startRef = useRef(null);
  const baseCountRef = useRef(0);
  const [avgSeconds, setAvgSeconds] = useState(null);

  useEffect(() => {
    if (isRunning && startRef.current === null) {
      startRef.current = performance.now();
      baseCountRef.current = current;
    }
    if (!isRunning) {
      startRef.current = null;
      return;
    }
    const done = current - baseCountRef.current;
    if (done > 0) {
      setAvgSeconds((performance.now() - startRef.current) / done / 1000);
    }
  }, [isRunning, current]);

  return isRunning ? avgSeconds : null;
}
