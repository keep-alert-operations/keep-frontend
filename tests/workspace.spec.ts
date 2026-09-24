import { expect, test, type Page } from "@playwright/test";

test("global administrator reviews source repair and preserves a conflicted draft", async ({
  page,
}) => {
  await setup(page, "admin");
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { data: { ...session, global_super_admin: true } } }),
  );
  const generation = "9007199254740999";
  await page.route("**/api/admin/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing"))
      return route.fulfill({
        json: {
          data: {
            blocked: true,
            block_generation: generation,
            head: null,
            last_repair: null,
          },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/processing/retry", (route) => {
    submitted = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: "repair_required",
          message: "Proof still requires repair.",
        },
      },
    });
  });
  await page.goto(`/tenants/${global}/platform`);
  await page
    .getByLabel("Repair reason")
    .fill("Reviewed and restored the missing proof");
  await page.getByRole("button", { name: "Verify repair and resume" }).click();
  await expect(
    page.getByText("Proof still requires repair.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Repair reason")).toHaveValue(
    "Reviewed and restored the missing proof",
  );
  expect(submitted?.expected_block_generation).toBe(generation);
  expect(submitted?.command_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("tenant creation gives the current global administrator the explicit initial grant", async ({
  page,
}) => {
  await setup(page, "admin");
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { data: { ...session, global_super_admin: true } } }),
  );
  await page.route("**/api/admin/**", (route) =>
    route.fulfill({
      json: {
        data: new URL(route.request().url()).pathname.endsWith("/processing")
          ? { blocked: false }
          : [],
        next_cursor: null,
      },
    }),
  );
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/tenants", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        data: {
          id: other,
          name: "Operations",
          kind: "specific",
          role: "admin",
          revision: "1",
        },
      },
    });
  });
  await page.goto(`/tenants/${global}/platform`);
  await page.getByLabel("Tenant name").fill("Operations");
  await page
    .getByRole("button", { name: "Create tenant", exact: true })
    .click();
  await expect(
    page.getByText("Created Operations.", { exact: false }),
  ).toBeVisible();
  expect(submitted?.initial_grants).toEqual([
    { principal_id: session.principal.id, role: "admin" },
  ]);
});

test("tenant administrators cannot open platform controls", async ({
  page,
}) => {
  await setup(page, "admin");
  let platformRequests = 0;
  await page.route("**/api/admin/**", (route) => {
    platformRequests += 1;
    return route.abort();
  });
  await page.goto(`/tenants/${global}/platform`);
  await expect(
    page.getByText(
      "Platform administration requires global administration access.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Tenant name")).toHaveCount(0);
  expect(platformRequests).toBe(0);
});

test("operator preparation stays unavailable and retries the exact observed revision", async ({
  page,
}) => {
  await setup(page, "admin");
  const operator = {
    id: alert,
    revision: "9007199254740999",
    name: "Synthetic operator",
    lifecycle: "pending",
    integration_health: "needs_attention",
    current_key_available: false,
    keys: [],
    operation: {
      id: other,
      kind: "setup",
      state: "needs_attention",
      error_code: "operator_capabilities_unverified",
    },
  };
  let body: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/*/operators/${alert}`, (route) =>
    route.fulfill({ json: { data: operator } }),
  );
  await page.route(
    `**/api/tenants/*/operators/${alert}/operations/${other}/retry`,
    (route) => {
      body = route.request().postDataJSON();
      expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
      return route.fulfill({
        status: 202,
        json: { data: { operator, operation: operator.operation } },
      });
    },
  );
  await page.goto(`/tenants/${global}/operators/${alert}`);
  await expect(
    page.getByRole("button", { name: "Copy current key" }),
  ).toBeDisabled();
  await expect(
    page.getByText("operator_capabilities_unverified.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry provisioning now" }).click();
  await expect.poll(() => body?.expected_revision).toBe(operator.revision);
  expect(body?.command_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("replacement key is available while revoked-key cleanup remains pending", async ({
  page,
}) => {
  await setup(page, "admin");
  const operator = {
    id: alert,
    revision: "9",
    name: "Synthetic revoked operator",
    lifecycle: "ready",
    integration_health: "needs_attention",
    current_key_available: false,
    keys: [],
    operation: { id: other, kind: "cleanup", state: "pending" },
  };
  await page.route(`**/api/tenants/*/operators/${alert}`, (route) =>
    route.fulfill({ json: { data: operator } }),
  );
  let submitted: Record<string, unknown> | undefined;
  await page.route(
    `**/api/tenants/*/operators/${alert}/keys/create`,
    (route) => {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: {
          data: {
            operator: {
              ...operator,
              revision: "10",
              operation: { ...operator.operation, kind: "create_key" },
            },
          },
        },
      });
    },
  );
  await page.goto(`/tenants/${global}/operators/${alert}`);
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expect.poll(() => submitted?.expected_revision).toBe("9");
  await expect(
    page.getByRole("button", { name: "Create key", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Copy current key" }),
  ).toBeDisabled();
});

test("explicit operator copy sends the secret only to clipboard", async ({
  page,
  context,
}) => {
  await setup(page, "admin");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const secret = "synthetic-browser-test-key-never-render";
  await page.route(`**/api/tenants/*/operators/${alert}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id: alert,
          revision: "8",
          name: "Synthetic operator",
          lifecycle: "ready",
          integration_health: "healthy",
          current_key_available: true,
          keys: [],
        },
      },
    }),
  );
  await page.route(
    `**/api/tenants/*/operators/${alert}/keys/current/copy`,
    (route) => {
      expect(route.request().postDataJSON().expected_revision).toBe("8");
      return route.fulfill({
        json: { data: { key: secret, credential_id: other } },
      });
    },
  );
  await page.goto(`/tenants/${global}/operators/${alert}`);
  await page.getByRole("button", { name: "Copy current key" }).click();
  await expect(
    page.getByText("Current key copied to clipboard."),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    secret,
  );
  await expect(page.locator("body")).not.toContainText(secret);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(secret);
});

test("active maintenance end edit keeps the draft after a conflict and omits locked CEL", async ({
  page,
}) => {
  await setup(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/*/maintenance/${alert}`, (route) => {
    if (route.request().method() === "PATCH") {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "revision_conflict",
            message: "A newer maintenance revision exists.",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        data: {
          id: alert,
          revision: "12",
          name: "Synthetic window",
          reason: "Test",
          cel: "true",
          timezone: "UTC",
          start_at: "2026-09-22T00:00:00Z",
          end_at: "2026-09-23T00:00:00Z",
          enabled: true,
          started_lock: true,
        },
      },
    });
  });
  await page.goto(`/tenants/${global}/maintenance/${alert}`);
  await page.getByRole("button", { name: "Edit shared definition" }).click();
  await page
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("schedule");
  await expect(
    page.getByRole("textbox", { name: "CEL", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Changed end local time").fill("2026-09-23T01:00");
  await page.getByRole("button", { name: "Save maintenance change" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "newer maintenance revision",
  );
  expect(submitted).toMatchObject({
    kind: "schedule",
    expected_revision: "12",
    end_local: "2026-09-23T01:00:00",
    timezone: "UTC",
  });
  expect(submitted).not.toHaveProperty("cel");
  expect(submitted).not.toHaveProperty("start_local");
  await expect(page.getByLabel("Changed end local time")).toHaveValue(
    "2026-09-23T01:00",
  );
});

test("saved preset preview preserves decimal totals and follows server cursors", async ({
  page,
}) => {
  await setup(page);
  await page.route(`**/api/tenants/*/presets/${alert}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id: alert,
          revision: "7",
          name: "Synthetic preset",
          columns: ["message"],
          cel: "true",
        },
      },
    }),
  );
  await page.route("**/api/tenants/*/presets/preview", (route) => {
    const submitted = route.request().postDataJSON();
    return route.fulfill({
      json: {
        data: [
          {
            ...row,
            message: submitted?.cursor
              ? "Synthetic second page"
              : "Synthetic first page",
          },
        ],
        meta: {
          total: "9007199254740999",
          evaluated_at: "2026-09-22T00:00:00Z",
          updating: true,
        },
        next_cursor: submitted?.cursor ? null : "opaque-next-cursor",
      },
    });
  });
  await page.goto(`/tenants/${global}/presets/${alert}`);
  await expect(
    page.getByText("9,007,199,254,740,999 matching alerts", { exact: false }),
  ).toBeVisible();
  const nextPageRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/presets/preview") &&
      request.method() === "POST" &&
      request.postDataJSON()?.cursor === "opaque-next-cursor",
  );
  await page.getByRole("button", { name: "Next results page" }).click();
  const submitted = (await nextPageRequest).postDataJSON();
  await expect(
    page.getByRole("link", {
      name: "Open Synthetic second page",
      exact: true,
    }),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    preset_id: alert,
    expected_revision: "7",
    cursor: "opaque-next-cursor",
    include_suppressed: false,
  });
});

const global = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  alert = "00000000-0000-4000-8000-000000000011";
const session = {
  principal: {
    id: "00000000-0000-4000-8000-000000000099",
    display_name: "Synthetic test user",
  },
  csrf_token: "test-csrf",
  tenants: [
    { id: global, name: "Global", kind: "global", role: "edit", revision: "1" },
    {
      id: other,
      name: "Synthetic second tenant",
      kind: "specific",
      role: "view",
      revision: "1",
    },
  ],
};
const row = {
  id: alert,
  revision: "9007199254740999",
  severity: "critical",
  status: "firing",
  message: "Synthetic firing alert",
  application: "test",
  component: "test",
  acknowledged: false,
};
async function setup(page: Page, role = "edit") {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          ...session,
          tenants: session.tenants.map((t) =>
            t.id === global ? { ...t, role } : t,
          ),
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
        json: { data: { source: "healthy", search: "healthy" } },
      });
    if (path.endsWith(`/alerts/${alert}`))
      return route.fulfill({ json: { data: row } });
    if (path.endsWith("/alerts"))
      return route.fulfill({
        json: { data: [row], meta: { total: "9007199254740999" } },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
}
test("unauthenticated shell offers company sign-in without protected data", async ({
  page,
}) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: { code: "session_required", message: "Sign in required" },
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Tenant navigation" }),
  ).toHaveCount(0);
});
test("feed preserves exact decimal count and source text", async ({ page }) => {
  await setup(page);
  await page.goto(`/tenants/${global}/alerts`);
  await expect(
    page.getByRole("link", {
      name: "Open Synthetic firing alert",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Synthetic firing alert/ }),
  ).toContainText("test · test");
  await expect(
    page
      .getByRole("region", { name: "Matching alerts" })
      .getByText("9,007,199,254,740,999 matching alerts", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Include suppressed")).not.toBeChecked();
});
test("failed search is unavailable rather than an empty or zero result", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/alerts?**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "search_unavailable", message: "Search unavailable" },
      },
    }),
  );
  await page.goto(`/tenants/${global}/alerts`);
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "Search unavailable",
  );
  await expect(
    page.getByRole("heading", { name: "No matching alerts" }),
  ).toHaveCount(0);
  const results = page.getByRole("region", { name: "Matching alerts" });
  await expect(results).toContainText("Count unavailable");
  await expect(results).not.toContainText(/0 matching alerts/);
  await expect(
    page
      .getByRole("group", { name: "Quick views, not saved" })
      .getByRole("button", { name: "All" }),
  ).not.toContainText("0");
});
test("viewer has no alert mutation controls", async ({ page }) => {
  await setup(page, "view");
  await page.goto(`/tenants/${global}/alerts/${alert}`);
  await expect(page.getByRole("heading", { name: row.message })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resolve alert", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Add a note", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Assign alert to a user")).toHaveCount(0);
});

for (const section of ["alerts", "incidents"]) {
  test(`${section} assignment uses verified directory selection and current revision`, async ({
    page,
  }) => {
    await setup(page);
    const principal = {
      id: other,
      directory_source: "fixture",
      object_id: "verified",
      display_name: "Verified target",
      kind: "user",
      eligible: true,
      deleted: false,
      selectable: true,
      verification: "verified",
      verified_at: "2026-09-23T00:00:00Z",
    };
    await page.route("**/assignees?**", (route) =>
      route.fulfill({
        json: {
          data: [
            principal,
            {
              ...principal,
              id: null,
              object_id: "pending",
              display_name: "Pending target",
              selectable: false,
              verification: "pending",
            },
          ],
          next_cursor: null,
        },
      }),
    );
    if (section === "incidents")
      await page.route(`**/api/tenants/${global}/incidents/${alert}`, (route) =>
        route.fulfill({
          json: {
            data: { ...row, title: "Synthetic incident", status: "open" },
          },
        }),
      );
    let submitted: Record<string, unknown> | undefined;
    await page.route(
      section === "alerts" ? "**/commands" : "**/assignment",
      (route) => {
        submitted = route.request().postDataJSON();
        expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
        return route.fulfill({
          json: { data: { ...row, assignee_id: other } },
        });
      },
    );
    await page.goto(`/tenants/${global}/${section}/${alert}`);
    await page.getByText("Assign to…", { exact: true }).click();
    const picker = page.getByRole("region", {
      name:
        section === "alerts"
          ? "Assign alert to a user"
          : "Assign incident to a user",
    });
    await picker.getByRole("textbox").fill("target");
    await picker.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      picker.getByRole("button", { name: "Choose Pending target" }),
    ).toBeDisabled();
    await picker
      .getByRole("button", { name: "Choose Verified target" })
      .click();
    await expect.poll(() => submitted?.expected_revision).toBe(row.revision);
    expect(submitted?.command_id).toMatch(/^[0-9a-f-]{36}$/);
    if (section === "alerts") {
      expect(submitted?.kind).toBe("set_assignee");
      expect(submitted?.value).toBe(other);
    } else expect(submitted?.assignee_id).toBe(other);
  });
}

test("bulk acknowledgement uses a boolean and captured selected revision", async ({
  page,
}) => {
  await setup(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/alerts/bulk-commands", (route) => {
    submitted = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
    return route.fulfill({ json: { data: { updated: "1" } } });
  });
  await page.goto(`/tenants/${global}/alerts`);
  await page.getByRole("checkbox", { name: `Select ${row.message}` }).check();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Acknowledge", exact: true })
    .click();
  await expect.poll(() => submitted?.kind).toBe("set_acknowledged");
  expect(submitted?.value).toBe(true);
  expect(submitted?.items).toEqual([
    { alert_id: alert, expected_revision: row.revision },
  ]);
});
test("uncertain alert command retries identical command UUID and revision", async ({
  page,
}) => {
  await setup(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/commands", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: bodies.length === 1 ? 503 : 200,
      json:
        bodies.length === 1
          ? {
              error: {
                code: "unknown_outcome",
                message: "Connection interrupted",
              },
            }
          : {
              data: {
                ...row,
                status: "resolved",
                revision: "9007199254741000",
              },
            },
    });
  });
  await page.goto(`/tenants/${global}/alerts/${alert}`);
  await page
    .getByRole("button", { name: "Resolve alert", exact: true })
    .click();
  await expect(
    page.getByText("The outcome is uncertain.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Resolve alert", exact: true })
    .click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0].expected_revision).toBe(row.revision);
});
for (const status of [401, 403]) {
  test(`authorization status ${status} clears protected drafts even with a null error body`, async ({
    page,
  }) => {
    await setup(page);
    let denied = false;
    await page.route("**/auth/session", (route) =>
      denied
        ? route.fulfill({
            status,
            contentType: "application/json",
            body: "null",
          })
        : route.fulfill({ json: { data: session } }),
    );
    await page.route("**/commands", (route) => {
      denied = true;
      return route.fulfill({
        status,
        contentType: "application/json",
        body: "null",
      });
    });
    await page.goto(`/tenants/${global}/alerts/${alert}`);
    await page
      .getByRole("textbox", { name: "Add a note", exact: true })
      .fill("Protected unsaved note");
    await page
      .getByRole("button", { name: "Acknowledge", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: row.message })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("textbox", { name: "Add a note", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Sign in with company account" }),
    ).toBeVisible();
  });
}

test("note conflict preserves draft", async ({ page }) => {
  await setup(page);
  await page.route(
    (url) => url.pathname === `/api/tenants/${global}/alerts/${alert}/notes`,
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 409,
            json: {
              error: {
                code: "revision_conflict",
                message: "Reload and review the current revision",
              },
            },
          })
        : route.fulfill({ json: { data: [] } }),
  );
  await page.goto(`/tenants/${global}/alerts/${alert}`);
  await page
    .getByRole("textbox", { name: "Add a note", exact: true })
    .fill("Keep this investigation draft");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "revision_conflict",
  );
  await expect(
    page.getByRole("textbox", { name: "Add a note", exact: true }),
  ).toHaveValue("Keep this investigation draft");
});
test("late response from previous tenant cannot enter new tenant view", async ({
  page,
}) => {
  await setup(page);
  let release: (() => void) | undefined;
  await page.route(`**/tenants/${global}/alerts?**`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({
        json: {
          data: [{ ...row, message: "Protected previous tenant content" }],
        },
      })
      .catch(() => {});
  });
  await page.route(`**/tenants/${other}/alerts?**`, (route) =>
    route.fulfill({ json: { data: [], meta: { total: "0" } } }),
  );
  await page.goto(`/tenants/${global}/alerts`);
  await expect(page.getByLabel("Tenant", { exact: true })).toBeVisible();
  await expect.poll(() => !!release).toBe(true);
  await page.getByLabel("Tenant", { exact: true }).selectOption(other);
  release?.();
  await expect(
    page.getByRole("heading", { name: "No matching alerts" }),
  ).toBeVisible();
  await expect(page.getByText("Protected previous tenant content")).toHaveCount(
    0,
  );
});
test("tenant access loss clears protected draft and operational content", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${global}/alerts/${alert}`);
  await page
    .getByRole("textbox", { name: "Add a note", exact: true })
    .fill("Protected draft");
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "session_expired", message: "Session expired" } },
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
  await expect(page.getByText(row.message, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Add a note", exact: true }),
  ).toHaveCount(0);
});
test("incident creation requires explicit immutable severity and CSRF", async ({
  page,
}) => {
  await setup(page);
  let sent: Record<string, unknown> | undefined, csrf: string | undefined;
  await page.route(`**/tenants/${global}/incidents`, (route) => {
    sent = route.request().postDataJSON();
    csrf = route.request().headers()["x-csrf-token"];
    return route.fulfill({
      status: 201,
      json: { data: { id: alert, revision: "1" } },
    });
  });
  await page.goto(`/tenants/${global}/incidents/new`);
  const severity = page.getByRole("radiogroup", { name: "Severity" });
  await expect(severity.getByRole("radio", { checked: true })).toHaveCount(0);
  await page.getByLabel("Title", { exact: true }).fill("Synthetic incident");
  await page.getByRole("button", { name: "Create incident" }).click();
  await expect(page.getByText("Choose a severity.")).toBeVisible();
  expect(sent).toBeUndefined();
  await severity.getByRole("radio", { name: "High" }).click();
  await expect(severity.getByRole("radio", { name: "High" })).toBeChecked();
  await page.getByRole("button", { name: "Create incident" }).click();
  await expect(page).toHaveURL(`/tenants/${global}/incidents/${alert}`);
  expect(sent?.severity).toBe("high");
  expect(csrf).toBe("test-csrf");
});
test("dark narrow layout retains keyboard access and semantic content", async ({
  page,
}) => {
  await setup(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tenants/${global}/alerts`);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "All alerts", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
});

test("shared editor keeps its original revision when a remote save arrives", async ({
  page,
}) => {
  await setup(page);
  let revision = "1",
    submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/${global}/presets/${alert}`, (route) => {
    if (route.request().method() === "PUT") {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "revision_conflict",
            message: "The shared preset changed",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        data: {
          id: alert,
          revision,
          name: "Shared preset",
          cel: "true",
          columns: ["message"],
          sort: [{ field: "timestamp", direction: "desc" }],
        },
      },
    });
  });
  await page.goto(`/tenants/${global}/presets/${alert}`);
  await page.getByRole("link", { name: "Edit preset" }).click();
  await expect(page).toHaveURL(`/tenants/${global}/presets/${alert}/edit`);
  await page.getByLabel("Name", { exact: true }).fill("My protected draft");
  revision = "2";
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByText("A newer shared revision 2", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "revision_conflict",
  );
  expect(submitted?.expected_revision).toBe("1");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "My protected draft",
  );
});

test("bulk status captures selected revisions instead of silently upgrading them", async ({
  page,
}) => {
  await setup(page);
  let revision = "1",
    submitted: Record<string, unknown> | undefined;
  await page.route("**/alerts?**", (route) =>
    route.fulfill({
      json: { data: [{ ...row, revision }], meta: { total: "1" } },
    }),
  );
  await page.route("**/alerts/bulk-commands", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: {
        error: { code: "revision_conflict", message: "The alert changed" },
      },
    });
  });
  await page.goto(`/tenants/${global}/alerts`);
  await page.getByRole("checkbox", { name: `Select ${row.message}` }).check();
  revision = "2";
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "revision_conflict",
  );
  expect(submitted?.kind).toBe("set_status");
  expect(submitted?.value).toBe("resolved");
  expect(submitted?.items).toEqual([
    { alert_id: alert, expected_revision: "1" },
  ]);
});

test("deleting an alert note uses revision and idempotency headers without a body", async ({
  page,
}) => {
  await setup(page);
  let headers: Record<string, string> | undefined,
    body: string | null = "not called";
  await page.route(
    (url) => url.pathname === `/api/tenants/${global}/alerts/${alert}/notes`,
    (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: other,
              revision: "1",
              text: "Synthetic note",
              actor_id: session.principal.id,
            },
          ],
        },
      }),
  );
  await page.route(`**/notes/${other}`, (route) => {
    headers = route.request().headers();
    body = route.request().postData();
    return route.fulfill({
      json: {
        data: { id: other, deleted: true, revision: "9007199254741000" },
      },
    });
  });
  await page.goto(`/tenants/${global}/alerts/${alert}`);
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this note?" });
  await expect(confirm).toBeVisible();
  expect(headers).toBeUndefined();
  await confirm
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await expect.poll(() => headers !== undefined).toBe(true);
  expect(headers?.["if-match"]).toBe(`"${row.revision}"`);
  expect(headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(body).toBeNull();
});

test("incident move sends both observed aggregate revisions and explicit alert IDs", async ({
  page,
}) => {
  await setup(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/tenants/${global}/incidents/${alert}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id: alert,
          revision: "3",
          title: "Source incident",
          severity: "high",
          status: "open",
        },
      },
    }),
  );
  await page.route(`**/api/tenants/${global}/incidents?**`, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: other,
            revision: "7",
            title: "Destination incident",
            severity: "high",
            status: "open",
          },
        ],
      },
    }),
  );
  await page.route("**/incidents/move-alerts", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { data: { source_revision: "4", destination_revision: "8" } },
    });
  });
  await page.goto(`/tenants/${global}/incidents/${alert}`);

  await page.getByRole("button", { name: "Unlink or move…" }).click();

  await page
    .getByRole("combobox", { name: "Operation", exact: true })
    .selectOption("move");
  await page.getByText("Enter known alert IDs", { exact: true }).click();
  await page
    .getByRole("textbox", { name: /^Alert IDs, separated/ })
    .fill(global);
  await page
    .getByRole("combobox", { name: "Destination active incident" })
    .selectOption(other);
  await page.getByRole("button", { name: "Move selected alerts" }).click();
  await expect.poll(() => submitted !== undefined).toBe(true);
  expect(submitted).toMatchObject({
    source_id: alert,
    destination_id: other,
    source_revision: "3",
    destination_revision: "7",
    alert_ids: [global],
  });
});

test("foreground reauthorization cannot repopulate protected data during sign-out", async ({
  page,
}) => {
  await setup(page);
  let complete: (() => void) | undefined;
  await page.route("**/auth/logout", async (route) => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    await route.fulfill({
      json: { data: { provider_logout_completed: false } },
    });
  });
  await page.goto(`/tenants/${global}/alerts`);
  await expect(
    page.getByRole("link", { name: `Open ${row.message}`, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("navigation", { name: "Tenant navigation" }),
  ).toHaveCount(0);
  await expect.poll(() => !!complete).toBe(true);
  complete?.();
  await expect(
    page.getByText("Signed out locally.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
});
