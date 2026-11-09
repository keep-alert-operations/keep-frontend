import { expect, test, type Page } from "@playwright/test";

// Requirements: REV-65; dashboard operations 2, 3, 11, 16.
const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const tickets = `/api/tenants/${tenant}/ticket-counts`;
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();

type Query = { team: string; ticket_state: string; detection: string };
type Result = {
  status: string;
  count: string | null;
  checked_at: string | null;
  last_count: string | null;
  last_counted_at: string | null;
};
const result = (patch: Partial<Result>): Result => ({
  status: "count",
  count: null,
  checked_at: null,
  last_count: null,
  last_counted_at: null,
  ...patch,
});
/** The synthetic ticket count service, by team. */
const answers: Record<string, Result> = {
  NOC: result({
    count: "27",
    checked_at: minutesAgo(0),
    last_count: "27",
    last_counted_at: minutesAgo(0),
  }),
  DBA: result({
    status: "unavailable",
    last_count: "12",
    last_counted_at: minutesAgo(6),
  }),
  Network: result({ count: "3", checked_at: minutesAgo(0) }),
  // A non-canonical count is not trusted.
  Odd: result({ count: "007", checked_at: minutesAgo(0) }),
  "Storage-ops": result({ status: "not_found" }),
  Quiet: result({ status: "no_count" }),
  Down: result({ status: "unavailable" }),
  Payments: result({ status: "not_configured" }),
};
const sn = (
  n: number,
  team: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-00000000004${n}`,
  type: "servicenow",
  title: null,
  team,
  ticket_state: "open",
  detection: "hamal",
  thresholds: [
    { lower_bound: "1", color: "green" },
    { lower_bound: "20", color: "red" },
  ],
  x: (3 * n) % 12,
  y: 3 * Math.floor((3 * n) / 12),
  w: 3,
  h: 3,
  ...extra,
});
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 9,
  w: 3,
  h: 2,
  thresholds: [],
};

async function setup(
  page: Page,
  panels: Record<string, unknown>[],
  options: {
    configured?: boolean;
    superAdmin?: boolean;
    delay?: number;
    path?: string;
    integration?: Record<string, unknown>;
    /** Replaces the synthetic service's answer, for example with an outage. */
    answer?: (queries: Query[]) => { status?: number; json: unknown };
  } = {},
) {
  const state = {
    definition: { id, name: "Team ticket load", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    batches: [] as Query[][],
    csrf: [] as (string | undefined)[],
    alertCounts: 0,
    tests: [] as (string | undefined)[],
    sessions: 0,
  };
  await page.route("**/auth/session", (route) => {
    state.sessions += 1;
    return route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "tickets-csrf",
          global_super_admin: options.superAdmin ?? false,
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: options.superAdmin ? "admin" : "edit",
              kind: "specific",
              revision: "1",
            },
          ],
        },
      },
    });
  });
  await page.route("**/api/admin/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/integrations/ticket-count/test") {
      state.tests.push(route.request().headers()["x-csrf-token"]);
      return route.fulfill({
        json: {
          data: {
            ok: true,
            message: "The ticket count service answered",
            elapsed_ms: "180",
          },
        },
      });
    }
    if (path === "/api/admin/integrations/ticket-count")
      return route.fulfill({
        json: {
          data: options.integration ?? {
            configured: true,
            host: "ticket-count.ops.example",
            last_success_at: minutesAgo(1),
            last_failure_at: null,
            last_error: null,
          },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.route("**/api/tenants/**", async (route) => {
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
    if (path === `${tickets}/status`)
      return route.fulfill({
        json: { data: { configured: options.configured ?? true } },
      });
    if (path === tickets) {
      const body = route.request().postDataJSON() as { queries: Query[] };
      state.batches.push(body.queries);
      // The API accepts 1 to 24 queries per request.
      if (body.queries.length < 1 || body.queries.length > 24)
        return route.fulfill({
          status: 422,
          json: { error: { code: "validation_failed", message: "1-24." } },
        });
      state.csrf.push(route.request().headers()["x-csrf-token"]);
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      if (options.answer) return route.fulfill(options.answer(body.queries));
      return route.fulfill({
        json: {
          data: {
            results: body.queries.map(
              (query) => answers[query.team] ?? result({ status: "not_found" }),
            ),
          },
        },
      });
    }
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
      state.alertCounts += 1;
      const counted = (
        state.definition.panels as { id: string; type?: string }[]
      ).filter((item) => (item.type ?? "count") === "count");
      return route.fulfill({
        json: {
          data: {
            observation_id: "tickets-observation",
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
              count: "4",
            })),
          },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(options.path ?? `/tenants/${tenant}/dashboards/${id}`);
  return state;
}

async function openCreate(page: Page) {
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const type = dialog.getByRole("button", { name: /Panel type/ });
  return { dialog, type };
}

test("the type list offers ServiceNow tickets only while the service is configured", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 1 and 7; dashboard operations 2 and 16.
  await setup(page, [count], { configured: false });
  const { dialog, type } = await openCreate(page);
  await type.click();
  const option = dialog.getByRole("option", { name: /ServiceNow tickets/ });
  await expect(option).toHaveAttribute("aria-disabled", "true");
  await expect(option).toContainText(
    "Not available yet. An admin sets up the ticket count service.",
  );
  // Playwright won't click it as a user could, so force the click.
  await option.click({ force: true });
  await expect(option).toBeVisible();
  // The keyboard can't choose it either, and the arrow keys skip it.
  const search = dialog.getByRole("combobox", { name: "Search panel types" });
  await search.fill("ServiceNow");
  await search.press("Enter");
  await expect(option).toBeVisible();
  await search.fill("");
  await search.press("ArrowUp");
  await expect(dialog.getByRole("option", { name: /Image/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("Escape");
  await expect(type).toContainText("Alert count");
});

test("an editor creates a ServiceNow panel with a live preview", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 1, 2 and 9; dashboard operations 2, 3 and 16.
  const state = await setup(page, [count]);
  const { dialog, type } = await openCreate(page);
  await type.click();
  const option = dialog.getByRole("option", { name: /ServiceNow tickets/ });
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await expect(option).toContainText(
    "How many ServiceNow incidents a team has right now, with color thresholds.",
  );
  await option.click();
  await expect(type).toContainText("ServiceNow tickets");
  await expect(dialog).toContainText(
    "Comes straight from ServiceNow through the ticket count service, about every minute.",
  );
  await expect(dialog).toContainText(
    "Shown at the panel's current size, 3 × 3",
  );
  const preview = dialog.getByRole("article", { name: "Team tickets" });
  await expect(preview).toContainText("Choose a team to see its count.");

  // Team is required.
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  const team = dialog.getByRole("textbox", { name: "Team", exact: true });
  await expect(team).toBeFocused();
  await expect(team).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator(".dashboard-panel-error")).toHaveText(
    "Choose the team whose tickets to count.",
  );

  // Typing asks for the count once, after typing stops.
  const before = state.batches.length;
  await team.pressSequentially("NOC", { delay: 40 });
  await expect(dialog.getByRole("textbox", { name: /Title/ })).toHaveAttribute(
    "placeholder",
    "NOC tickets",
  );
  const live = dialog.getByRole("article", { name: "NOC tickets: 27" });
  await expect(live).toBeVisible();
  expect(state.batches.slice(before)).toEqual([
    [{ team: "NOC", ticket_state: "open", detection: "hamal" }],
  ]);
  expect(state.csrf.at(-1)).toBe("tickets-csrf");
  await expect(live).toContainText("NOC · Open · Hamal");

  // Segmented ticket state and detection, with help for the detection.
  await dialog.getByText("In progress", { exact: true }).click();
  await dialog.getByText("Direct", { exact: true }).click();
  await expect(dialog).toContainText(
    "Direct: incidents reported straight to the team.",
  );
  await dialog.getByText("Both", { exact: true }).click();
  await dialog.getByText("All", { exact: true }).click();
  await expect(dialog).toContainText("All: both Hamal and direct incidents.");
  await expect(
    dialog.getByRole("article", { name: "NOC tickets: 27" }),
  ).toContainText("NOC · Open and in progress · All");
  await expect
    .poll(() => state.batches.at(-1))
    .toEqual([{ team: "NOC", ticket_state: "both", detection: "all" }]);

  // A threshold colors the preview's top bar once the count reaches it.
  await dialog.getByRole("button", { name: "Add threshold" }).click();
  await dialog.getByLabel("Exact lower bound 1").fill("10");
  await expect(
    dialog.getByRole("article", { name: "NOC tickets: 27" }),
  ).toHaveAttribute("data-threshold-color", "blue");
  await dialog.getByLabel("Exact lower bound 1").fill("30");
  await expect(
    dialog.getByRole("article", { name: "NOC tickets: 27" }),
  ).not.toHaveAttribute("data-threshold-color");

  // A wrong team shows up in the preview, not as a warning while typing.
  await team.fill("Storage-ops");
  await expect(
    dialog.getByRole("article", {
      name: "Storage-ops tickets: team not found",
    }),
  ).toContainText('ServiceNow has no team called "Storage-ops".');
  await team.fill("NOC");
  await dialog.getByLabel("Exact lower bound 1").fill("10");

  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  // The unsaved draft panel shows its count on the board too.
  await expect(
    page.getByRole("article", { name: "NOC tickets: 27" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "servicenow",
  );
  expect(saved).toMatchObject({
    type: "servicenow",
    title: null,
    team: "NOC",
    ticket_state: "both",
    detection: "all",
    thresholds: [{ lower_bound: "10", color: "blue" }],
    w: 3,
    h: 3,
  });
  expect(saved).not.toHaveProperty("preset_id");

  // Edit keeps every setting and the type is locked.
  await page.getByRole("button", { name: "Options for NOC tickets" }).click();
  await page.getByRole("menuitem", { name: /Edit panel/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(edit.getByRole("button", { name: /Panel type/ })).toBeDisabled();
  await expect(
    edit.getByRole("textbox", { name: "Team", exact: true }),
  ).toHaveValue("NOC");
  await expect(edit.getByRole("radio", { name: "Both" })).toBeChecked();
  await expect(edit.getByRole("radio", { name: "All" })).toBeChecked();
  await expect(edit.getByLabel("Exact lower bound 1")).toHaveValue("10");
});

test("each tile state shows what the ticket count service answered", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 2, 4, 5 and 7; dashboard operations 3 and 11.
  const state = await setup(
    page,
    [
      sn(0, "NOC", { title: "Night shift" }),
      sn(1, "Network", { ticket_state: "in_progress", detection: "direct" }),
      sn(2, "DBA", { ticket_state: "both", detection: "all" }),
      sn(3, "Storage-ops"),
      sn(4, "Quiet"),
      sn(5, "Down"),
      sn(6, "Payments"),
      sn(7, "Odd"),
      count,
    ],
    { delay: 700 },
  );
  // First load: a placeholder that keeps the panel's size.
  const first = page.getByRole("article", { name: "Night shift, loading" });
  await expect(first).toContainText("Getting the count…");
  await expect(first).toHaveAttribute("aria-busy", "true");

  const noc = page.getByRole("article", { name: "Night shift: 27" });
  await expect(noc).toHaveAttribute("data-threshold-color", "red");
  await expect(noc).toContainText("NOC · Open · Hamal");
  const network = page.getByRole("article", { name: "Network tickets: 3" });
  await expect(network).toHaveAttribute("data-threshold-color", "green");
  await expect(network).toContainText("Network · In progress · Direct");

  const dba = page.getByRole("article", {
    name: "DBA tickets: last count 12, out of date",
  });
  await expect(dba).toContainText("DBA · Open and in progress · All");
  await expect(dba).toContainText("Last count 6 min ago. Retrying.");
  await expect(dba).not.toHaveAttribute("data-threshold-color");
  await expect(dba.locator(".pn-value b")).toHaveClass(/pn-none-value/);

  await expect(
    page.getByRole("article", { name: "Storage-ops tickets: team not found" }),
  ).toContainText('Team not foundServiceNow has no team called "Storage-ops".');
  await expect(
    page.getByRole("article", { name: "Quiet tickets: no count" }),
  ).toContainText("No count");
  await expect(
    page.getByRole("article", { name: "Down tickets: couldn't get the count" }),
  ).toContainText("Couldn't get the count");
  await expect(
    page.getByRole("article", {
      name: "Payments tickets: ServiceNow not connected",
    }),
  ).toContainText(
    "ServiceNow isn't connectedAn admin sets up the ticket count service.",
  );
  // Ticket counts never join alert count batches, and there is no link.
  await expect(
    page.getByRole("article", { name: "Odd tickets: couldn't get the count" }),
  ).toBeVisible();
  expect(state.batches[0]).toHaveLength(8);
  await expect(noc.getByRole("link")).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Critical count" }),
  ).toContainText("4");
});

test("every tile state fits a 3 × 3 and a 3 × 2 panel", async ({ page }) => {
  // Requirements: REV-65 acceptance 2, 4 and 5; dashboard operations 3.
  await page.setViewportSize({ width: 1280, height: 900 });
  const teams = ["DBA", "Storage-ops", "Quiet", "Down", "Payments"];
  await setup(page, [
    ...teams.map((team, n) =>
      sn(n, team, { x: (3 * n) % 12, y: n < 4 ? 0 : 3, h: 3 }),
    ),
    ...teams.map((team, n) =>
      sn(n + 5, team, {
        title: `${team} short`,
        x: (3 * n) % 12,
        y: n < 4 ? 6 : 8,
        h: 2,
      }),
    ),
  ]);
  await expect(page.locator(".pn-sn")).toHaveCount(10);
  await expect(
    page.getByRole("article", {
      name: "Payments short: ServiceNow not connected",
    }),
  ).toBeVisible();
  await expect(page.locator(".pn-sn[aria-busy]")).toHaveCount(0);
  const problems = await page.locator(".pn-sn").evaluateAll((tiles) =>
    tiles.flatMap((tile) => {
      const box = tile.getBoundingClientRect();
      const found: string[] = [];
      for (const part of tile.querySelectorAll<HTMLElement>(
        ".pn-head, .sub, .pn-sn-msg, .pn-sn-msg strong, .pn-sn-foot",
      )) {
        const own = part.getBoundingClientRect();
        if (
          own.top < box.top - 0.5 ||
          own.bottom > box.bottom + 0.5 ||
          own.left < box.left - 0.5 ||
          own.right > box.right + 0.5
        )
          found.push(`${tile.getAttribute("aria-label")}: ${part.className}`);
      }
      // The message box and the whole footer fit without being cut off.
      for (const part of tile.querySelectorAll<HTMLElement>(
        ".pn-sn-msg, .pn-sn-note",
      ))
        if (part.scrollHeight > part.clientHeight + 1)
          found.push(
            `${tile.getAttribute("aria-label")}: ${part.className} cut`,
          );
      const sub = tile.querySelector(".sub");
      if (sub && /mono/i.test(getComputedStyle(sub).fontFamily))
        found.push(`${tile.getAttribute("aria-label")}: mono filter line`);
      return found;
    }),
  );
  expect(problems).toEqual([]);
  // A too-short panel keeps the heading; its full text stays in the title.
  const short = page.getByRole("article", {
    name: "Storage-ops short: team not found",
  });
  await expect(short.locator(".pn-sn-msg strong")).toBeVisible();
  await expect(short.locator(".pn-sn-msg span")).toBeHidden();
  await expect(short.locator(".pn-sn-msg")).toHaveAttribute(
    "title",
    'Team not found ServiceNow has no team called "Storage-ops".',
  );
  // The stale footer wraps instead of being cut off.
  await expect(
    page
      .getByRole("article", { name: "DBA tickets: last count 12, out of date" })
      .locator(".pn-sn-note"),
  ).toHaveText("Last count 6 min ago. Retrying.");
});

test("a count the page already showed stays, greyed, while the service is down", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 5; dashboard operations 11.
  let down = false;
  await setup(page, [sn(0, "NOC")], {
    answer: (queries) =>
      down
        ? {
            status: 503,
            json: { error: { code: "unavailable", message: "Down" } },
          }
        : {
            json: {
              data: {
                results: queries.map(() =>
                  result({ count: "27", checked_at: minutesAgo(2) }),
                ),
              },
            },
          },
  });
  await expect(
    page.getByRole("article", { name: "NOC tickets: 27" }),
  ).toHaveAttribute("data-threshold-color", "red");
  down = true;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  const stale = page.getByRole("article", {
    name: "NOC tickets: last count 27, out of date",
  });
  await expect(stale).toContainText("Last count 2 min ago. Retrying.");
  await expect(stale).not.toHaveAttribute("data-threshold-color");
});

test("a refused ticket count request goes through the sign-in check", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 8; dashboard operations 11.
  let refused = false;
  const state = await setup(page, [sn(0, "NOC")], {
    answer: (queries) =>
      refused
        ? {
            status: 401,
            json: { error: { code: "unauthenticated", message: "Sign in." } },
          }
        : {
            json: {
              data: {
                results: queries.map(() =>
                  result({ count: "27", checked_at: minutesAgo(0) }),
                ),
              },
            },
          },
  });
  const tile = page.getByRole("article", { name: "NOC tickets: 27" });
  await expect(tile).toBeVisible();
  const sessions = state.sessions;
  refused = true;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect.poll(() => state.sessions).toBeGreaterThan(sessions);
  // The session check takes over; the panel is never marked unavailable for it.
  await page.waitForTimeout(500);
  await expect(page.getByText("Couldn't get the count")).toHaveCount(0);
  await expect(page.getByText(/Last count .* Retrying\./)).toHaveCount(0);
});

test("one batched request refreshes every ServiceNow panel", async ({
  page,
}) => {
  // Requirements: REV-65 acceptance 6; dashboard operations 11.
  await page.clock.install();
  const state = await setup(page, [
    sn(0, "NOC"),
    sn(1, "NOC", { title: "NOC again" }),
    sn(2, "Network"),
    count,
  ]);
  await expect(
    page.getByRole("article", { name: "NOC again: 27" }),
  ).toBeVisible();
  // Identical queries are asked once, in one request. (Development mode mounts
  // the board twice, so the first request may repeat.)
  expect(new Set(state.batches.map((batch) => JSON.stringify(batch)))).toEqual(
    new Set([
      JSON.stringify([
        { team: "NOC", ticket_state: "open", detection: "hamal" },
        { team: "Network", ticket_state: "open", detection: "hamal" },
      ]),
    ]),
  );
  const start = state.batches.length;
  // About every minute.
  await page.clock.runFor(60_000);
  await expect.poll(() => state.batches.length).toBe(start + 1);
  // Refresh counts.
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect.poll(() => state.batches.length).toBe(start + 2);
  // The tab becoming visible again.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => state.batches.length).toBe(start + 3);
  // Fullscreen shows the same counts and refreshes them too.
  await page.getByRole("button", { name: "Fullscreen" }).click();
  const full = page.locator("dialog.db-fullscreen");
  await expect(
    full.getByRole("article", { name: "NOC tickets: 27" }),
  ).toBeVisible();
  await full.getByRole("button", { name: "Refresh counts" }).click();
  await expect.poll(() => state.batches.length).toBe(start + 4);
  expect(state.batches.every((batch) => batch.length === 2)).toBe(true);
});

test("super admins see the ticket count service and can test it", async ({
  page,
}) => {
  // Requirements: REV-65 decision D2; dashboard operations 16.
  const state = await setup(page, [], {
    superAdmin: true,
    path: `/tenants/${tenant}/integrations`,
  });
  const tabs = page.getByRole("navigation", { name: "Administration" });
  await expect(
    tabs.getByRole("link", { name: "Integrations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  const card = page.getByRole("region", { name: "ServiceNow ticket count" });
  await expect(card).toContainText("Connected");
  await expect(card).toContainText("ticket-count.ops.example");
  await expect(card).toContainText("APPCHI_TICKET_COUNT_URL");
  // Read-only: no address field, no save or disconnect.
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText(["Test connection"]);
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(card.getByRole("status")).toContainText(
    "The ticket count service answered · 180 ms",
  );
  expect(state.tests).toEqual(["tickets-csrf"]);
});

test("an unconfigured service shows Not configured and can't be tested", async ({
  page,
}) => {
  // Requirements: REV-65 decision D2.
  await setup(page, [], {
    superAdmin: true,
    path: `/tenants/${tenant}/integrations`,
    integration: {
      configured: false,
      host: null,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
    },
  });
  const card = page.getByRole("region", { name: "ServiceNow ticket count" });
  await expect(card).toContainText("Not configured");
  await expect(
    card.getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();
});

test("other users don't see Integrations", async ({ page }) => {
  // Requirements: REV-65 decision D2.
  await setup(page, [], { path: `/tenants/${tenant}/operators` });
  const tabs = page.getByRole("navigation", { name: "Administration" });
  await expect(tabs.getByRole("link", { name: "Operators" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await page.goto(`/tenants/${tenant}/integrations`);
  await expect(
    page.getByText("Integrations require global administration access."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test connection" }),
  ).toHaveCount(0);
});

test("a ServiceNow panel shows its panel link like every panel type", async ({
  page,
}) => {
  // Requirements: REV-66 (with REV-65); dashboard operations 3 and 16.
  await setup(page, [
    sn(0, "NOC", {
      title: "Night shift",
      link: { url: "https://servicenow.example/queue/noc", label: "Queue" },
    }),
    sn(1, "Network"),
  ]);
  const tile = page.getByRole("article", { name: /^Night shift: 27/ });
  const button = tile.getByRole("link", { name: "Queue (opens in a new tab)" });
  await expect(button).toHaveAttribute(
    "href",
    "https://servicenow.example/queue/noc",
  );
  await expect(button).toHaveAttribute("target", "_blank");
  await expect(button).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page
      .getByRole("article", { name: /^Network tickets/ })
      .getByRole("link", { name: /opens in a new tab/ }),
  ).toHaveCount(0);
});
