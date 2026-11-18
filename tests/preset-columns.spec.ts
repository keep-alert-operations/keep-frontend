import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-77; preset operations 6; UI acceptance.
 * Preset columns render in their saved order. The tenant is Global unless a
 * test says otherwise, so the alert is a native v1 alert as sent (`object`,
 * no site) and the column choices are the v1 ones; a specific tenant keeps
 * the v2 choices.
 */
const tenant = "00000000-0000-4000-8000-000000000001";
const preset = "00000000-0000-4000-8000-000000000002";
const row = {
  id: "00000000-0000-4000-8000-000000000003",
  revision: "9007199254740999",
  message: "Database latency",
  severity: "error",
  status: "firing",
  application: "Synthetic database",
  object: "Query service",
  schema_version: "v1",
  operator: "00000000-0000-4000-8000-000000000005",
  operator_display_name: "Payments",
  acknowledged: false,
  node_name: "Synthetic west",
  assignee_id: "00000000-0000-4000-8000-000000000004",
  assignee_display_name: "Test operator",
  timestamp: "2026-09-24T09:00:00Z",
};
// The same alert as v2, for a specific tenant.
const v2Row = {
  ...row,
  severity: "critical",
  object: undefined,
  component: "Query service",
  schema_version: "v2",
  node_name: "db-07",
  site: "Synthetic west",
};

async function setup(
  page: Page,
  columns = ["message", "node_name", "assignee_id", "timestamp"],
  suppressed = false,
  kind: "global" | "specific" = "global",
) {
  const alert = kind === "global" ? row : v2Row;
  const saved = {
    id: preset,
    revision: "7",
    name: "Custom columns",
    cel: "true",
    columns,
    sort: [{ field: "node_name", direction: "asc" }],
  };
  const creates: Array<{ columns: string[] }> = [];
  const previews: Record<string, unknown>[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: row.assignee_id, display_name: "Test operator" },
          csrf_token: "column-test-csrf",
          tenants: [
            {
              id: tenant,
              name: kind === "global" ? "Global" : "Local Demo",
              kind,
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/presets") && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      creates.push(body);
      Object.assign(saved, {
        name: body.name,
        cel: body.cel,
        columns: body.columns,
        sort: body.sort,
        revision: "1",
      });
      return route.fulfill({ status: 201, json: { data: saved } });
    }
    if (path.endsWith(`/presets/${preset}`))
      return route.fulfill({ json: { data: saved } });
    if (path.endsWith("/presets/preview")) {
      previews.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          data: [{ ...alert, suppressed }],
          meta: { total: "1" },
          next_cursor: null,
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return { creates, previews };
}

// Global defaults to v1 Object; a specific tenant keeps v2 Component (REV-77).
for (const [kind, field, label] of [
  ["global", "object", "Object"],
  ["specific", "component", "Component"],
] as const)
  for (const customize of [false, true]) {
    test(`new ${kind} preset renders its ${customize ? "customized" : "initial"} columns immediately after creation and reload`, async ({
      page,
    }) => {
      const { creates } = await setup(page, undefined, false, kind);
      await page.goto(`/tenants/${tenant}/presets/new`);
      await page.getByLabel("Name", { exact: true }).fill("New column preset");
      await page.getByRole("tab", { name: /^Columns/ }).click();
      if (customize) {
        await page
          .getByRole("button", { name: `Remove ${label}`, exact: true })
          .click();
        await page
          .getByRole("button", { name: "Move Alert up", exact: true })
          .click();
      }
      const labels = await page
        .getByRole("list", { name: "Columns, in order", exact: true })
        .locator(".pe-col-label")
        .allTextContents();
      await page
        .getByRole("button", { name: "Create preset", exact: true })
        .click();
      await expect(page).toHaveURL(`/tenants/${tenant}/presets/${preset}`);
      expect(creates).toHaveLength(1);
      if (!customize)
        expect(creates[0].columns).toEqual([
          "severity",
          "display_status",
          "message",
          "application",
          field,
          "timestamp",
          "assignee_id",
        ]);
      const headings = [
        "",
        ...labels.map((label) =>
          label === "Last received" ? `${label} ↓` : label,
        ),
        "Actions",
      ];
      const table = page.getByRole("table", { name: "Alerts", exact: true });
      await expect(table.getByRole("columnheader")).toHaveText(headings);
      await expect(
        table.getByRole("cell", { name: "Synthetic database", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(table.getByRole("columnheader")).toHaveText(headings);
      await page
        .getByRole("link", { name: "Edit preset", exact: true })
        .click();
      await expect(table.getByRole("columnheader")).toHaveText([
        "Selection",
        ...headings.slice(1, -1),
      ]);
      expect(creates).toHaveLength(1);
    });
  }

// In Global a saved v2 `component` column shows the v1 Object (REV-77).
test("saved presets adapt legacy acknowledgement columns without changing their stored definition", async ({
  page,
}) => {
  await setup(page, [
    "severity",
    "message",
    "status",
    "application",
    "component",
    "timestamp",
    "acknowledged",
    "assignee_id",
  ]);
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  await expect(
    page
      .getByRole("table", { name: "Alerts", exact: true })
      .getByRole("columnheader"),
  ).toHaveText([
    "",
    "Severity",
    "Alert",
    "Status",
    "Application",
    "Object",
    "Last received",
    "Assignee",
    "Actions",
  ]);
});

test("saved preset renders configured fields in order with its actual sort", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "",
    "Alert",
    "Node ↑",
    "Assignee",
    "Last received",
    "Actions",
  ]);
  await expect(
    table.getByRole("cell", { name: "Synthetic west", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("cell", { name: "Test operator (you)", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Node ↑" }),
  ).toHaveAttribute("aria-sort", "ascending");
  await table
    .getByRole("checkbox", { name: "Select Database latency", exact: true })
    .check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
});

test("preset column clicks temporarily replace saved sort and restore it on the third click", async ({
  page,
}) => {
  const { previews } = await setup(page);
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") saves.push(request.url());
  });
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  const heading = table.getByRole("columnheader", { name: "Last received" });
  const preview = () => previews.filter((body) => body.limit === 50).at(-1);
  await expect.poll(() => preview()?.preset_id).toBe(preset);

  await heading.getByRole("button").click();
  await expect
    .poll(() => preview()?.sort)
    .toEqual([{ field: "timestamp", direction: "asc" }]);
  await expect(
    table.getByRole("columnheader", { name: "Last received ↑" }),
  ).toHaveAttribute("aria-sort", "ascending");

  await table.getByRole("button", { name: "Last received ↑" }).click();
  await expect
    .poll(() => preview()?.sort)
    .toEqual([{ field: "timestamp", direction: "desc" }]);
  await expect(
    table.getByRole("columnheader", { name: "Last received ↓" }),
  ).toHaveAttribute("aria-sort", "descending");

  await table.getByRole("button", { name: "Last received ↓" }).click();
  await expect.poll(() => preview()?.preset_id).toBe(preset);
  await expect(
    table.getByRole("columnheader", { name: "Node ↑" }),
  ).toHaveAttribute("aria-sort", "ascending");
  expect(saves).toEqual([]);
});

test("operator column shows the managed name rather than its stable ID", async ({
  page,
}) => {
  await setup(page, ["message", "operator"]);
  await page.route(`**/alerts/${row.id}`, (route) =>
    route.fulfill({ json: { data: row } }),
  );
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(
    table.getByRole("cell", { name: "Payments", exact: true }),
  ).toBeVisible();
  await expect(table.getByText(row.operator, { exact: true })).toHaveCount(0);
  await table.getByRole("link", { name: "Open Database latency" }).click();
  await expect(page.getByText("Payments", { exact: true })).toBeVisible();
  await expect(page.getByText(row.operator, { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: "Presets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "← Back to preset" }),
  ).toHaveAttribute("href", `/tenants/${tenant}/presets/${preset}`);
});

test("draft column removal and reordering update the preview without saving", async ({
  page,
}) => {
  await setup(page);
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") saves.push(request.url());
  });
  await page.goto(`/tenants/${tenant}/presets/${preset}/edit`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(
    table.getByRole("columnheader", { name: "Node ↑" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Columns/ }).click();
  await page.getByRole("button", { name: "Move Node up", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove Last received", exact: true })
    .click();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Selection",
    "Node ↑",
    "Alert",
    "Assignee",
  ]);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  expect(saves).toEqual([]);
});

test("custom columns retain row navigation and suppression when message is hidden", async ({
  page,
}) => {
  await setup(page, ["node_name"], true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "",
    "Node ↑",
    "Actions",
  ]);
  await expect(table.getByText("Suppressed", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await table
    .getByRole("link", { name: "Open Database latency", exact: true })
    .click();
  await expect(page).toHaveURL(`/tenants/${tenant}/alerts/${row.id}`);
});
