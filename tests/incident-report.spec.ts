import { expect, test, type Page } from "@playwright/test";

/**
 * Requirements: REV-53; incident operations 14, 20; system completion 3, 4.
 * The Reports page against a synthetic incident report API.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const reader = "00000000-0000-4000-8000-000000000002";
const ruleKept = "00000000-0000-4000-8000-0000000000a1";
const ruleDeleted = "00000000-0000-4000-8000-0000000000a2";
// 14:30 on Thursday 29 October 2026 in Jerusalem, four days after its DST change.
const now = new Date("2026-10-29T12:30:00Z");
const retained = "2026-07-31T21:00:00.000000Z";

test.use({ timezoneId: "Asia/Jerusalem" });

type Mode = "ready" | "empty" | "partial" | "error";

function figures(
  row: Record<string, unknown>,
  opened: number,
  resolved: number,
) {
  return {
    ...row,
    opened: String(opened),
    resolved: String(resolved),
    reopened: String(Math.min(1, resolved)),
    first_response_median_seconds: opened ? "540" : null,
    time_to_resolve_median_seconds: resolved ? "11520" : null,
  };
}

function report(url: URL, mode: Mode) {
  const from = url.searchParams.get("from")!;
  const to = url.searchParams.get("to")!;
  const compare = url.searchParams.get("compare") === "true";
  const coveredFrom = Date.parse(from) < Date.parse(retained) ? retained : from;
  const span = Date.parse(to) - Date.parse(coveredFrom);
  const bin =
    span <= 25 * 3_600_000 ? "hour" : span <= 45 * 86_400_000 ? "day" : "week";
  const step = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }[bin];
  const empty = mode === "empty";
  const series = [];
  for (
    let start = Date.parse(coveredFrom), index = 0;
    start < Date.parse(to);
    start += step, index++
  )
    series.push({
      start: new Date(start).toISOString(),
      opened: empty ? "0" : String(index % 3),
      resolved: empty ? "0" : String((index + 1) % 3),
    });
  const previousAllowed = compare && coveredFrom === from && bin !== "week";
  const assignments = mode !== "partial";
  const summary = (
    opened: number,
    resolved: number,
    response: number,
    resolve: number,
    reopened: number,
  ) => ({
    opened: String(opened),
    opened_new: String(opened - reopened),
    opened_reopened: String(reopened),
    resolved: String(resolved),
    resolved_by_cause: {
      manual: String(Math.ceil(resolved * 0.6)),
      alerts_resolved: String(resolved - Math.ceil(resolved * 0.6)),
      inactivity: "0",
    },
    reopened: String(reopened),
    time_to_resolve: resolved
      ? { median_seconds: String(resolve), p90_seconds: "108000" }
      : null,
    first_response: assignments
      ? {
          median_seconds: opened ? String(response) : null,
          p90_seconds: opened ? "2820" : null,
          responded: String(opened),
          waiting: "0",
        }
      : null,
  });
  return {
    data: {
      period: {
        requested_from: from,
        requested_to: to,
        covered_from: coveredFrom,
        covered_to: to,
        retention_from: retained,
        time_zone: url.searchParams.get("time_zone"),
        bin,
      },
      previous: previousAllowed
        ? {
            from: new Date(
              Date.parse(from) -
                Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) *
                  86_400_000,
            ).toISOString(),
            to: from,
          }
        : null,
      previous_unavailable: !compare
        ? "not_requested"
        : previousAllowed
          ? null
          : "past_retention",
      summary: empty ? summary(0, 0, 0, 0, 0) : summary(48, 51, 540, 11520, 5),
      previous_summary: previousAllowed ? summary(41, 44, 840, 13800, 3) : null,
      series,
      breakdowns: {
        severity: [
          figures({ severity: "critical" }, empty ? 0 : 7, empty ? 0 : 8),
          figures({ severity: "high" }, empty ? 0 : 15, empty ? 0 : 16),
          figures({ severity: "medium" }, empty ? 0 : 18, empty ? 0 : 19),
          figures({ severity: "low" }, empty ? 0 : 8, empty ? 0 : 8),
        ],
        origin: [
          figures({ origin: "correlation" }, empty ? 0 : 31, empty ? 0 : 33),
          figures({ origin: "manual" }, empty ? 0 : 17, empty ? 0 : 18),
        ],
        rule: {
          rows: empty
            ? []
            : [
                figures(
                  {
                    rule_id: ruleKept,
                    name: "Checkout errors",
                    deleted: false,
                  },
                  9,
                  10,
                ),
                figures(
                  { rule_id: ruleDeleted, name: "TLS expiry", deleted: true },
                  1,
                  1,
                ),
              ],
          other: null,
        },
        assignee: assignments
          ? {
              rows: empty
                ? []
                : [
                    figures(
                      { assignee_id: reader, display_name: "Dana Levi" },
                      13,
                      14,
                    ),
                    figures({ assignee_id: null, display_name: null }, 8, 7),
                  ],
              other: null,
            }
          : null,
      },
      unavailable: assignments ? [] : ["first_response", "assignee"],
    },
    meta: { computed_at: now.toISOString() },
  };
}

async function setup(page: Page, options: { theme?: "dark" } = {}) {
  const state = {
    mode: "ready" as Mode,
    delay: 0,
    reports: [] as URLSearchParams[],
    incidents: [] as URLSearchParams[],
  };
  await page.clock.setFixedTime(now);
  await page.addInitScript((theme) => {
    if (theme) localStorage.setItem("keep-theme", theme);
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input === "string" && input.endsWith("/events"))
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: state\ndata: {"view_generation":"1"}\n\n',
                  ),
                );
                init?.signal?.addEventListener("abort", () =>
                  controller.close(),
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      return original(input, init);
    };
  }, options.theme);
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: reader, display_name: "Dana Levi" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Acme Retail",
              kind: "specific",
              role: "view",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (url.pathname.endsWith("/health"))
      return route.fulfill({
        json: { data: { source: "healthy", search: "healthy" } },
      });
    if (url.pathname.endsWith("/reports/incidents")) {
      state.reports.push(url.searchParams);
      if (state.delay)
        await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (state.mode === "error")
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "query_deadline",
              message:
                "Required capability is unavailable. Retry after recovery.",
              request_id: "3f9a2c71-0b4e-4f1d-9e2a-6c51d08b7a14",
            },
          },
        });
      return route.fulfill({ json: report(url, state.mode) });
    }
    if (url.pathname.endsWith("/incidents")) {
      if (url.searchParams.has("sort")) state.incidents.push(url.searchParams);
      return route.fulfill({ json: { data: [], next_cursor: null } });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return state;
}

const summary = (page: Page) =>
  page.getByRole("region", { name: "Incident summary" });

test("Reports opens the last 30 days with comparison, figures and breakdown", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(`/tenants/${tenant}/reports`);
  await expect(
    page.getByRole("heading", { name: "Reports", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Reports" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  // Thirty calendar days in the viewer's zone, including today, up to now.
  expect(Object.fromEntries(state.reports[0])).toEqual({
    from: "2026-09-29T21:00:00.000Z",
    to: "2026-10-29T12:30:00.000Z",
    time_zone: "Asia/Jerusalem",
    compare: "true",
  });
  await expect(
    page.getByText("30 Sep – 29 Oct 2026", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("vs 31 Aug – 29 Sep", { exact: true }),
  ).toBeVisible();
  await expect(summary(page).getByText("43 new · 5 reopened")).toBeVisible();
  await expect(summary(page).getByText("9 min", { exact: true })).toBeVisible();
  await expect(summary(page).getByText("↓ 36% from 14 min")).toBeVisible();
  await expect(
    summary(page).getByText("3 h 12 min", { exact: true }),
  ).toBeVisible();
  await expect(summary(page).getByText("9.8%", { exact: true })).toBeVisible();
  await expect(summary(page).getByText("↑ 3.0 pts from 6.8%")).toBeVisible();
  await expect(page.getByText("Computed just now")).toBeVisible();
  const cause = page.getByRole("region", { name: "Resolution cause" });
  await expect(
    cause.getByText("Automatic inactivity resolution is off"),
  ).toBeVisible();

  const breakdown = page.getByRole("region", { name: "Breakdown" });
  await expect(breakdown.getByRole("link", { name: "Critical" })).toBeVisible();
  await breakdown.getByRole("button", { name: "Correlation rule" }).click();
  await expect(
    breakdown.getByRole("button", { name: "Correlation rule" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(breakdown.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(
    breakdown.getByText("17 manual incidents have no rule and are not listed."),
  ).toBeVisible();
  await breakdown.getByRole("button", { name: "Assignee" }).click();
  await expect(
    breakdown.getByRole("link", { name: "Dana Levi (you)" }),
  ).toBeVisible();
  await expect(
    breakdown.getByRole("link", { name: "Unassigned" }),
  ).toBeVisible();

  // A row opens the Incidents list already filtered by the group and created time.
  await breakdown.getByRole("button", { name: "Correlation rule" }).click();
  await breakdown.getByRole("link", { name: "Checkout errors" }).click();
  await expect(page).toHaveURL(/\/incidents\?/);
  await expect.poll(() => state.incidents.length).toBeGreaterThan(0);
  expect(Object.fromEntries(state.incidents.at(-1)!)).toMatchObject({
    view: "all",
    rule_id: ruleKept,
    created_from: "2026-09-29T21:00:00Z",
    created_to: "2026-10-29T12:30:00Z",
  });
});

test("periods, comparison and the retention horizon", async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/tenants/${tenant}/reports`);
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  const period = page.getByRole("group", { name: "Period" });

  await period.getByRole("button", { name: "90 days" }).click();
  await expect(
    page.getByText("No comparison: the previous period is past retention"),
  ).toBeVisible();
  expect(state.reports.at(-1)!.get("from")).toBe("2026-07-31T21:00:00.000Z");
  await expect(
    page.getByRole("heading", { name: "Opened and resolved, per week" }),
  ).toBeVisible();

  await period.getByRole("button", { name: "Custom" }).click();
  const dialog = page.getByRole("dialog", { name: "Custom period" });
  await dialog.getByLabel("From").fill("2026-05-01");
  await expect(
    dialog.getByText(/so this report starts on 1 Aug/),
  ).toBeVisible();
  await dialog.getByLabel("To").fill("2026-04-01");
  await expect(dialog.getByRole("alert")).toHaveText(
    "Choose a From date on or before the To date.",
  );
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByLabel("To").fill("2026-10-29");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();
  expect(state.reports.at(-1)!.get("from")).toBe("2026-04-30T21:00:00.000Z");
  await expect(
    page.getByRole("status").filter({ hasText: "This report covers" }),
  ).toContainText(
    "This report covers 1 Aug – 29 Oct 2026, not the full 1 May – 29 Oct 2026 you chose.",
  );

  await period.getByRole("button", { name: "24 hours" }).click();
  await expect(page.getByText("28 Oct, 14:30 – 29 Oct, 14:30")).toBeVisible();
  expect(state.reports.at(-1)!.get("from")).toBe("2026-10-28T12:30:00.000Z");
  await expect(
    page.getByRole("heading", { name: "Opened and resolved, per hour" }),
  ).toBeVisible();

  await page.getByLabel("Compare with previous period").uncheck();
  expect(state.reports.at(-1)!.get("compare")).toBe("false");
  await expect(summary(page).getByText(/% from|pts from/)).toHaveCount(0);
});

test("first load, empty period, partial history and failure", async ({
  page,
}) => {
  const state = await setup(page);
  state.delay = 1500;
  await page.goto(`/tenants/${tenant}/reports`);
  // Before the first result: placeholders, never an empty claim.
  await expect(page.getByText("Computing…")).toBeVisible();
  await expect(page.getByText("No incidents opened or resolved")).toHaveCount(
    0,
  );
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  state.delay = 0;

  state.mode = "empty";
  await page
    .getByRole("group", { name: "Period" })
    .getByRole("button", { name: "24 hours" })
    .click();
  await expect(page.getByText("No incidents opened or resolved")).toBeVisible();
  await expect(
    page.getByText("No incidents resolved in this period."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show last 7 days" }).click();
  expect(state.reports.at(-1)!.get("from")).toBe("2026-10-22T21:00:00.000Z");

  state.mode = "partial";
  await page.getByRole("button", { name: "Refresh" }).click();
  const warning = page
    .getByRole("status")
    .filter({ hasText: "Assignment history could not be read in time" });
  await expect(warning).toBeVisible();
  await expect(summary(page).getByText("Unavailable for now")).toBeVisible();
  await page
    .getByRole("region", { name: "Breakdown" })
    .getByRole("button", { name: "Assignee" })
    .click();
  await expect(
    page.getByText(
      "Assignment history could not be read in time, so this breakdown is unavailable for now.",
    ),
  ).toBeVisible();
  state.mode = "ready";
  const before = state.reports.length;
  await warning.getByRole("button", { name: "Retry" }).click();
  await expect(warning).toBeHidden();
  expect(state.reports.length).toBeGreaterThan(before);

  state.mode = "error";
  await page
    .getByRole("group", { name: "Period" })
    .getByRole("button", { name: "90 days" })
    .click();
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Reports couldn't be computed" });
  await expect(failure).toContainText(
    "Request 3f9a2c71-0b4e-4f1d-9e2a-6c51d08b7a14",
  );
  state.mode = "ready";
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
});

test("refresh keeps the figures until the new report arrives", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(`/tenants/${tenant}/reports`);
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  state.delay = 1500;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Refreshing…")).toBeVisible();
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  await expect(page.getByText("Computed just now")).toBeVisible();
});

test("definitions and the chart table work from the keyboard", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/reports`);
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  const info = page.getByRole("button", { name: "How opened is measured" });
  await info.focus();
  await page.keyboard.press("Enter");
  await expect(info).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("note")).toContainText(
    "new incidents plus reopenings",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("note")).toHaveCount(0);
  await page.getByRole("button", { name: "View as table" }).click();
  const table = page.getByRole("table", {
    name: "Opened and resolved incident cycles",
  });
  await expect(
    table.getByRole("columnheader", { name: "Resolved" }),
  ).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(31);
  await expect(page.getByRole("img", { name: /Bar chart/ })).toHaveCount(0);
});

test("dark theme and phone width keep the report readable", async ({
  page,
}) => {
  await setup(page, { theme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tenants/${tenant}/reports`);
  await expect(summary(page).getByText("48", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bar = page.locator(".rp-bar").first();
  await expect(bar).toHaveCSS("background-color", "rgb(47, 143, 207)");
  const columns = await summary(page).evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(columns).toBe(2);
  // Nothing scrolls the page sideways; the breakdown table scrolls inside its panel.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const box = page.locator(".rp-tablebox");
  expect(
    await box.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
});
