import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const profile = (context: string) => ({
  profile: "appchi-cel-v1",
  context,
  cost_model: "appchi-cel-cost-v1",
  fields: [
    { name: "message", type: "string", nullable: false, values: [] },
    {
      name: "severity",
      type: "enum",
      nullable: false,
      values: ["critical", "major"],
    },
  ],
  operators: ["==", "&&"],
  functions: [
    {
      name: "contains",
      signature: 'string_field.contains("literal")',
      description: "Case-sensitive literal string predicate; false on null.",
      insert_text: 'contains("")',
    },
    ...(context === "feed"
      ? [
          {
            name: "now",
            signature: "now()",
            description: "Feed only.",
            insert_text: "now()",
          },
        ]
      : []),
  ],
  limits: {
    source_bytes: 16384,
    ast_nodes: 256,
    depth: 32,
    list_members: 100,
    compile_timeout_ms: 1000,
  },
});
const valid = (context = "feed") => ({
  valid: true,
  profile: "appchi-cel-v1",
  context,
  diagnostics: [],
  position_encoding: "unicode_codepoints",
  ast_nodes: 1,
  rule_cost_upper_bound: "1",
  relative: false,
});
async function setup(page: Page) {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: "00000000-0000-4000-8000-000000000099",
            display_name: "Synthetic CEL editor user",
          },
          csrf_token: "cel-test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: "admin",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/cel/profile"))
      return route.fulfill({
        json: { data: profile(url.searchParams.get("context") ?? "feed") },
      });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (url.pathname.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (url.pathname.endsWith("/health"))
      return route.fulfill({
        json: { data: { source: "healthy", search: "healthy" } },
      });
    return route.fulfill({
      json: { data: [], next_cursor: null, meta: { total: "0" } },
    });
  });
}

test("feed discovers only supported fields and completes receiver methods at the caret", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Supported fields and functions" })
    .click();
  const editor = page.getByLabel("CEL expression", { exact: true });
  await expect(
    page.getByText("appchi-cel-v1", { exact: false }).first(),
  ).toBeVisible();
  await editor.fill("sev");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /^severity/ })).toBeVisible();
  await editor.press("Enter");
  await expect(editor).toHaveValue("severity");
  await editor.fill("message.con");
  await editor.press("Control+Space");
  await editor.press("Enter");
  await expect(editor).toHaveValue('message.contains("")');

  await page.getByLabel("Filter supported CEL").fill("severity");
  await expect(
    page.getByRole("button", { name: "Insert severity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("enum · critical, major", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Filter supported CEL").fill("matches");
  await expect(page.getByRole("button", { name: /^Insert / })).toHaveCount(0);
  await editor.fill('alert.message == "alert.sev"');
  await editor.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(
      element.value.length - 1,
      element.value.length - 1,
    ),
  );
  await editor.press("Control+Space");
  await expect(
    page.getByRole("listbox", { name: "CEL completions" }),
  ).toHaveCount(0);
});

test("validation uses the exact draft and CSRF, shows type errors and selects Unicode source positions", async ({
  page,
}) => {
  await setup(page);
  const source = 'alert.message == "😀" && alert.severity == 42';
  const offset = Array.from(source.slice(0, source.indexOf("42"))).length;
  await page.route("**/cel/validate", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      cel: source,
      context: "feed",
    });
    expect(route.request().headers()["x-csrf-token"]).toBe("cel-test-csrf");
    return route.fulfill({
      json: {
        data: {
          ...valid(),
          valid: false,
          diagnostics: [
            {
              code: "invalid_cel",
              message: "Literal does not match field type",
              position: offset,
              line: 1,
              column: offset + 1,
            },
          ],
        },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Supported fields and functions" })
    .click();
  const editor = page.getByLabel("CEL expression", { exact: true });
  await editor.fill(source);
  await page.getByRole("button", { name: "Validate CEL", exact: true }).click();
  await expect(page.getByText("Invalid", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Literal does not match field type", { exact: false }),
  ).toBeVisible();
  await expect(editor).toHaveValue(source);
  await expect(editor).toHaveAttribute("aria-invalid", "true");
  await expect(editor).toHaveAccessibleDescription(
    /Literal does not match field type/,
  );
  await page.getByRole("button", { name: "Show source position" }).click();
  expect(
    await editor.evaluate(
      (element: HTMLTextAreaElement) => element.selectionStart,
    ),
  ).toBe(source.indexOf("42"));
  await editor.fill("true");
  await expect(editor).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor).not.toHaveAccessibleDescription(
    /Literal does not match field type/,
  );
  await expect(page.getByText("Invalid", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Expression changed. Validate this draft again."),
  ).toBeVisible();
});

test("keyboard completion announces its list and Tab dismisses it without trapping focus", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Supported fields and functions" })
    .click();
  const editor = page.getByLabel("CEL expression", { exact: true });
  await expect(
    page.getByText("appchi-cel-v1", { exact: false }).first(),
  ).toBeVisible();
  await editor.fill("alert.sev");
  await editor.press("Control+Space");
  await expect(
    page.getByRole("listbox", { name: "CEL completions" }),
  ).toBeVisible();
  await expect(editor).toHaveAttribute("aria-autocomplete", "list");
  await expect(editor).toHaveAttribute("aria-activedescendant", /choice-0$/);
  await editor.press("Tab");
  await expect(
    page.getByRole("button", { name: "Run query", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("listbox", { name: "CEL completions" }),
  ).toHaveCount(0);
  await expect(editor).not.toHaveAttribute("aria-activedescendant");
  await page.keyboard.press("Shift+Tab");
  await expect(editor).toBeFocused();
});

test("late validation cannot certify a changed draft and service failure preserves it", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/cel/validate", async (route) => {
    requests += 1;
    if (requests === 1) {
      await delay;
      await route.fulfill({ json: { data: valid() } }).catch(() => {});
    } else
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "cel_unavailable",
            message: "CEL compiler unavailable",
          },
        },
      });
  });
  await page.goto(`/tenants/${tenant}/alerts`);
  await page
    .getByRole("button", { name: "Supported fields and functions" })
    .click();
  await page.getByRole("button", { name: "Validate CEL", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  const editor = page.getByLabel("CEL expression", { exact: true });
  await editor.fill('alert.severity == "major"');
  release();
  await page.getByRole("button", { name: "Validate CEL", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "CEL compiler unavailable" }),
  ).toBeVisible();
  await expect(editor).toHaveAccessibleDescription(/CEL compiler unavailable/);
  await expect(editor).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor).toHaveValue('alert.severity == "major"');
  await expect(page.getByText("Valid", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Invalid", { exact: true })).toHaveCount(0);
});

for (const section of ["presets", "maintenance", "correlation-rules"]) {
  test(`${section} uses its published CEL context and keeps source after validation`, async ({
    page,
  }) => {
    await setup(page);
    const context =
      section === "presets"
        ? "feed"
        : section === "correlation-rules"
          ? "correlation"
          : "rule";
    await page.route("**/cel/validate", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        cel: 'alert.severity == "critical"',
        context,
      });
      return route.fulfill({ json: { data: valid(context) } });
    });
    const profiles: (string | null)[] = [];
    await page.route("**/cel/profile?**", (route) => {
      const requested = new URL(route.request().url()).searchParams.get(
        "context",
      );
      profiles.push(requested);
      return route.fulfill({ json: { data: profile(requested ?? "feed") } });
    });
    const source = 'alert.severity == "critical"';
    if (section === "maintenance")
      await page.route("**/timezones", (route) =>
        route.fulfill({
          json: {
            data: [{ id: "UTC", offset_seconds: 0 }],
            meta: { tzdata_version: "2025.2", as_of: "2026-09-23T12:00:00Z" },
          },
        }),
      );
    await page.goto(`/tenants/${tenant}/${section}/new`);
    if (section === "correlation-rules")
      await page
        .getByRole("button", { name: "Add condition", exact: true })
        .click();
    // Screen owners may relabel the field (S06 uses "Filter (CEL)").
    const editor = page.getByLabel(
      section === "correlation-rules"
        ? /^Condition 1 CEL$/
        : /^(CEL expression|Filter \(CEL\))$/,
    );
    await editor.fill(source);
    const region = page.getByRole("region", {
      name:
        section === "correlation-rules"
          ? /^Condition 1 CEL editor$/
          : /^(CEL expression|Filter \(CEL\)) editor$/,
    });
    // The editor loads only its own published catalog context.
    await expect.poll(() => profiles.length).toBeGreaterThan(0);
    expect(new Set(profiles)).toEqual(new Set([context]));
    if (section === "presets") {
      await region
        .getByRole("button", { name: "Supported fields and functions" })
        .click();
      await expect(
        region.getByRole("button", { name: "Insert now", exact: true }),
      ).toHaveCount(1);
      // The preset editor shows the reference as a popover; close it first.
      await region
        .getByRole("button", { name: "Supported fields and functions" })
        .click();
      await region
        .getByRole("button", { name: "Validate CEL", exact: true })
        .click();
      await expect(region.getByText("Valid", { exact: true })).toBeVisible();
      await expect(region.getByRole("status")).toContainText(
        "CEL expression is valid",
      );
      await expect(editor).toHaveValue(source);
      return;
    }
    // Rule-context editors are minimal: no per-field reference or Validate
    // CEL button. The page validates the whole definition with the source.
    await expect(
      region.getByRole("button", { name: "Supported fields and functions" }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("button", { name: "Validate CEL", exact: true }),
    ).toHaveCount(0);
    let validated: Record<string, unknown> | undefined;
    if (section === "maintenance") {
      await page.route(
        `**/api/tenants/${tenant}/maintenance/validate`,
        (route) => {
          validated = route.request().postDataJSON();
          expect(route.request().headers()["x-csrf-token"]).toBe(
            "cel-test-csrf",
          );
          const endpoint = (local: string) => ({
            local,
            utc: `${local}+00:00`,
            timezone: "UTC",
            offset_seconds: 0,
            occurrence: null,
            tzdata_version: "2025.2",
          });
          return route.fulfill({
            json: {
              data: {
                valid: true,
                schedule: {
                  start: endpoint("2027-01-01T10:00:00"),
                  end: endpoint("2027-01-01T12:00:00"),
                },
                diagnostics: [],
              },
            },
          });
        },
      );
      await page.getByLabel("Name", { exact: true }).fill("Synthetic window");
      await page
        .getByRole("combobox", { name: "Timezone", exact: true })
        .selectOption("UTC");
      await page.getByLabel("Starts", { exact: true }).fill("2027-01-01T10:00");
      await page.getByLabel("Ends", { exact: true }).fill("2027-01-01T12:00");
      await page.getByRole("button", { name: "Validate schedule" }).click();
      await expect(
        page.locator(".mw-valid").getByText("Valid", { exact: true }),
      ).toBeVisible();
      expect(validated).toMatchObject({ cel: source, timezone: "UTC" });
    } else {
      await page.route(
        `**/api/tenants/${tenant}/correlation-rules/validate`,
        (route) => {
          validated = route.request().postDataJSON();
          expect(route.request().headers()["x-csrf-token"]).toBe(
            "cel-test-csrf",
          );
          return route.fulfill({
            json: { data: { valid: true, diagnostics: [] } },
          });
        },
      );
      await page
        .getByRole("region", { name: "Rule definition" })
        .getByRole("button", { name: "Validate", exact: true })
        .click();
      await expect(
        page.getByText("The definition is valid.", { exact: false }),
      ).toBeVisible();
      expect(
        (validated?.conditions as { cel: string }[] | undefined)?.[0]?.cel,
      ).toBe(source);
    }
    expect(new Set(profiles)).toEqual(new Set([context]));
    await expect(editor).toHaveValue(source);
  });
}
