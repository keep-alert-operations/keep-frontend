import { expect, test, type Page } from "@playwright/test";
import { LIVE_QUIET_MS } from "../src/lib/live-coalescer";

const tenant = "00000000-0000-4000-8000-000000000001";
const preset = "00000000-0000-4000-8000-000000000002";
const cases = [
  ["presets", "No presets yet"],
  ["dashboards", "No dashboards yet"],
  ["alerts", "No matching alerts"],
  ["incidents", "No incidents found"],
  ["correlation-rules", "No correlation rules yet"],
  ["maintenance", "No maintenance windows"],
  ["operators", "No operators send to this tenant."],
] as const;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(page: Page, section: string, viewPath = section) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, options) => {
      if (typeof input === "string" && input.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              Object.assign(window, {
                emitLoadingTest: (generation: number) => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `event: invalidate\ndata: {"view_generation":"${generation}"}\n\n`,
                    ),
                  );
                },
              });
              options?.signal?.addEventListener("abort", () =>
                controller.close(),
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return original(input, options);
    };
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "fixture", display_name: "Loading test user" },
          csrf_token: "test",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: "admin",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  const initial = gate();
  const refresh = gate();
  const h = {
    block: initial.promise,
    reads: 0,
    generation: 1,
    failure: false,
    rows: [] as Record<string, unknown>[],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === `/api/tenants/${tenant}/${section}` &&
      url.searchParams.get("limit") !== "1"
    ) {
      h.reads++;
      await h.block;
      return route.fulfill(
        h.failure
          ? {
              status: 503,
              json: {
                error: {
                  code: "service_unavailable",
                  message: "Synthetic list unavailable",
                },
              },
            }
          : {
              json: {
                data: h.rows,
                next_cursor: null,
                meta: { total: String(h.rows.length) },
              },
            },
      );
    }
    if (url.pathname === `/api/tenants/${tenant}/presets/${preset}`) {
      return route.fulfill({
        json: {
          data: {
            id: preset,
            name: "Saved preset",
            cel: "true",
            revision: "1",
            columns: ["message"],
            sort: [{ field: "timestamp", direction: "desc" }],
          },
        },
      });
    }
    return route.fulfill({
      json: {
        data: url.pathname.endsWith("/view-state")
          ? { view_generation: String(h.generation) }
          : [],
        meta: { total: "0" },
        next_cursor: null,
      },
    });
  });
  await page.goto(`/tenants/${tenant}/${viewPath}`);
  await expect.poll(() => h.reads).toBeGreaterThan(0);
  return {
    h,
    initial,
    refresh,
    async invalidate() {
      h.generation++;
      await page.evaluate((generation) => {
        (
          window as unknown as { emitLoadingTest: (generation: number) => void }
        ).emitLoadingTest(generation);
      }, h.generation);
      await page.clock.runFor(LIVE_QUIET_MS + 100);
    },
  };
}

for (const [section, emptyText] of cases) {
  test(`${section} keeps its completed empty state during live refresh`, async ({
    page,
  }) => {
    const { h, initial, refresh, invalidate } = await setup(page, section);
    const empty = page.getByText(emptyText, { exact: true });
    await expect(empty).toHaveCount(0);
    initial.release();
    await expect(empty).toBeVisible();
    await page.clock.runFor(LIVE_QUIET_MS + 500);
    const before = await empty.boundingBox();
    h.block = refresh.promise;
    const reads = h.reads;
    await invalidate();
    await expect.poll(() => h.reads).toBeGreaterThan(reads);
    await expect(empty).toBeVisible();
    expect(await empty.boundingBox()).toEqual(before);
    await expect(
      page.getByText(
        "Previous successful results are shown while the requested snapshot is unavailable.",
      ),
    ).toHaveCount(0);
    if (section === "presets") {
      h.rows = [
        { id: preset, name: "New shared preset", cel: "true", revision: "1" },
      ];
    }
    refresh.release();
    if (section === "presets") {
      await expect(
        page.getByRole("link", { name: "New shared preset", exact: true }),
      ).toBeVisible();
      await expect(empty).toHaveCount(0);
    } else {
      await expect(empty).toBeVisible();
    }
  });
}

test("a changed preset filter waits for its own result and failures never become an empty list", async ({
  page,
}) => {
  const { h, initial, refresh, invalidate } = await setup(page, "presets");
  initial.release();
  await expect(page.getByText("No presets yet", { exact: true })).toBeVisible();
  await page.clock.runFor(LIVE_QUIET_MS + 500);
  h.block = refresh.promise;
  await page.getByLabel("Search presets by name").fill("matched");
  await page.clock.runFor(400);
  await expect(
    page.getByText("Loading presets…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No presets match “matched”", { exact: true }),
  ).toHaveCount(0);
  h.rows = [
    {
      id: preset,
      name: "matched preset",
      cel: "true",
      revision: "1",
      sort: [{ field: "timestamp", direction: "desc" }],
    },
  ];
  refresh.release();
  await expect(
    page.getByRole("link", { name: "matched preset", exact: true }),
  ).toBeVisible();
  h.failure = true;
  await invalidate();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic list unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "matched preset", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No presets match “matched”", { exact: true }),
  ).toHaveCount(0);
});

test("a failed first preset request shows an error without inventing an empty result", async ({
  page,
}) => {
  const { h, initial } = await setup(page, "presets");
  h.failure = true;
  initial.release();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic list unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("No presets yet", { exact: true })).toHaveCount(
    0,
  );
});

test("saved preset results keep a completed empty result only for the same query", async ({
  page,
}) => {
  const { h, initial, refresh, invalidate } = await setup(
    page,
    "presets/preview",
    `presets/${preset}`,
  );
  const empty = page.getByRole("heading", {
    name: "No matching alerts",
    exact: true,
  });
  await expect(empty).toHaveCount(0);
  initial.release();
  await expect(empty).toBeVisible();
  await page.clock.runFor(LIVE_QUIET_MS + 500);
  h.block = refresh.promise;
  const reads = h.reads;
  await invalidate();
  await expect.poll(() => h.reads).toBeGreaterThan(reads);
  await expect(empty).toBeVisible();
  await page.getByLabel("Search text in results").fill("new query");
  await page.clock.runFor(400);
  await expect(
    page.getByText("Loading matching alerts…", { exact: true }),
  ).toBeVisible();
  await expect(empty).toHaveCount(0);
  refresh.release();
  await expect(empty).toBeVisible();
});

test("a populated alert feed stays in place during refresh and still warns on failure", async ({
  page,
}) => {
  const { h, initial, refresh, invalidate } = await setup(page, "alerts");
  h.rows = [
    {
      id: preset,
      message: "Retained alert",
      severity: "high",
      status: "firing",
      revision: "1",
    },
  ];
  initial.release();
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(table).toBeVisible();
  await page.clock.runFor(LIVE_QUIET_MS + 500);
  const before = await table.boundingBox();
  h.block = refresh.promise;
  const reads = h.reads;
  await invalidate();
  await expect.poll(() => h.reads).toBeGreaterThan(reads);
  expect(await table.boundingBox()).toEqual(before);
  const warning = page.getByText(
    "Previous successful results are shown while the requested snapshot is unavailable.",
  );
  await expect(warning).toHaveCount(0);
  h.failure = true;
  refresh.release();
  await expect(warning).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Retained alert", exact: true }),
  ).toBeVisible();
});
