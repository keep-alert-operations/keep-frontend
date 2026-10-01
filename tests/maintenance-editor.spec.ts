import { expect, test, type Page } from "@playwright/test";
const tenant = "00000000-0000-4000-8000-000000000001",
  id = "00000000-0000-4000-8000-000000000022";
const base = `/api/tenants/${tenant}/maintenance`;
const windowData = {
  id,
  revision: "9007199254740999",
  name: "Synthetic maintenance",
  reason: "Reviewed reason",
  cel: "true",
  timezone: "UTC",
  start_at: "2027-01-01T10:00:00Z",
  end_at: "2027-01-01T12:00:00Z",
  phase: "active",
  started_lock: true,
  enabled: false,
};
const endpoint = (
  local: string,
  utc: string,
  timezone = "America/New_York",
  offset_seconds = -18000,
) => ({
  local,
  utc,
  timezone,
  offset_seconds,
  occurrence: null,
  tzdata_version: "2025.2",
});
async function setup(page: Page, current = windowData) {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "test", display_name: "Synthetic schedule editor" },
          csrf_token: "schedule-csrf",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/tenants/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (url.pathname.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (url.pathname.endsWith("/timezones"))
      return route.fulfill({
        json: {
          data: [
            { id: "UTC", offset_seconds: 0 },
            { id: "America/New_York", offset_seconds: -14400 },
          ],
          meta: { tzdata_version: "2025.2", as_of: "2026-09-23T12:00:00Z" },
        },
      });
    if (url.pathname.endsWith(`/maintenance/${id}`))
      return route.fulfill({ json: { data: current } });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
}

test("create uses server timezone catalog, reports DST gaps and requires an explicit fold choice", async ({
  page,
}) => {
  await setup(page);
  const validations: Record<string, unknown>[] = [];
  await page.route(`**${base}/validate`, (route) => {
    const body = route.request().postDataJSON();
    validations.push(body);
    expect(body).not.toHaveProperty("command_id");
    expect(route.request().headers()["x-csrf-token"]).toBe("schedule-csrf");
    if (body.start_local.startsWith("2027-03"))
      return route.fulfill({
        json: {
          data: {
            valid: false,
            diagnostics: [
              {
                code: "nonexistent_local_time",
                message: "The local time does not exist.",
                fields: null,
              },
            ],
          },
        },
      });
    if (!body.start_occurrence)
      return route.fulfill({
        json: {
          data: {
            valid: false,
            diagnostics: [
              {
                code: "ambiguous_local_time",
                message: "Choose the first or second occurrence.",
                fields: [
                  {
                    candidates: [
                      {
                        utc: "2027-11-07T05:30:00+00:00",
                        offset_seconds: -14400,
                      },
                      {
                        utc: "2027-11-07T06:30:00+00:00",
                        offset_seconds: -18000,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
    return route.fulfill({
      json: {
        data: {
          valid: true,
          schedule: {
            start: {
              ...endpoint(
                "2027-11-07T01:30:00",
                "2027-11-07T05:30:00+00:00",
                "America/New_York",
                -14400,
              ),
              occurrence: "first",
            },
            end: endpoint("2027-11-07T02:30:00", "2027-11-07T07:30:00+00:00"),
          },
        },
      },
    });
  });
  await page.goto(`/tenants/${tenant}/maintenance/new`);
  await page
    .getByLabel("Name", { exact: true })
    .fill("One-time DST maintenance");
  await page
    .getByRole("combobox", { name: "Timezone", exact: true })
    .selectOption("America/New_York");
  await expect(
    page.getByText("Defaults to your browser timezone · tzdata 2025.2", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("CEL expression", { exact: true }).fill("true");
  await expect(
    page.getByRole("combobox", { name: "Start repeated local time" }),
  ).toHaveCount(0);
  await page.getByLabel("Starts", { exact: true }).fill("2027-03-14T02:30");
  await page.getByLabel("Ends", { exact: true }).fill("2027-03-14T04:30");
  await page.getByRole("button", { name: "Validate schedule" }).click();
  await expect(
    page.getByText("The local time does not exist.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Starts", { exact: true })).toHaveValue(
    "2027-03-14T02:30",
  );
  await page.getByLabel("Starts", { exact: true }).fill("2027-11-07T01:30");
  await page.getByLabel("Ends", { exact: true }).fill("2027-11-07T02:30");
  await page.getByRole("button", { name: "Validate schedule" }).click();
  await expect(
    page.getByText("First occurrence: 07-11-2027 05:30:00 UTC", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Second occurrence: 07-11-2027 06:30:00 UTC", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Start repeated local time", exact: true })
    .selectOption("first");
  await page.getByRole("button", { name: "Validate schedule" }).click();
  await expect(
    page.getByRole("region", { name: "Validated start schedule evidence" }),
  ).toContainText("07-11-2027 05:30:00");
  await expect(
    page.getByRole("region", { name: "Validated start schedule evidence" }),
  ).toContainText("first occurrence");
  await expect(page.getByText(/Runs 2 hours · stored as/)).toBeVisible();
  await page.route(`**${base}/test`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      alert_id: id,
      start_occurrence: "first",
      timezone: "America/New_York",
    });
    expect(route.request().postDataJSON()).not.toHaveProperty("command_id");
    return route.fulfill({
      json: {
        data: {
          matches: true,
          covers_selected_time: false,
          firing: true,
          qualification_proven: false,
          explanation: "A match does not establish a new transition.",
        },
      },
    });
  });
  await page.getByLabel("Test against retained alert ID").fill(id);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.locator(".fld", { hasText: "Condition matches" }),
  ).toContainText("Yes");
  await expect(
    page.locator(".fld", { hasText: "Time is covered" }),
  ).toContainText("No");
  let saved: Record<string, unknown> | undefined;
  await page.route(`**${base}`, (route) => {
    saved = route.request().postDataJSON();
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("schedule-csrf");
    return route.fulfill({ json: { data: windowData } });
  });
  await page
    .getByRole("button", { name: "Create window", exact: true })
    .click();
  // The created window opens in its detail view.
  await expect(page).toHaveURL(new RegExp(`/maintenance/${id}$`));
  await expect(
    page.getByRole("heading", { name: "Synthetic maintenance" }),
  ).toBeVisible();
  expect(saved).toMatchObject({
    timezone: "America/New_York",
    start_local: "2027-11-07T01:30:00",
    end_local: "2027-11-07T02:30:00",
    start_occurrence: "first",
  });
  expect(saved).not.toHaveProperty("end_occurrence");
  expect(saved).not.toHaveProperty("start_at");
  expect(saved).not.toHaveProperty("enabled");
  expect(typeof saved?.command_id).toBe("string");
  expect(validations).toHaveLength(3);
});

test("started schedule edits omit locked fields, preview authoritative UTC and preserve conflict drafts", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/maintenance/${id}`);
  await page.getByRole("button", { name: "Edit shared definition" }).click();
  await page
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("schedule");
  await expect(page.getByLabel("Changed start local time")).toBeDisabled();
  await expect(page.getByLabel("CEL", { exact: true })).toBeDisabled();
  await page.getByLabel("Changed end local time").fill("2027-01-01T13:00");
  let validated: Record<string, unknown> | undefined;
  await page.route(`**${base}/${id}/validate`, (route) => {
    validated = route.request().postDataJSON();
    return route.fulfill({
      json: {
        data: {
          valid: true,
          schedule: {
            start: endpoint(
              "2027-01-01T10:00:00",
              windowData.start_at,
              "UTC",
              0,
            ),
            end: endpoint(
              "2027-01-01T13:00:00",
              "2027-01-01T13:00:00Z",
              "UTC",
              0,
            ),
          },
        },
      },
    });
  });
  await page.getByRole("button", { name: "Validate schedule" }).click();
  await expect(
    page.getByRole("region", { name: "Validated start schedule evidence" }),
  ).toContainText("01-01-2027 10:00:00");
  expect(validated).toMatchObject({
    kind: "schedule",
    expected_revision: windowData.revision,
    end_local: "2027-01-01T13:00:00",
    timezone: "UTC",
  });
  expect(validated).not.toHaveProperty("cel");
  expect(validated).not.toHaveProperty("start_local");
  await page.route(`**${base}/${id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 409,
          json: {
            error: {
              code: "revision_conflict",
              message: "Schedule changed on the server",
            },
          },
        })
      : route.fulfill({ json: { data: windowData } }),
  );
  await page.getByRole("button", { name: "Save maintenance change" }).click();
  await expect(
    page.getByText("Schedule changed on the server", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Changed end local time")).toHaveValue(
    "2027-01-01T13:00",
  );
});

test("ended windows allow metadata and timezone only and uncertain retries keep the tagged command", async ({
  page,
}) => {
  const ended = { ...windowData, phase: "ended" };
  await setup(page, ended);
  await page.goto(`/tenants/${tenant}/maintenance/${id}`);
  await page.getByRole("button", { name: "Edit shared definition" }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Change", exact: true })
      .locator('option[value="schedule"]'),
  ).toHaveAttribute("disabled", "");
  await page
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("timezone");
  await page
    .getByRole("combobox", { name: "Timezone", exact: true })
    .selectOption("America/New_York");
  await page.route(`**${base}/${id}/validate`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      kind: "timezone",
      timezone: "America/New_York",
      expected_revision: ended.revision,
    });
    return route.fulfill({
      json: {
        data: {
          valid: true,
          start_display: endpoint("2027-01-01T05:00:00", ended.start_at),
          end_display: endpoint("2027-01-01T07:00:00", ended.end_at),
        },
      },
    });
  });
  await page.getByRole("button", { name: "Validate schedule" }).click();
  await expect(
    page.getByRole("region", { name: "Validated end schedule evidence" }),
  ).toContainText("01-01-2027 12:00:00");
  await expect(page.getByText(/Displays as 01-01-2027 05:00:00/)).toBeVisible();
  await page
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("metadata");
  await page.getByLabel("Name", { exact: true }).fill("Reviewed ended window");
  const submitted: Record<string, unknown>[] = [];
  await page.route(`**${base}/${id}`, (route) => {
    if (route.request().method() !== "PATCH")
      return route.fulfill({ json: { data: ended } });
    submitted.push(route.request().postDataJSON());
    return submitted.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: { code: "unavailable", message: "Result unknown" } },
        })
      : route.fulfill({
          json: { data: { ...ended, name: "Reviewed ended window" } },
        });
  });
  await page.getByRole("button", { name: "Save maintenance change" }).click();
  await expect(
    page.getByRole("button", { name: "Retry original command" }),
  ).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Retry original command" }).click();
  await expect(
    page.getByRole("button", { name: "Edit shared definition" }),
  ).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(submitted[0]).toMatchObject({
    kind: "metadata",
    name: "Reviewed ended window",
    expected_revision: ended.revision,
  });
  expect(submitted[0]).not.toHaveProperty("end_local");
});

test("deleting a window explains retained suppression and sends a conditional delete", async ({
  page,
}) => {
  await setup(page);
  let headers: Record<string, string> | undefined;
  await page.route(`**${base}/${id}`, (route) => {
    if (route.request().method() === "DELETE") {
      headers = route.request().headers();
      return route.fulfill({ json: { data: { accepted: true } } });
    }
    return route.fulfill({ json: { data: windowData } });
  });
  await page.goto(`/tenants/${tenant}/maintenance/${id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete maintenance window “Synthetic maintenance”?",
  });
  await expect(dialog).toContainText(
    "Existing suppression remains until each alert receives another source update.",
  );
  await dialog
    .getByRole("button", { name: "Delete window", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/tenants/${tenant}/maintenance$`));
  expect(headers?.["if-match"]).toBe(`"${windowData.revision}"`);
  expect(headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
});
