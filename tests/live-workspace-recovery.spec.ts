import { expect, test, type Page } from "@playwright/test";
import {
  LIVE_EXPEDITED_MS,
  LIVE_MAX_WAIT_MS,
  LIVE_QUIET_MS,
} from "../src/lib/live-coalescer";
import { liveStream } from "../src/lib/live-stream";

const tenant = "00000000-0000-4000-8000-000000000001";
const row = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: "7",
  message: "Database latency",
  severity: "critical",
  status: "firing",
  acknowledged: false,
  assignee_id: null,
};
interface Harness {
  polls: number;
  aborts: number;
  stall: boolean;
  emit: (generation: number) => void;
}
const state = (page: Page) =>
  page.evaluate(() => {
    const value = (window as unknown as { workspaceLiveTest: Harness })
      .workspaceLiveTest;
    return { polls: value.polls, aborts: value.aborts };
  });

async function workspace(page: Page, { editor = false } = {}) {
  let feedReads = 0,
    commands = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.fetch;
    const h: Harness = { polls: 0, aborts: 0, stall: false, emit() {} };
    Object.assign(window, { workspaceLiveTest: h });
    window.fetch = async (input, options) => {
      if (typeof input === "string" && input.endsWith("/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            h.emit = (generation) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `event: invalidate\ndata: {"view_generation":"${generation}"}\n\n`,
                ),
              );
            h.emit(1);
            const heartbeat = setInterval(
              () =>
                controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")),
              15000,
            );
            options?.signal?.addEventListener("abort", () => {
              clearInterval(heartbeat);
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (typeof input === "string" && input.endsWith("/view-state")) {
        h.polls++;
        if (h.stall) {
          // Headers arrive normally. Abort must interrupt the pending JSON body.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              options?.signal?.addEventListener("abort", () => {
                h.aborts++;
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          });
          return new Response(body, {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return original(input, options);
    };
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "fixture", display_name: "Synthetic live user" },
          csrf_token: "test",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: editor ? "edit" : "view",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/alerts")) feedReads++;
    if (url.pathname.endsWith("/commands")) {
      commands++;
      return route.fulfill({
        json: { data: { ...row, assignee_id: "fixture", revision: "8" } },
      });
    }
    return route.fulfill({
      json: {
        data: url.pathname.endsWith("view-state")
          ? { view_generation: "1" }
          : url.pathname.endsWith("/alerts") && editor
            ? [row]
            : [],
        meta: { total: editor ? "1" : "0" },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect.poll(() => feedReads).toBeGreaterThan(0);
  await page.clock.runFor(500);
  return { feedReads: () => feedReads, commands: () => commands };
}

const emit = (page: Page, generation: number) =>
  page.evaluate((value) => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.emit(value);
  }, generation);
// A bump's request starts after a React render and is counted when routed, which
// can take hundreds of milliseconds on a loaded machine; wait for a stable count.
async function settled(read: () => number) {
  let last = -1,
    stable = 0;
  await expect
    .poll(
      () => {
        stable = read() === last ? stable + 1 : 0;
        last = read();
        return stable >= 2;
      },
      { intervals: [750], timeout: 20000 },
    )
    .toBe(true);
  return last;
}
// A merged refresh can be scheduled after a clock advance; run until none remain.
async function quiet(page: Page, read: () => number) {
  let count = await settled(read);
  for (let round = 0; round < 5; round++) {
    await page.clock.runFor(LIVE_MAX_WAIT_MS);
    const next = await settled(read);
    if (next === count) return count;
    count = next;
  }
  throw new Error("Feed reads did not settle");
}

test("a single invalidation refreshes the feed once after the quiet window", async ({
  page,
}) => {
  test.slow(); // Each settled count waits for real time.
  const h = await workspace(page);
  // Stop real time from advancing the page clock while counts settle.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const before = await quiet(page, h.feedReads);
  await emit(page, 2);
  await page.clock.runFor(LIVE_QUIET_MS - 100);
  expect(await settled(h.feedReads)).toBe(before);
  await page.clock.runFor(200);
  await expect.poll(h.feedReads).toBe(before + 1);
  await page.clock.runFor(5000);
  expect(await settled(h.feedReads)).toBe(before + 1);
});

test("continuous invalidations refresh at the maximum wait", async ({
  page,
}) => {
  test.slow(); // Each settled count waits for real time.
  const h = await workspace(page);
  // Stop real time from advancing the page clock while counts settle.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const before = await quiet(page, h.feedReads);
  for (let generation = 2; generation < 62; generation++) {
    await emit(page, generation);
    await page.clock.runFor(100);
  }
  // No quiet window passed in 6 s; only the 1 s cap refreshed (about six times).
  await expect.poll(h.feedReads).toBeGreaterThanOrEqual(before + 4);
  expect(await settled(h.feedReads)).toBeLessThanOrEqual(before + 8);
});

test("the projection hint after the user's own command refreshes within 250 ms", async ({
  page,
}) => {
  test.slow(); // Each settled count waits for real time.
  const h = await workspace(page, { editor: true });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await quiet(page, h.feedReads);
  await page.getByRole("link", { name: "Open Database latency" }).hover();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect.poll(h.commands).toBe(1);
  // The feed reloads at once, but search has not applied the command yet.
  const reloaded = await settled(h.feedReads);
  await emit(page, 2);
  await page.clock.runFor(LIVE_EXPEDITED_MS + 50);
  // The ordinary window would still be waiting until 500 ms.
  expect(LIVE_EXPEDITED_MS + 50).toBeLessThan(LIVE_QUIET_MS);
  await expect.poll(h.feedReads).toBe(reloaded + 1);
});

test("stalled focus reconciliation times out and later focus can recover", async ({
  page,
}) => {
  await workspace(page);
  const baseline = await state(page);
  await page.evaluate(() => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.stall = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(2100);
  await expect
    .poll(async () => (await state(page)).polls)
    .toBeGreaterThan(baseline.polls);
  const first = await state(page);
  await page.clock.runFor(10000);
  await expect
    .poll(async () => (await state(page)).aborts)
    .toBeGreaterThan(first.aborts);
  await page.evaluate(() => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.stall = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(2100);
  await expect
    .poll(async () => (await state(page)).polls)
    .toBeGreaterThan(first.polls);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
});

test("hiding aborts in-flight reconciliation and visible return starts a fresh one", async ({
  page,
}) => {
  await workspace(page);
  await page.evaluate(() => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.stall = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(2100);
  const before = await state(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await state(page)).aborts)
    .toBeGreaterThan(before.aborts);
  const hidden = await state(page);
  await page.clock.runFor(20000);
  expect((await state(page)).polls).toBe(hidden.polls);
  await page.evaluate(() => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.stall = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await state(page)).polls)
    .toBeGreaterThan(hidden.polls);
});

for (const behavior of ["reject", "hang"] as const) {
  test(`authorization denial is immediate when body cancellation ${behavior}s`, async () => {
    let denied = 0,
      degraded = 0;
    const stream = liveStream(
      {
        path: `/api/tenants/${tenant}/events`,
        onEvent() {},
        onConnect() {},
        onDenied() {
          denied++;
        },
        onDegraded() {
          degraded++;
        },
      },
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                return behavior === "reject"
                  ? Promise.reject(new Error("Body failed"))
                  : new Promise(() => {});
              },
            }),
            { status: 403 },
          ),
        now: () => 0,
        random: () => 0.5,
        later: (callback, delay) => setTimeout(callback, delay),
        cancel: (timer) => clearTimeout(timer),
      },
    );
    try {
      stream.setVisible(true);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect({ denied, degraded }).toEqual({ denied: 1, degraded: 0 });
    } finally {
      stream.close();
    }
  });
}
