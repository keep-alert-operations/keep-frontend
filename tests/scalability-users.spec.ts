import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";

async function fixture(page: Page, relative = false) {
  const seen = {
    sessions: 0,
    activity: 0,
    feeds: 0,
    counts: 0,
    polls: 0,
    legacyCounts: 0,
    closed: [] as string[],
  };
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.fetch;
    const state = { emit: (_generation: number) => {} };
    Object.assign(window, { scaleLive: state });
    window.fetch = async (input, options) => {
      if (typeof input === "string" && input.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            state.emit = (generation) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `event: invalidate\ndata: {"view_generation":"${generation}"}\n\n`,
                ),
              );
            state.emit(1);
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
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return original(input, options);
    };
  });
  await page.route("**/auth/session", (route) => {
    seen.sessions++;
    return route.fulfill({
      json: {
        data: {
          principal: {
            id: "user",
            display_name: `Synthetic user ${seen.sessions}`,
          },
          csrf_token: "csrf",
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
    });
  });
  await page.route("**/auth/activity", (route) => {
    seen.activity++;
    return route.fulfill({ json: { data: { accepted: true } } });
  });
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/alerts/counts")) {
      seen.counts++;
      const queries = route.request().postDataJSON().queries as {
        id: string;
      }[];
      return route.fulfill({
        json: {
          data: {
            counts: Object.fromEntries(queries.map((q) => [q.id, "100"])),
          },
        },
      });
    }
    if (url.pathname.endsWith("/alerts/snapshot/close")) {
      seen.closed.push(route.request().postDataJSON().token);
      return route.fulfill({ json: { data: { closed: true } } });
    }
    if (url.pathname.endsWith("/alerts")) {
      seen.feeds++;
      if (url.searchParams.get("limit") === "1") seen.legacyCounts++;
      return route.fulfill({
        json: {
          data: [],
          next_cursor: `cursor-${seen.feeds}`,
          meta: {
            total: "100",
            evaluated_at: `2026-10-06T12:00:${String(seen.feeds).padStart(2, "0")}Z`,
            relative,
            close_token: `close-${seen.feeds}`,
          },
        },
      });
    }
    if (url.pathname.endsWith("/view-state")) seen.polls++;
    return route.fulfill({
      json: {
        data:
          url.pathname.endsWith("/view-state") ||
          url.pathname.endsWith("/health")
            ? { view_generation: "1" }
            : [],
        meta: {},
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect.poll(() => seen.feeds).toBeGreaterThan(0);
  await page.clock.runFor(1000);
  await expect.poll(() => seen.counts).toBeGreaterThan(0);
  return seen;
}

test("session polling preserves activity heartbeat and healthy SSE avoids fallback polls", async ({
  page,
}) => {
  const seen = await fixture(page);
  const polls = seen.polls;
  for (let tick = 0; tick < 4; tick++) {
    await page.clock.runFor(31000);
    await expect.poll(() => seen.sessions).toBeGreaterThanOrEqual(tick + 2);
    await expect(
      page.getByRole("button", {
        name: `Account: Synthetic user ${seen.sessions}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect.poll(() => seen.sessions).toBeGreaterThanOrEqual(5);
  await expect.poll(() => seen.activity).toBeGreaterThanOrEqual(2);
  expect(seen.polls).toBe(polls);
});

test("one invalidation uses one feed and one count batch, and releases old snapshots", async ({
  page,
}) => {
  const seen = await fixture(page);
  const before = { feeds: seen.feeds, counts: seen.counts };
  await page.evaluate(() =>
    (
      window as unknown as { scaleLive: { emit: (n: number) => void } }
    ).scaleLive.emit(2),
  );
  await page.clock.runFor(500);
  await expect.poll(() => seen.feeds).toBe(before.feeds + 1);
  await expect.poll(() => seen.counts).toBe(before.counts + 1);
  expect(seen.legacyCounts).toBe(0);
  await expect
    .poll(() => seen.closed.includes(`close-${before.feeds}`))
    .toBe(true);
  const last = seen.feeds;
  await page
    .getByRole("link", { name: "Incidents", exact: true })
    .first()
    .click();
  await expect.poll(() => seen.closed.includes(`close-${last}`)).toBe(true);
});

test("relative feed refreshes while idle and pauses while hidden", async ({
  page,
}) => {
  const seen = await fixture(page, true);
  const before = seen.feeds;
  await page.clock.runFor(3100);
  await expect.poll(() => seen.feeds).toBeGreaterThanOrEqual(before + 2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Let already-admitted requests settle before comparing hidden work.
  await page.clock.runFor(100);
  const hidden = seen.feeds;
  await page.clock.runFor(3000);
  expect(seen.feeds).toBe(hidden);
});
