import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const principal = "00000000-0000-4000-8000-0000000000aa";
const rows = ["One", "Two", "Three", "Four"].map((name, index) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  revision: String(index + 1),
  message: `Alert ${name}`,
  application: "payments",
  severity: "critical",
  status: "firing",
  acknowledged: false,
  assignee_id: null,
}));

async function setup(page: Page) {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: principal, display_name: "Reviewer" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
              kind: "global",
              role: "admin",
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
        data: path.endsWith("/alerts") ? rows : [],
        meta: { total: String(rows.length) },
        next_cursor: null,
      },
    });
  });
}

async function center(page: Page, name: string) {
  const box = await page
    .getByRole("row")
    .filter({ hasText: name })
    .locator("[role=cell]")
    .nth(3)
    .boundingBox();
  if (!box) throw new Error(`no row ${name}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Requirements: REV-43; alert operations 17. Holding the mouse selects rows. */
test("holding the mouse over alert rows selects them until release", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByLabel("Select Alert One")).toBeVisible();

  const first = await center(page, "Alert One");
  const third = await center(page, "Alert Three");
  const fourth = await center(page, "Alert Four");
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(third.x, third.y, { steps: 6 });
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  // Dragging back shrinks the range while the button is still held.
  await page.mouse.move(first.x, first.y + 70, { steps: 4 });
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.mouse.move(third.x, third.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel("Select Alert One")).toBeChecked();
  await expect(page.getByLabel("Select Alert Three")).toBeChecked();
  await expect(page.getByLabel("Select Alert Four")).not.toBeChecked();
  // The release over a row link is not a click, so the list stays open.
  await expect(page).toHaveURL(`/tenants/${tenant}/alerts`);

  // Moving without the button held changes nothing.
  await page.mouse.move(fourth.x, fourth.y, { steps: 4 });
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();

  // Pressing a selected row and dragging deselects the rows it covers.
  await page.mouse.move(third.x, third.y);
  await page.mouse.down();
  await page.mouse.move(first.x, first.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
});

test("a plain click on an alert still opens it and selects nothing", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("link", { name: "Open Alert Two" }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${rows[1].id}`));
});
