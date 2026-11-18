import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-77; alert operations 3; preset operations 6; UI acceptance
 * A6 and A7.
 * Native v1 alerts are kept as sent and land only in the fixed Global tenant.
 * Global shows them with v1 fields (Object; no Component, Site or Impact) and
 * v1 severities (Error, Major, Warning); a specific tenant keeps the v2 fields.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const v1Id = "00000000-0000-4000-8000-000000000011";
const majorId = "00000000-0000-4000-8000-000000000012";
const v2Id = "00000000-0000-4000-8000-000000000013";
const incident = "00000000-0000-4000-8000-000000000020";
const rule =
  "https://grafana.example.org/alerting/grafana/cpu-rule/view?orgId=1";
const runbook = "https://runbooks.example/latency";

// A Grafana-sent v1 alert, as the API returns it after REV-77.
const v1Alert = {
  id: v1Id,
  revision: "5",
  schema_version: "v1",
  message: "CPU saturated",
  name: null,
  application: "payments",
  object: "cpu",
  component: null,
  node_name: "node-1",
  operator: "ops-team",
  provider: "grafana",
  alert_rule_url: rule,
  severity: "error",
  status: "firing",
  display_status: "firing",
  assignee_id: null,
  suppressed: false,
  timestamp: "2026-11-18T09:00:00Z",
  first_received_at: "2026-11-18T08:00:00Z",
  occurrence_number: "1",
};
const majorAlert = {
  ...v1Alert,
  id: majorId,
  message: "Disk filling",
  object: "disk",
  severity: "major",
  provider: "api",
  alert_rule_url: null,
};
const v2Alert = {
  id: v2Id,
  revision: "7",
  schema_version: "v2",
  name: "Database latency",
  message: "p99 above 2s",
  application: "payments",
  component: "postgres",
  node_name: "db-07",
  site: "eu-west-1",
  operator: "00000000-0000-4000-8000-000000000005",
  operator_display_name: "Payments",
  provider: "api",
  impact: "Checkout slow",
  runbook_url: runbook,
  severity: "critical",
  status: "firing",
  display_status: "firing",
  assignee_id: null,
  suppressed: false,
  timestamp: "2026-11-18T09:00:00Z",
  first_received_at: "2026-11-18T08:00:00Z",
  occurrence_number: "1",
};

async function setup(page: Page, kind: "global" | "specific" = "global") {
  const counts: { id: string; cel: string }[][] = [];
  const feeds: URLSearchParams[] = [];
  const rows = kind === "global" ? [v1Alert, majorAlert] : [v2Alert];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "reviewer", display_name: "Design reviewer" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: kind === "global" ? "Global" : "Local Demo",
              kind,
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/alerts/counts")) {
      const queries = route.request().postDataJSON().queries as {
        id: string;
        cel: string;
      }[];
      counts.push(queries);
      return route.fulfill({
        json: {
          data: {
            counts: Object.fromEntries(queries.map((q) => [q.id, "2"])),
          },
        },
      });
    }
    for (const row of [v1Alert, majorAlert, v2Alert])
      if (path.endsWith(`/alerts/${row.id}`))
        return route.fulfill({ json: { data: row } });
    if (path.endsWith(`/incidents/${incident}`))
      return route.fulfill({
        json: {
          data: {
            id: incident,
            revision: "3",
            title: "CPU incident",
            status: "open",
            severity: "high",
          },
        },
      });
    if (path.endsWith(`/incidents/${incident}/alerts`))
      return route.fulfill({
        json: { data: [v1Alert], meta: { total: "1" }, next_cursor: null },
      });
    if (path.endsWith("/alerts")) feeds.push(url.searchParams);
    if (path.endsWith("/alerts") || path.endsWith("/presets/preview"))
      return route.fulfill({
        json: { data: rows, meta: { total: String(rows.length) } },
      });
    return route.fulfill({
      json: { data: [], meta: { total: "0" }, next_cursor: null },
    });
  });
  return { counts, feeds };
}

const detailLabels = (page: Page) =>
  page
    .getByRole("region", { name: "Details" })
    .locator(".ad-fields dt")
    .allTextContents();

test("a Global v1 alert's details list v1 fields and its Grafana rule", async ({
  page,
}) => {
  // Requirements: REV-77; alert operations 3; UI acceptance A6.
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts/${v1Id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "CPU saturated",
  );
  await expect
    .poll(() => detailLabels(page))
    .toEqual([
      "Application",
      "Object",
      "Node name",
      "Operator",
      "Provider",
      "First received",
      "Last received",
      "Occurrence",
      "Schema",
    ]);
  const details = page.getByRole("region", { name: "Details" });
  await expect(
    details.locator(".fld", { hasText: "Object" }).locator("dd"),
  ).toHaveText("cpu");
  await expect(
    details.locator(".fld", { hasText: "Provider" }).locator("dd"),
  ).toHaveText("Grafana");
  await expect(
    details.locator(".fld", { hasText: "Schema" }).locator("dd"),
  ).toHaveText("v1");
  await expect(
    page.getByRole("link", { name: "Open alert rule" }),
  ).toHaveAttribute("href", rule);
  await expect(page.getByRole("link", { name: "Open runbook" })).toHaveCount(0);
});

test("a Local Demo v2 alert's details are unchanged", async ({ page }) => {
  // Requirements: REV-77; alert operations 3; UI acceptance A6.
  await setup(page, "specific");
  await page.goto(`/tenants/${tenant}/alerts/${v2Id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Database latency",
  );
  await expect
    .poll(() => detailLabels(page))
    .toEqual([
      "Application",
      "Component",
      "Node name",
      "Site",
      "Operator",
      "Provider",
      "Impact",
      "First received",
      "Last received",
      "Occurrence",
      "Schema",
    ]);
  const details = page.getByRole("region", { name: "Details" });
  await expect(
    details.locator(".fld", { hasText: "Component" }).locator("dd"),
  ).toHaveText("postgres");
  await expect(
    details.locator(".fld", { hasText: "Impact" }).locator("dd"),
  ).toHaveText("Checkout slow");
  await expect(
    page.getByRole("link", { name: "Open runbook" }),
  ).toHaveAttribute("href", runbook);
});

const editorChoices = async (page: Page) => {
  await page.getByRole("tab", { name: /^Columns/ }).click();
  const columns = await page
    .getByRole("list", { name: "Columns, in order", exact: true })
    .locator(".pe-col-label")
    .allTextContents();
  const addable = (
    await page.locator(".pe-add-list label").allTextContents()
  ).map((text) => text.trim());
  await page.getByRole("tab", { name: /^Sort/ }).click();
  const sort = (
    await page.getByLabel("Sort field 1").locator("option").allTextContents()
  ).map((text) => text.trim());
  await page.getByRole("tab", { name: /^Group by/ }).click();
  const group = (await page.locator(".pe-radios label").allTextContents()).map(
    (text) => text.trim(),
  );
  return { columns, addable, sort, group };
};

test("the Global preset editor offers v1 columns, sort and grouping", async ({
  page,
}) => {
  // Requirements: REV-77; preset operations 6; UI acceptance A7.
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByLabel("Name", { exact: true }).fill("v1 preset");
  const choices = await editorChoices(page);
  expect(choices.columns).toEqual([
    "Severity",
    "Status",
    "Alert",
    "Application",
    "Object",
    "Last received",
    "Assignee",
  ]);
  expect(choices.addable).toEqual([
    "Node",
    "Operator",
    "Provider",
    "Created",
    "Suppressed",
    "Incident",
  ]);
  expect(choices.sort).toEqual([
    "Last received",
    "Severity",
    "Lifecycle",
    "Application",
    "Object",
    "Node",
    "Operator",
    "Created",
    "Assignee",
  ]);
  expect(choices.group).toEqual([
    "No grouping",
    "Severity",
    "Status",
    "Application",
    "Object",
    "Node",
    "Assignee",
    "Incident",
  ]);
  for (const list of Object.values(choices))
    for (const absent of ["Component", "Site", "Impact", "Alert name"])
      expect(list).not.toContain(absent);
});

test("a Local Demo preset editor keeps the v2 columns, sort and grouping", async ({
  page,
}) => {
  // Requirements: REV-77; preset operations 6; UI acceptance A7.
  await setup(page, "specific");
  await page.goto(`/tenants/${tenant}/presets/new`);
  await page.getByLabel("Name", { exact: true }).fill("v2 preset");
  const choices = await editorChoices(page);
  expect(choices.columns).toEqual([
    "Severity",
    "Status",
    "Alert",
    "Application",
    "Component",
    "Last received",
    "Assignee",
  ]);
  expect(choices.addable).toEqual([
    "Node",
    "Site",
    "Operator",
    "Provider",
    "Created",
    "Suppressed",
    "Impact",
    "Incident",
  ]);
  expect(choices.sort).toEqual([
    "Last received",
    "Severity",
    "Lifecycle",
    "Alert name",
    "Application",
    "Component",
    "Node",
    "Site",
    "Operator",
    "Created",
    "Assignee",
  ]);
  expect(choices.group).toEqual([
    "No grouping",
    "Severity",
    "Status",
    "Alert name",
    "Application",
    "Component",
    "Node",
    "Site",
    "Assignee",
    "Incident",
  ]);
  for (const list of Object.values(choices))
    expect(list).not.toContain("Object");
});

test("Global quick views read Error, Major and Warning and filter on v1 severities", async ({
  page,
}) => {
  // Requirements: REV-77; preset operations 6; UI acceptance A7.
  const { counts, feeds } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const group = page.getByRole("group", { name: "Quick views, not saved" });
  await expect(group.getByRole("button")).toHaveText([
    /^All/,
    /^Error/,
    /^Major/,
    /^Warning/,
    /^Firing/,
    /^Acknowledged/,
    /^Resolved/,
    /^Assigned to me/,
  ]);
  await expect(group.locator(".qv-dot.qv-error")).toHaveCount(1);
  await expect(group.locator(".qv-dot.qv-major")).toHaveCount(1);
  await expect.poll(() => counts.length).toBeGreaterThan(0);
  const ids = counts[0].map((query) => query.id);
  expect(ids).toEqual(expect.arrayContaining(["error", "major", "warning"]));
  expect(ids).not.toContain("critical");
  expect(ids).not.toContain("high");
  expect(counts[0]).toContainEqual(
    expect.objectContaining({
      id: "error",
      cel: '(true) && (severity == "error")',
    }),
  );
  for (const [name, severity] of [
    ["Error", "error"],
    ["Major", "major"],
  ]) {
    await group.getByRole("button", { name, exact: true }).click();
    await expect
      .poll(() => feeds.at(-1)?.get("cel"))
      .toBe(`(true) && (severity == "${severity}")`);
  }
});

test("Local Demo quick views keep Critical, High and Warning", async ({
  page,
}) => {
  // Requirements: REV-77; preset operations 6; UI acceptance A7.
  await setup(page, "specific");
  await page.goto(`/tenants/${tenant}/alerts`);
  const group = page.getByRole("group", { name: "Quick views, not saved" });
  await expect(group.getByRole("button")).toHaveText([
    /^All/,
    /^Critical/,
    /^High/,
    /^Warning/,
    /^Firing/,
    /^Acknowledged/,
    /^Resolved/,
    /^Assigned to me/,
  ]);
});

test("Error and Major badges take the critical and high colors", async ({
  page,
}) => {
  // Requirements: REV-77; alert operations 3; UI acceptance A7.
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const error = page
    .locator(`[data-alert-id="${v1Id}"]`)
    .locator(".sev.sev-error");
  const major = page
    .locator(`[data-alert-id="${majorId}"]`)
    .locator(".sev.sev-major");
  await expect(error).toHaveText("Error");
  await expect(major).toHaveText("Major");
  // Compare with the v2 badges' colors, rendered off-screen for reference.
  const reference = await page.evaluate(() => {
    const color = (name: string) => {
      const span = document.createElement("span");
      span.className = `sev sev-${name}`;
      document.body.append(span);
      const value = getComputedStyle(span).color;
      span.remove();
      return value;
    };
    return {
      critical: color("critical"),
      high: color("high"),
      plain: color("unknown"),
    };
  });
  expect(reference.critical).not.toBe(reference.plain);
  expect(reference.high).not.toBe(reference.plain);
  await expect(error).toHaveCSS("color", reference.critical);
  await expect(major).toHaveCSS("color", reference.high);
});

test("an incident's linked v1 alert shows its object in the subline", async ({
  page,
}) => {
  // Requirements: REV-77; incident operations; UI acceptance A6.
  await setup(page);
  await page.goto(`/tenants/${tenant}/incidents/${incident}`);
  const linked = page.getByRole("table", { name: "Linked alerts" });
  await expect(linked.locator(".sub")).toHaveText("payments · cpu · node-1");
  await expect(linked.locator(".sev.sev-error")).toHaveText("Error");
});
