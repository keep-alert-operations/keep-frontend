import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const panel = (n: number, title: string, color?: string) => ({
  id: `00000000-0000-4000-8000-00000000003${n}`,
  preset_id: preset,
  title,
  x: 3 * n,
  y: 0,
  w: 3,
  h: 2,
  thresholds: color ? [{ lower_bound: "1", color }] : [],
});

async function setup(page: Page, panels: Record<string, unknown>[]) {
  const state = {
    definition: { id, name: "Colors", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "colors-csrf",
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: "edit",
              kind: "specific",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/health"))
      return route.fulfill({
        json: { data: { committed_seq: "1", searchable_seq: "1" } },
      });
    if (path === api) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        state.saves.push(body);
        state.definition = {
          ...state.definition,
          panels: body.panels,
          revision: "4",
        };
      }
      return route.fulfill({ json: { data: state.definition } });
    }
    if (path === `${api}/counts`)
      return route.fulfill({
        json: {
          data: {
            observation_id: "colors-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-09T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: (state.definition.panels as { id: string }[]).map(
              (item) => ({
                panel_id: item.id,
                preset_id: preset,
                preset_name: "All alerts",
                count: "12",
              }),
            ),
          },
        },
      });
    if (path.endsWith("/dashboards/validate"))
      return route.fulfill({ json: { data: { valid: true, removed: [] } } });
    if (path.endsWith("/alerts/counts"))
      return route.fulfill({ json: { data: { counts: { total: "42" } } } });
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            { id: preset, name: "All alerts", revision: "1", cel: "true" },
          ],
          next_cursor: null,
        },
      });
    if (path.endsWith(`/presets/${preset}`))
      return route.fulfill({
        json: {
          data: { id: preset, name: "All alerts", revision: "1", cel: "true" },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

const topColor = (page: Page, name: string) =>
  page
    .getByRole("article", { name: `${name} count`, exact: true })
    .evaluate((element) => getComputedStyle(element).borderTopColor);

test("the picker sets palette and custom threshold colors and saves them", async ({
  page,
}) => {
  // Requirements: REV-64; dashboard operations 5 and 16.
  const state = await setup(page, [panel(0, "Critical")]);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  await dialog.getByLabel("Title (optional)").fill("Checkout");
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).click();
  await dialog.getByRole("option", { name: "All alerts" }).click();
  const preview = dialog.getByRole("article", { name: /count$/ });
  await expect(preview).toContainText("42");
  await dialog.getByRole("button", { name: "Add threshold" }).click();
  await dialog.getByRole("button", { name: "Add threshold" }).click();

  // A new threshold starts blue, as before.
  const first = dialog.getByRole("button", { name: "Color 1: Blue" });
  await expect(first).toBeVisible();
  await first.click();
  const picker = page.getByRole("dialog", { name: "Color 1 color" });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "Blue", exact: true }),
  ).toBeFocused();
  await expect(
    picker.getByRole("button", { name: "Blue", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Arrow keys move through the swatches: down one shade, then right one hue.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(
    picker.getByRole("button", { name: "Dark purple" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(picker).toContainText("Selected: Dark blue");
  await picker.getByRole("button", { name: "Dark teal", exact: true }).click();
  await expect(picker).toContainText("Selected: Dark teal");

  // Escape closes the picker only; the panel dialog stays open.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Color 1: Dark teal" }),
  ).toBeVisible();

  // Threshold 2 (bound 1) matches the preview count and gets a custom color.
  await dialog.getByRole("button", { name: "Color 2: Blue" }).click();
  const second = page.getByRole("dialog", { name: "Color 2 color" });
  await second.getByRole("button", { name: "Custom", exact: true }).click();
  const hex = second.getByLabel("Hex");
  await expect(hex).toHaveValue("#0A6FB0");
  await hex.fill("#abc");
  await expect(second).toContainText("Enter six hex digits");
  await hex.fill("e0569b");
  await expect(second).not.toContainText("Enter six hex digits");
  await expect(preview).toHaveAttribute("data-threshold-color", "#E0569B");
  await expect
    .poll(() =>
      preview.evaluate((element) => getComputedStyle(element).borderTopColor),
    )
    .toBe("rgb(224, 86, 155)");
  // The hue slider and the area change the custom color too.
  await second.getByRole("slider", { name: "Hue" }).fill("120");
  await expect(preview).not.toHaveAttribute("data-threshold-color", "#E0569B");
  const area = second.getByRole("slider", {
    name: "Saturation and brightness",
  });
  await area.click({ position: { x: 5, y: 5 } });
  await area.press("ArrowRight");
  await hex.fill("#E0569B");
  // A click elsewhere in the panel dialog closes the picker.
  await dialog.getByText("Count thresholds").click();
  await expect(second).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Color 2: #E0569B" }),
  ).toBeVisible();

  // Reopening a custom color starts on the Custom tab.
  await dialog.getByRole("button", { name: "Color 2: #E0569B" }).click();
  await expect(
    second.getByRole("button", { name: "Custom", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.title === "Checkout",
  );
  expect(saved).toMatchObject({
    thresholds: [
      { lower_bound: "0", color: "dark-teal" },
      { lower_bound: "1", color: "#E0569B" },
    ],
  });
});

test("palette colors follow the theme and custom colors do not", async ({
  page,
}) => {
  // Requirements: REV-64; dashboard operations 5 and 16.
  await page.emulateMedia({ colorScheme: "light" });
  await setup(page, [
    panel(0, "Legacy", "amber"),
    panel(1, "Palette", "dark-teal"),
    panel(2, "Custom", "#E0569B"),
    panel(3, "Neutral"),
  ]);
  await expect(
    page.getByRole("article", { name: "Legacy count", exact: true }),
  ).toContainText("12");
  // The former names keep their theme marks.
  expect(await topColor(page, "Legacy")).toBe("rgb(217, 154, 6)");
  expect(await topColor(page, "Palette")).toBe("rgb(11, 106, 102)");
  expect(await topColor(page, "Custom")).toBe("rgb(224, 86, 155)");
  expect(await topColor(page, "Neutral")).toBe("rgb(220, 230, 240)");

  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  expect(await topColor(page, "Legacy")).toBe("rgb(229, 181, 61)");
  expect(await topColor(page, "Palette")).toBe("rgb(19, 145, 139)");
  expect(await topColor(page, "Custom")).toBe("rgb(224, 86, 155)");
});
