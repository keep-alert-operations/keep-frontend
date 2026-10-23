/**
 * Trailing merge window for live invalidations. A refresh runs once changes have
 * been quiet for `quiet` milliseconds, and no later than `maxWait` after the first
 * unrefreshed change, so a continuous stream still refreshes regularly. After the
 * user's own command, `expedite` merges changes for only `expedited` milliseconds
 * for `expediteFor`, so the projected result of that command is not held back.
 */
export const LIVE_QUIET_MS = 500;
export const LIVE_MAX_WAIT_MS = 1000;
export const LIVE_EXPEDITED_MS = 250;
export const LIVE_EXPEDITE_FOR_MS = 5000;

interface Runtime {
  now: () => number;
  later: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}

export function liveCoalescer(
  flush: () => void,
  {
    quiet = LIVE_QUIET_MS,
    maxWait = LIVE_MAX_WAIT_MS,
    expedited = LIVE_EXPEDITED_MS,
    expediteFor = LIVE_EXPEDITE_FOR_MS,
  } = {},
  runtime: Runtime = {
    now: () => performance.now(),
    later: (callback, delay) => setTimeout(callback, delay),
    cancel: (timer) => clearTimeout(timer),
  },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: number | undefined;
  let expediteUntil = -Infinity;
  function cancel() {
    runtime.cancel(timer);
    timer = undefined;
    first = undefined;
  }
  function schedule(now: number) {
    const fast = now < expediteUntil;
    runtime.cancel(timer);
    timer = runtime.later(
      () => {
        cancel();
        flush();
      },
      Math.max(
        0,
        Math.min(
          fast ? expedited : quiet,
          first! + (fast ? expedited : maxWait) - now,
        ),
      ),
    );
  }
  return {
    /** Records a change and restarts the quiet window within the max wait. */
    change() {
      const now = runtime.now();
      first ??= now;
      schedule(now);
    },
    /** Shortens the window after the user's own command, including a pending merge. */
    expedite() {
      const now = runtime.now();
      expediteUntil = now + expediteFor;
      if (timer !== undefined) schedule(now);
    },
    /** Drops the pending refresh, e.g. when a refresh already started. */
    cancel,
  };
}
