import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-54; alert operations 3.
 * The alert name is the title in the Feed, alert detail and dismiss dialog,
 * with the message under it; v1 alerts have no name and keep their message.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const namedId = "00000000-0000-4000-8000-000000000011";
const unnamedId = "00000000-0000-4000-8000-000000000012";
const legacyId = "00000000-0000-4000-8000-000000000013";
const key = "3f9a6b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e";
const base = {
  application: "payments",
  component: "postgres",
  severity: "critical",
  status: "firing",
  assignee_id: null,
  suppressed: false,
  timestamp: "2026-10-31T11:00:00Z",
  schema_version: "v2",
};
const rows = [
  {
    ...base,
    id: namedId,
    revision: "2",
    key_field: "a".repeat(64),
    name: "High CPU",
    message: "CPU above 90% for 10 minutes",
  },
  {
    ...base,
    id: unnamedId,
    revision: "3",
    key_field: key,
    name: key,
    message: "Disk usage above 95%",
  },
  {
    ...base,
    id: legacyId,
    revision: "4",
    schema_version: "v1",
    key_field: "v1:8:payments8:postgres2:n1",
    name: null,
    message: "Legacy replication lag",
  },
];

async function setup(page: Page) {
  const groups: unknown[] = [];
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
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/alerts/groups")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      groups.push(body.group_by);
      return route.fulfill({
        json: {
          data: [
            {
              key: "High CPU",
              total: "1",
              severity: { critical: "1", high: "0", warning: "0", clear: "0" },
              data: [rows[0]],
              next_cursor: null,
            },
          ],
          meta: { total: "1", group_count: "1", group_by: body.group_by },
          next_group_cursor: null,
        },
      });
    }
    if (path.endsWith("/alerts"))
      return route.fulfill({
        json: { data: rows, meta: { total: "3" }, next_cursor: null },
      });
    if (path.endsWith(`/alerts/${namedId}`))
      return route.fulfill({ json: { data: rows[0] } });
    return route.fulfill({
      json: { data: [], meta: { total: "0" }, next_cursor: null },
    });
  });
  return { groups };
}

test("the Feed titles each alert by its name with the message under it", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const named = page.locator(`[data-alert-id="${namedId}"]`);
  await expect(
    named.getByRole("link", { name: "Open High CPU", exact: true }),
  ).toHaveText("High CPU");
  await expect(named.locator(".alert-sub")).toHaveText(
    "CPU above 90% for 10 minutes",
  );
  const unnamed = page.locator(`[data-alert-id="${unnamedId}"]`);
  await expect(unnamed.locator(".msg")).toHaveText(key);
  await expect(unnamed.locator(".alert-sub")).toHaveText(
    "Disk usage above 95%",
  );
  const legacy = page.locator(`[data-alert-id="${legacyId}"]`);
  await expect(legacy.locator(".msg")).toHaveText("Legacy replication lag");
  await expect(legacy.locator(".alert-sub")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Actions for High CPU", exact: true }),
  ).toBeVisible();
});

test("the Feed can group alerts by name", async ({ page }) => {
  const { groups } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("button", { name: "Group by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Alert name" }).click();
  await expect(
    page.getByRole("button", { name: "Group by Alert name" }),
  ).toBeVisible();
  await expect.poll(() => groups).toContain("name");
});

test("alert detail and the dismiss dialog use the name", async ({ page }) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${namedId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("High CPU");
  await expect(page.locator(".alert-detail-message")).toHaveText(
    "CPU above 90% for 10 minutes",
  );
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Actions for High CPU", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect(page.locator(".dismiss-alert")).toHaveText("High CPU");
});
