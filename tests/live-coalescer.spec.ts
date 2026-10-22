import { expect, test } from "@playwright/test";
import {
  LIVE_MAX_WAIT_MS,
  LIVE_QUIET_MS,
  liveCoalescer,
} from "../src/lib/live-coalescer";

function fakeClock() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    runtime: {
      now: () => now,
      later: (callback: () => void, delay: number) => {
        timers.set(++next, { at: now + delay, callback });
        return next as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (timer: ReturnType<typeof setTimeout> | undefined) => {
        timers.delete(timer as unknown as number);
      },
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function harness() {
  const clock = fakeClock();
  const flushes: number[] = [];
  const live = liveCoalescer(
    () => flushes.push(clock.runtime.now()),
    {},
    clock.runtime,
  );
  return { clock, flushes, live };
}

test("selected live merge window stays within the visibility budget", () => {
  expect(LIVE_QUIET_MS).toBe(1000);
  expect(LIVE_MAX_WAIT_MS).toBe(2000);
});

test("a single change refreshes once after the quiet window", () => {
  const { clock, flushes, live } = harness();
  live.change();
  clock.advance(LIVE_QUIET_MS - 1);
  expect(flushes).toEqual([]);
  clock.advance(1);
  expect(flushes).toEqual([LIVE_QUIET_MS]);
  clock.advance(10000);
  expect(flushes).toHaveLength(1);
  expect(clock.pending()).toBe(0);
});

test("changes inside the quiet window extend it as a trailing merge", () => {
  const { clock, flushes, live } = harness();
  live.change();
  clock.advance(600);
  live.change();
  clock.advance(600);
  expect(flushes).toEqual([]);
  clock.advance(400);
  expect(flushes).toEqual([1600]);
});

test("a continuous stream still refreshes at the maximum wait", () => {
  const { clock, flushes, live } = harness();
  for (let elapsed = 0; elapsed < 7000; elapsed += 100) {
    live.change();
    clock.advance(100);
  }
  // Without the cap a trailing debounce would not refresh until the stream stops.
  expect(flushes).toEqual([2000, 4000, 6000]);
  clock.advance(LIVE_QUIET_MS);
  expect(flushes).toEqual([2000, 4000, 6000, 7900]);
});

test("cancel drops the pending refresh and resets the max wait", () => {
  const { clock, flushes, live } = harness();
  for (let i = 0; i < 3; i++) {
    live.change();
    clock.advance(500);
  }
  live.cancel();
  clock.advance(5000);
  expect(flushes).toEqual([]);
  for (let i = 0; i < 3; i++) {
    live.change();
    clock.advance(500);
  }
  // The cap counts from the first change after the cancel, not the earlier one.
  expect(flushes).toEqual([]);
  clock.advance(500);
  expect(flushes).toEqual([8500]);
});
