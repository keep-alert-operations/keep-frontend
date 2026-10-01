import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const operator = "00000000-0000-4000-8000-000000000002";

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "test", display_name: "Test admin" },
          csrf_token: "test",
          tenants: [
            {
              id: tenant,
              name: "Test",
              kind: "specific",
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
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
});

test("operator creation waits for completion and shows verified success", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(`**/api/tenants/${tenant}/operators`, async (route) => {
    await pending;
    await route.fulfill({
      status: 201,
      json: {
        data: { operator: { id: operator, revision: "2", lifecycle: "ready" } },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/operators/new`);
  await page.getByLabel("Operator name").fill("Sender");
  await page
    .getByRole("button", { name: "Create operator", exact: true })
    .click();
  await expect(page.getByText("Verifying operator setup…")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create operator", exact: true }),
  ).toBeDisabled();
  finish!();
  await expect(
    page.getByText("Operator ready.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Provisioning continues in the background."),
  ).toHaveCount(0);
});

test("partial setup failure exposes original operator recovery without a second create", async ({
  page,
}) => {
  await page.route(`**/api/tenants/${tenant}/operators`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "remote_outcome_uncertain",
          message: "Remote changes may be partial.",
          fields: {
            operator_id: operator,
            operation_id: "operation",
            outcome_may_be_partial: true,
          },
        },
      },
    }),
  );
  await page.goto(`/tenants/${tenant}/operators/new`);
  await page.getByLabel("Operator name").fill("Sender");
  await page
    .getByRole("button", { name: "Create operator", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open operator to inspect and retry" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create operator", exact: true }),
  ).toBeDisabled();
});
