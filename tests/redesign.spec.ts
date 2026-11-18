import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const alertId = "00000000-0000-4000-8000-000000000002";
// The tenant is Global, so the alert is a native v1 alert as sent: `object`,
// v1 severities and no runbook (REV-77).
const row = {
  id: alertId,
  revision: "9007199254740999",
  message: "Database latency",
  application: "payments",
  object: "postgres",
  severity: "error",
  schema_version: "v1",
  status: "firing",
  acknowledged: false,
  assignee_id: null,
};
async function setup(page: Page, role = "admin") {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: alertId, display_name: "Design reviewer" },
          csrf_token: "test-csrf",
          tenants: [
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
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    return route.fulfill({
      json: {
        data: path.endsWith("/alerts") ? [row] : [],
        meta: { total: "1" },
        next_cursor: null,
      },
    });
  });
}

test("quick views compose with applied CEL and search without saving a preset", async ({
  page,
}) => {
  await setup(page);
  const queries: URLSearchParams[] = [];
  await page.route("**/api/tenants/*/alerts?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { data: [row], meta: { total: "1" } } });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByLabel("CEL expression", { exact: true })
    .fill('application == "payments"');
  await page.getByLabel("Search text", { exact: true }).fill("latency");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.getByRole("button", { name: "Error", exact: true }).click();
  await expect
    .poll(() => queries.at(-1)?.get("cel"))
    .toBe('(application == "payments") && (severity == "error")');
  expect(queries.at(-1)?.get("q")).toBe("latency");
  await page.getByLabel("Include suppressed").check();
  await expect
    .poll(() => queries.at(-1)?.get("include_suppressed"))
    .toBe("true");
  await expect(
    page.getByText("1 matching alerts", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Query and freshness")).toHaveCount(0);
  await page.getByLabel("Rows per page").selectOption("100");
  await expect.poll(() => queries.at(-1)?.get("limit")).toBe("100");
  expect(queries.at(-1)?.get("cursor")).toBeNull();
  await page.getByRole("button", { name: "Save as preset…" }).click();
  // The preset editor may label its filter "Filter (CEL)" (reference S06).
  await expect(
    page.getByLabel(/^(CEL expression|Filter \(CEL\))$/),
  ).toHaveValue('application == "payments"');
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
});

test("new preset reads direct-link CEL and retains edits when the URL query changes", async ({
  page,
}) => {
  await setup(page);
  const initial = 'application == "payments"';
  await page.goto(
    `/tenants/${tenant}/presets/new?${new URLSearchParams({ cel: initial })}`,
  );
  const editor = page.getByLabel(/^(CEL expression|Filter \(CEL\))$/);
  await expect(editor).toHaveValue(initial);
  const edited = 'object == "postgres"';
  await editor.fill(edited);
  await page.evaluate(() => {
    const target = new URL(window.location.href);
    target.searchParams.set("cel", "false");
    window.history.replaceState(null, "", target);
  });
  await expect(page).toHaveURL(/cel=false$/);
  await expect(editor).toHaveValue(edited);
  await page.screenshot({
    path: test.info().outputPath("preset-cel-preserved.png"),
    fullPage: true,
  });
});

test("alert column clicks cycle server sort and restart pagination", async ({
  page,
}) => {
  await setup(page);
  const queries: URLSearchParams[] = [];
  await page.route("**/api/tenants/*/alerts?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "50") queries.push(params);
    return route.fulfill({
      json: {
        data: [row],
        meta: { total: "2" },
        next_cursor: params.has("cursor") ? null : "next-page",
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  const table = page.getByRole("table", { name: "Alerts", exact: true });
  await expect(table.getByRole("button", { name: "Severity" })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => queries.at(-1)?.get("cursor")).toBe("next-page");

  await table.getByRole("button", { name: "Severity" }).click();
  await expect.poll(() => queries.at(-1)?.get("sort")).toBe("severity");
  expect(queries.at(-1)?.get("direction")).toBe("asc");
  expect(queries.at(-1)?.has("cursor")).toBe(false);
  await expect(page.getByText(/page 1$/)).toBeVisible();

  await table.getByRole("button", { name: "Severity ↑" }).click();
  await expect.poll(() => queries.at(-1)?.get("direction")).toBe("desc");
  await table.getByRole("button", { name: "Severity ↓" }).click();
  await expect.poll(() => queries.at(-1)?.has("sort")).toBe(false);
  await expect(
    table.getByRole("columnheader", { name: "Last received ↓" }),
  ).toHaveAttribute("aria-sort", "descending");
});

/** Requirements: REV-43; alert operations 17. The row ⋯ menu assigns. */
test("row assignment sends the observed revision and select-all captures the displayed rows", async ({
  page,
}) => {
  await setup(page);
  let command: Record<string, unknown> | undefined;
  await page.route(`**/alerts/${alertId}/commands`, (route) => {
    command = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
    return route.fulfill({
      json: {
        data: { ...row, assignee_id: alertId, revision: "9007199254741000" },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Actions for Database latency", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Assign to me", exact: true })
    .click();
  await expect.poll(() => command?.kind).toBe("set_assignee");
  expect(command?.value).toBe(alertId);
  await expect(page).toHaveURL(`/tenants/${tenant}/alerts`);
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(command?.expected_revision).toBe(row.revision);
  await page.getByLabel("Select all on this page").check();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByLabel("Select all on this page").uncheck();
  await expect(page.getByText("1 selected", { exact: true })).toHaveCount(0);
});

test("reference palette and rail remain stable under dark OS preference and narrow layouts", async ({
  page,
}) => {
  await setup(page, "view");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(247, 250, 253)",
  );
  await expect(page.locator(".rail")).toHaveCSS("width", "76px");
  await expect(
    page
      .getByRole("navigation", { name: "Tenant navigation" })
      .getByRole("link", { name: "Feed", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "Save as preset…" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Assign to me", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: test.info().outputPath("feed-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("feed-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Account:/ }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
});

test("alert detail uses list context, readable history and confirmed note deletion", async ({
  page,
}) => {
  await setup(page);
  const second = {
    ...row,
    id: "00000000-0000-4000-8000-000000000003",
    message: "Queue backlog",
  };
  const detailPath = `/api/tenants/${tenant}/alerts/${alertId}`;
  let command: Record<string, unknown> | undefined;
  let deletion: Record<string, string> | undefined;
  await page.route("**/api/tenants/*/alerts?*", (route) =>
    route.fulfill({ json: { data: [row, second], meta: { total: "2" } } }),
  );
  await page.route(`**${detailPath}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === detailPath)
      return route.fulfill({
        json: {
          data: {
            ...row,
            operator: "pg-exporter",
            active_incident_id: "00000000-0000-4000-8000-000000000010",
            active_incident_title: "Payments DB degradation",
          },
        },
      });
    if (url.pathname === detailPath + "/history")
      return route.fulfill({
        json: {
          data: [
            {
              id: "h1",
              kind: "source",
              recorded_at: "2026-09-24T06:18:22Z",
              evidence: {
                before: { ...row, severity: "major" },
                after: { ...row, operator: "pg-exporter" },
              },
            },
            {
              id: "h2",
              kind: "set_acknowledged",
              recorded_at: "2026-09-24T06:20:00Z",
              actor_id: "00000000-0000-4000-8000-000000000077",
              actor_display_name: "r.lee",
              evidence: { before: row, after: { ...row, acknowledged: true } },
            },
          ],
          next_cursor: null,
        },
      });
    if (url.pathname === detailPath + "/notes")
      return route.fulfill({
        json: {
          data: [
            {
              id: "n1",
              text: "Watching WAL volume",
              created_at: "2026-09-24T06:33:02Z",
              actor_id: "00000000-0000-4000-8000-000000000077",
              actor_display_name: "r.lee",
            },
          ],
          next_cursor: null,
        },
      });
    if (url.pathname === detailPath + "/notes/n1") {
      deletion = route.request().headers();
      return route.fulfill({ json: { data: { id: "n1", deleted: true } } });
    }
    if (url.pathname === detailPath + "/commands") {
      command = route.request().postDataJSON();
      return route.fulfill({
        json: {
          data: { ...row, assignee_id: alertId, revision: "9007199254741000" },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page.getByRole("link", { name: "Open Database latency" }).click();
  await expect(
    page.getByRole("heading", { name: "Database latency", level: 1 }),
  ).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    crumbs.getByRole("link", { name: "Feed", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous alert in list" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Next alert in list" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Severity changed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("from Major to Error by the source.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Acknowledged.", { exact: true })).toBeVisible();
  await expect(page.getByText("Event details")).toHaveCount(0);
  await expect(page.getByText("All current alert fields")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Payments DB degradation" }),
  ).toBeVisible();
  // v1 has no runbook; v1-fields.spec.ts covers a v2 alert's runbook link.
  await expect(page.getByRole("link", { name: "Open runbook" })).toHaveCount(0);
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect.poll(() => command?.kind).toBe("set_assignee");
  expect(command?.expected_revision).toBe(row.revision);
  expect(command?.value).toBe(alertId);
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this note?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(deletion).toBeUndefined();
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete note" }).click();
  await expect.poll(() => deletion?.["if-match"]).toBe('"9007199254741000"');
  expect(deletion?.["x-csrf-token"]).toBe("test-csrf");
  expect(deletion?.["idempotency-key"]).toBeTruthy();
  await page.getByRole("button", { name: "Next alert in list" }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${second.id}$`));
  await crumbs.getByRole("link", { name: "Feed", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tenants/${tenant}/alerts$`));
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true, level: 1 }),
  ).toBeVisible();
});
