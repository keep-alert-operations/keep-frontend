import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-55; alert operations 3 and 24; preset operations 4.
 * Alert detail shows where an alert came from and links to the Grafana rule
 * that fired it; Provider is a preset column and editor choice.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const preset = "00000000-0000-4000-8000-000000000002";
const grafanaId = "00000000-0000-4000-8000-000000000021";
const apiId = "00000000-0000-4000-8000-000000000022";
const pendingId = "00000000-0000-4000-8000-000000000023";
const rule =
  "https://grafana.example.org/alerting/grafana/cpu-rule/view?orgId=1";
const base = {
  application: "payments",
  component: "postgres",
  severity: "critical",
  status: "firing",
  assignee_id: null,
  suppressed: false,
  timestamp: "2026-10-31T11:00:00Z",
  schema_version: "v2",
  revision: "2",
};
const rows = [
  {
    ...base,
    id: grafanaId,
    name: "High CPU",
    message: "CPU above 90%",
    provider: "grafana",
    alert_rule_url: rule,
  },
  {
    ...base,
    id: apiId,
    name: "Disk full",
    message: "Disk usage above 95%",
    provider: "api",
    alert_rule_url: null,
  },
  {
    ...base,
    id: pendingId,
    name: "Replication lag",
    message: "Stored before providers existed",
    provider: null,
    alert_rule_url: null,
  },
];

async function setup(page: Page) {
  const saved = {
    id: preset,
    revision: "3",
    name: "Providers",
    cel: 'provider == "grafana" || provider == "api" || provider == null',
    columns: ["message", "provider"],
    sort: [{ field: "timestamp", direction: "desc" }],
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "reviewer", display_name: "Design reviewer" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
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
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith(`/presets/${preset}`))
      return route.fulfill({ json: { data: saved } });
    if (path.endsWith("/presets/preview") || path.endsWith("/alerts"))
      return route.fulfill({
        json: { data: rows, meta: { total: "3" }, next_cursor: null },
      });
    for (const row of rows)
      if (path.endsWith(`/alerts/${row.id}`))
        return route.fulfill({ json: { data: row } });
    return route.fulfill({
      json: { data: [], meta: { total: "0" }, next_cursor: null },
    });
  });
}

test("a Grafana alert shows its provider and opens its rule in a new tab", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${grafanaId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("High CPU");
  const provider = page.locator(".fld", { hasText: "Provider" });
  await expect(provider.locator("dd")).toHaveText("Grafana");
  const link = page.getByRole("link", { name: "Open alert rule" });
  await expect(link).toHaveAttribute("href", rule);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("API alerts have no rule link and unfilled ones show a dash", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${apiId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Disk full");
  const provider = page.locator(".fld", { hasText: "Provider" });
  await expect(provider.locator("dd")).toHaveText("API");
  await expect(page.getByRole("link", { name: "Open alert rule" })).toHaveCount(
    0,
  );
  await page.goto(`/tenants/${tenant}/alerts/${pendingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Replication lag",
  );
  await expect(provider.locator("dd")).toHaveText("—");
});

test("a preset shows the Provider column and the editor offers it", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${preset}`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(
    table.getByRole("columnheader", { name: "Provider", exact: true }),
  ).toBeVisible();
  for (const [id, label] of [
    [grafanaId, "Grafana"],
    [apiId, "API"],
    [pendingId, "—"],
  ])
    await expect(
      table.locator(`[data-alert-id="${id}"]`).getByRole("cell", {
        name: label,
        exact: true,
      }),
    ).toBeVisible();
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByRole("tab", { name: /^Columns/ }).click();
  await expect(
    page.locator(".pe-add-list").getByText("Provider", { exact: true }),
  ).toBeVisible();
});
