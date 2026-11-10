import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const ruleId = "00000000-0000-4000-8000-000000000010";
const alertId = "00000000-0000-4000-8000-000000000020";
const conditions = [true, false, null].map((match, index) => ({
  id: `00000000-0000-4000-8000-00000000003${index}`,
  label: [
    "Matching condition",
    "Nonmatching condition",
    "Unavailable condition",
  ][index],
  cel: match === false ? "false" : "true",
}));
const definition = {
  name: "Synthetic correlation rule",
  description: "Controlled browser fixture",
  severity: "high",
  conditions,
  group_by: ["application", "acknowledged"],
  window_minutes: 10,
};
const result = () => ({
  data: {
    valid: true,
    qualification_proven: false,
    conditions: conditions.map((item, index) => ({
      condition_id: item.id,
      label: item.label,
      matches: [true, false, null][index],
      error: index === 2 ? "Synthetic evaluation unavailable" : null,
    })),
    group: [
      ["application", "string", "  exact text  "],
      ["acknowledged", "bool", false],
    ] as [string, string, string | boolean | number][],
    eligibility_exclusions: ["not_firing", "suppressed", "active_ownership"],
  },
  meta: {
    profile: "keep-cel-v1",
    as_of: "2026-09-23T12:00:00Z",
    alert_revision: "9007199254740997",
  },
});

async function setup(page: Page, role = "view") {
  let accessible = true;
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: "00000000-0000-4000-8000-000000000099",
            display_name: "Synthetic rule tester",
          },
          csrf_token: "rule-test-csrf",
          tenants: accessible
            ? [
                {
                  id: tenant,
                  name: "Synthetic tenant",
                  kind: "specific",
                  role,
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
    if (path.endsWith(`/correlation-rules/${ruleId}`))
      return route.fulfill({
        json: {
          data: { ...definition, id: ruleId, revision: "4", enabled: true },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return {
    revoke: () => {
      accessible = false;
    },
  };
}
async function openTest(page: Page) {
  await page.goto(`/tenants/${tenant}/correlation-rules/${ruleId}`);
  await page.getByLabel("Alert identifier for rule test").fill(alertId);
}
const testButton = (page: Page) =>
  page.getByRole("button", { name: "Test", exact: true });

test("viewer explicitly tests a saved rule with CSRF and exact typed results without qualification", async ({
  page,
}) => {
  await setup(page);
  let calls = 0;
  await page.route("**/correlation-rules/test", (route) => {
    calls++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("rule-test-csrf");
    expect(route.request().postDataJSON()).toEqual({
      ...definition,
      alert_id: alertId,
    });
    return route.fulfill({ json: result() });
  });
  await openTest(page);
  expect(calls).toBe(0);
  await expect(
    page.getByRole("button", { name: "Edit shared definition", exact: true }),
  ).toHaveCount(0);
  await testButton(page).click();
  const output = page.getByRole("region", {
    name: "Current alert test result",
  });
  await expect(
    output.getByRole("row", { name: "Matching condition True —" }),
  ).toBeVisible();
  await expect(
    output.getByRole("row", { name: "Nonmatching condition False —" }),
  ).toBeVisible();
  await expect(
    output.getByRole("row", { name: /Unavailable condition Unavailable/ }),
  ).toBeVisible();
  await expect(
    output.getByText('"  exact text  "', { exact: true }),
  ).toBeVisible();
  await expect(output.getByText("false", { exact: true })).toBeVisible();
  await expect(
    output.getByText(/Alert revision 9007199254740997/),
  ).toBeVisible();
  await expect(
    output.getByText("Alert is suppressed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/A match now does not prove a qualifying transition/),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.getByLabel("Alert identifier for rule test").fill("not-a-uuid");
  await expect(output).toHaveCount(0);
  await testButton(page).click();
  await expect(
    page.getByText("Enter a valid existing alert UUID.", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
});

test("draft changes discard an in-flight answer and require another explicit test", async ({
  page,
}) => {
  await setup(page, "edit");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  await page.route("**/correlation-rules/test", async (route) => {
    calls++;
    if (calls === 1) {
      started();
      await gate;
    }
    await route.fulfill({ json: result() }).catch(() => {});
  });
  await openTest(page);
  // Rule details are directly editable for edit access (S11 reference).
  await expect(page.getByLabel("Name", { exact: true })).toBeEditable();
  await testButton(page).click();
  await received;
  await page.getByLabel("Name", { exact: true }).fill("Changed draft");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  release();
  await expect(testButton(page)).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "Current alert test result" }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
  await testButton(page).click();
  await expect(
    page.getByRole("region", { name: "Current alert test result" }),
  ).toBeVisible();
  expect(calls).toBe(2);
});

test("invalid definitions show diagnostics and missing typed groups stay unavailable", async ({
  page,
}) => {
  await setup(page);
  let calls = 0;
  await page.route("**/correlation-rules/test", (route) => {
    calls++;
    const response = result();
    return route.fulfill({
      json:
        calls === 1
          ? {
              data: {
                valid: false,
                qualification_proven: false,
                diagnostics: { message: "Synthetic CEL type error" },
              },
              meta: { profile: "keep-cel-v1" },
            }
          : {
              ...response,
              data: {
                ...response.data,
                group: null,
                eligibility_exclusions: ["invalid_group"],
              },
            },
    });
  });
  await openTest(page);
  await testButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Rule validation failed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic CEL type error", { exact: true }),
  ).toBeVisible();
  await testButton(page).click();
  await expect(
    page.getByText("Unavailable: grouping fields are incomplete or invalid."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Rule validation failed" }),
  ).toHaveCount(0);
});

for (const malformed of ["unsafe integer", "qualification claim"] as const) {
  test(`rejects ${malformed} in a successful response`, async ({ page }) => {
    await setup(page);
    await page.route("**/correlation-rules/test", (route) => {
      const response = result();
      if (malformed === "unsafe integer")
        response.data.group[0] = [
          "application",
          "int",
          Number("9007199254740993"),
        ];
      else response.data.qualification_proven = true;
      return route.fulfill({ json: response });
    });
    await openTest(page);
    await testButton(page).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "The rule test response does not match its API contract.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Current alert test result" }),
    ).toHaveCount(0);
  });
}

test("authorization denial clears the protected workspace", async ({
  page,
}) => {
  const access = await setup(page);
  await page.route("**/correlation-rules/test", (route) => {
    access.revoke();
    return route.fulfill({
      status: 403,
      json: { error: { code: "forbidden", message: "Access changed" } },
    });
  });
  await openTest(page);
  await testButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Tenant unavailable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Alert identifier for rule test")).toHaveCount(
    0,
  );
});

test("saving an edited rule sends the full definition with its base revision and keeps the draft on conflict", async ({
  page,
}) => {
  await setup(page, "edit");
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/tenants/*/correlation-rules/${ruleId}`, (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({
        json: {
          data: { ...definition, id: ruleId, revision: "4", enabled: true },
        },
      });
    expect(route.request().headers()["x-csrf-token"]).toBe("rule-test-csrf");
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: "revision_conflict",
          message: "A newer rule revision exists.",
        },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/correlation-rules/${ruleId}`);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("Window (minutes)").fill("15");
  await page.getByRole("button", { name: "Critical", exact: true }).click();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await save.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "A newer rule revision exists." }),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    ...definition,
    severity: "critical",
    window_minutes: 15,
    expected_revision: "4",
  });
  expect(typeof bodies[0].command_id).toBe("string");
  await expect(page.getByLabel("Window (minutes)")).toHaveValue("15");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
});

test("deleting a rule confirms in a dialog and sends an idempotent conditional delete", async ({
  page,
}) => {
  await setup(page, "edit");
  let deleted: Record<string, string> | undefined;
  await page.route(`**/api/tenants/*/correlation-rules/${ruleId}`, (route) => {
    if (route.request().method() === "DELETE") {
      deleted = route.request().headers();
      return route.fulfill({ json: { data: { accepted: true } } });
    }
    return route.fulfill({
      json: {
        data: { ...definition, id: ruleId, revision: "4", enabled: true },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/correlation-rules/${ruleId}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete rule “Synthetic correlation rule”?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(deleted).toBeUndefined();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete rule", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/tenants/${tenant}/correlation-rules$`),
  );
  expect(deleted?.["if-match"]).toBe('"4"');
  expect(deleted?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(deleted?.["x-csrf-token"]).toBe("rule-test-csrf");
});
