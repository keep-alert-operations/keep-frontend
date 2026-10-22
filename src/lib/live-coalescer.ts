/**
 * Trailing merge window for live invalidations. A refresh runs once changes have
 * been quiet for `quiet` milliseconds, and no later than `maxWait` after the first
 * unrefreshed change, so a continuous stream still refreshes regularly.
 */
export const LIVE_QUIET_MS = 1000;
export const LIVE_MAX_WAIT_MS = 2000;

interface Runtime {
  now: () => number;
  later: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}

export function liveCoalescer(
  flush: () => void,
  { quiet = LIVE_QUIET_MS, maxWait = LIVE_MAX_WAIT_MS } = {},
  runtime: Runtime = {
    now: () => performance.now(),
    later: (callback, delay) => setTimeout(callback, delay),
    cancel: (timer) => clearTimeout(timer),
  },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: number | undefined;
  function cancel() {
    runtime.cancel(timer);
    timer = undefined;
    first = undefined;
  }
  return {
    /** Records a change and restarts the quiet window within the max wait. */
    change() {
      const now = runtime.now();
      first ??= now;
      runtime.cancel(timer);
      timer = runtime.later(
        () => {
          cancel();
          flush();
        },
        Math.max(0, Math.min(quiet, first + maxWait - now)),
      );
    },
    /** Drops the pending refresh, e.g. when a refresh already started. */
    cancel,
  };
}
