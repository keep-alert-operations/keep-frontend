import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  thresholds: [],
};
const notes = {
  id: "00000000-0000-4000-8000-000000000031",
  type: "html",
  title: "Handover",
  x: 3,
  y: 0,
  w: 4,
  h: 4,
  html: '<p><strong>Freeze</strong> until Friday.</p><a href="https://example.com/board">board</a>',
};

async function setup(page: Page, panels: Record<string, unknown>[]) {
  const state = {
    definition: { id, name: "Types", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    counts: 0,
    validations: [] as Record<string, unknown>[],
    previews: [] as Record<string, unknown>[],
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "types-csrf",
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
    if (path === `${api}/counts`) {
      state.counts += 1;
      return route.fulfill({
        json: {
          data: {
            observation_id: "types-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-03T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: (state.definition.panels as { id: string; type?: string }[])
              .filter((item) => item.type !== "html")
              .map((item) => ({
                panel_id: item.id,
                preset_id: preset,
                preset_name: "All alerts",
                count: "12",
              })),
          },
        },
      });
    }
    if (path.endsWith("/dashboards/validate")) {
      const body = route.request().postDataJSON();
      state.validations.push(body);
      const html = String(body.panels?.[0]?.html ?? "");
      return route.fulfill({
        json: {
          data: {
            valid: true,
            removed: html.includes("onclick")
              ? [
                  {
                    panel_id: body.panels[0].id,
                    line: 2,
                    what: "onclick attribute",
                  },
                ]
              : [],
          },
        },
      });
    }
    if (path.endsWith("/alerts/counts")) {
      state.previews.push(route.request().postDataJSON());
      return route.fulfill({ json: { data: { counts: { total: "42" } } } });
    }
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

test("an HTML panel shows sanitized content beside count panels", async ({
  page,
}) => {
  // Requirements: REV-57; dashboard operations 2, 3 and 16.
  await setup(page, [
    count,
    {
      ...notes,
      html: `${notes.html}<img src="x" onerror="window.__panelXss=1"><script>window.__panelXss=2</script>`,
    },
  ]);
  const html = page.getByRole("article", { name: "Handover", exact: true });
  await expect(html.locator("strong")).toHaveText("Freeze");
  await expect(html.getByRole("link", { name: "board" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(html.getByRole("link", { name: "board" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(html.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => "__panelXss" in window)).toBe(false);
  await expect(
    page.getByRole("article", { name: "Critical count", exact: true }),
  ).toContainText("12");
});

test("an HTML panel keeps a font size and drops other styles", async ({
  page,
}) => {
  // Requirements: REV-57 (later decision 2026-11-04); dashboard operations 5.
  await setup(page, [
    {
      ...notes,
      html: '<p style="font-size: 24px; position: fixed">Large</p>',
    },
  ]);
  const large = page
    .getByRole("article", { name: "Handover", exact: true })
    .getByText("Large");
  await expect(large).toHaveCSS("font-size", "24px");
  await expect(large).toHaveAttribute("style", "font-size: 24px");
});

test("a dashboard of only HTML panels makes no count request", async ({
  page,
}) => {
  // Requirements: REV-57; dashboard operations 2 and 10.
  const state = await setup(page, [{ ...notes, x: 0 }]);
  await expect(
    page.getByRole("article", { name: "Handover", exact: true }),
  ).toContainText("Freeze");
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await page.waitForTimeout(300);
  expect(state.counts).toBe(0);
});

test("the panel dialog keeps its size across types and creates an HTML panel", async ({
  page,
}) => {
  // Requirements: REV-57; dashboard operations 3, 5, 14 and 16.
  const state = await setup(page, [count]);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const before = await dialog.boundingBox();
  const type = dialog.getByRole("button", { name: /Panel type/ });
  await expect(type).toContainText("Alert count");
  await type.click();
  const search = dialog.getByRole("combobox", { name: "Search panel types" });
  await expect(search).toBeFocused();
  await search.fill("html");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(type).toContainText("HTML");
  await expect(type).toBeFocused();
  const after = await dialog.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);

  await dialog.getByLabel("Title (optional)").fill("Runbooks");
  await dialog
    .getByLabel("HTML", { exact: true })
    .fill(
      '<ul>\n<li onclick="x()"><a href="https://example.com/rb">Checkout</a></li>\n</ul>',
    );
  const preview = dialog.getByRole("article", { name: "Runbooks preview" });
  await expect(preview.getByRole("link", { name: "Checkout" })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "onclick attribute on line 2",
  );
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("article", { name: "Runbooks", exact: true }),
  ).toContainText("Checkout");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.title === "Runbooks",
  );
  expect(saved).toMatchObject({ type: "html" });
  expect(saved).not.toHaveProperty("preset_id");
});

test("editing a panel keeps its type locked", async ({ page }) => {
  // Requirements: REV-57; dashboard operations 2 and 14.
  await setup(page, [count, notes]);
  await page
    .getByRole("button", { name: "Options for Handover", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit panel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(
    dialog.getByRole("button", { name: /Panel type/ }),
  ).toBeDisabled();
  await expect(dialog).toContainText("A panel keeps its type");
  await expect(dialog.getByLabel("HTML", { exact: true })).toHaveValue(
    notes.html,
  );
});

test("the count preview counts the chosen preset before saving", async ({
  page,
}) => {
  // Requirements: REV-57; dashboard operations 3 and 5.
  const state = await setup(page, [count]);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const preview = dialog.getByRole("article", { name: /count$/ });
  await expect(preview).toContainText("Choose a preset to see its count");
  // Title comes first, then the preset.
  await expect
    .poll(() =>
      dialog
        .locator('input[name="title"], input[name="preset"]')
        .evaluateAll((fields) =>
          fields.map((field) => field.getAttribute("name")),
        ),
    )
    .toEqual(["title", "preset"]);
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).click();
  await dialog.getByRole("option", { name: "All alerts" }).click();
  await expect(preview).toContainText("42");
  await expect(preview).not.toContainText("Exact logical alerts");
  expect(state.previews.at(-1)).toMatchObject({
    queries: [{ id: "total", cel: "true", include_suppressed: false }],
  });
  await dialog.getByRole("button", { name: "Add threshold" }).click();
  // The threshold colors the panel without a caption naming its bound.
  await expect(preview).toHaveClass(/pn-toned/);
  await expect(preview).toHaveAttribute("data-threshold-color", "blue");
  await expect(preview).not.toContainText("At least");
  expect(state.saves).toHaveLength(0);
});
