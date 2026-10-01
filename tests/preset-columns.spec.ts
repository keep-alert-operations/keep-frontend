import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const preset = "00000000-0000-4000-8000-000000000002";
const row = {
  id: "00000000-0000-4000-8000-000000000003",
  revision: "9007199254740999",
  message: "Database latency",
  severity: "critical",
  status: "firing",
  application: "Synthetic database",
  component: "Query service",
  schema_version: "v2",
  operator: "00000000-0000-4000-8000-000000000005",
  operator_display_name: "Payments",
  acknowledged: false,
  site: "Synthetic west",
  assignee_id: "00000000-0000-4000-8000-000000000004",
  assignee_display_name: "Test operator",
  timestamp: "2026-09-24T09:00:00Z",
};

async function setup(
  page: Page,
  columns = ["message", "site", "assignee_id", "timestamp"],
  suppressed = false,
) {
  const saved = {
    id: preset,
    revision: "7",
    name: "Custom columns",
    cel: "true",
    columns,
    sort: [{ field: "site", direction: "asc" }],
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
              name: "Global",
              kind: "global",
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
          data: [{ ...row, suppressed }],
          meta: { total: "1" },
          next_cursor: null,
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return { creates, previews };
}

for (const customize of [false, true]) {
  test(`new preset renders its ${customize ? "customized" : "initial"} columns immediately after creation and reload`, async ({
    page,
  }) => {
    const { creates } = await setup(page);
    await page.goto(`/tenants/${tenant}/presets/new`);
    await page.getByLabel("Name", { exact: true }).fill("New column preset");
    if (customize) {
      await page
        .getByRole("button", { name: "Remove Component", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Move Message up", exact: true })
        .click();
    }
    const labels = await page
      .getByRole("list", { name: "Columns", exact: true })
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
        "component",
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
    await page.getByRole("link", { name: "Edit preset", exact: true }).click();
    await expect(table.getByRole("columnheader")).toHaveText([
      "Selection",
      ...headings.slice(1, -1),
    ]);
    expect(creates).toHaveLength(1);
  });
}

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
    "Message",
    "Status",
    "Application",
    "Component",
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
    "Message",
    "Site ↑",
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
    table.getByRole("columnheader", { name: "Site ↑" }),
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
    table.getByRole("columnheader", { name: "Site ↑" }),
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
    table.getByRole("columnheader", { name: "Site ↑" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Move Site up", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove Last received", exact: true })
    .click();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Selection",
    "Site ↑",
    "Message",
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
  await setup(page, ["site"], true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "",
    "Site ↑",
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
