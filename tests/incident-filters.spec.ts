import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const identifier = "00000000-0000-4000-8000-000000000002";
async function setup(page: Page, role = "edit") {
  const state = {
    denied: false,
    failure: false,
    empty: false,
    queries: [] as URLSearchParams[],
    counts: [] as URLSearchParams[],
  };
  // These cases exercise filters. A finite route.fulfill SSE body disconnects
  // immediately and races pagination with reconnect-driven reconciliation.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (typeof input === "string" && input.endsWith("/events")) {
        let closed = false;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: state\ndata: {"view_generation":"1"}\n\n',
                  ),
                );
                options?.signal?.addEventListener("abort", () => {
                  if (!closed) {
                    closed = true;
                    controller.close();
                  }
                });
              },
              cancel() {
                closed = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      }
      return original(input, options);
    };
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: identifier,
            display_name: "Synthetic incident reader",
          },
          csrf_token: "test-csrf",
          tenants: state.denied
            ? []
            : [
                {
                  id: tenant,
                  name: "Global",
                  kind: "global",
                  role,
                  revision: "1",
                },
              ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (url.pathname.endsWith("/health"))
      return route.fulfill({
        json: { data: { source: "healthy", search: "healthy" } },
      });
    if (url.pathname.endsWith("/incidents")) {
      // The header's active-count query carries no sort; list queries do.
      if (url.searchParams.has("sort")) state.queries.push(url.searchParams);
      else state.counts.push(url.searchParams);
      if (url.searchParams.get("q") === "access-revoked") state.denied = true;
      if (state.denied || state.failure)
        return route.fulfill({
          status: state.denied ? 403 : 503,
          json: {
            error: {
              code: "test_unavailable",
              message: "Incident query unavailable.",
            },
          },
        });
      return route.fulfill({
        json: {
          data: state.empty
            ? []
            : [
                {
                  id: identifier,
                  revision: "1",
                  title: url.searchParams.has("cursor")
                    ? "Second page incident"
                    : "First page incident",
                  status: "open",
                  severity: "high",
                  origin: "manual",
                  last_activity: "2026-09-22T10:00:00Z",
                },
              ],
          next_cursor:
            state.empty || url.searchParams.has("cursor")
              ? null
              : "opaque-page-2",
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/incidents`);
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  return state;
}

test("incident filters capture all supported fields and reset query-bound pagination", async ({
  page,
}) => {
  const state = await setup(page);
  expect(Object.fromEntries(state.queries.at(-1)!)).toEqual({
    view: "active",
    limit: "50",
    sort: "last_activity",
    direction: "desc",
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Second page incident", exact: true }),
  ).toBeVisible();
  expect(Object.fromEntries(state.counts.at(-1)!)).toEqual({
    view: "active",
    limit: "200",
  });
  // The bounded count query has another page, so the total is a lower bound.
  await expect(page.getByText("1+ active", { exact: true })).toBeVisible();
  await page
    .getByRole("group", { name: "Incident view" })
    .getByRole("button", { name: "All", exact: true })
    .click();
  await expect.poll(() => state.queries.at(-1)!.get("view")).toBe("all");
  expect(state.queries.at(-1)!.has("cursor")).toBe(false);
  await page.getByLabel("Search incidents").fill("database timeout");
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Rows per page").selectOption("200");
  await expect(
    page
      .getByRole("combobox", { name: "Sort", exact: true })
      .getByRole("option", { name: "Severity, highest" }),
  ).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("severity:desc");
  await page
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("investigating");
  await page
    .getByRole("combobox", { name: "Severity", exact: true })
    .selectOption("critical");
  await page
    .getByRole("combobox", { name: "Assignee", exact: true })
    .selectOption("me");
  await page
    .getByRole("combobox", { name: "Creation source", exact: true })
    .selectOption("correlation");
  await expect
    .poll(() => state.queries.at(-1)!.get("origin"))
    .toBe("correlation");
  // Top-row controls apply at once; drafts in More filters wait for Apply.
  expect(state.queries.at(-1)!.has("q")).toBe(false);
  expect(state.queries.at(-1)!.get("limit")).toBe("50");
  for (const name of [
    "Exact incident identifier",
    "Originating rule identifier",
    "Linked alert identifier",
  ])
    await page.getByLabel(name, { exact: true }).fill(identifier);
  for (const name of ["Created", "Activity", "Resolved"]) {
    await page
      .getByLabel(`${name} from (UTC)`, { exact: true })
      .fill("2026-09-21T10:00");
    await page
      .getByLabel(`${name} before (UTC)`, { exact: true })
      .fill("2026-09-23T10:00");
  }
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  expect(Object.fromEntries(state.queries.at(-1)!)).toEqual({
    view: "all",
    q: "database timeout",
    limit: "200",
    sort: "severity",
    direction: "desc",
    status: "investigating",
    severity: "critical",
    assignee: "me",
    origin: "correlation",
    rule_id: identifier,
    alert_id: identifier,
    incident_id: identifier,
    created_from: "2026-09-21T10:00:00Z",
    created_to: "2026-09-23T10:00:00Z",
    activity_from: "2026-09-21T10:00:00Z",
    activity_to: "2026-09-23T10:00:00Z",
    resolved_from: "2026-09-21T10:00:00Z",
    resolved_to: "2026-09-23T10:00:00Z",
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Second page incident", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh from first page", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  expect(state.queries.at(-1)!.get("q")).toBe("database timeout");
  expect(state.queries.at(-1)!.has("cursor")).toBe(false);
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect
    .poll(() => Object.fromEntries(state.queries.at(-1)!))
    .toEqual({
      view: "active",
      limit: "50",
      sort: "last_activity",
      direction: "desc",
    });
});

test("incident queries distinguish failure and empty, and clear records on access loss", async ({
  page,
}) => {
  const state = await setup(page, "view");
  await expect(
    page.getByRole("link", { name: "New incident", exact: true }),
  ).toHaveCount(0);
  state.failure = true;
  await page
    .getByRole("button", { name: "Refresh from first page", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Incident query unavailable",
  );
  await expect(
    page.getByRole("heading", { name: "No incidents found" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next page", exact: true }),
  ).toBeDisabled();
  state.failure = false;
  state.empty = true;
  await page
    .getByRole("button", { name: "Refresh from first page", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No incidents found" }),
  ).toBeVisible();
  state.empty = false;
  await page
    .getByRole("button", { name: "Refresh from first page", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search incidents").fill("access-revoked");
  await page.getByLabel("Search incidents").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Tenant unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("First page incident", { exact: true }),
  ).toHaveCount(0);
});

test("incident range validation preserves draft and explicit assignee filters", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole("combobox", { name: "Assignee", exact: true })
    .selectOption("id");
  await page.getByLabel("Assignee identifier").fill(identifier);
  await page.getByLabel("Created from (UTC)").fill("2026-09-23T10:00");
  await page.getByLabel("Created before (UTC)").fill("2026-09-22T10:00");
  const before = state.queries.length;
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Created range must end after it starts",
  );
  expect(
    state.queries
      .slice(before)
      .some((query) => query.has("created_from") || query.has("assignee")),
  ).toBe(false);
  await expect(page.getByLabel("Assignee identifier")).toHaveValue(identifier);
  await page.getByLabel("Created before (UTC)").fill("2026-09-24T10:00");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect
    .poll(() => state.queries.at(-1)!.get("assignee"))
    .toBe(identifier);
  await page
    .getByRole("combobox", { name: "Assignee", exact: true })
    .selectOption("unassigned");
  await page
    .getByRole("group", { name: "Incident view" })
    .getByRole("button", { name: "Resolved", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("resolved_at:asc");
  await expect
    .poll(() => state.queries.at(-1)!.get("sort"))
    .toBe("resolved_at");
  expect(state.queries.at(-1)!.get("assignee")).toBe("unassigned");
  expect(state.queries.at(-1)!.get("view")).toBe("resolved");
  expect(state.queries.at(-1)!.get("direction")).toBe("asc");
  expect(state.queries.at(-1)!.get("created_from")).toBe(
    "2026-09-23T10:00:00Z",
  );
});

test("late incident responses cannot replace a newer applied filter", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/incidents?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "slow")
      return route.fallback();
    started();
    await held;
    try {
      await route.fulfill({
        json: {
          data: [
            { id: identifier, revision: "1", title: "Stale slow incident" },
          ],
          next_cursor: null,
        },
      });
    } finally {
      finished();
    }
  });
  await page.getByLabel("Search incidents").fill("slow");
  await page.getByLabel("Search incidents").press("Enter");
  await requested;
  await expect(
    page.getByText("Loading incidents…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Search incidents").fill("newer");
  await page.getByLabel("Search incidents").press("Enter");
  await expect(
    page.getByRole("link", { name: "First page incident", exact: true }),
  ).toBeVisible();
  release();
  await completed;
  await expect(page.getByLabel("Search incidents")).toHaveValue("newer");
  await expect(
    page.getByRole("link", { name: "Stale slow incident", exact: true }),
  ).toHaveCount(0);
});
