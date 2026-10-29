import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const principal = "00000000-0000-4000-8000-0000000000aa";
const free = {
  id: "00000000-0000-4000-8000-000000000101",
  revision: "4",
  message: "Disk almost full",
  application: "payments",
  severity: "critical",
  status: "firing",
  assignee_id: null,
  active_incident_id: null,
};
const owned = {
  ...free,
  id: "00000000-0000-4000-8000-000000000102",
  message: "Checkout latency",
  active_incident_id: "00000000-0000-4000-8000-000000000201",
  active_incident_title: "Checkout degraded",
};
const incidents = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    revision: "7",
    title: "Checkout degraded",
    severity: "high",
    status: "investigating",
  },
  {
    id: "00000000-0000-4000-8000-000000000202",
    revision: "3",
    title: "Storage pressure",
    severity: "critical",
    status: "open",
  },
];

async function setup(page: Page, role = "edit") {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
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
              role,
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
    if (request.method() === "POST" && path.includes("/incidents/")) {
      posts.push({ path, body: request.postDataJSON() });
      return route.fulfill({ json: { data: incidents[1], meta: {} } });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    const incident = incidents.find((item) => path.endsWith(`/${item.id}`));
    if (incident) return route.fulfill({ json: { data: incident, meta: {} } });
    const alert = [free, owned].find((item) => path.endsWith(`/${item.id}`));
    if (alert) return route.fulfill({ json: { data: alert, meta: {} } });
    return route.fulfill({
      json: {
        data: path.endsWith("/alerts")
          ? [free, owned]
          : path.endsWith("/incidents")
            ? incidents
            : [],
        meta: { total: "2" },
        next_cursor: null,
      },
    });
  });
  return posts;
}

/**
 * Requirements: REV-48; incident operations 5–6. The Feed row menu links an
 * unowned alert to the chosen active incident at that incident's revision.
 */
test("the Feed row menu links an alert to an incident", async ({ page }) => {
  const posts = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Actions for Disk almost full" })
    .click();
  await page.getByRole("menuitem", { name: "Link to incident" }).click();

  const dialog = page.getByRole("dialog", { name: "Link to incident" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#link-inc-q")).toBeFocused();
  const link = dialog.getByRole("button", { name: "Link to incident" });
  await expect(link).toBeDisabled();
  await dialog.getByRole("radio", { name: "Storage pressure" }).check();
  await link.click();

  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe(
    `/api/tenants/${tenant}/incidents/${incidents[1].id}/alerts/link`,
  );
  expect(posts[0].body).toMatchObject({
    expected_revision: "3",
    alert_ids: [free.id],
  });
});

/**
 * Requirements: REV-48; incident operations 5–6. An alert another active
 * incident owns is moved explicitly, never silently taken by Link.
 */
test("the alert page moves an owned alert to another incident", async ({
  page,
}) => {
  const posts = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${owned.id}`);
  await page.getByRole("button", { name: "Link to incident" }).click();

  const dialog = page.getByRole("dialog", { name: "Link to incident" });
  await expect(dialog).toContainText("is linked to Checkout degraded");
  await expect(
    dialog.getByRole("radio", { name: "Checkout degraded" }),
  ).toBeDisabled();
  await expect(dialog.getByText("Linked here")).toBeVisible();
  await dialog.getByRole("radio", { name: "Storage pressure" }).check();
  await dialog.getByRole("button", { name: "Move to incident" }).click();

  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe(`/api/tenants/${tenant}/incidents/move-alerts`);
  expect(posts[0].body).toMatchObject({
    source_id: incidents[0].id,
    destination_id: incidents[1].id,
    source_revision: "7",
    destination_revision: "3",
    alert_ids: [owned.id],
  });
});

/** Requirements: REV-48; incident operations 5. Escape closes without linking. */
test("Escape closes the dialog and returns focus", async ({ page }) => {
  const posts = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${free.id}`);
  const open = page.getByRole("button", { name: "Link to incident" });
  await open.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(posts).toHaveLength(0);
});

/** Requirements: REV-48; incident operations 5. Viewers cannot link. */
test("viewers see no link action", async ({ page }) => {
  await setup(page, "view");
  await page.goto(`/tenants/${tenant}/alerts/${free.id}`);
  await expect(page.getByText("Disk almost full").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Link to incident" }),
  ).toHaveCount(0);
});
