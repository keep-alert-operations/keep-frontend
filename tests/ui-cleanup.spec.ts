import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-43; shared system 3; alert operations 17.
 * The quieter Feed, preset and alert detail screens: a row ⋯ menu, no Active
 * quick view, plain row labels, relative times and no revision numbers.
 */
test.use({ timezoneId: "UTC" });

const tenant = "00000000-0000-4000-8000-000000000001";
const alertId = "00000000-0000-4000-8000-000000000002";
const presetId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-10-26T12:00:00Z");
const row = {
  id: alertId,
  revision: "9007199254740999",
  message: "Database latency",
  application: "payments",
  component: "postgres",
  node_name: "db-07",
  site: "eu-west-1",
  severity: "critical",
  status: "firing",
  assignee_id: null,
  timestamp: "2026-10-26T10:00:00Z",
  first_received_at: "2026-10-23T12:00:00Z",
  opened_at: "2026-10-26T11:59:30Z",
  occurrence_number: "3",
};

async function setup(page: Page) {
  const commands: Record<string, unknown>[] = [];
  await page.clock.setFixedTime(now);
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
    if (path.endsWith(`/alerts/${alertId}/commands`)) {
      commands.push(route.request().postDataJSON());
      return route.fulfill({ json: { data: { ...row, status: "resolved" } } });
    }
    if (path.endsWith(`/alerts/${alertId}`))
      return route.fulfill({ json: { data: row } });
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            {
              id: presetId,
              name: "Payments on-call",
              cel: 'application == "payments"',
              revision: "12",
              updated_by: "reviewer",
              updated_at: "2026-10-26T10:00:00Z",
            },
          ],
          next_cursor: null,
        },
      });
    return route.fulfill({
      json: {
        data: path.endsWith("/alerts") ? [row] : [],
        meta: { total: "1" },
        next_cursor: null,
      },
    });
  });
  return commands;
}

test("quick views drop Active and mark each severity and status with a dot", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const group = page.getByRole("group", { name: "Quick views, not saved" });
  await expect(group.getByRole("button")).toHaveText([
    /^All/,
    /^Critical/,
    /^High/,
    /^Warning/,
    /^Firing/,
    /^Acknowledged/,
    /^Resolved/,
    /^Assigned to me/,
  ]);
  await expect(group.locator(".qv-dot")).toHaveCount(6);
  await expect(group).toHaveAttribute("title", "Quick views are not saved");
  await expect(page.getByText("Quick views are not saved")).toHaveCount(0);
});

test("the row ⋯ menu resolves without navigating and returns focus on Escape", async ({
  page,
}) => {
  const commands = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const trigger = page.getByRole("button", {
    name: "Actions for Database latency",
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Actions for Database latency" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Assign to me",
    "Resolve",
    "Link to incident",
    "Dismiss",
  ]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Resolve", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    kind: "set_status",
    value: "resolved",
    expected_revision: row.revision,
  });
  await expect(page).toHaveURL(`/tenants/${tenant}/alerts`);
  await expect(
    page.getByRole("button", { name: "Resolve", exact: true }),
  ).toHaveCount(0);
});

test("feed rows show plain labels and times relative to now", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const line = page.getByRole("row", { name: /Database latency/ });
  await expect(line).toContainText("Critical");
  await expect(line).toContainText("Firing");
  await expect(line.locator(".sev i, .st i")).toHaveCount(0);
  await expect(line).not.toContainText("payments · postgres");
  await expect(line.locator(".chip-new")).toHaveCount(0);
  const time = line.locator("time");
  await expect(time).toHaveText("2 hours ago");
  await expect(time).toHaveAttribute("title", /^26-10-2026 10:00:00 UTC/);
  await expect(page.getByText(/^Times in /)).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
});

test("alert detail drops its revision and source line and reads times relatively", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${alertId}`);
  await expect(
    page.getByRole("heading", { name: "Database latency" }),
  ).toBeVisible();
  const summary = page.getByRole("region", { name: "Alert summary" });
  await expect(summary).not.toContainText("payments · postgres");
  const details = page.getByRole("region", { name: "Details" });
  await expect(details).not.toContainText(/Revision/);
  await expect(details).toContainText("Last received2 hours ago");
  await expect(details).toContainText("First received3 days ago");
  await expect(details).toContainText("Occurrence#3, opened 30 seconds ago");
  await expect(page.getByText(/^Times in /)).toHaveCount(0);
});

test("the presets list has no revision column and relative modification times", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets`);
  const table = page.getByRole("table", { name: "Presets", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    /^Name/,
    "Sort",
    "Last editor",
    "Last modified",
    "Actions",
  ]);
  const preset = table.getByRole("row", { name: /Payments on-call/ });
  await expect(preset).toContainText("2 hours ago");
  // The actions stay in the last track once the Revision column is gone.
  const rowBox = (await preset.boundingBox())!;
  const menuBox = (await preset
    .getByRole("button", { name: "More actions for Payments on-call" })
    .boundingBox())!;
  expect(rowBox.x + rowBox.width - (menuBox.x + menuBox.width)).toBeLessThan(
    40,
  );
});
