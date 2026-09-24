import { expect, test, type Page } from "@playwright/test";
import { liveStream } from "../src/lib/live-stream";

const tenant = "00000000-0000-4000-8000-000000000001";
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

async function workspace(page: Page) {
  let feedReads = 0;
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
              role: "view",
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
    return route.fulfill({
      json: {
        data: url.pathname.endsWith("view-state")
          ? { view_generation: "1" }
          : [],
        meta: { total: "0" },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect.poll(() => feedReads).toBeGreaterThan(0);
  await page.clock.runFor(500);
  return { feedReads: () => feedReads };
}

test("continuous invalidations refresh within fixed coalescing windows", async ({
  page,
}) => {
  const h = await workspace(page);
  const before = h.feedReads();
  for (let generation = 2; generation < 22; generation++) {
    await page.evaluate((value) => {
      (
        window as unknown as { workspaceLiveTest: Harness }
      ).workspaceLiveTest.emit(value);
    }, generation);
    await page.clock.runFor(100);
  }
  // There has not been any quiet250ms window; debounce would never refresh.
  await expect.poll(h.feedReads).toBeGreaterThan(before + 1);
});

test("stalled reconciliation body times out and a later poll can recover", async ({
  page,
}) => {
  await workspace(page);
  await page.evaluate(() => {
    (
      window as unknown as { workspaceLiveTest: Harness }
    ).workspaceLiveTest.stall = true;
  });
  const baseline = await state(page);
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
