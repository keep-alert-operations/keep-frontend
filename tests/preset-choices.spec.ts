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
    preview: undefined as unknown,
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
    if (url.pathname.endsWith("/dashboards/preview")) {
      state.preview = route.request().postDataJSON();
      return route.fulfill({ json: { data: { panels: [] } } });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/new`);
  await page.getByRole("button", { name: "Add panel", exact: true }).click();
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
  await page.getByRole("button", { name: "Next preset page" }).click();
  await expect(picker.locator(`option[value="${later}"]`)).toHaveText(
    "Later preset",
  );
  await expect(picker).toHaveValue(first);
  await picker.selectOption(later);
  await page.getByRole("button", { name: "First preset page" }).click();
  await expect(picker).toHaveValue(later);
  await expect(picker.locator(`option[value="${later}"]`)).toHaveText(
    "Later preset",
  );
  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect
    .poll(() => state.preview)
    .toMatchObject({ preset_revisions: { [later]: "9007199254740999" } });
  await page.getByLabel("Find shared presets").fill("Later");
  await page
    .getByRole("button", { name: "Search presets", exact: true })
    .click();
  await expect
    .poll(() => state.searches.some((search) => search.includes("name=Later")))
    .toBe(true);
  await expect(picker).toHaveValue(later);
});

test("changed preset collection preserves the dashboard draft and can restart", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByLabel("Name", { exact: true })
    .fill("Preserved dashboard draft");
  await page
    .getByRole("combobox", { name: "Saved preset", exact: true })
    .selectOption(first);
  state.expired = true;
  await page.getByRole("button", { name: "Next preset page" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Preserved dashboard draft",
  );
  await page.getByRole("button", { name: "Refresh preset choices" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Saved preset", exact: true }),
  ).toHaveValue(first);
});
