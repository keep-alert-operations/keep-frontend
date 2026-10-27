import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const operator = "00000000-0000-4000-8000-000000000002";
const incident = "00000000-0000-4000-8000-000000000003";
const incidentPath = `/api/tenants/${tenant}/incidents/${incident}`;

async function openIncident(
  page: Page,
  data: Record<string, unknown>,
  related: { cycles?: unknown[]; activity?: unknown[] } = {},
) {
  await page.route(`**${incidentPath}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === incidentPath)
      return route.fulfill({
        json: {
          data: {
            id: incident,
            revision: "4",
            title: "Database latency",
            severity: "high",
            origin: "manual",
            created_at: "2026-08-01T10:00:00Z",
            ...data,
          },
        },
      });
    const rows =
      path === `${incidentPath}/cycles`
        ? related.cycles
        : path === `${incidentPath}/activity`
          ? related.activity
          : undefined;
    return route.fulfill({ json: { data: rows ?? [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/incidents/${incident}`);
  await expect(
    page.getByRole("heading", { name: "Database latency" }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "test", display_name: "Test admin" },
          csrf_token: "test",
          tenants: [
            {
              id: tenant,
              name: "Test",
              kind: "specific",
              role: "admin",
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
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
});

test("operator creation waits for completion and shows verified success", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(`**/api/tenants/${tenant}/operators`, async (route) => {
    await pending;
    await route.fulfill({
      status: 201,
      json: {
        data: { operator: { id: operator, revision: "2", lifecycle: "ready" } },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/operators/new`);
  await page.getByLabel("Operator name").fill("Sender");
  await page
    .getByRole("button", { name: "Create operator", exact: true })
    .click();
  await expect(page.getByText("Verifying operator setup…")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create operator", exact: true }),
  ).toBeDisabled();
  finish!();
  await expect(
    page.getByText("Operator ready.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Provisioning continues in the background."),
  ).toHaveCount(0);
});

test("partial setup failure exposes original operator recovery without a second create", async ({
  page,
}) => {
  await page.route(`**/api/tenants/${tenant}/operators`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "remote_outcome_uncertain",
          message: "Remote changes may be partial.",
          fields: {
            operator_id: operator,
            operation_id: "operation",
            outcome_may_be_partial: true,
          },
        },
      },
    }),
  );
  await page.goto(`/tenants/${tenant}/operators/new`);
  await page.getByLabel("Operator name").fill("Sender");
  await page
    .getByRole("button", { name: "Create operator", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open operator to inspect and retry" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create operator", exact: true }),
  ).toBeDisabled();
});

test("incident creation describes resolution without deferred sweeps", async ({
  page,
}) => {
  await page.goto(`/tenants/${tenant}/incidents/new`);
  const facts = page
    .getByRole("list")
    .filter({ hasText: "Status and assignment are independent." });
  await expect(facts).toContainText(
    "Incidents stay active until someone resolves them or all their linked alerts resolve; nothing removes an incident automatically.",
  );
  await expect(facts).not.toContainText(/days without activity|retained for/i);
});

test("active incident shows last activity without an inactivity deadline", async ({
  page,
}) => {
  await openIncident(
    page,
    {
      status: "open",
      cycle_id: "cycle-1",
      last_activity: "2026-09-20T08:00:00Z",
    },
    { cycles: [{ id: "cycle-1", opened_at: "2026-08-01T10:00:00Z" }] },
  );
  await expect(page.getByText(/^Last activity\s/)).toBeVisible();
  await expect(
    page.getByText(/resolves automatically|without activity/i),
  ).toHaveCount(0);
  await expect(page.locator('[title^="Deadline"]')).toHaveCount(0);
});

test("resolved incident omits the retention deadline but keeps recorded inactivity history", async ({
  page,
}) => {
  await openIncident(
    page,
    {
      status: "resolved",
      cycle_id: "cycle-2",
      resolved_at: "2026-10-02T09:00:00Z",
      // Stored compatibility field; no sweep acts on it in this release.
      retention_at: "2026-12-31T09:00:00Z",
    },
    {
      cycles: [
        {
          id: "cycle-2",
          cycle_number: 2,
          opened_at: "2026-09-25T10:00:00Z",
          resolved_at: "2026-10-02T09:00:00Z",
          cause: "manual",
        },
        {
          id: "cycle-1",
          cycle_number: 1,
          opened_at: "2026-08-01T10:00:00Z",
          resolved_at: "2026-09-10T10:00:00Z",
          cause: "inactivity",
        },
      ],
      activity: [
        { id: "a-1", kind: "inactivity", recorded_at: "2026-09-10T10:00:00Z" },
      ],
    },
  );
  await expect(page.getByText("· manually")).toBeVisible();
  await expect(page.getByText(/retained until|retention/i)).toHaveCount(0);
  await expect(
    page.getByText("Resolved automatically after 30 days without activity."),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Cycles/ }).click();
  await expect(page.getByText("Cycle 2 resolved manually.")).toBeVisible();
  await expect(
    page.getByText("Cycle 1 resolved after 30 days without activity."),
  ).toBeVisible();
});

test("incident resolved because all linked alerts resolved names that cause", async ({
  page,
}) => {
  // Requirements: REV-46; incident operations 4.
  await openIncident(
    page,
    {
      status: "resolved",
      cycle_id: "cycle-1",
      resolved_at: "2026-10-27T09:00:00Z",
    },
    {
      cycles: [
        {
          id: "cycle-1",
          cycle_number: 1,
          opened_at: "2026-10-20T10:00:00Z",
          resolved_at: "2026-10-27T09:00:00Z",
          cause: "alerts_resolved",
        },
      ],
      activity: [
        {
          id: "a-1",
          kind: "alerts-resolved",
          recorded_at: "2026-10-27T09:00:00Z",
        },
      ],
    },
  );
  await expect(
    page.getByText("· when all linked alerts resolved"),
  ).toBeVisible();
  await expect(
    page.getByText("Resolved automatically when all linked alerts resolved."),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Cycles/ }).click();
  await expect(
    page.getByText("Cycle 1 resolved when all linked alerts resolved."),
  ).toBeVisible();
});
