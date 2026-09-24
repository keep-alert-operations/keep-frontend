import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const alertId = "00000000-0000-4000-8000-000000000002";
const row = {
  id: alertId,
  revision: "9007199254740999",
  message: "Database latency",
  application: "payments",
  component: "postgres",
  severity: "critical",
  status: "firing",
  acknowledged: false,
  assignee_id: null,
};
async function setup(page: Page, role = "admin") {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: alertId, display_name: "Design reviewer" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
              kind: "global",
              role,
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
    return route.fulfill({
      json: {
        data: path.endsWith("/alerts") ? [row] : [],
        meta: { total: "1" },
        next_cursor: null,
      },
    });
  });
}

test("quick views compose with applied CEL and search without saving a preset", async ({
  page,
}) => {
  await setup(page);
  const queries: URLSearchParams[] = [];
  await page.route("**/api/tenants/*/alerts?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { data: [row], meta: { total: "1" } } });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByLabel("CEL expression", { exact: true })
    .fill('alert.application == "payments"');
  await page.getByLabel("Search text", { exact: true }).fill("latency");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.getByRole("button", { name: "Critical", exact: true }).click();
  await expect
    .poll(() => queries.at(-1)?.get("cel"))
    .toBe(
      '(alert.application == "payments") && (alert.severity == "critical")',
    );
  expect(queries.at(-1)?.get("q")).toBe("latency");
  await page.getByLabel("Include suppressed").check();
  await expect
    .poll(() => queries.at(-1)?.get("include_suppressed"))
    .toBe("true");
  await expect(
    page.getByText("1 matching alerts", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Query and freshness")).toHaveCount(0);
  await page.getByLabel("Rows per page").selectOption("100");
  await expect.poll(() => queries.at(-1)?.get("limit")).toBe("100");
  expect(queries.at(-1)?.get("cursor")).toBeNull();
  await page.getByRole("button", { name: "Save as preset…" }).click();
  // The preset editor may label its filter "Filter (CEL)" (reference S06).
  await expect(
    page.getByLabel(/^(CEL expression|Filter \(CEL\))$/),
  ).toHaveValue('alert.application == "payments"');
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
});

test("row acknowledgement sends the observed revision and select-all captures the displayed rows", async ({
  page,
}) => {
  await setup(page);
  let command: Record<string, unknown> | undefined;
  await page.route(`**/alerts/${alertId}/commands`, (route) => {
    command = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
    return route.fulfill({
      json: {
        data: { ...row, acknowledged: true, revision: "9007199254741000" },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("link", { name: "Open Database latency" }).hover();
  await page.getByRole("button", { name: "Ack", exact: true }).click();
  await expect.poll(() => command?.kind).toBe("set_acknowledged");
  expect(command?.value).toBe(true);
  expect(command?.expected_revision).toBe(row.revision);
  await page.getByLabel("Select all on this page").check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByLabel("Select all on this page").uncheck();
  await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0);
});

test("reference palette and rail remain stable under dark OS preference and narrow layouts", async ({
  page,
}) => {
  await setup(page, "view");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(
    page.getByRole("heading", { name: "All alerts", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(246, 245, 242)",
  );
  await expect(page.locator(".rail")).toHaveCSS("width", "76px");
  await expect(
    page.getByRole("button", { name: "Save as preset…" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ack", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();
  await page.getByRole("button", { name: /^Account:/ }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
});

test("alert detail uses list context, readable history and confirmed note deletion", async ({
  page,
}) => {
  await setup(page);
  const second = {
    ...row,
    id: "00000000-0000-4000-8000-000000000003",
    message: "Queue backlog",
  };
  const detailPath = `/api/tenants/${tenant}/alerts/${alertId}`;
  let command: Record<string, unknown> | undefined;
  let deletion: Record<string, string> | undefined;
  await page.route("**/api/tenants/*/alerts?*", (route) =>
    route.fulfill({ json: { data: [row, second], meta: { total: "2" } } }),
  );
  await page.route(`**${detailPath}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === detailPath)
      return route.fulfill({
        json: {
          data: {
            ...row,
            operator: "pg-exporter",
            runbook_url: "https://runbooks.example/latency",
            active_incident_id: "00000000-0000-4000-8000-000000000010",
            active_incident_title: "Payments DB degradation",
          },
        },
      });
    if (url.pathname === detailPath + "/history")
      return route.fulfill({
        json: {
          data: [
            {
              id: "h1",
              kind: "source",
              recorded_at: "2026-09-24T06:18:22Z",
              evidence: {
                before: { ...row, severity: "high" },
                after: { ...row, operator: "pg-exporter" },
              },
            },
            {
              id: "h2",
              kind: "set_acknowledged",
              recorded_at: "2026-09-24T06:20:00Z",
              actor_id: "00000000-0000-4000-8000-000000000077",
              actor_display_name: "r.lee",
              evidence: { before: row, after: { ...row, acknowledged: true } },
            },
          ],
          next_cursor: null,
        },
      });
    if (url.pathname === detailPath + "/notes")
      return route.fulfill({
        json: {
          data: [
            {
              id: "n1",
              text: "Watching WAL volume",
              created_at: "2026-09-24T06:33:02Z",
              actor_id: "00000000-0000-4000-8000-000000000077",
              actor_display_name: "r.lee",
            },
          ],
          next_cursor: null,
        },
      });
    if (url.pathname === detailPath + "/notes/n1") {
      deletion = route.request().headers();
      return route.fulfill({ json: { data: { id: "n1", deleted: true } } });
    }
    if (url.pathname === detailPath + "/commands") {
      command = route.request().postDataJSON();
      return route.fulfill({
        json: {
          data: { ...row, acknowledged: true, revision: "9007199254741000" },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("link", { name: "Open Database latency" }).click();
  await expect(
    page.getByRole("heading", { name: "Database latency", level: 1 }),
  ).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "All alerts" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous alert in list" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Next alert in list" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Severity changed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("from High to Critical by the source.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Acknowledged.", { exact: true })).toBeVisible();
  await expect(page.getByText("Event details")).toHaveCount(0);
  await expect(page.getByText("All current alert fields")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Payments DB degradation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open runbook ↗" }),
  ).toHaveAttribute("href", "https://runbooks.example/latency");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect.poll(() => command?.kind).toBe("set_acknowledged");
  expect(command?.expected_revision).toBe(row.revision);
  expect(command?.value).toBe(true);
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this note?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(deletion).toBeUndefined();
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete note" }).click();
  await expect.poll(() => deletion?.["if-match"]).toBe('"9007199254741000"');
  expect(deletion?.["x-csrf-token"]).toBe("test-csrf");
  expect(deletion?.["idempotency-key"]).toBeTruthy();
  await page.getByRole("button", { name: "Next alert in list" }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${second.id}$`));
});
