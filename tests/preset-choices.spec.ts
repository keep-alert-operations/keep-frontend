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
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "Preset", exact: true });
  // One input both searches and selects; there is no separate search box.
  await expect(dialog.getByRole("searchbox")).toHaveCount(0);
  await picker.click();
  await dialog.getByRole("option", { name: "First preset" }).click();
  await expect(picker).toHaveValue("First preset");
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  // Paging lives in the open list and keeps it open.
  await dialog.getByRole("button", { name: "Show presets" }).click();
  await dialog.getByRole("button", { name: "Next page" }).click();
  await expect(
    dialog.getByRole("option", { name: "Later preset" }),
  ).toBeVisible();
  await expect(picker).toHaveValue("First preset");
  await dialog.getByRole("option", { name: "Later preset" }).click();
  await picker.click();
  await dialog.getByRole("button", { name: "First page" }).click();
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await expect(picker).toHaveValue("Later preset");
  await picker.fill("Later");
  await expect
    .poll(() => state.searches.some((search) => search.includes("name=Later")))
    .toBe(true);
  await expect(dialog.getByRole("option")).toHaveText(["Later preset"]);
  await picker.press("Enter");
  await expect(picker).toHaveValue("Later preset");
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
  await page.getByLabel("Title (optional)").fill("Preserved panel draft");
  await page.getByRole("combobox", { name: "Preset", exact: true }).click();
  await page.getByRole("option", { name: "First preset" }).click();
  state.expired = true;
  await page.getByRole("combobox", { name: "Preset", exact: true }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toBeVisible();
  await expect(page.getByLabel("Title (optional)")).toHaveValue(
    "Preserved panel draft",
  );
  await page.getByRole("button", { name: "Retry loading presets" }).click();
  await expect(
    page.getByText("Configuration changed; restart the list."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Preset", exact: true }),
  ).toHaveValue("First preset");
});

test("dashboard preset field keeps the dialog open while closing its list", async ({
  page,
}) => {
  await setup(page);
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "Preset", exact: true });
  const closed = await dialog.boundingBox();
  await picker.press("ArrowDown");
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("listbox")).toBeVisible();
  // The list overlays the dialog instead of growing it.
  expect(await dialog.boundingBox()).toEqual(closed);
  await picker.press("Enter");
  await expect(picker).toHaveValue("First preset");
  await picker.fill("Lat");
  await expect(dialog.getByRole("listbox")).toBeVisible();
  // Escape closes only the list and restores the selected name.
  await picker.press("Escape");
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveValue("First preset");
  // Leaving the field without choosing keeps the selection.
  await picker.fill("Lat");
  await dialog.getByLabel("Title (optional)").focus();
  await expect(picker).toHaveValue("First preset");
  await expect(
    dialog.getByRole("button", { name: "Create panel", exact: true }),
  ).toBeEnabled();
});
