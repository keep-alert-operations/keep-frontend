import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const columns = [
  "severity",
  "message",
  "display_status",
  "timestamp",
  "assignee_id",
  "application",
];
const table = {
  id: "00000000-0000-4000-8000-000000000032",
  type: "table",
  preset_id: preset,
  title: "Latest critical",
  rows: 3,
  x: 0,
  y: 0,
  w: 12,
  h: 6,
};
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 6,
  w: 3,
  h: 2,
  thresholds: [],
};
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();
const alerts = [
  ["checkout-api latency above 2s", "critical", "firing", 2],
  ["payments-db replication lag", "high", "acknowledged", 6],
  ["orders-worker restarting", "warning", "firing", 11],
].map(([message, severity, status, age], index) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  revision: "1",
  message,
  severity,
  status,
  application: "shop",
  timestamp: minutesAgo(Number(age)),
}));

async function setup(
  page: Page,
  panels: Record<string, unknown>[],
  options: { rows?: typeof alerts; changedOnce?: boolean } = {},
) {
  const state = {
    definition: { id, name: "Tables", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    counts: [] as string[][],
    previews: [] as Record<string, unknown>[],
    presetReads: 0,
    changedOnce: options.changedOnce ?? false,
    conflicted: undefined as string | undefined,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "tables-csrf",
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
      const counted = (
        state.definition.panels as { id: string; type?: string }[]
      ).filter((item) => (item.type ?? "count") === "count");
      state.counts.push(counted.map((item) => item.id));
      return route.fulfill({
        json: {
          data: {
            observation_id: "tables-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-09T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: counted.map((item) => ({
              panel_id: item.id,
              preset_id: preset,
              preset_name: "Critical alerts",
              count: "12",
            })),
          },
        },
      });
    }
    if (path.endsWith("/presets/preview")) {
      const body = route.request().postDataJSON();
      state.previews.push(body);
      if (state.changedOnce) {
        state.changedOnce = false;
        state.conflicted = String(body.expected_revision);
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "preset_changed", message: "Preset changed." },
          },
        });
      }
      const rows = (options.rows ?? alerts).slice(0, Number(body.limit));
      return route.fulfill({
        json: {
          data: rows,
          meta: {
            total: String(options.rows ? options.rows.length : 37),
            applied: {
              definition: {
                cel: "true",
                sort: [{ field: "timestamp", direction: "desc" }],
                columns,
              },
            },
          },
          next_cursor: null,
        },
      });
    }
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            {
              id: preset,
              name: "Critical alerts",
              revision: "1",
              cel: "true",
              columns,
            },
          ],
          next_cursor: null,
        },
      });
    if (path.endsWith(`/presets/${preset}`)) {
      state.presetReads += 1;
      return route.fulfill({
        json: {
          data: {
            id: preset,
            name: "Critical alerts",
            revision: String(state.presetReads),
            cel: "true",
            columns,
            sort: [{ field: "severity", direction: "asc" }],
          },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

test("a table panel lists its preset's latest alerts, newest first", async ({
  page,
}) => {
  // Requirements: REV-63; dashboard operations 3, 7, 10 and 14.
  const state = await setup(page, [table, count]);
  const panel = page.getByRole("article", {
    name: "Latest critical",
    exact: true,
  });
  const grid = panel.getByRole("table", {
    name: "Latest alerts in Latest critical",
  });
  await expect(grid.getByRole("row")).toHaveCount(4);
  await expect(grid.getByRole("columnheader")).toHaveText([
    "Severity",
    "Alert",
    "Status",
    "Last received ↓",
    "Assignee",
    "Application",
  ]);
  await expect(grid.getByRole("row").nth(1)).toContainText(
    "checkout-api latency above 2s",
  );
  await expect(
    grid.getByRole("link", { name: "checkout-api latency above 2s" }),
  ).toHaveAttribute(
    "href",
    `/tenants/${tenant}/alerts/00000000-0000-4000-8000-000000000100`,
  );
  await expect(panel).toContainText("Latest 3 · newest first");
  await expect(panel).toContainText("Showing 3 of 37 matching alerts");
  await expect(panel).toContainText("Preset: Critical alerts");
  await expect(
    panel.getByRole("link", { name: "Open preset", exact: true }),
  ).toHaveAttribute(
    "href",
    `/tenants/${tenant}/presets/${preset}?from=dashboard`,
  );
  // The saved preset is read by reference, newest first, at the panel's size.
  expect(state.previews.at(-1)).toEqual({
    preset_id: preset,
    expected_revision: String(state.presetReads),
    newest_first: true,
    limit: 3,
  });
  // The panel settles instead of reloading on every render.
  // It reloads with the dashboard's live updates, as counts do, and no more often.
  await page.waitForTimeout(3000);
  expect(state.previews.length).toBeLessThanOrEqual(state.counts.length + 1);
  // Only the count panel is counted.
  await expect.poll(() => state.counts.at(-1)).toEqual([count.id]);
});

test("a narrow table panel hides columns from the right and keeps Alert", async ({
  page,
}) => {
  // Requirements: REV-63; dashboard operations 3 and 4.
  await setup(page, [{ ...table, w: 4 }]);
  const headers = page
    .getByRole("table", { name: "Latest alerts in Latest critical" })
    .getByRole("columnheader");
  await expect(headers.first()).toHaveText("Severity");
  await expect(headers).toContainText(["Alert"]);
  expect(await headers.count()).toBeLessThan(columns.length);
  await expect(headers.last()).not.toHaveText("Application");
});

test("an empty preset says so, and a changed preset is read again", async ({
  page,
}) => {
  // Requirements: REV-63; dashboard operations 3 and 11.
  const state = await setup(page, [table], { rows: [], changedOnce: true });
  const panel = page.getByRole("article", {
    name: "Latest critical",
    exact: true,
  });
  await expect(panel).toContainText("No alerts match this preset");
  // The rejected revision was followed by a read of the current preset.
  expect(state.conflicted).toBeDefined();
  expect(
    state.previews.some(
      (item) => Number(item.expected_revision) > Number(state.conflicted),
    ),
  ).toBe(true);
});

test("the panel dialog creates an alert table panel", async ({ page }) => {
  // Requirements: REV-63; dashboard operations 2, 3, 14 and 16.
  const state = await setup(page, [count]);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const type = dialog.getByRole("button", { name: /Panel type/ });
  await type.click();
  await dialog.getByRole("option", { name: /Alert table/ }).click();
  await expect(type).toContainText("Alert table");
  await expect(
    dialog.getByRole("article", { name: "Alert table preview" }),
  ).toContainText("Choose a preset to see its latest alerts");
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
  await dialog.getByRole("option", { name: "Critical alerts" }).click();
  await expect(
    dialog.getByRole("list", { name: "Preset columns" }).getByRole("listitem"),
  ).toHaveText([
    "Severity",
    "Alert",
    "Status",
    "Last received",
    "Assignee",
    "Application",
  ]);
  const rows = dialog.getByLabel("Alerts to show");
  await expect(rows).toHaveValue("10");
  await rows.fill("51");
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Show from 1 to 50 alerts.",
  );
  await rows.fill("2");
  const preview = dialog.getByRole("article", {
    name: "Critical alerts",
    exact: true,
  });
  await expect(preview.getByRole("row")).toHaveCount(3);
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "table",
  );
  expect(saved).toMatchObject({ type: "table", preset_id: preset, rows: 2 });
  expect(saved).not.toHaveProperty("thresholds");
});
