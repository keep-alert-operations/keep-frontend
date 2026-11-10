import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const incidents = {
  id: "00000000-0000-4000-8000-000000000031",
  type: "incident_count",
  preset_id: preset,
  incident_status: "both",
  title: null,
  x: 0,
  y: 0,
  w: 3,
  h: 3,
  thresholds: [
    { lower_bound: "1", color: "green" },
    { lower_bound: "4", color: "red" },
  ],
};
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical alerts",
  x: 3,
  y: 0,
  w: 3,
  h: 3,
  thresholds: [],
};
/** Incidents per status for the preset, as the API would count them. */
const NUMBERS: Record<string, { count: string; linked_alerts: string }> = {
  open: { count: "3", linked_alerts: "12" },
  investigating: { count: "1", linked_alerts: "5" },
  both: { count: "4", linked_alerts: "17" },
};

async function setup(
  page: Page,
  panels: Record<string, unknown>[],
  options: { tooMany?: boolean } = {},
) {
  const state = {
    definition: { id, name: "Service health", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    quick: [] as Record<string, unknown>[],
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "incidents-csrf",
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
        state.definition.panels as {
          id: string;
          type?: string;
          incident_status?: string;
        }[]
      ).filter((item) =>
        ["count", "incident_count"].includes(item.type ?? "count"),
      );
      return route.fulfill({
        json: {
          data: {
            observation_id: "incidents-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-10T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: counted.map((item) => ({
              panel_id: item.id,
              preset_id: preset,
              preset_name: "Critical firing",
              ...(item.type === "incident_count"
                ? options.tooMany
                  ? {
                      error: {
                        code: "incident_count_too_large",
                        message:
                          "More incidents match than one panel can count.",
                      },
                    }
                  : {
                      ...NUMBERS[item.incident_status ?? "both"],
                      alerts: "38",
                    }
                : { count: "38" }),
            })),
          },
        },
      });
    }
    if (path.endsWith("/alerts/counts")) {
      const body = route.request().postDataJSON();
      state.quick.push(body);
      const query = body.queries[0];
      return route.fulfill({
        json: {
          data: {
            counts: { [query.id]: "38" },
            ...(query.incident_status
              ? {
                  incidents: {
                    [query.id]: {
                      ...NUMBERS[query.incident_status],
                      alerts: "38",
                    },
                  },
                }
              : {}),
          },
        },
      });
    }
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            {
              id: preset,
              name: "Critical firing",
              revision: "1",
              cel: 'severity == "critical"',
              columns: ["severity", "message"],
            },
          ],
          next_cursor: null,
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

test("an incident count panel shows its incidents, statuses and threshold", async ({
  page,
}) => {
  // Requirements: REV-69; dashboard operations 3, 7 and 16.
  await setup(page, [incidents, count]);
  const panel = page.getByRole("article", {
    name: "Critical firing incidents count",
  });
  await expect(panel.locator(".pn-value b")).toHaveText("4");
  await expect(panel).toContainText(
    "Critical firing · Firing and investigating",
  );
  await expect(panel).toHaveAttribute("data-threshold-color", "red");
  // The title opens the preset, as an alert count panel's does.
  await expect(
    panel.getByRole("link", { name: "Critical firing incidents" }),
  ).toHaveAttribute(
    "href",
    `/tenants/${tenant}/presets/${preset}?from=dashboard`,
  );
  // The alert count beside it is unchanged.
  await expect(
    page
      .getByRole("article", { name: "Critical alerts count" })
      .locator(".pn-value b"),
  ).toHaveText("38");
});

test("too many incidents is shown as unavailable, not as a number", async ({
  page,
}) => {
  // Requirements: REV-69; dashboard operations 11.
  await setup(page, [incidents], { tooMany: true });
  const panel = page.getByRole("article", { name: /incidents count|count$/ });
  await expect(panel).toContainText("Too many incidents to count");
  await expect(panel.locator(".pn-value b")).toHaveText("—");
});

test("the panel dialog creates an incident count panel", async ({ page }) => {
  // Requirements: REV-69; dashboard operations 2, 3, 14 and 16.
  const state = await setup(page, [count]);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const type = dialog.getByRole("button", { name: /Panel type/ });
  await type.click();
  // Incident count is listed second, after Alert count.
  await expect(dialog.getByRole("option").nth(1)).toContainText(
    "Incident count",
  );
  await dialog.getByRole("option", { name: /Incident count/ }).click();
  await expect(type).toContainText("Incident count");
  const firing = dialog.getByRole("checkbox", { name: "Firing" });
  const investigating = dialog.getByRole("checkbox", {
    name: "Investigating",
  });
  await expect(firing).toBeChecked();
  await expect(investigating).toBeChecked();
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).click();
  await dialog.getByRole("option", { name: "Critical firing" }).click();
  await expect(dialog.getByLabel("Title (optional)")).toHaveAttribute(
    "placeholder",
    "Critical firing incidents",
  );
  const preview = dialog.getByRole("article", {
    name: "Critical firing incidents count",
  });
  await expect(preview.locator(".pn-value b")).toHaveText("4");
  await expect(preview).toContainText(
    "Critical firing · Firing and investigating",
  );
  await expect(dialog.locator(".dashboard-panel-facts")).toContainText(
    "38alerts match Critical firing",
  );
  await expect(dialog.locator(".dashboard-panel-facts")).toContainText(
    "17of them are in a firing or investigating incident",
  );
  expect(state.quick.at(-1)).toEqual({
    queries: [
      { id: "total", cel: 'severity == "critical"', incident_status: "both" },
    ],
  });
  // Unticking both asks for a status and blocks creating the panel.
  await investigating.uncheck();
  await expect(preview.locator(".pn-value b")).toHaveText("3");
  await expect(preview).toContainText("Critical firing · Firing");
  await firing.uncheck();
  await expect(dialog).toContainText("Choose at least one status to count.");
  const create = dialog.getByRole("button", {
    name: "Create panel",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await investigating.check();
  await expect(preview.locator(".pn-value b")).toHaveText("1");
  await create.click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "incident_count",
  );
  expect(saved).toMatchObject({
    type: "incident_count",
    preset_id: preset,
    incident_status: "investigating",
    thresholds: [],
    w: 3,
    h: 3,
  });
  // The saved panel is counted with the others.
  await expect(
    page
      .getByRole("article", { name: "Critical firing incidents count" })
      .locator(".pn-value b"),
  ).toHaveText("1");
});

test("editing an incident count panel keeps its type and statuses", async ({
  page,
}) => {
  // Requirements: REV-69; dashboard operations 3 and 8.
  await setup(page, [{ ...incidents, incident_status: "open" }]);
  const panel = page.getByRole("article", {
    name: "Critical firing incidents count",
  });
  await expect(panel.locator(".pn-value b")).toHaveText("3");
  await expect(panel).toContainText("Critical firing · Firing");
  await panel.hover();
  await page.keyboard.press("e");
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(
    dialog.getByRole("button", { name: /Panel type/ }),
  ).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "Firing" })).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Investigating" }),
  ).not.toBeChecked();
});
