import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const alert = "00000000-0000-4000-8000-000000000020";
const recorded = "2026-09-23T12:00:00Z";
const saved = {
  id,
  revision: "9007199254740993",
  name: "Saved maintenance",
  reason: "Persisted schedule",
  cel: "true",
  timezone: "UTC",
  phase: "ended",
  enabled: false,
  start_at: "2025-01-01T00:00:00Z",
  end_at: "2025-01-01T01:00:00Z",
};
async function setup(page: Page) {
  let allowed = true;
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: alert, display_name: "Synthetic history viewer" },
          csrf_token: "temporal-csrf",
          tenants: allowed
            ? [
                {
                  id: tenant,
                  name: "Synthetic",
                  kind: "specific",
                  role: "view",
                  revision: "1",
                },
              ]
            : [],
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
    if (path.endsWith(`/maintenance/${id}`))
      return route.fulfill({ json: { data: saved } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return {
    revoke: () => {
      allowed = false;
    },
  };
}

for (const section of ["maintenance", "correlation-rules"] as const) {
  test(`${section} deleted discovery opens retained history without reading an active resource`, async ({
    page,
  }) => {
    await setup(page);
    let activeReads = 0;
    await page.route(`**/api/tenants/${tenant}/${section}/${id}`, (route) => {
      activeReads++;
      return route.fulfill({
        status: 404,
        json: {
          error: { code: "not_found", message: "Active resource unavailable" },
        },
      });
    });
    await page.route(`**/api/tenants/${tenant}/${section}?*`, (route) => {
      const query = new URL(route.request().url()).searchParams;
      const deleted =
        query.get(section === "maintenance" ? "phase" : "state") === "deleted";
      return route.fulfill({
        json: {
          data: deleted
            ? [{ ...saved, name: "Deleted evidence", deleted_at: recorded }]
            : [],
          next_cursor: null,
        },
      });
    });
    await page.route(
      `**/api/tenants/${tenant}/${section}/${id}/history?*`,
      (route) => {
        const older = new URL(route.request().url()).searchParams.has("cursor");
        return route.fulfill({
          json: {
            data: [
              {
                revision: older ? "1" : "2",
                recorded_at: recorded,
                action: "deleted",
              },
            ],
            next_cursor: older ? null : "older-page",
          },
        });
      },
    );
    await page.route(
      `**/api/tenants/${tenant}/${section}/${id}/history/2`,
      (route) =>
        route.fulfill({
          json: {
            data:
              section === "maintenance"
                ? {
                    revision: "2",
                    recorded_at: recorded,
                    action: "deleted",
                    actor_label: "Historical editor",
                    snapshot: { name: "Retained definition", cel: "true" },
                  }
                : {
                    revision: "2",
                    recorded_at: recorded,
                    definition: { name: "Retained definition", cel: "true" },
                    activity: null,
                  },
          },
        }),
    );
    await page.route(
      `**/api/tenants/${tenant}/${section}/${id}/history/1`,
      (route) =>
        route.fulfill({
          status: 404,
          json: {
            error: { code: "not_found", message: "Selected revision expired" },
          },
        }),
    );
    await page.goto(`/tenants/${tenant}/${section}`);
    await page
      .getByRole("button", { name: "Deleted history", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Deleted evidence", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/${section}/${id}/history$`));
    await expect(
      page
        .getByRole("region", { name: "Revision 2 detail" })
        .getByText("Retained definition", { exact: true }),
    ).toBeVisible();
    if (section === "correlation-rules")
      await expect(
        page.getByText(
          "Activity metadata is unavailable for this retained revision.",
        ),
      ).toBeVisible();
    expect(activeReads).toBe(0);
    await expect(
      page.getByRole("button", { name: /Save|Restore|Enable|Disable/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Next history page" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Selected revision expired" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Revision 1 detail" })
        .getByText("Retained definition", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "First history page" }).click();
    await expect(
      page.getByRole("region", { name: "Revision 2 detail" }),
    ).toBeVisible();
  });
}

test("saved maintenance viewer tests persisted ended schedule using only identity and revision", async ({
  page,
}) => {
  await setup(page);
  let calls = 0;
  await page.route(
    `**/api/tenants/${tenant}/maintenance/${id}/test`,
    (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({
        alert_id: alert,
        expected_revision: saved.revision,
      });
      expect(route.request().headers()["x-csrf-token"]).toBe("temporal-csrf");
      return route.fulfill({
        json: {
          data: {
            matches: true,
            covers_selected_time: false,
            firing: true,
            enabled: false,
            qualification_proven: false,
            explanation: "No transition qualification.",
          },
          meta: {
            revision: saved.revision,
            alert_revision: "7",
            as_of: recorded,
          },
        },
      });
    },
  );
  await page.goto(`/tenants/${tenant}/maintenance/${id}`);
  const tester = page.getByRole("region", {
    name: "Maintenance current alert test",
  });
  await tester.getByLabel("Test against retained alert ID").fill(alert);
  expect(calls).toBe(0);
  await tester.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    tester.locator(".fld", { hasText: "Condition matches" }),
  ).toContainText("Yes");
  await expect(
    tester.locator(".fld", { hasText: "Time is covered" }),
  ).toContainText("No");
  await expect(tester.getByText(/Saved window intent: Disabled/)).toBeVisible();
  await expect(
    tester.getByText(/window revision 9007199254740993/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit shared definition" }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
});

test("new saved maintenance revision discards an in-flight test result", async ({
  page,
}) => {
  await setup(page);
  let revision = saved.revision;
  await page.route(`**/api/tenants/${tenant}/maintenance/${id}`, (route) =>
    route.fulfill({ json: { data: { ...saved, revision } } }),
  );
  let release!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route(
    `**/api/tenants/${tenant}/maintenance/${id}/test`,
    async (route) => {
      calls++;
      const captured = route.request().postDataJSON().expected_revision;
      if (calls === 1) await delay;
      await route
        .fulfill({
          json: {
            data: {
              matches: true,
              covers_selected_time: false,
              firing: true,
              enabled: false,
              qualification_proven: false,
              explanation:
                captured === saved.revision
                  ? "Obsolete answer"
                  : "Fresh answer",
            },
            meta: { revision: captured, alert_revision: "8", as_of: recorded },
          },
        })
        .catch(() => {});
    },
  );
  await page.goto(`/tenants/${tenant}/maintenance/${id}`);
  await page.getByLabel("Test against retained alert ID").fill(alert);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  revision = "9007199254740994";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(new RegExp(`^Revision ${revision} ·`)),
  ).toBeVisible();
  release();
  await expect(page.getByText("Obsolete answer", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("Fresh answer", { exact: true })).toBeVisible();
});

test("retained history reauthorization removes protected content", async ({
  page,
}) => {
  const access = await setup(page);
  await page.route(
    `**/api/tenants/${tenant}/maintenance/${id}/history?*`,
    (route) =>
      route.fulfill({
        json: {
          data: [{ revision: "1", recorded_at: recorded }],
          next_cursor: null,
        },
      }),
  );
  await page.route(
    `**/api/tenants/${tenant}/maintenance/${id}/history/1`,
    (route) =>
      route.fulfill({
        json: {
          data: { revision: "1", snapshot: { name: "Protected history" } },
        },
      }),
  );
  await page.goto(`/tenants/${tenant}/maintenance/${id}/history`);
  await expect(
    page
      .getByRole("region", { name: "Revision 1 detail" })
      .getByText("Protected history", { exact: true }),
  ).toBeVisible();
  await page.route(
    `**/api/tenants/${tenant}/maintenance/${id}/history?*`,
    (route) => {
      access.revoke();
      return route.fulfill({
        status: 403,
        json: { error: { code: "forbidden", message: "Access changed" } },
      });
    },
  );
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(
    page.getByRole("heading", { name: "Tenant unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Protected history", { exact: true }),
  ).toHaveCount(0);
});
