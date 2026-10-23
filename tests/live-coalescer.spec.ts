import { expect, test } from "@playwright/test";
import {
  LIVE_EXPEDITE_FOR_MS,
  LIVE_EXPEDITED_MS,
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
  expect(LIVE_QUIET_MS).toBe(500);
  expect(LIVE_MAX_WAIT_MS).toBe(1000);
  expect(LIVE_EXPEDITED_MS).toBe(250);
  expect(LIVE_EXPEDITE_FOR_MS).toBe(5000);
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
  clock.advance(300);
  live.change();
  clock.advance(300);
  expect(flushes).toEqual([]);
  clock.advance(200);
  expect(flushes).toEqual([800]);
});

test("a continuous stream still refreshes at the maximum wait", () => {
  const { clock, flushes, live } = harness();
  for (let elapsed = 0; elapsed < 7000; elapsed += 100) {
    live.change();
    clock.advance(100);
  }
  // Without the cap a trailing debounce would not refresh until the stream stops.
  expect(flushes).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  clock.advance(LIVE_QUIET_MS);
  expect(flushes).toHaveLength(7);
});

test("cancel drops the pending refresh and resets the max wait", () => {
  const { clock, flushes, live } = harness();
  for (let i = 0; i < 3; i++) {
    live.change();
    clock.advance(200);
  }
  live.cancel();
  clock.advance(5000);
  expect(flushes).toEqual([]);
  for (let i = 0; i < 3; i++) {
    live.change();
    clock.advance(200);
  }
  // The cap counts from the first change after the cancel, not the earlier one.
  expect(flushes).toEqual([]);
  clock.advance(300);
  expect(flushes).toEqual([6500]);
});

test("after the user's own command a change merges for only 250 ms", () => {
  const { clock, flushes, live } = harness();
  live.expedite();
  clock.advance(100);
  live.change();
  clock.advance(LIVE_EXPEDITED_MS - 1);
  expect(flushes).toEqual([]);
  clock.advance(1);
  expect(flushes).toEqual([100 + LIVE_EXPEDITED_MS]);
});

test("expediting flushes a merge that has already waited 250 ms", () => {
  const { clock, flushes, live } = harness();
  live.change();
  clock.advance(300);
  live.expedite();
  clock.advance(0);
  expect(flushes).toEqual([300]);
});

test("a stream after the user's own command refreshes every 250 ms until it expires", () => {
  const { clock, flushes, live } = harness();
  live.expedite();
  for (let elapsed = 0; elapsed < 8000; elapsed += 50) {
    live.change();
    clock.advance(50);
  }
  const expedited = flushes.filter((at) => at <= LIVE_EXPEDITE_FOR_MS);
  expect(expedited).toEqual(
    Array.from({ length: 20 }, (_, i) => (i + 1) * LIVE_EXPEDITED_MS),
  );
  // Once the window expires the normal one-second cap applies again.
  expect(flushes.filter((at) => at > LIVE_EXPEDITE_FOR_MS)).toEqual([
    6000, 7000, 8000,
  ]);
});

test("the expedite window survives a cancel and expires on time", () => {
  const { clock, flushes, live } = harness();
  live.expedite();
  live.change();
  live.cancel();
  clock.advance(1000);
  live.change();
  clock.advance(LIVE_EXPEDITED_MS);
  expect(flushes).toEqual([1000 + LIVE_EXPEDITED_MS]);
  clock.advance(LIVE_EXPEDITE_FOR_MS);
  live.change();
  clock.advance(LIVE_EXPEDITED_MS);
  expect(flushes).toHaveLength(1);
  clock.advance(LIVE_QUIET_MS - LIVE_EXPEDITED_MS);
  expect(flushes).toHaveLength(2);
});
