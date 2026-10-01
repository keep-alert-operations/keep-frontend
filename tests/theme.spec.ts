import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";

async function mockApi(page: Page, signedIn = true) {
  await page.route("**/auth/session", (route) =>
    route.fulfill(
      signedIn
        ? {
            json: {
              data: {
                principal: {
                  id: "theme-user",
                  display_name: "Theme test user",
                },
                csrf_token: "test",
                tenants: [
                  {
                    id: tenant,
                    name: "Global",
                    kind: "global",
                    role: "admin",
                    revision: "1",
                  },
                ],
              },
            },
          }
        : {
            status: 401,
            json: {
              error: { code: "session_required", message: "Sign in required" },
            },
          },
    ),
  );
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill(
      path.endsWith("/events")
        ? {
            contentType: "text/event-stream",
            body: 'event: state\ndata: {"view_generation":"1"}\n\n',
          }
        : {
            json: {
              data: path.endsWith("/view-state")
                ? { view_generation: "1" }
                : [],
              meta: { total: "0" },
              next_cursor: null,
            },
          },
    );
  });
}

async function openAccount(page: Page) {
  await page.getByRole("button", { name: "Account: Theme test user" }).click();
}

test("account theme switch persists across pages and reloads", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByRole("heading", { name: "All alerts" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  const lightPanel = await page
    .locator(".panel")
    .first()
    .evaluate((panel) => getComputedStyle(panel).backgroundColor);

  await openAccount(page);
  await page.getByRole("switch", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("appchi-theme"))).toBe(
    "dark",
  );
  const darkBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  const darkPanel = await page
    .locator(".panel")
    .first()
    .evaluate((panel) => getComputedStyle(panel).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  expect(darkPanel).not.toBe(lightPanel);

  await page.getByRole("link", { name: "Presets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Presets", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Presets", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await openAccount(page);
  await page.getByRole("switch", { name: "Dark mode", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Dark mode" }),
  ).not.toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("appchi-theme"))).toBe(
    "light",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("signed-out login uses the stored theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("appchi-theme", "dark"));
  await mockApi(page, false);
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
  await expect(page.locator(".login-screen")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
