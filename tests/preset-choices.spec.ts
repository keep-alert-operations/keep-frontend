import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const first = "00000000-0000-4000-8000-000000000010";
const later = "00000000-0000-4000-8000-000000000020";
const preset = (id: string) => ({
  id,
  revision: "9007199254740999",
  name: id === first ? "First preset" : "Later preset",
  cel: "true",
});

async function setup(page: Page) {
  const state = {
    expired: false,
    saved: undefined as unknown,
    searches: [] as string[],
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: first, display_name: "Synthetic editor" },
          csrf_token: "preset-csrf",
          tenants: [
            {
              id: tenant,
              kind: "global",
              name: "Global",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (url.pathname.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (url.pathname.endsWith("/presets")) {
      state.searches.push(url.search);
      if (url.searchParams.has("cursor") && state.expired)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "list_changed",
              message: "Configuration changed; restart the list.",
            },
          },
        });
      const second =
        url.searchParams.has("cursor") ||
        url.searchParams.get("name") === "Later";
      return route.fulfill({
        json: {
          data: [preset(second ? later : first)],
          next_cursor: second ? null : "page-two",
        },
      });
    }
    if (url.pathname.endsWith(`/presets/${first}`))
      return route.fulfill({ json: { data: preset(first) } });
    if (url.pathname.endsWith(`/presets/${later}`))
      return route.fulfill({ json: { data: preset(later) } });
    if (
      url.pathname.endsWith("/dashboards") &&
      route.request().method() === "POST"
    ) {
      state.saved = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: {
          data: {
            ...(state.saved as Record<string, unknown>),
            id: first,
            revision: "1",
          },
        },
      });
    }
    if (url.pathname.endsWith(`/dashboards/${first}`))
      return route.fulfill({
        json: {
          data: {
            ...(state.saved as Record<string, unknown>),
            id: first,
            revision: "1",
          },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/new`);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  return state;
}

test("dashboard preset choices page and search without losing selected references", async ({
  page,
}) => {
  const state = await setup(page);
  const picker = page.getByRole("combobox", {
    name: "Saved preset",
    exact: true,
  });
  await picker.selectOption(first);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(picker.locator(`option[value="${later}"]`)).toHaveText(
    "Later preset",
  );
  await expect(picker).toHaveValue(first);
  await picker.selectOption(later);
  await page.getByRole("button", { name: "First page" }).click();
  await expect(picker).toHaveValue(later);
  await expect(picker.locator(`option[value="${later}"]`)).toHaveText(
    "Later preset",
  );
  await page.getByLabel("Search presets", { exact: true }).fill("Later");
  await expect
    .poll(() => state.searches.some((search) => search.includes("name=Later")))
    .toBe(true);
  await expect(picker).toHaveValue(later);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page
    .getByLabel("Dashboard name", { exact: true })
    .fill("Saved dashboard");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  await expect(
    page.getByRole("button", { name: "More dashboard actions", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => state.saved)
    .toMatchObject({ name: "Saved dashboard", panels: [{ preset_id: later }] });
});

test("changed preset collection preserves the dashboard draft and can restart", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByLabel("Custom title (optional)")
    .fill("Preserved panel draft");
  await page
    .getByRole("combobox", { name: "Saved preset", exact: true })
    .selectOption(first);
  state.expired = true;
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toBeVisible();
  await expect(page.getByLabel("Custom title (optional)")).toHaveValue(
    "Preserved panel draft",
  );
  await page.getByRole("button", { name: "Retry loading presets" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Saved preset", exact: true }),
  ).toHaveValue(first);
});
