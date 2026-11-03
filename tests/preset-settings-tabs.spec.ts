import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-47, REV-58; preset operations 3, 4, 8 and 9.
 * The preset editor keeps its preview beside a Preset settings panel: Name
 * above Filter, Columns, Sort, Group by and Sound tabs. Tabs keep their state,
 * show problems while hidden, and the saved definition is unchanged.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const created = "00000000-0000-4000-8000-000000000002";
const row = {
  id: "00000000-0000-4000-8000-000000000003",
  revision: "4",
  message: "Database latency",
  severity: "critical",
  status: "firing",
  application: "Synthetic database",
  component: "Query service",
  node_name: "db-1",
  timestamp: "2026-10-28T09:00:00Z",
};
const broken = "severity ==";

async function setup(page: Page, saveStatus = 201) {
  const creates: Record<string, unknown>[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: "00000000-0000-4000-8000-000000000004",
            display_name: "Test operator",
          },
          csrf_token: "tabs-test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
              kind: "managed",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/presets") && request.method() === "POST") {
      const body = request.postDataJSON();
      creates.push(body);
      if (saveStatus !== 201)
        return route.fulfill({
          status: saveStatus,
          json: {
            error: { code: "invalid_cel", message: "Expected an operand." },
          },
        });
      return route.fulfill({
        status: 201,
        json: { data: { ...body, id: created, revision: "1" } },
      });
    }
    if (path.endsWith("/presets/preview")) {
      const body = request.postDataJSON();
      if (String(body?.cel ?? "").includes(broken))
        return route.fulfill({
          status: 422,
          json: {
            error: { code: "invalid_cel", message: "Expected an operand." },
          },
        });
      return route.fulfill({
        json: { data: [row], meta: { total: "1" }, next_cursor: null },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return { creates };
}

const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("tab", { name });
const filter = (page: Page) => page.getByLabel("Filter (CEL)", { exact: true });

test("tabs follow the keyboard pattern and keep each panel's state", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await expect(
    page.getByRole("heading", { name: "Preset settings" }),
  ).toBeVisible();
  await expect(tab(page, "Filter")).toHaveAttribute("aria-selected", "true");
  await filter(page).fill('severity == "critical"');

  await tab(page, "Filter").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, /^Columns/)).toBeFocused();
  await expect(tab(page, /^Columns/)).toHaveAttribute("aria-selected", "true");
  await expect(filter(page)).toBeHidden();
  await expect(
    page.getByRole("list", { name: "Columns, in order" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(tab(page, "Sound")).toBeFocused();
  await expect(
    page.getByRole("switch", { name: "Noisy preset" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Group by")).toBeFocused();
  await expect(
    page.getByRole("radiogroup", { name: "Group by" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Filter")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Sound")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(page, "Filter")).toHaveAttribute("aria-selected", "true");
  await expect(filter(page)).toHaveValue('severity == "critical"');
});

test("hidden tabs show an invalid filter and a missing column", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await filter(page).fill(broken);
  await page
    .getByRole("button", { name: "Preview draft", exact: true })
    .click();
  await expect(page.getByText("The filter is invalid.")).toBeVisible();
  await tab(page, /^Columns/).click();
  await expect(tab(page, "Filter Invalid")).toBeVisible();

  const list = page.getByRole("list", { name: "Columns, in order" });
  for (const label of await list.locator(".pe-col-label").allTextContents())
    await page
      .getByRole("button", { name: `Remove ${label}`, exact: true })
      .click();
  await expect(tab(page, "Columns None")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create preset", exact: true }),
  ).toBeDisabled();
});

test("an empty name is reported in view while another tab is open", async ({
  page,
}) => {
  const { creates } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await tab(page, "Sort 1").click();
  await page
    .getByRole("button", { name: "Create preset", exact: true })
    .click();
  await expect(page.getByText("Enter a name for this preset.")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  expect(creates).toHaveLength(0);
});

test("a save rejected for its definition opens the Filter tab", async ({
  page,
}) => {
  await setup(page, 422);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByLabel("Name", { exact: true }).fill("Rejected preset");
  await tab(page, "Group by").click();
  await page
    .getByRole("button", { name: "Create preset", exact: true })
    .click();
  await expect(tab(page, "Filter")).toHaveAttribute("aria-selected", "true");
  await expect(filter(page)).toBeFocused();
});

test("the Add columns checklist appends a column and the save carries every setting", async ({
  page,
}) => {
  const { creates } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByLabel("Name", { exact: true }).fill("Tabbed preset");
  await tab(page, /^Columns/).click();
  const add = page.getByRole("group", { name: "Add columns" });
  // Ticking moves the column into the ordered list, so the box disappears.
  await add.getByRole("checkbox", { name: "Node", exact: true }).click();
  await expect(add.getByRole("checkbox", { name: "Node" })).toHaveCount(0);
  await expect(
    page
      .getByRole("list", { name: "Columns, in order" })
      .locator(".pe-col-label")
      .last(),
  ).toHaveText("Node");
  await expect(tab(page, "Columns 8")).toBeVisible();

  await tab(page, "Group by").click();
  await page
    .getByRole("radiogroup", { name: "Group by" })
    .getByRole("radio", { name: "Application", exact: true })
    .check();
  await expect(tab(page, "Group by Application")).toBeVisible();
  await page
    .getByRole("button", { name: "Create preset", exact: true })
    .click();
  await expect.poll(() => creates.length).toBe(1);
  expect(creates[0]).toMatchObject({
    name: "Tabbed preset",
    cel: "true",
    group_by: "application",
    columns: [
      "severity",
      "display_status",
      "message",
      "application",
      "component",
      "timestamp",
      "assignee_id",
      "node_name",
    ],
  });
});

test("supported fields and functions open as a popover and Escape closes it", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  const toggle = page.getByRole("button", {
    name: "Supported fields and functions",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(".cel-pop").getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(filter(page)).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Validate CEL", exact: true }),
  ).toBeVisible();
});
