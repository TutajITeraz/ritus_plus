import { useEffect, useRef, useState } from "react";

/**
 * Rough "seconds per page" estimate for a polled background job, derived
 * purely from wall-clock time observed in this browser tab (the server does
 * not report per-page timing for batch jobs). Resets whenever the job
 * transitions into "running" from something else, so resuming an interrupted
 * job starts a fresh estimate instead of counting time it was paused.
 *
 * avgSeconds is a cumulative average over the whole run (total elapsed time
 * divided by pages completed since it started running), not just the most
 * recently finished page - one slow or fast page nudges it but does not
 * replace it. etaSeconds projects that average across the pages still left.
 *
 * @param {boolean} isRunning
 * @param {number} current - pages completed so far, per the polled job status
 * @param {number} [total] - total pages the job expects to process, for ETA
 * @returns {{avgSeconds: number|null, etaSeconds: number|null}}
 */
export function useJobPacing(isRunning, current, total = 0) {
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
      setAvgSeconds(null);
      return;
    }
    const done = current - baseCountRef.current;
    if (done > 0) {
      setAvgSeconds((performance.now() - startRef.current) / done / 1000);
    }
  }, [isRunning, current]);

  if (!isRunning) return { avgSeconds: null, etaSeconds: null };

  const remaining = total > current ? total - current : 0;
  const etaSeconds = avgSeconds != null && remaining > 0 ? avgSeconds * remaining : null;
  return { avgSeconds, etaSeconds };
}

/** Formats a duration in seconds as e.g. "45s", "3m 20s", "1h 05m". */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
