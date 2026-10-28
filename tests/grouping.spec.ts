import { expect, test, type Page } from "@playwright/test";

/* REV-44 grouped Feed and preset results against controlled API fixtures. */

const tenant = "00000000-0000-4000-8000-000000000001";
const preset = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000004";

function alert(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
    revision: "3",
    message: `Synthetic alert ${n}`,
    severity: "critical",
    status: "firing",
    application: "payments-api",
    component: "db",
    schema_version: "v2",
    operator: "00000000-0000-4000-8000-000000000005",
    timestamp: "2026-10-26T12:00:00Z",
    ...extra,
  };
}

const severityGroups = [
  {
    key: "critical",
    total: "3",
    severity: { critical: "3", high: "0", warning: "0", clear: "0" },
    status: { firing: "2", acknowledged: "1", resolved: "0" },
    data: [alert(1), alert(2)],
    next_cursor: "critical-cursor",
  },
  {
    key: "high",
    total: "1",
    severity: { critical: "0", high: "1", warning: "0", clear: "0" },
    status: { firing: "1", acknowledged: "0", resolved: "0" },
    data: [alert(4, { severity: "high" })],
    next_cursor: null,
  },
];

async function setup(page: Page, options: { tooMany?: boolean } = {}) {
  const saved = {
    id: preset,
    revision: "7",
    name: "Payments on-call",
    cel: "true",
    columns: ["severity", "display_status", "message", "application"],
    sort: [{ field: "timestamp", direction: "desc" }],
    group_by: "application" as string | null,
  };
  const calls: {
    path: string;
    body?: Record<string, unknown>;
    query: URLSearchParams;
  }[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: me, display_name: "Test operator" },
          csrf_token: "grouping-test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Acme",
              kind: "specific",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body =
      route.request().method() === "POST"
        ? (route.request().postDataJSON() as Record<string, unknown>)
        : undefined;
    calls.push({ path, body, query: url.searchParams });
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/alerts/counts"))
      return route.fulfill({ json: { data: { counts: { all: "4" } } } });
    if (path.endsWith("/alerts/groups")) {
      if (options.tooMany)
        return route.fulfill({
          status: 422,
          json: {
            error: {
              code: "too_many_groups",
              message: "More than 1,000 values to group; narrow the query.",
            },
          },
        });
      if (body?.group_by === "application")
        return new Promise<void>((done) =>
          setTimeout(() => {
            void route
              .fulfill({
                json: {
                  data: [
                    {
                      key: "payments-api",
                      total: "4",
                      severity: {
                        critical: "3",
                        high: "1",
                        warning: "0",
                        clear: "0",
                      },
                      data: [alert(1)],
                      next_cursor: null,
                    },
                  ],
                  meta: {
                    total: "4",
                    group_count: "1",
                    group_by: "application",
                  },
                  next_group_cursor: null,
                },
              })
              .then(done);
          }, 1500),
        );
      return route.fulfill({
        json: {
          data: severityGroups,
          meta: { total: "4", group_count: "2", group_by: body?.group_by },
          next_group_cursor: null,
        },
      });
    }
    if (path.endsWith("/alerts")) {
      if (url.searchParams.get("group_key") === "critical")
        return route.fulfill({
          json: { data: [alert(3)], meta: { total: "3" }, next_cursor: null },
        });
      return route.fulfill({
        json: {
          data: [alert(1), alert(4, { severity: "high" })],
          meta: { total: "2" },
          next_cursor: null,
        },
      });
    }
    if (path.endsWith("/presets") && body) {
      Object.assign(saved, body, { revision: "1" });
      return route.fulfill({ status: 201, json: { data: saved } });
    }
    if (path.endsWith(`/presets/${preset}`))
      return route.fulfill({ json: { data: saved } });
    if (path.endsWith("/presets/preview/groups")) {
      const field = (body?.group_by as string | undefined) ?? saved.group_by;
      const groups =
        field === "display_status"
          ? [
              {
                key: "firing",
                total: "1",
                data: [alert(1)],
                next_cursor: null,
              },
              {
                key: "acknowledged",
                total: "1",
                data: [alert(2, { assignee_id: me })],
                next_cursor: null,
              },
            ]
          : [
              {
                key: "payments-api",
                total: "2",
                severity: {
                  critical: "2",
                  high: "0",
                  warning: "0",
                  clear: "0",
                },
                data: [alert(1), alert(2)],
                next_cursor: null,
              },
              {
                key: null,
                total: "1",
                severity: {
                  critical: "0",
                  high: "0",
                  warning: "1",
                  clear: "0",
                },
                data: [alert(5, { severity: "warning", application: "" })],
                next_cursor: null,
              },
            ];
      return route.fulfill({
        json: {
          data: groups,
          meta: {
            total: "3",
            group_count: String(groups.length),
            group_by: field,
            evaluated_at: "2026-10-26T12:00:10Z",
          },
          next_group_cursor: null,
        },
      });
    }
    if (path.endsWith("/presets/preview"))
      return route.fulfill({
        json: { data: [alert(1)], meta: { total: "1" }, next_cursor: null },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return { calls, saved };
}

test("Feed groups by severity with per-group tables, paging and collapse", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("button", { name: "Group by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Severity" }).click();
  const critical = page.getByRole("region", { name: "Critical, 3 alerts" });
  await expect(critical).toBeVisible();
  await expect(
    page.getByRole("region", { name: "High, 1 alert" }),
  ).toBeVisible();
  const request = calls.find((call) => call.path.endsWith("/alerts/groups"));
  expect(request?.body).toMatchObject({
    group_by: "severity",
    group_limit: 10,
    rows_per_group: 5,
  });
  const table = critical.getByRole("table", { name: "Alerts: Critical" });
  await expect(
    table.getByRole("columnheader", { name: "Severity" }),
  ).toHaveCount(0);
  await expect(
    table.getByRole("columnheader", { name: "Status" }),
  ).toBeVisible();
  await expect(critical.getByText("2 Firing")).toBeVisible();
  await expect(critical.getByText("Showing 2 of 3")).toBeVisible();
  await critical.getByRole("button", { name: "Show 1 more" }).click();
  await expect(
    table.getByRole("link", { name: "Open Synthetic alert 3" }),
  ).toBeVisible();
  const more = calls.find((call) => call.query.get("group_key") === "critical");
  expect(more?.query.get("group_by")).toBe("severity");
  expect(more?.query.get("cursor")).toBe("critical-cursor");
  await critical.getByRole("button", { name: "Show fewer" }).click();
  await expect(
    table.getByRole("link", { name: "Open Synthetic alert 3" }),
  ).toHaveCount(0);
  await critical
    .getByRole("checkbox", { name: "Select all shown in Critical" })
    .check();
  await expect(
    page.getByRole("toolbar", { name: "Bulk actions" }),
  ).toContainText("2 selected");
  await critical.getByRole("button", { name: /Critical/ }).click();
  await expect(table).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByRole("table")).toHaveCount(2);
  await expect(page.getByText("4 matching alerts")).toBeVisible();
  await page.getByRole("button", { name: "Group by Severity" }).click();
  await page.getByRole("menuitemradio", { name: "No grouping" }).click();
  await expect(
    page.getByRole("table", { name: "Alerts", exact: true }),
  ).toBeVisible();
});

test("switching the grouping field never shows the old groups under the new field", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("button", { name: "Group by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Severity" }).click();
  await expect(
    page.getByRole("region", { name: "Critical, 3 alerts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Group by Severity" }).click();
  await page.getByRole("menuitemradio", { name: "Application" }).click();
  await expect(
    page.getByRole("region", { name: "Critical, 3 alerts" }),
  ).toHaveCount(0);
  await expect(page.locator(".ag-head .ag-value")).toHaveCount(0);
  await expect(page.getByText("Loading alerts…")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "payments-api, 4 alerts" }),
  ).toBeVisible();
});

test("Feed keeps one table when there are too many values to group", async ({
  page,
}) => {
  await setup(page, { tooMany: true });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("button", { name: "Group by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Node" }).click();
  await expect(
    page.getByText(/Too many values to group by node/),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Alerts", exact: true }),
  ).toBeVisible();
});

test("Save as preset carries the Feed grouping into the new preset", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("button", { name: "Group by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Severity" }).click();
  await page.getByRole("button", { name: "Save as preset…" }).click();
  await page.getByRole("tab", { name: "Group by Severity" }).click();
  await expect(
    page
      .getByRole("radiogroup", { name: "Group by" })
      .getByRole("radio", { name: "Severity", exact: true }),
  ).toBeChecked();
  await page.getByLabel("Name", { exact: true }).fill("Grouped preset");
  await page
    .getByRole("button", { name: "Create preset", exact: true })
    .click();
  const create = calls.find(
    (call) =>
      call.path.endsWith("/presets") && call.body?.name === "Grouped preset",
  );
  expect(create?.body?.group_by).toBe("severity");
});

test("Saved preset groups by its saved field and changes it only for the view", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  await expect(
    page.getByText(/Grouped by application · sorted by/),
  ).toBeVisible();
  const payments = page.getByRole("region", { name: "payments-api, 2 alerts" });
  await expect(payments).toBeVisible();
  await expect(
    page.getByRole("region", { name: "No value, 1 alert" }),
  ).toBeVisible();
  const first = calls.find((call) =>
    call.path.endsWith("/presets/preview/groups"),
  );
  expect(first?.body).toMatchObject({
    preset_id: preset,
    expected_revision: "7",
  });
  expect(first?.body?.group_by).toBeUndefined();
  await page.getByRole("button", { name: "Group by Application" }).click();
  const menu = page.getByRole("menu", { name: "Group by Application" });
  await expect(
    menu.getByRole("menuitemradio", { name: /Application Saved/ }),
  ).toBeVisible();
  await expect(menu.getByText(/for this view only/)).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Status" }).click();
  await expect(
    page.getByRole("region", { name: "Acknowledged, 1 alert" }),
  ).toBeVisible();
  const override = calls
    .filter((call) => call.path.endsWith("/presets/preview/groups"))
    .at(-1);
  expect(override?.body).toMatchObject({
    group_by: "display_status",
    cel: "true",
  });
  expect(override?.body?.preset_id).toBeUndefined();
  await expect(
    page.getByText(/Grouped by application · sorted by/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(payments).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset", exact: true }),
  ).toHaveCount(0);
});

test("Preset editor saves the grouping field", async ({ page }) => {
  const { calls } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByLabel("Name", { exact: true }).fill("Editor grouping");
  await page.getByRole("tab", { name: "Group by", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Group by" })
    .getByRole("radio", { name: "Site", exact: true })
    .check();
  await expect(
    page.getByText("Each site gets its own table.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create preset", exact: true })
    .click();
  const create = calls.find(
    (call) =>
      call.path.endsWith("/presets") && call.body?.name === "Editor grouping",
  );
  expect(create?.body?.group_by).toBe("site");
});
