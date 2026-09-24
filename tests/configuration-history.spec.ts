import { expect, test, type Page } from "@playwright/test";
const tenant = "00000000-0000-4000-8000-000000000001",
  id = "00000000-0000-4000-8000-000000000010",
  presetId = "00000000-0000-4000-8000-000000000020",
  panelId = "00000000-0000-4000-8000-000000000030";
const at = "2026-09-23T10:00:00Z";
const preset = {
  id,
  revision: "9007199254740999",
  name: "Current preset",
  cel: "true",
  columns: ["severity", "message"],
  sort: [{ field: "timestamp", direction: "desc" }],
};
const oldPreset = {
  ...preset,
  revision: "2",
  name: "Historical preset",
  cel: 'alert.severity == "critical"',
};
const dashboard = {
  id,
  revision: "4",
  name: "Deleted dashboard",
  deleted_at: at,
  panels: [
    {
      id: panelId,
      preset_id: presetId,
      title: "Historical panel",
      x: 0,
      y: 0,
      w: 6,
      h: 2,
      thresholds: [{ lower_bound: "9007199254740999", color: "red" }],
    },
  ],
};
async function setup(page: Page, section = "presets", role = "edit") {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: "00000000-0000-4000-8000-000000000099",
            display_name: "Synthetic history user",
          },
          csrf_token: "history-csrf",
          tenants: [
            { id: tenant, name: "Global", kind: "global", role, revision: "1" },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith(`/${section}/${id}/history`))
      return route.fulfill({
        json: {
          data: [
            {
              revision: section === "presets" ? "2" : "4",
              recorded_at: at,
              definition_available: true,
              activity_available: section !== "presets",
            },
          ],
          next_cursor: null,
        },
      });
    if (
      path.endsWith(
        `/${section}/${id}/history/${section === "presets" ? "2" : "4"}`,
      )
    )
      return route.fulfill({
        json: {
          data: {
            definition: section === "presets" ? oldPreset : dashboard,
            before_definition:
              section === "presets"
                ? { ...oldPreset, revision: "1", cel: "false" }
                : { ...dashboard, revision: "3", deleted_at: null },
            activity:
              section === "presets"
                ? null
                : {
                    kind: "deleted",
                    command_id: "00000000-0000-4000-8000-000000000088",
                    actor_id: "00000000-0000-4000-8000-000000000099",
                    actor_label: "Synthetic historical editor",
                    before_revision: "3",
                    after_revision: "4",
                    changed_fields: null,
                    recorded_at: at,
                  },
          },
        },
      });
    if (path.endsWith(`/${section}/${id}`))
      return section === "presets"
        ? route.fulfill({ json: { data: preset } })
        : route.fulfill({
            status: 404,
            json: {
              error: { code: "not_found", message: "Resource unavailable" },
            },
          });
    if (path.endsWith("/presets"))
      return route.fulfill({ json: { data: [{ ...preset, id: presetId }] } });
    if (path.endsWith(`/presets/${presetId}`))
      return route.fulfill({ json: { data: { ...preset, id: presetId } } });
    if (path.endsWith("/dashboards"))
      return route.fulfill({
        json: {
          data: url.searchParams.get("state") === "deleted" ? [dashboard] : [],
          next_cursor: null,
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
}

test("shared definition editing transfers keyboard focus and restores it after discard or save", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${id}`);
  const edit = page.getByRole("link", { name: "Edit preset", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/presets/${id}/edit$`));
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("Unsaved keyboard draft");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await discard.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(discard).toBeFocused();
  await expect(name).toHaveValue("Unsaved keyboard draft");
  await page.keyboard.press("Enter");
  await confirm.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/presets/${id}$`));
  await expect(edit).toBeFocused();
  await expect(name).toHaveCount(0);
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route(`**/api/tenants/*/presets/${id}`, (route) => {
    if (route.request().method() !== "GET")
      writes.push({
        method: route.request().method(),
        body: route.request().postDataJSON(),
      });
    return route.fulfill({ json: { data: preset } });
  });
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await name.fill("Saved keyboard draft");
  await page.getByRole("button", { name: "Save changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/presets/${id}$`));
  await expect(edit).toBeFocused();
  await expect(name).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("PUT");
  expect(writes[0].body).toMatchObject({
    name: "Saved keyboard draft",
    cel: preset.cel,
    columns: preset.columns,
    sort: preset.sort,
    expected_revision: preset.revision,
  });
  expect(writes[0].body.command_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("saved results use the saved preview while quick views and counts use candidates", async ({
  page,
}) => {
  await setup(page);
  const previews: Record<string, unknown>[] = [];
  let changed = false;
  await page.route("**/presets/preview", (route) => {
    const body = route.request().postDataJSON();
    previews.push(body);
    expect(route.request().headers()["x-csrf-token"]).toBe("history-csrf");
    if (changed && body.preset_id) {
      changed = false;
      return route.fulfill({
        status: 409,
        json: {
          error: { code: "preset_changed", message: "Preset changed" },
        },
      });
    }
    return route.fulfill({
      json: {
        data:
          body.limit === 1
            ? []
            : [
                {
                  id: presetId,
                  revision: "3",
                  severity: "critical",
                  status: "firing",
                  message: body.cursor
                    ? "Second page alert"
                    : "First page alert",
                  application: "synthetic",
                  acknowledged: false,
                },
              ],
        meta: {
          total: body.limit === 1 ? "9007199254740993" : "9007199254740999",
          evaluated_at: at,
          updating: false,
        },
        next_cursor: body.cursor || body.limit === 1 ? null : "opaque-next",
      },
    });
  });
  await page.goto(`/tenants/${tenant}/presets/${id}`);
  await expect(
    page.getByText("9,007,199,254,740,999 matching alerts", { exact: false }),
  ).toBeVisible();
  const saved = previews.find((body) => body.preset_id);
  expect(saved).toMatchObject({
    preset_id: id,
    expected_revision: preset.revision,
    include_suppressed: false,
    limit: 50,
  });
  expect(saved).not.toHaveProperty("cel");
  expect(saved).not.toHaveProperty("sort");
  expect(saved).not.toHaveProperty("columns");
  const counts = previews.filter((body) => body.limit === 1);
  expect(counts.length).toBeGreaterThan(0);
  for (const body of counts) {
    expect(body).not.toHaveProperty("preset_id");
    expect(body).not.toHaveProperty("expected_revision");
    expect(body).toMatchObject({ sort: preset.sort, columns: preset.columns });
  }
  await page.getByRole("button", { name: "Next results page" }).click();
  await expect(
    page.getByRole("link", { name: "Open Second page alert" }),
  ).toBeVisible();
  expect(previews.findLast((body) => body.cursor)).toMatchObject({
    preset_id: id,
    expected_revision: preset.revision,
    cursor: "opaque-next",
    limit: 50,
  });
  await page.getByRole("button", { name: "Critical", exact: true }).click();
  await expect
    .poll(() =>
      previews.some(
        (body) =>
          body.limit === 50 &&
          body.cel === `(${preset.cel}) && (alert.severity == "critical")`,
      ),
    )
    .toBe(true);
  const quick = previews.findLast((body) => body.limit === 50);
  expect(quick).not.toHaveProperty("preset_id");
  expect(quick).not.toHaveProperty("cursor");
  expect(quick).toMatchObject({ sort: preset.sort, columns: preset.columns });
  await page.getByRole("button", { name: "All", exact: true }).click();
  const reads = { count: 0 };
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname.endsWith(`/presets/${id}`)
    )
      reads.count++;
  });
  changed = true;
  await page
    .getByRole("button", { name: "More preset actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Refresh results" }).click();
  await expect.poll(() => reads.count).toBeGreaterThan(0);
  await expect(
    page.getByText("9,007,199,254,740,999 matching alerts", { exact: false }),
  ).toBeVisible();
});

test("preset deletion confirms by name and sends revision headers", async ({
  page,
}) => {
  await setup(page);
  let deleted: Record<string, string> | undefined;
  await page.route(`**/api/tenants/*/presets/${id}`, (route) => {
    if (route.request().method() === "DELETE") {
      deleted = route.request().headers();
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "preset_in_use",
            message: "Dashboards still use this preset",
          },
        },
      });
    }
    return route.fulfill({ json: { data: preset } });
  });
  await page.goto(`/tenants/${tenant}/presets/${id}`);
  await page
    .getByRole("button", { name: "More preset actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete preset" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: `Delete preset “${preset.name}”?`,
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(deleted).toBeUndefined();
  await page
    .getByRole("button", { name: "More preset actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete preset" }).click();
  await confirm.getByRole("button", { name: "Delete preset" }).click();
  await expect(
    page.getByText("Dashboards still use this preset", { exact: false }),
  ).toBeVisible();
  expect(deleted?.["if-match"]).toBe(`"${preset.revision}"`);
  expect(deleted?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(deleted?.["x-csrf-token"]).toBe("history-csrf");
  await expect(
    page.getByRole("button", { name: "View dashboard references" }),
  ).toBeVisible();
});

test("history comparison reuses source with current revision and preserves conflict and retry drafts", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${id}/history`);
  await expect(
    page.getByText(
      "Activity metadata is unavailable for this retained revision.",
    ),
  ).toBeVisible();
  const comparison = page.getByRole("region", {
    name: "Revision 2 comparison",
  });
  await expect(
    comparison.getByRole("columnheader", {
      name: `Current · revision ${preset.revision}`,
    }),
  ).toBeVisible();
  await expect(comparison.getByText("Differs")).toHaveCount(2);
  await page.getByLabel("Compare with").selectOption("before");
  await expect(comparison.getByText("false", { exact: true })).toBeVisible();
  await expect(
    comparison.getByText(oldPreset.cel, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use this revision", exact: true })
    .click();
  await expect(page.getByLabel("Filter (CEL)", { exact: true })).toHaveValue(
    oldPreset.cel,
  );
  const writes: Record<string, unknown>[] = [];
  await page.route(`**/api/tenants/*/presets/${id}`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { data: preset } });
    writes.push(route.request().postDataJSON());
    expect(route.request().method()).toBe("PUT");
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: "revision_conflict",
          message: "A newer shared revision exists",
        },
      },
    });
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("A newer shared revision exists", { exact: false }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    expected_revision: preset.revision,
    cel: oldPreset.cel,
  });
  await expect(page.getByLabel("Filter (CEL)", { exact: true })).toHaveValue(
    oldPreset.cel,
  );
  await page.getByRole("button", { name: "Save as new…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save as a new preset" });
  const copyName = dialog.getByLabel("New preset name", { exact: true });
  await expect(copyName).toHaveValue("");
  await copyName.fill("Explicit new preset name");
  const copies: Record<string, unknown>[] = [];
  await page.route(`**/api/tenants/${tenant}/presets`, (route) => {
    copies.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("history-csrf");
    return copies.length === 1
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "unavailable", message: "Outcome uncertain" },
          },
        })
      : route.fulfill({
          json: {
            data: { ...preset, id: presetId, name: "Explicit new preset name" },
          },
        });
  });
  await dialog.getByRole("button", { name: "Create preset" }).click();
  await expect(
    dialog.getByRole("button", { name: "Retry original command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "The outcome is uncertain." }),
  ).toBeVisible();
  await copyName.fill("Later local draft");
  await dialog.getByRole("button", { name: "Retry original command" }).click();
  await expect(
    page.getByRole("button", { name: "Open saved definition" }),
  ).toBeVisible();
  expect(copies).toHaveLength(2);
  expect(copies[1]).toEqual(copies[0]);
  expect(copies[0]).toMatchObject({
    name: "Explicit new preset name",
    cel: oldPreset.cel,
  });
  expect(copies[0]).not.toHaveProperty("expected_revision");
  expect(copies[0]).not.toHaveProperty("id");
  expect(copies[0].command_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("deleted dashboard history creates a new named identity with new panel IDs and retained references", async ({
  page,
}) => {
  await setup(page, "dashboards");
  await page.goto(`/tenants/${tenant}/dashboards`);
  await page.getByRole("button", { name: "Deleted", exact: true }).click();
  await page.getByRole("link", { name: /Deleted dashboard/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${id}/history$`));
  await expect(
    page
      .getByRole("region", { name: "Revision 4 comparison" })
      .getByText("Deleted by Synthetic historical editor", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this revision", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save as new draft…", exact: true })
    .click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await page
    .getByLabel("Name", { exact: true })
    .fill("Explicit recovered dashboard");
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/${tenant}/dashboards`, (route) => {
    submitted = route.request().postDataJSON();
    expect(route.request().method()).toBe("POST");
    return route.fulfill({
      json: {
        data: {
          id: presetId,
          revision: "1",
          name: "Explicit recovered dashboard",
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Create dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open saved definition" }),
  ).toBeVisible();
  expect(submitted).not.toHaveProperty("expected_revision");
  expect(submitted).not.toHaveProperty("deleted_at");
  const panels = submitted?.panels as typeof dashboard.panels;
  expect(panels).toHaveLength(1);
  expect(panels[0].id).not.toBe(panelId);
  expect(panels[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(panels[0]).toMatchObject({
    preset_id: presetId,
    thresholds: dashboard.panels[0].thresholds,
  });
});

test("viewers compare retained history without persistence actions and expired details are not substituted", async ({
  page,
}) => {
  await setup(page, "presets", "view");
  await page.route(`**/presets/${id}/history?*`, (route) =>
    route.fulfill({
      json: {
        data: ["2", "1"].map((revision) => ({
          revision,
          recorded_at: at,
          definition_available: true,
          activity_available: false,
        })),
        next_cursor: null,
      },
    }),
  );
  await page.route(`**/presets/${id}/history/1`, (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: { code: "not_found", message: "Retained revision expired" },
      },
    }),
  );
  await page.goto(`/tenants/${tenant}/presets/${id}/history`);
  await expect(
    page.getByRole("region", { name: "Revision 2 comparison" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this revision", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save as new draft…", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Revision 1\b/ }).click();
  await expect(
    page.getByText("Retained revision expired", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: /comparison/ })).toHaveCount(0);
  await expect(page.getByText(oldPreset.cel, { exact: true })).toHaveCount(0);
});

test("lost tenant access clears retained history and its draft", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${id}/history`);
  await page
    .getByRole("button", { name: "Use this revision", exact: true })
    .click();
  await expect(page.getByLabel("Filter (CEL)", { exact: true })).toHaveValue(
    oldPreset.cel,
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "session_required", message: "Session expired" } },
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Filter (CEL)", { exact: true })).toHaveCount(0);
  await expect(page.getByText(oldPreset.name, { exact: true })).toHaveCount(0);
});

test("refresh between pointer down and up preserves the selected revision action", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${id}/history`);
  const use = page.getByRole("button", {
    name: "Use this revision",
    exact: true,
  });
  await expect(use).toBeEnabled();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = false;
  await page.route(`**/api/tenants/*/presets/${id}`, async (route) => {
    pending = true;
    await wait;
    await route.fulfill({ json: { data: preset } }).catch(() => {});
  });
  await use.hover();
  await page.mouse.down();
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect.poll(() => pending).toBe(true);
  await expect(use).toBeEnabled();
  await page.mouse.up();
  await expect(page.getByLabel("Filter (CEL)", { exact: true })).toHaveValue(
    oldPreset.cel,
  );
  release();
});
