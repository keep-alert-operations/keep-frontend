import { expect, test, type Page } from "@playwright/test";
const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const first = "00000000-0000-4000-8000-000000000030";
const second = "00000000-0000-4000-8000-000000000031";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const initial = {
  id,
  revision: "1",
  name: "Synthetic dashboard",
  panels: [
    {
      id: first,
      preset_id: preset,
      title: "First panel",
      x: 0,
      y: 0,
      w: 6,
      h: 2,
      thresholds: [],
    },
    {
      id: second,
      preset_id: preset,
      title: "Second panel",
      x: 6,
      y: 0,
      w: 6,
      h: 2,
      thresholds: [],
    },
  ],
};
const batch = (revision = "1", relative = false) => ({
  observation_id: "00000000-0000-4000-8000-000000000040",
  dashboard_revision: revision,
  preset_revisions: { [preset]: "3" },
  evaluated_at: "2026-09-23T12:00:00Z",
  relative,
  updating: false,
  updating_suppression: false,
  panels: [
    {
      panel_id: first,
      preset_id: preset,
      preset_name: "Saved preset",
      count: "9007199254740993",
    },
    {
      panel_id: second,
      preset_id: preset,
      preset_name: "Saved preset",
      count: "0",
    },
  ],
});
async function setup(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (String(input).endsWith("/events"))
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: state\ndata: {"view_generation":"1"}\n\n',
                  ),
                );
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      return fetch(input, options);
    };
  });
  const state = {
    definition: initial,
    calls: 0,
    relative: false,
    failure: false,
    conflicts: 0,
    partial: false,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic dashboard viewer" },
          csrf_token: "counts-csrf",
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: "view",
              kind: "specific",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path === api)
      return route.fulfill({ json: { data: state.definition } });
    if (path === api + "/counts") {
      state.calls++;
      expect(route.request().headers()["x-csrf-token"]).toBe("counts-csrf");
      if (state.conflicts > 0) {
        state.conflicts--;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "count_snapshot_changed",
              message: "Count context changed",
            },
          },
        });
      }
      if (state.failure)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "count_search_unavailable",
              message: "Search unavailable",
            },
          },
        });
      const value = batch(
        route.request().postDataJSON().expected_revision,
        state.relative,
      );
      return route.fulfill({
        json: {
          data: state.partial
            ? {
                ...value,
                panels: [
                  value.panels[0],
                  {
                    panel_id: second,
                    preset_id: preset,
                    error: { code: "unavailable" },
                  },
                ],
              }
            : value,
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return state;
}
async function open(page: Page) {
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Exact logical alerts");
  await page.clock.runFor(300);
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Exact logical alerts");
}

test("static dashboards issue no periodic counts and preserve exact partial and stale states", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  const before = state.calls;
  await page.clock.runFor(6000);
  expect(state.calls).toBe(before);
  state.partial = true;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(
    page.getByRole("article", { name: "Second panel count" }),
  ).toContainText("Unavailable");
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("9,007,199,254,740,993");
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Preset: Saved preset");
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Exact logical alerts");
  state.failure = true;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Search unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Previous observation · stale");
});

test("relative dashboards refresh each foreground second and pause or hide without querying", async ({
  page,
}) => {
  const state = await setup(page);
  state.relative = true;
  await open(page);
  const before = state.calls;
  await page.clock.runFor(1000);
  await expect.poll(() => state.calls).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Pause updates" }).click();
  const paused = state.calls;
  await page.clock.runFor(4000);
  expect(state.calls).toBe(paused);
  await page.getByRole("button", { name: "Resume updates" }).click();
  await expect.poll(() => state.calls).toBeGreaterThan(paused);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = state.calls;
  await page.clock.runFor(4000);
  expect(state.calls).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => state.calls).toBeGreaterThan(hidden);
});

test("refreshes coalesce behind one in-flight count without cancelling it", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  const before = state.calls;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  await page.route(`**${api}/counts`, async (route) => {
    waiting++;
    if (waiting === 1) await gate;
    await route.fulfill({ json: { data: batch() } }).catch(() => {});
  });
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect.poll(() => waiting).toBe(1);
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await page.clock.runFor(400);
  expect(waiting).toBe(1);
  release();
  await expect.poll(() => waiting).toBe(2);
  await expect(
    page.getByRole("article", { name: "First panel count" }),
  ).toContainText("Exact logical alerts");
  await page.clock.runFor(3000);
  expect(waiting).toBe(2);
  expect(state.calls).toBe(before);
});

test("a changed count context gets one fresh-definition retry then remains Updating", async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  state.definition = { ...initial, revision: "2" };
  state.conflicts = 1;
  const before = state.calls;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(page.locator(".db-status-text")).toContainText(
    /captured at .*dashboard revision 2/,
  );
  expect(state.calls).toBe(before + 2);
  state.conflicts = 2;
  const again = state.calls;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(
    page.getByText(
      "Updating: count context changed again. Refresh counts or wait for the next committed change.",
    ),
  ).toBeVisible();
  await page.clock.runFor(4000);
  expect(state.calls).toBe(again + 2);
});

test("fullscreen uses a modal focus boundary and Escape restores its opener", async ({
  page,
}) => {
  await setup(page);
  await open(page);
  const opener = page.getByRole("button", { name: "Fullscreen", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Synthetic dashboard",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeFocused();
  await page
    .locator('aside a[href$="/alerts"]')
    .evaluate((element: HTMLAnchorElement) => element.focus());
  expect(
    await page.evaluate(() =>
      document.querySelector("dialog")?.contains(document.activeElement),
    ),
  ).toBe(true);
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        document.querySelector("dialog")?.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await dialog.getByRole("button", { name: "Pause updates" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("link", { name: "Second panel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Pause updates" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("dashboard list exposes panel and editor metadata and resets paging when sort changes", async ({
  page,
}) => {
  await setup(page);
  const searches: URLSearchParams[] = [];
  await page.route(`**/api/tenants/${tenant}/dashboards?*`, (route) => {
    const params = new URL(route.request().url()).searchParams;
    searches.push(params);
    return route.fulfill({
      json: {
        data: [
          {
            ...initial,
            name: params.has("cursor")
              ? "Second page dashboard"
              : "First page dashboard",
            panel_count: "2",
            updated_by: preset,
            updated_at: "2026-09-23T12:00:00Z",
          },
        ],
        next_cursor: params.has("cursor") ? null : "next-page",
      },
    });
  });
  await page.goto(`/tenants/${tenant}/dashboards`);
  const card = page.getByRole("link", { name: /First page dashboard/ });
  await expect(card).toContainText("2 panels");
  await expect(card).toContainText(`updated by ${preset} (you)`);
  await expect(card).toHaveAttribute(
    "href",
    `/tenants/${tenant}/dashboards/${id}`,
  );
  expect(searches.at(-1)?.get("sort")).toBe("name");
  expect(searches.at(-1)?.get("direction")).toBe("asc");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /Second page dashboard/ }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Sort dashboards by", exact: true })
    .selectOption("updated_at:desc");
  await expect(
    page.getByRole("link", { name: /First page dashboard/ }),
  ).toBeVisible();
  await expect.poll(() => searches.at(-1)?.get("sort")).toBe("updated_at");
  expect(searches.at(-1)?.get("direction")).toBe("desc");
  expect(searches.at(-1)?.has("cursor")).toBe(false);
});

test("viewers see counts without edit or delete actions and the whole panel opens its preset", async ({
  page,
}) => {
  await setup(page);
  await open(page);
  await expect(page.getByRole("link", { name: "Edit dashboard" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "More dashboard actions", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Delete dashboard" }),
  ).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "History" })).toBeVisible();
  await page.keyboard.press("Escape");
  const link = page.getByRole("link", { name: "First panel", exact: true });
  await expect(link).toHaveAttribute(
    "href",
    `/tenants/${tenant}/presets/${preset}?from=dashboard`,
  );
  const box = await page
    .getByRole("article", { name: "First panel count" })
    .boundingBox();
  await page.mouse.click(box!.x + box!.width - 20, box!.y + box!.height - 12);
  await expect(page).toHaveURL(
    new RegExp(`/presets/${preset}\\?from=dashboard$`),
  );
});
