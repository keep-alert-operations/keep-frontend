import { expect, test, type Page } from "@playwright/test";

const global = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const alert = "00000000-0000-4000-8000-000000000003";

async function setup(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const state = { sessions: 0, expired: false, streams: 0 };
  await page.route("**/auth/session", (route) => {
    state.sessions++;
    return route.fulfill(
      state.expired
        ? {
            status: 401,
            json: {
              error: { code: "session_expired", message: "Session expired" },
            },
          }
        : {
            json: {
              data: {
                principal: { id: alert, display_name: "Navigation user" },
                csrf_token: "test",
                tenants: [
                  {
                    id: global,
                    name: "Global",
                    kind: "global",
                    role: "admin",
                    revision: "1",
                  },
                  {
                    id: other,
                    name: "Other tenant",
                    kind: "specific",
                    role: "view",
                    revision: "1",
                  },
                ],
              },
            },
          },
    );
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events")) {
      state.streams++;
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    }
    return route.fulfill({
      json: {
        data: path.endsWith("/view-state")
          ? { view_generation: "1" }
          : path.endsWith("/alerts")
            ? [
                {
                  id: alert,
                  revision: "1",
                  message: path.includes(global)
                    ? "Global alert"
                    : "Other tenant alert",
                  severity: "high",
                  status: "firing",
                },
              ]
            : [],
        meta: { total: "1" },
        next_cursor: null,
      },
    });
  });
  await page.goto(`/tenants/${global}/alerts`);
  await expect(
    page.getByRole("link", { name: "Open Global alert", exact: true }),
  ).toBeVisible();
  return state;
}

test("page, administration, home and browser-history navigation preserve the signed-in shell", async ({
  page,
}) => {
  const state = await setup(page);
  const sessions = state.sessions;
  const rail = await page.locator(".rail").elementHandle();
  for (const name of [
    "Presets",
    "Dashboards",
    "Incidents",
    "Correlation rules",
    "Maintenance",
    "Operators",
  ]) {
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.locator(".login-screen")).toHaveCount(0);
    expect(state.sessions).toBe(sessions);
    expect(await rail!.evaluate((element) => element.isConnected)).toBe(true);
  }
  await page.getByRole("link", { name: "Permissions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Permissions", exact: true, level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Operators", exact: true, level: 1 }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Permissions", exact: true, level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Appchi home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "All alerts", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/tenants/${global}/alerts$`));
  expect(state.sessions).toBe(sessions);
  expect(await rail!.evaluate((element) => element.isConnected)).toBe(true);
});

test("tenant changes retain the session but clear the previous tenant content while loading", async ({
  page,
}) => {
  const state = await setup(page);
  const sessions = state.sessions;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(`**/api/tenants/${other}/alerts?**`, async (route) => {
    requested = true;
    await pending;
    await route.fallback();
  });
  await page
    .getByRole("combobox", { name: "Tenant", exact: true })
    .selectOption(other);
  await expect.poll(() => requested).toBe(true);
  await expect(
    page.getByRole("link", { name: "Open Global alert", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".login-screen")).toHaveCount(0);
  expect(state.sessions).toBe(sessions);
  release();
  await expect(
    page.getByRole("link", { name: "Open Other tenant alert", exact: true }),
  ).toBeVisible();
});

test("periodic reauthorization still clears the persistent workspace on session expiry", async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole("link", { name: "Presets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Presets", exact: true, level: 1 }),
  ).toBeVisible();
  state.expired = true;
  await page.clock.runFor(30000);
  await expect(
    page.getByRole("link", {
      name: "Sign in with company account",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".shell")).toHaveCount(0);
});

test("expired sign-in recovery remains outside the workspace session check", async ({
  page,
}) => {
  let sessions = 0;
  await page.route("**/auth/session", (route) => {
    sessions++;
    return route.abort();
  });
  await page.goto("/sign-in-expired");
  await expect(
    page.getByRole("link", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Checking your session…", { exact: true }),
  ).toHaveCount(0);
  expect(sessions).toBe(0);
});
