import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  compactPanels,
  firstPanelGap,
  placePanel,
} from "../src/lib/dashboard-layout";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const panel = (suffix: number, title: string, x: number, y = 0) => ({
  id: `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
  preset_id: preset,
  title,
  x,
  y,
  w: 3,
  h: 2,
  thresholds: [],
});
const initial = {
  id,
  name: "Layout test",
  revision: "7",
  panels: [
    panel(30, "First", 0),
    panel(31, "Second", 3),
    panel(32, "Third", 6),
  ],
};
const api = `/api/tenants/${tenant}/dashboards/${id}`;

async function setup(
  page: Page,
  options: {
    conflict?: boolean;
    role?: string;
    panels?: typeof initial.panels;
    failSaveOnce?: boolean;
  } = {},
) {
  const state = {
    definition: structuredClone({
      ...initial,
      panels: options.panels ?? initial.panels,
    }),
    saves: [] as Record<string, unknown>[],
    conflict: options.conflict ?? false,
    deleted: false,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic layout editor" },
          csrf_token: "layout-csrf",
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: options.role ?? "edit",
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
      if (state.deleted)
        return route.fulfill({
          status: 404,
          json: { error: { code: "not_found", message: "Dashboard deleted." } },
        });
      if (route.request().method() === "PUT") {
        expect(route.request().headers()["x-csrf-token"]).toBe("layout-csrf");
        const body = route.request().postDataJSON();
        state.saves.push(body);
        if (options.failSaveOnce && state.saves.length === 1)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "temporarily_unavailable",
                message: "Save outcome unknown.",
              },
            },
          });
        if (state.conflict)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "revision_conflict",
                message: "The dashboard changed.",
              },
            },
          });
        state.definition = {
          ...state.definition,
          name: body.name,
          panels: body.panels,
          revision: "8",
        };
      }
      return route.fulfill({ json: { data: state.definition } });
    }
    if (path.endsWith("/counts")) {
      if (state.deleted)
        return route.fulfill({
          status: 404,
          json: { error: { code: "not_found", message: "Dashboard deleted." } },
        });
      if (
        route.request().postDataJSON()?.expected_revision !==
        state.definition.revision
      )
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "revision_conflict",
              message: "The dashboard changed.",
            },
          },
        });
      return route.fulfill({
        json: {
          data: {
            observation_id: "layout-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-10-08T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: state.definition.panels.map((item) => ({
              panel_id: item.id,
              preset_id: item.preset_id,
              preset_name: "All alerts",
              count: "12",
            })),
          },
        },
      });
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
    if (path.endsWith("/validate"))
      return route.fulfill({ json: { data: { valid: true } } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  if (options.role !== "view")
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
  return state;
}
const tile = (page: Page, title: string) =>
  page.getByRole("article", { name: `${title} count`, exact: true });
async function position(tile: Locator) {
  return tile.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow,
  }));
}
async function drag(
  page: Page,
  handle: Locator,
  columns: number,
  rows: number,
  release = true,
) {
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const pitch = await page
    .locator(".de-grid")
    .evaluate((element) => (element.getBoundingClientRect().width + 12) / 12);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + columns * pitch,
    box.y + box.height / 2 + rows * 60,
    { steps: 8 },
  );
  if (release) await page.mouse.up();
}

test.use({ viewport: { width: 1440, height: 900 } });

test("inline name editing enables Save only for real changes and Escape restores the name", async ({
  page,
}) => {
  const state = await setup(page);
  const save = page.getByRole("button", { name: "Save", exact: true });
  const rename = page.getByRole("button", {
    name: "Edit dashboard name",
    exact: true,
  });
  await expect(rename.locator("svg")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Edit dashboard", exact: true }),
  ).toHaveCount(0);
  await rename.click();
  const name = page.getByLabel("Dashboard name", { exact: true });
  await expect(name).toBeFocused();
  await expect(save).toBeDisabled();
  await name.fill("Changed name");
  await expect(save).toBeEnabled();
  await name.press("Escape");
  await expect(rename).toHaveText("Layout test");
  await expect(save).toBeDisabled();
  await rename.click();
  await name.fill("Changed name");
  await name.fill("Layout test");
  await expect(save).toBeDisabled();
  await name.fill("Changed name");
  await name.press("Enter");
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.saves[0]).toMatchObject({
    name: "Changed name",
    expected_revision: "7",
    panels: initial.panels,
  });
});

test("unchanged panel edits, Cancel, and creating then deleting a draft panel keep Save disabled", async ({
  page,
}) => {
  await setup(page);
  const save = page.getByRole("button", { name: "Save", exact: true });
  let dialog = await editPanel(page, "First");
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(save).toBeDisabled();
  dialog = await editPanel(page, "First");
  await dialog.getByLabel("Custom title (optional)").fill("Canceled");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tile(page, "First")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  await create
    .getByRole("combobox", { name: "Saved preset", exact: true })
    .click();
  await create.getByRole("option", { name: "All alerts" }).click();
  await create.getByLabel("Custom title (optional)").fill("Transient");
  await create
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await page
    .getByRole("button", { name: "Options for Transient", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete panel", exact: true })
    .click();
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create panel", exact: true }),
  ).toBeFocused();
});

test("panel dialog keeps focus inside, rejects unordered exact bounds and can be dismissed", async ({
  page,
}, testInfo) => {
  await setup(page);
  const options = page.getByRole("button", {
    name: "Options for First",
    exact: true,
  });
  const dialog = await editPanel(page, "First");
  await dialog
    .getByRole("button", { name: "Add threshold", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add threshold", exact: true })
    .click();
  await dialog.getByLabel("Exact lower bound 1").fill("9007199254740999");
  await dialog.getByLabel("Exact lower bound 2").fill("9007199254740998");
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Thresholds must increase",
  );
  await expect(dialog.getByLabel("Exact lower bound 2")).toBeFocused();
  const apply = dialog.getByRole("button", {
    name: "Apply changes",
    exact: true,
  });
  await apply.focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("panel-dialog.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(options).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("uncertain Save locks edits and retries the exact original command", async ({
  page,
}) => {
  const state = await setup(page, { failSaveOnce: true });
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page.getByLabel("Dashboard name", { exact: true }).fill("Retry name");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const retry = page.getByRole("button", {
    name: "Retry original command",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create panel", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await retry.click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  expect(state.saves[1]).toEqual(state.saves[0]);
});

test("remote saves update a clean board and preserve a dirty draft until explicit discard", async ({
  page,
}) => {
  const state = await setup(page);
  await expect(tile(page, "First")).toContainText("12");
  state.definition = {
    ...state.definition,
    name: "Remote name",
    revision: "8",
  };
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Remote name");
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page.getByLabel("Dashboard name", { exact: true }).fill("My draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  state.definition = {
    ...state.definition,
    name: "Newer remote name",
    revision: "9",
  };
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "A newer shared version is available" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("My draft");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Newer remote name");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("tenant refresh adopts shared definitions and preserves dirty drafts", async ({
  page,
}) => {
  const state = await setup(page);
  state.definition = {
    ...state.definition,
    name: "Refreshed remote",
    revision: "8",
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Refreshed remote");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page
    .getByLabel("Dashboard name", { exact: true })
    .fill("Refreshed local draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  state.definition = {
    ...state.definition,
    name: "New refreshed remote",
    revision: "9",
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "A newer shared version is available" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Refreshed local draft");
});

test("deleted shared dashboards preserve a permitted draft for Save as new", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page.getByLabel("Dashboard name", { exact: true }).fill("Kept draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  state.deleted = true;
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "This shared dashboard was deleted" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Kept draft");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save as new…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Save as a new dashboard",
    exact: true,
  });
  await expect(
    dialog.getByLabel("New dashboard name", { exact: true }),
  ).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.saves).toHaveLength(0);
});

test("toolbar discard confirms, restores the saved draft and never previews counts", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  const discard = page.getByRole("button", {
    name: "Discard changes",
    exact: true,
  });
  await expect(discard).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /Pause updates|Resume updates|Preview draft counts/,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page
    .getByLabel("Dashboard name", { exact: true })
    .fill("Toolbar draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  let previewRequests = 0;
  await page.route(`**/api/tenants/${tenant}/dashboards/preview`, (route) => {
    previewRequests++;
    return route.fulfill({ status: 500, json: {} });
  });
  await expect(tile(page, "First")).toContainText("12");
  await expect(discard).toBeEnabled();
  await expect(
    page.getByText("Changes are visible only to you until you save.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Click a panel to open its preset", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".db-count-actions, .db-provenance")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Count provenance", exact: true }),
  ).toHaveCount(0);
  const moveHandle = page.getByRole("button", {
    name: "Move First",
    exact: true,
  });
  const helpId = await moveHandle.getAttribute("aria-describedby");
  expect(helpId).toBeTruthy();
  const help = page.locator(`[id="${helpId}"]`);
  await expect(help).toContainText("Arrow keys also work on either handle");
  const helpBox = (await help.boundingBox())!;
  expect(helpBox.width).toBeLessThanOrEqual(1);
  expect(helpBox.height).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("toolbar-dirty.png") });
  await discard.focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discard).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Toolbar draft");
  await discard.click();
  await confirmation
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(discard).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Layout test");
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await expect(tile(page, "First")).toContainText("12");
  await expect(tile(page, "Second")).toContainText("12");
  await expect(
    page.getByRole("button", { name: "Count provenance", exact: true }),
  ).toHaveCount(0);
  expect(previewRequests).toBe(0);
  expect(state.saves).toHaveLength(0);
});

for (const role of ["edit", "view"]) {
  test(`clean deleted dashboard returns ${role} users to the list without creation controls`, async ({
    page,
  }) => {
    const state = await setup(page, { role });
    await expect(tile(page, "First")).toContainText("12");
    state.deleted = true;
    await page
      .getByRole("button", { name: "Refresh counts", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/tenants/${tenant}/dashboards$`));
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "The open dashboard was deleted" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save as new…", exact: true }),
    ).toHaveCount(0);
    expect(state.saves).toHaveLength(0);
  });
}

test("changing a panel preset never displays another preset's saved count", async ({
  page,
}) => {
  const state = await setup(page);
  const other = "00000000-0000-4000-8000-000000000099";
  const row = { id: other, name: "Other preset", revision: "1", cel: "true" };
  await page.route(`**/api/tenants/${tenant}/presets?*`, (route) =>
    route.fulfill({
      json: {
        data: [
          { id: preset, name: "All alerts", revision: "1", cel: "true" },
          row,
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route(`**/api/tenants/${tenant}/presets/${other}`, (route) =>
    route.fulfill({ json: { data: row } }),
  );
  await expect(tile(page, "First")).toContainText("12");
  const dialog = await editPanel(page, "First");
  await dialog
    .getByRole("combobox", { name: "Saved preset", exact: true })
    .click();
  await dialog.getByRole("option", { name: "Other preset" }).click();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(tile(page, "First")).toContainText(
    "Save the dashboard to count this panel",
  );
  await expect(tile(page, "First")).not.toContainText("12");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((state.saves[0].panels as typeof initial.panels)[0]).toMatchObject({
    preset_id: other,
    id: initial.panels[0].id,
  });
  await expect(tile(page, "First")).toContainText("12");
});

test("deleting an existing panel stays local until the full dashboard is saved", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole("button", { name: "Options for Second", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete panel", exact: true })
    .click();
  await expect(tile(page, "Second")).toHaveCount(0);
  expect(state.definition.panels).toHaveLength(3);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  expect(state.definition.panels.map((item) => item.title)).toEqual([
    "First",
    "Third",
  ]);
});

test("access loss clears the ordinary board and its unsaved draft", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page
    .getByLabel("Dashboard name", { exact: true })
    .fill("Protected draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  // Hold the denial until the refresh click finishes so a background response
  // cannot remove the toolbar before that click.
  let releaseDenial!: () => void;
  const denial = new Promise<void>((resolve) => {
    releaseDenial = resolve;
  });
  let revoked = false;
  await page.route("**/auth/session", (route) =>
    revoked
      ? route.fulfill({
          status: 401,
          json: {
            error: { code: "unauthorized", message: "Session expired." },
          },
        })
      : route.fallback(),
  );
  await page.route(`**${api}/counts`, async (route) => {
    await denial;
    revoked = true;
    return route.fulfill({
      status: 403,
      json: { error: { code: "forbidden", message: "Access removed." } },
    });
  });
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  releaseDenial();
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("Protected draft", { exact: true })).toHaveCount(
    0,
  );
});

test("drag previews collisions without saving and persists the whole layout on explicit save", async ({
  page,
}) => {
  const state = await setup(page);
  const first = tile(page, "First");
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    3,
    0,
    false,
  );
  await expect
    .poll(() => position(first))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
  await expect
    .poll(() => position(tile(page, "Second")))
    .toEqual({ column: "4 / span 3", row: "3 / span 2" });
  expect(state.saves).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Move First", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}$`));
  expect(state.saves[0].expected_revision).toBe("7");
  expect(state.saves[0].command_id).toBeTruthy();
  expect(
    state.definition.panels.find((item) => item.title === "First"),
  ).toMatchObject({ x: 3, y: 0, w: 3, h: 2, id: initial.panels[0].id });
  await page.reload();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
  await expect(
    page.getByRole("button", { name: "Move First", exact: true }),
  ).toBeVisible();
});

test("corner resize snaps to whole grid units and displaces panels without overlap", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  await drag(
    page,
    page.getByRole("button", { name: "Resize First", exact: true }),
    3,
    2,
  );
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "1 / span 6", row: "1 / span 4" });
  await expect
    .poll(() => position(tile(page, "Second")))
    .toEqual({ column: "4 / span 3", row: "5 / span 2" });
  await expect
    .poll(() => position(tile(page, "Third")))
    .toEqual({ column: "7 / span 3", row: "1 / span 2" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.definition.panels[0]).toMatchObject({ w: 6, h: 4 });
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}$`));
  await page.screenshot({
    path: testInfo.outputPath("desktop-saved.png"),
  });
});

test("dragging a later panel before earlier panels keeps pointer capture and focus", async ({
  page,
}, testInfo) => {
  await setup(page);
  const handle = page.getByRole("button", { name: "Move Second", exact: true });
  await drag(page, handle, -3, 0, false);
  await expect
    .poll(() => position(tile(page, "Second")))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "1 / span 3", row: "3 / span 2" });
  await page.mouse.up();
  await expect(handle).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("desktop-editor.png"),
  });
});

test("Escape and pointer cancellation restore the draft and leave it clean", async ({
  page,
}) => {
  await setup(page);
  const original = await position(tile(page, "First"));
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    4,
    2,
    false,
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => position(tile(page, "First"))).toEqual(original);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await drag(
    page,
    page.getByRole("button", { name: "Resize First", exact: true }),
    3,
    1,
    false,
  );
  await page
    .getByRole("button", { name: "Resize First", exact: true })
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect.poll(() => position(tile(page, "First"))).toEqual(original);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("keyboard move and resize retain focus, announce changes and preserve conflicts", async ({
  page,
}) => {
  const state = await setup(page, { conflict: true });
  const move = page.getByRole("button", { name: "Move First", exact: true });
  await move.focus();
  await move.press("ArrowRight");
  await expect(move).toBeFocused();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "2 / span 3", row: "1 / span 2" });
  const resize = page.getByRole("button", {
    name: "Resize First",
    exact: true,
  });
  await resize.focus();
  await resize.press("ArrowRight");
  await resize.press("ArrowDown");
  await expect(resize).toBeFocused();
  await expect(
    page.getByRole("status").filter({
      hasText: "First: column 2, row 1, 4 columns wide and 3 units high",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The dashboard changed." }),
  ).toBeVisible();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "2 / span 4", row: "1 / span 3" });
  expect(state.saves[0].expected_revision).toBe("7");
});

/** Requirements: REV-50; dashboard operations 4. Sizes are set on the grid only. */
test("panel width grows one column at a time to the full row and height has no cap", async ({
  page,
}) => {
  const state = await setup(page);
  const dialog = await editPanel(page, "First");
  await expect(
    dialog.getByRole("combobox", { name: /Width|Height/ }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const resize = page.getByRole("button", {
    name: "Resize First",
    exact: true,
  });
  await resize.focus();
  for (let w = 4; w <= 12; w++) {
    await resize.press("ArrowRight");
    await expect
      .poll(() => position(tile(page, "First")))
      .toEqual({ column: `1 / span ${w}`, row: "1 / span 2" });
  }
  await resize.press("ArrowRight");
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "1 / span 12", row: "1 / span 2" });
  for (let i = 0; i < 7; i++) await resize.press("ArrowDown");
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "1 / span 12", row: "1 / span 9" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.definition.panels[0]).toMatchObject({ w: 12, h: 9 });
});

async function editPanel(page: Page, title: string) {
  await page
    .getByRole("button", { name: `Options for ${title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit panel", exact: true }).click();
  return page.getByRole("dialog", { name: "Edit panel", exact: true });
}
test("title, threshold, create and delete preserve columns in a compacted layout", async ({
  page,
}) => {
  await setup(page, {
    panels: [panel(30, "First", 6, 4), panel(31, "Second", 0, 0)],
  });
  const dialog = await editPanel(page, "First");
  await dialog.getByLabel("Custom title (optional)").fill("Renamed");
  await dialog
    .getByRole("button", { name: "Add threshold", exact: true })
    .click();
  await dialog.getByLabel("Exact lower bound 1").fill("5");
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect
    .poll(() => position(tile(page, "Renamed")))
    .toEqual({ column: "7 / span 3", row: "1 / span 2" });
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  await create
    .getByRole("combobox", { name: "Saved preset", exact: true })
    .click();
  await create.getByRole("option", { name: "All alerts" }).click();
  await create.getByLabel("Custom title (optional)").fill("Added");
  await create
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect
    .poll(() => position(tile(page, "Added")))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
  await page
    .getByRole("button", { name: "Options for Added", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete panel", exact: true })
    .click();
  await expect(tile(page, "Added")).toHaveCount(0);
  await expect
    .poll(() => position(tile(page, "Renamed")))
    .toEqual({ column: "7 / span 3", row: "1 / span 2" });
});

for (const width of [800, 390]) {
  test(`responsive ${width}px editing preserves desktop columns and compacts vertical gaps`, async ({
    page,
  }, testInfo) => {
    const state = await setup(page, {
      panels: [panel(30, "First", 6, 4), panel(31, "Second", 0, 0)],
    });
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("button", { name: "Move First", exact: true }),
    ).toBeHidden();
    const dialog = await editPanel(page, "First");
    await dialog.getByLabel("Custom title (optional)").fill("Edited");
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Options for Edited", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => state.saves.length).toBe(1);
    expect(
      state.definition.panels.find((item) => item.title === "Edited"),
    ).toMatchObject({ x: 6, y: 0, w: 3, h: 2 });
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}$`));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const valueLabel = tile(page, "Edited").locator(".pn-value > b");
    const labelBox = (await valueLabel.boundingBox())!;
    const panelBox = (await tile(page, "Edited").boundingBox())!;
    expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(
      panelBox.y + panelBox.height,
    );
    await page.screenshot({
      path: testInfo.outputPath(`saved-${width}.png`),
    });
  });
}

test("viewers see counts without editing controls", async ({ page }) => {
  await setup(page, { role: "view" });
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Move |^Resize / }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Discard changes|Pause updates|Resume updates|Preview draft counts/,
    }),
  ).toHaveCount(0);
});

/** Requirements: REV-60; dashboard operations 4. Panels move on the grid only. */
test("panel options offer Edit and Delete without Move actions", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: "Options for Second", exact: true })
    .click();
  await expect(page.getByRole("menuitem")).toHaveText([
    /^Edit panel/,
    "Delete panel",
  ]);
});

/** Requirements: REV-61; dashboard operations 8. E edits the hovered panel. */
test("pressing E over a panel opens its Edit panel dialog", async ({
  page,
}) => {
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(
    page.getByRole("menuitem", { name: "Edit panel", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("e");
  await expect(dialog).toHaveCount(0);
  await tile(page, "Second").hover();
  await page.keyboard.press("e");
  await expect(dialog).toBeVisible();
  const title = dialog.getByLabel("Custom title (optional)");
  await expect(title).toHaveValue("Second");
  // Typing in the dialog never reopens it or loses the letter.
  await title.fill("");
  await title.press("e");
  await expect(title).toHaveValue("e");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Modifier chords and an open menu are left to the browser and the menu.
  await tile(page, "Third").hover();
  await page.keyboard.press("Control+e");
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Options for Third", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Edit panel", exact: true }),
  ).toHaveAttribute("aria-keyshortcuts", "E");
  await page.keyboard.press("e");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Keyboard users get the same shortcut from a panel's focused handle.
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Move First", exact: true }).focus();
  await page.keyboard.press("E");
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue("First");
});

/** Requirements: REV-61; dashboard operations 8. */
test("E does nothing in fullscreen or while renaming", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await setup(page);
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  const name = page.getByRole("textbox", { name: "Dashboard name" });
  await tile(page, "First").hover();
  await name.press("End");
  await name.press("e");
  await expect(name).toHaveValue("Layout teste");
  await expect(dialog).toHaveCount(0);
  await name.press("Escape");
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await tile(page, "First").hover();
  await page.keyboard.press("e");
  await expect(dialog).toHaveCount(0);
});

/** Requirements: REV-61; dashboard operations 8. */
test("E opens nothing for viewers", async ({ page }) => {
  await setup(page, { role: "view" });
  await tile(page, "First").hover();
  await page.keyboard.press("e");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("opening a panel dialog cancels an active drag without overwriting edits", async ({
  page,
}) => {
  await setup(page);
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    3,
    1,
    false,
  );
  await page
    .getByRole("button", { name: "Options for First", exact: true })
    .dispatchEvent("click");
  await page
    .getByRole("menuitem", { name: "Edit panel", exact: true })
    .dispatchEvent("click");
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await dialog
    .getByLabel("Custom title (optional)")
    .fill("Updated during drag");
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await page.mouse.up();
  await expect
    .poll(() => position(tile(page, "Updated during drag")))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
});

test("another pointer cannot finish the active drag", async ({ page }) => {
  await setup(page);
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    3,
    1,
    false,
  );
  const other = page.getByRole("button", { name: "Move Third", exact: true });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    await other.dispatchEvent(event, { pointerId: 99 });
  await expect(page.locator(".de-tile-active")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.mouse.up();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
});

test("collision chains compact every column and reject actual overflow atomically", () => {
  const panels = [
    panel(30, "First", 0),
    panel(31, "Second", 3),
    panel(32, "Third", 3, 2),
    panel(33, "Untouched", 9, 8),
  ];
  const result = placePanel(panels, panels[0].id, { w: 6, h: 4 })!;
  expect(result.find((item) => item.title === "Second")).toMatchObject({
    x: 3,
    y: 4,
  });
  expect(result.find((item) => item.title === "Third")).toMatchObject({
    x: 3,
    y: 6,
  });
  expect(result.find((item) => item.title === "Untouched")).toEqual({
    ...panels[3],
    y: 0,
  });
  expect(
    placePanel(
      Array.from({ length: 26 }, (_, index) => ({
        ...panel(30 + index, `Panel ${index}`, 0, index * 4),
        w: 12,
        h: index < 2 ? 2 : 4,
      })),
      panels[0].id,
      { h: 4 },
    ),
  ).toBeNull();
  expect(placePanel(panels, panels[0].id, { x: 10 })).toBeNull();
  expect(placePanel(panels, panels[0].id, { w: 5, h: 9 })).not.toBeNull();
  for (const patch of [{ w: 2 }, { w: 13 }, { h: 1 }, { w: 3.5 }])
    expect(placePanel(panels, panels[0].id, patch)).toBeNull();
  expect(panels[1].y).toBe(0);
  expect(
    firstPanelGap(
      [panel(30, "First", 0), panel(31, "Second", 6)],
      panel(32, "New", 0),
    ),
  ).toMatchObject({ x: 3, y: 0 });
});

test("drag follows small pointer movements while its destination stays compacted", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  const first = tile(page, "First");
  const original = (await first.boundingBox())!;
  const handle = page.getByRole("button", { name: "Move First", exact: true });
  const grip = (await handle.boundingBox())!;
  const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 17, start.y + 22);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.x - original.x))
    .toBe(17);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.y - original.y))
    .toBe(22);
  await expect
    .poll(() => position(first))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await expect(page.locator(".de-drop-placeholder")).toHaveCount(1);
  await page.mouse.move(start.x + 26, start.y + 37);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.x - original.x))
    .toBe(26);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.y - original.y))
    .toBe(37);
  await page.screenshot({ path: testInfo.outputPath("fluid-drag.png") });
  expect(state.saves).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.y - original.y))
    .toBe(0);
  await expect(page.locator(".de-drop-placeholder")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("resize follows pixel movement before snapping to permitted saved dimensions", async ({
  page,
}, testInfo) => {
  await setup(page);
  const first = tile(page, "First");
  const original = (await first.boundingBox())!;
  const corner = (await page
    .getByRole("button", { name: "Resize First", exact: true })
    .boundingBox())!;
  const start = {
    x: corner.x + corner.width / 2,
    y: corner.y + corner.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 17, start.y + 13);
  await expect
    .poll(async () =>
      Math.round((await first.boundingBox())!.width - original.width),
    )
    .toBe(17);
  await expect
    .poll(async () =>
      Math.round((await first.boundingBox())!.height - original.height),
    )
    .toBe(13);
  await expect
    .poll(() => position(first))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await page.screenshot({ path: testInfo.outputPath("fluid-resize.png") });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Math.round((await first.boundingBox())!.width - original.width),
    )
    .toBe(0);
  await expect
    .poll(async () =>
      Math.round((await first.boundingBox())!.height - original.height),
    )
    .toBe(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("dropping into an empty column settles at the top and persists only on Save", async ({
  page,
}) => {
  const state = await setup(page);
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    9,
    7,
  );
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "10 / span 3", row: "1 / span 2" });
  expect(state.saves).toHaveLength(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(
    state.definition.panels.find((item) => item.title === "First"),
  ).toMatchObject({ x: 9, y: 0 });
});

test("shrinking and deleting a supporting panel close the vertical gap", async ({
  page,
}, testInfo) => {
  const state = await setup(page, {
    panels: [
      { ...panel(30, "Tall", 0), h: 4 },
      panel(31, "Below", 0, 12),
      panel(32, "Side", 6, 30),
    ],
  });
  await expect
    .poll(() => position(tile(page, "Below")))
    .toEqual({ column: "1 / span 3", row: "5 / span 2" });
  await expect
    .poll(() => position(tile(page, "Side")))
    .toEqual({ column: "7 / span 3", row: "1 / span 2" });
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  const resize = page.getByRole("button", { name: "Resize Tall", exact: true });
  await resize.press("ArrowUp");
  await resize.press("ArrowUp");
  await expect
    .poll(() => position(tile(page, "Below")))
    .toEqual({ column: "1 / span 3", row: "3 / span 2" });
  await page
    .getByRole("button", { name: "Options for Tall", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete panel", exact: true })
    .click();
  await expect
    .poll(() => position(tile(page, "Below")))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.definition.panels.every((item) => item.y === 0)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("compacted-board.png") });
});

test("dragging below a supporting panel changes their order without leaving gaps", async ({
  page,
}) => {
  const state = await setup(page, {
    panels: [panel(30, "First", 0), panel(31, "Second", 0, 2)],
  });
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    0,
    5,
  );
  await expect
    .poll(() => position(tile(page, "Second")))
    .toEqual({ column: "1 / span 3", row: "1 / span 2" });
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "1 / span 3", row: "3 / span 2" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.definition.panels.map((item) => item.title)).toEqual([
    "Second",
    "First",
  ]);
});

test("viewers and fullscreen see compacted older layouts", async ({ page }) => {
  await setup(page, {
    role: "view",
    panels: [panel(30, "First", 6, 20), panel(31, "Second", 0, 8)],
  });
  for (const title of ["First", "Second"])
    await expect
      .poll(() => position(tile(page, title)))
      .toEqual({
        column: title === "First" ? "7 / span 3" : "1 / span 3",
        row: "1 / span 2",
      });
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "7 / span 3", row: "1 / span 2" });
});

test("reduced motion keeps pointer following and skips settling animations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    3,
    0,
    false,
  );
  await expect
    .poll(() => position(tile(page, "Second")))
    .toEqual({ column: "4 / span 3", row: "3 / span 2" });
  expect(
    await page
      .locator(".de-grid")
      .evaluate((grid) => grid.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await page.mouse.up();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
});

test("vertical compaction preserves blockers, metadata and caller data", () => {
  const panels = [
    { ...panel(30, "Wide", 0, 4), w: 6, h: 4 },
    panel(31, "Side", 6, 12),
    panel(32, "Below", 0, 30),
    { ...panel(33, "Bridge", 0, 50), w: 12 },
  ];
  const next = compactPanels(panels);
  expect(next.map((item) => [item.title, item.y])).toEqual([
    ["Wide", 0],
    ["Side", 0],
    ["Below", 4],
    ["Bridge", 6],
  ]);
  expect(next.map((item) => item.id).sort()).toEqual(
    panels.map((item) => item.id).sort(),
  );
  expect(next.find((item) => item.title === "Below")).toEqual({
    ...panels[2],
    y: 4,
  });
  expect(compactPanels(next)).toEqual(next);
  expect(panels.map((item) => item.y)).toEqual([4, 12, 30, 50]);
});

test("picking up a settling panel preserves its visible position", async ({
  page,
}) => {
  await setup(page);
  const first = tile(page, "First");
  const handle = page.getByRole("button", { name: "Move First", exact: true });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + 17,
    grip.y + grip.height / 2 + 81,
  );
  await expect(page.locator(".de-tile-active")).toHaveCount(1);
  await page.mouse.up();
  // Hold a real settling animation mid-flight to make rapid pickup reproducible.
  await first.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation) throw new Error("Expected panel settling animation");
    animation.pause();
    animation.currentTime = 30;
  });
  const visible = (await first.boundingBox())!;
  const nextGrip = (await handle.boundingBox())!;
  await page.mouse.move(
    nextGrip.x + nextGrip.width / 2,
    nextGrip.y + nextGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    nextGrip.x + nextGrip.width / 2 + 8,
    nextGrip.y + nextGrip.height / 2 + 7,
  );
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.x - visible.x))
    .toBe(8);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.y - visible.y))
    .toBe(7);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});

test("a newer shared revision preserves an active drag in a dirty local draft", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole("button", { name: "Edit dashboard name", exact: true })
    .click();
  await page.getByLabel("Dashboard name", { exact: true }).fill("Local draft");
  await page.getByLabel("Dashboard name", { exact: true }).press("Enter");
  await drag(
    page,
    page.getByRole("button", { name: "Move First", exact: true }),
    3,
    0,
    false,
  );
  state.definition = {
    ...state.definition,
    revision: "8",
    name: "Remote update",
  };
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .dispatchEvent("click");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "A newer shared version is available" }),
  ).toBeVisible();
  await expect(page.locator(".de-tile-active")).toHaveCount(1);
  await page.mouse.up();
  await expect
    .poll(() => position(tile(page, "First")))
    .toEqual({ column: "4 / span 3", row: "1 / span 2" });
  await expect(
    page.getByRole("button", { name: "Edit dashboard name", exact: true }),
  ).toHaveText("Local draft");
  expect(state.saves).toHaveLength(0);
});

test("clicking a settling handle without dragging lets the panel finish settling", async ({
  page,
}) => {
  await setup(page);
  const first = tile(page, "First");
  const original = (await first.boundingBox())!;
  const handle = page.getByRole("button", { name: "Move First", exact: true });
  await drag(page, handle, 0, 1);
  await first.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation) throw new Error("Expected panel settling animation");
    animation.pause();
    animation.currentTime = 30;
  });
  await handle.click();
  await expect
    .poll(() =>
      first.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation.playState === "paused"),
      ),
    )
    .toBe(false);
  await expect
    .poll(async () => Math.round((await first.boundingBox())!.y - original.y))
    .toBe(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
});
