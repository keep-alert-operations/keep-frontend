import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000099";
const principal = "00000000-0000-4000-8000-000000000098";
const resource = "00000000-0000-4000-8000-000000000097";
const event = {
  id: "00000000-0000-4000-8000-000000000095",
  tenant_id: tenant,
  actor_id: actor,
  actor_label: "Captured <b>actor</b>",
  kind: "permissions-changed",
  recorded_at: "2026-09-22T12:00:00Z",
  dependency_protected: true,
  evidence: {
    before: "Historical <script>text</script>",
    changes: [{ principal_id: principal, role: "edit" }],
  },
  references: [{ kind: "source-item", id: resource, available: false }],
};

test("malformed audit envelopes show an error instead of crashing or reporting an empty page", async ({
  page,
}) => {
  await setup(page);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route(`**/api/tenants/${tenant}/audit?**`, (route) =>
    route.fulfill({
      json: { data: { blocked: false }, next_cursor: "not-valid-for-an-error" },
    }),
  );
  await page.goto(`/tenants/${tenant}/audit`);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "audit response does not match its API contract" }),
  ).toBeVisible();
  await expect(
    page.getByText("No audit records match these filters."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Older records" }),
  ).toBeDisabled();
  expect(failures).toEqual([]);
});

async function setup(page: Page, platform = false) {
  const state = { role: "admin", platform };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: actor, display_name: "Current actor" },
          csrf_token: "audit-csrf",
          global_super_admin: state.platform,
          tenants: [
            {
              id: tenant,
              name: "Audit tenant",
              kind: "specific",
              role: state.role,
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
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/health") || path.endsWith("/processing"))
      return route.fulfill({ json: { data: { blocked: false } } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return state;
}

test("tenant audit defaults to 30 days and binds pages to applied filters", async ({
  page,
}) => {
  await setup(page);
  const requests: URL[] = [];
  await page.route(`**/api/tenants/${tenant}/audit?**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    expect(route.request().method()).toBe("GET");
    return route.fulfill({
      json: {
        data: [event],
        next_cursor:
          url.searchParams.has("cursor") || url.searchParams.has("action")
            ? null
            : "opaque-audit/+==",
      },
    });
  });
  await page.goto(`/tenants/${tenant}/audit`);
  const row = page.getByRole("row", { name: "Audit event", exact: true });
  await expect(row).toBeVisible();
  // Human summary: the affected principal is shown, the chip names the change.
  await expect(row).toContainText("Grant added");
  expect(requests[0].searchParams.get("period")).toBe("recent");
  await expect(page.getByText("Times in ", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Older records", exact: true })
    .click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("cursor"))
    .toBe("opaque-audit/+==");
  // Changing the period applies at once and returns to the first page.
  await page.getByRole("button", { name: "Full retained period" }).click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("period"))
    .toBe("retained");
  expect(requests.at(-1)!.searchParams.has("cursor")).toBe(false);
  await page
    .getByLabel("Action", { exact: true })
    .selectOption("permissions-changed");
  // Names seen on the page resolve to immutable IDs; IDs pass through.
  await page.getByLabel("Actor", { exact: true }).fill("Captured <b>actor</b>");
  await page
    .getByLabel("Affected user or team", { exact: true })
    .fill(principal);
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Affected resource ID", { exact: true }).fill(resource);
  await page
    .getByLabel("Recorded from (inclusive)", { exact: true })
    .fill("2026-09-01T09:00");
  await page
    .getByLabel("Recorded before (exclusive)", { exact: true })
    .fill("2026-09-23T09:00");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("affected_principal_id"))
    .toBe(principal);
  const query = requests.at(-1)!.searchParams;
  expect(query.get("period")).toBe("retained");
  expect(query.get("actor_id")).toBe(actor);
  expect(query.get("resource_id")).toBe(resource);
  expect(query.get("action")).toBe("permissions-changed");
  expect(query.has("cursor")).toBe(false);
  expect(query.get("from_at")).toMatch(/Z$/);
  expect(query.get("to_at")).toMatch(/Z$/);
  await page.getByRole("button", { name: "Show event details" }).click();
  const details = page.getByRole("row", { name: "Audit details" });
  await expect(details).toContainText("Referenced resource unavailable");
  await expect(details).toContainText("Historical <script>text</script>");
  await expect(details.locator("script,b")).toHaveCount(0);
  await expect(row.locator("script,b")).toHaveCount(0);
});

test("unknown actor names are rejected instead of sent as filters", async ({
  page,
}) => {
  await setup(page);
  const requests: URL[] = [];
  await page.route(`**/api/tenants/${tenant}/audit?**`, (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { data: [event], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/audit`);
  await expect(
    page.getByRole("row", { name: "Audit event", exact: true }),
  ).toBeVisible();
  const sent = requests.length;
  await page.getByLabel("Actor", { exact: true }).fill("nobody.known");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No known user or team" }),
  ).toBeVisible();
  expect(requests.length).toBe(sent);
  expect(requests.some((url) => url.searchParams.has("actor_id"))).toBe(false);
});

test("platform audit adds the affected tenant filter without switching audit scope", async ({
  page,
}) => {
  await setup(page, true);
  const requests: URL[] = [];
  await page.route("**/api/admin/access-audit?**", (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        data: [{ ...event, tenant_id: null, kind: "source-processing-retry" }],
        next_cursor: null,
      },
    });
  });
  await page.goto(`/tenants/${tenant}/platform`);
  await page.getByRole("button", { name: "Platform access audit" }).click();
  await expect(page).toHaveURL(/\/platform\/audit$/);
  await expect(
    page.getByRole("heading", { name: "Platform access audit" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: "Audit event", exact: true }),
  ).toContainText("Repair check");
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Affected tenant ID", { exact: true }).fill(tenant);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("tenant_id"))
    .toBe(tenant);
  expect(requests.at(-1)?.pathname).toBe("/api/admin/access-audit");
});

test("audit permission loss clears displayed protected records", async ({
  page,
}) => {
  const state = await setup(page);
  let denied = false;
  await page.route(`**/api/tenants/${tenant}/audit?**`, (route) =>
    denied
      ? route.fulfill({
          status: 403,
          json: {
            error: {
              code: "forbidden",
              message: "Administration access was removed.",
            },
          },
        })
      : route.fulfill({ json: { data: [event], next_cursor: null } }),
  );
  await page.goto(`/tenants/${tenant}/audit`);
  await expect(
    page.getByRole("row", { name: "Audit event", exact: true }),
  ).toBeVisible();
  state.role = "view";
  denied = true;
  await page
    .getByRole("button", { name: "Refresh audit", exact: true })
    .click();
  await expect(
    page.getByRole("row", { name: "Audit event", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply filters", exact: true }),
  ).toHaveCount(0);
});

test("permission changes are saved together with the observed roster revision", async ({
  page,
}) => {
  await setup(page);
  const revision = "9007199254740999";
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/${tenant}/permissions`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          data: [
            {
              principal_id: actor,
              display_name: "Current actor",
              kind: "user",
              role: "admin",
              eligible: true,
              deleted: false,
            },
          ],
          meta: { revision },
        },
      });
    submitted = route.request().postDataJSON();
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers()["x-csrf-token"]).toBe("audit-csrf");
    return route.fulfill({
      status: 409,
      json: {
        error: { code: "revision_conflict", message: "Grant roster changed" },
      },
    });
  });
  await page.route("**/permission-principals?**", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: principal,
            directory_source: "fixture",
            object_id: "team",
            display_name: "Verified team",
            kind: "team",
            eligible: true,
            deleted: false,
            selectable: true,
            verification: "verified",
            verified_at: "2026-09-23T00:00:00Z",
          },
        ],
      },
    }),
  );
  await page.goto(`/tenants/${tenant}/permissions`);
  await page
    .getByRole("textbox", {
      name: "Add a user or team from the company directory",
    })
    .fill("team");
  await page.getByRole("button", { name: "Choose Verified team" }).click();
  await page.getByLabel("Role for new grant").selectOption("edit");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("New grant", { exact: true })).toBeVisible();
  await page.getByLabel("Role for Current actor").selectOption("view");
  await expect(page.getByText("Admin → View")).toBeVisible();
  await page.getByRole("button", { name: "Save 2 changes" }).click();
  await expect(
    page.getByText("Grant roster changed", { exact: false }),
  ).toBeVisible();
  expect(submitted?.expected_revision).toBe(revision);
  expect(submitted?.command_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted?.operations).toEqual([
    { principal_id: principal, action: "set", role: "edit" },
    { principal_id: actor, action: "set", role: "view" },
  ]);
  // The conflicted draft stays in place for review.
  await expect(page.getByLabel("Role for Verified team")).toHaveValue("edit");
  await expect(
    page.getByRole("button", { name: "Save 2 changes" }),
  ).toBeVisible();
});
