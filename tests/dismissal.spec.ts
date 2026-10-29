import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-49; alert operations 25, 29.
 * Timed dismissal from the Feed ⋯ menu: the dialog, the Suppressed · until
 * indicator, Change dismissal / Undismiss, and a refresh when a dismissal ends.
 */
test.use({ timezoneId: "UTC" });

const tenant = "00000000-0000-4000-8000-000000000001";
const firingId = "00000000-0000-4000-8000-000000000002";
const dismissedId = "00000000-0000-4000-8000-000000000003";
const resolvedId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-10-28T12:00:00Z");
const base = {
  application: "payments",
  component: "postgres",
  severity: "critical",
  status: "firing",
  assignee_id: null,
  suppressed: false,
  timestamp: "2026-10-28T11:00:00Z",
};
const rows = [
  { ...base, id: firingId, revision: "4", message: "Disk usage above 95%" },
  {
    ...base,
    id: dismissedId,
    revision: "7",
    message: "Queue depth growing",
    suppressed: true,
    dismissed_until: "2026-10-28T12:30:00Z",
  },
  {
    ...base,
    id: resolvedId,
    revision: "2",
    message: "Pod restarts",
    status: "resolved",
  },
];

async function setup(
  page: Page,
  nextChange: string | null = null,
  { holdLive = false } = {},
) {
  const commands: Record<string, unknown>[] = [];
  const feeds: string[] = [];
  await page.clock.install({ time: now });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "reviewer", display_name: "Design reviewer" },
          csrf_token: "test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
              kind: "global",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    // A held stream never connects or reconnects, so its reloads cannot land
    // inside a timing window under test.
    if (path.endsWith("/events") && holdLive)
      return new Promise<void>(() => {});
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/commands")) {
      commands.push(route.request().postDataJSON());
      return route.fulfill({ json: { data: rows[0] } });
    }
    if (path.endsWith("/alerts")) {
      feeds.push(route.request().url());
      return route.fulfill({
        json: {
          data: rows,
          meta: { total: "3", next_change_at: nextChange },
          next_cursor: null,
        },
      });
    }
    return route.fulfill({
      json: { data: [], meta: { total: "0" }, next_cursor: null },
    });
  });
  return { commands, feeds };
}

function menuFor(page: Page, message: string) {
  return {
    trigger: page.getByRole("button", {
      name: `Actions for ${message}`,
      exact: true,
    }),
    menu: page.getByRole("menu", { name: `Actions for ${message}` }),
  };
}

test("the ⋯ menu offers Dismiss on firing rows and Change dismissal on dismissed rows", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const firing = menuFor(page, "Disk usage above 95%");
  await firing.trigger.click();
  await expect(firing.menu.getByRole("menuitem")).toHaveText([
    "Assign to me",
    "Resolve",
    "Link to incident",
    "Dismiss",
  ]);
  await page.keyboard.press("Escape");
  const dismissed = menuFor(page, "Queue depth growing");
  await dismissed.trigger.click();
  await expect(dismissed.menu.getByRole("menuitem")).toHaveText([
    "Assign to me",
    "Resolve",
    "Link to incident",
    "Change dismissal",
    "Undismiss",
  ]);
  await page.keyboard.press("Escape");
  const resolved = menuFor(page, "Pod restarts");
  await resolved.trigger.click();
  await expect(resolved.menu.getByRole("menuitem")).toHaveText([
    "Assign to me",
    "Reopen",
    "Link to incident",
  ]);
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".chip-supp").filter({ hasText: "Suppressed · until 12:30" }),
  ).toHaveCount(1);
});

test("the dialog dismisses for a preset or custom duration with an optional reason", async ({
  page,
}) => {
  const { commands } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const { trigger, menu } = menuFor(page, "Disk usage above 95%");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Dismiss" }).click();
  const dialog = page.getByRole("dialog", { name: "Dismiss alert" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Disk usage above 95%");
  await expect(dialog.getByRole("radio", { name: "1 hour" })).toBeChecked();
  await expect(dialog.getByRole("status")).toContainText("(in 1 hour)");
  await expect(dialog.getByRole("status")).toContainText("returns as Firing");
  const custom = dialog.getByRole("spinbutton", { name: "Custom" });
  await expect(custom).toBeVisible();
  await custom.fill("45");
  await expect(dialog.getByRole("radio", { name: "1 hour" })).not.toBeChecked();
  await expect(dialog.getByRole("status")).toContainText("(in 45 minutes)");
  await dialog.screenshot({ path: test.info().outputPath("custom.png") });
  await dialog.getByRole("combobox", { name: "Unit" }).selectOption("days");
  await expect(dialog.getByRole("alert")).toHaveText(
    "A dismissal can last up to 30 days.",
  );
  await expect(
    dialog.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Unit" }).selectOption("minutes");
  await dialog
    .getByRole("textbox", { name: /Reason/ })
    .fill("  Known backlog  ");
  await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    kind: "set_dismissal",
    expected_revision: "4",
    value: { duration_seconds: 2700, reason: "Known backlog" },
  });
  await expect(dialog).toHaveCount(0);
});

test("until a date validates the time and Undismiss sends null", async ({
  page,
}) => {
  const { commands } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const { trigger, menu } = menuFor(page, "Queue depth growing");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Change dismissal" }).click();
  const dialog = page.getByRole("dialog", { name: "Change dismissal" });
  await expect(
    dialog.getByRole("radio", { name: "Until a date" }),
  ).toBeChecked();
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue(
    "2026-10-28",
  );
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("12:30");
  await expect(dialog).toContainText("Times are in your time zone, UTC+00:00.");
  await dialog.getByLabel("Time", { exact: true }).fill("11:00");
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose a time after now",
  );
  await dialog.getByRole("button", { name: "Monday 09:00" }).click();
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue(
    "2026-11-02",
  );
  await dialog.getByRole("button", { name: "Update dismissal" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    kind: "set_dismissal",
    expected_revision: "7",
    value: { until: "2026-11-02T09:00:00.000Z" },
  });
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Undismiss" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toMatchObject({ kind: "set_dismissal", value: null });
});

async function feedsAcrossTheEnd(page: Page, nextChange: string | null) {
  const { feeds } = await setup(page, nextChange, { holdLive: true });
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByText("Disk usage above 95%")).toBeVisible();
  // Stop just before 12:10:00 so other timers settle, then step across it.
  await page.clock.pauseAt(new Date("2026-10-28T12:09:59.200Z"));
  await page.waitForTimeout(1500);
  const before = feeds.length;
  await page.clock.runFor(1500);
  await page.waitForTimeout(1500);
  return feeds.length - before;
}

test("the Feed re-queries when the next dismissal ends", async ({
  browser,
}) => {
  // Live reconnects and polling may also query; compare like with like.
  const across = async (nextChange: string | null) => {
    const context = await browser.newContext();
    try {
      return await feedsAcrossTheEnd(await context.newPage(), nextChange);
    } finally {
      await context.close();
    }
  };
  const without = await across(null);
  const withEnd = await across("2026-10-28T12:10:00Z");
  expect(withEnd).toBeGreaterThan(without);
});

test("an empty custom field waits without an error and the dialog keeps its size", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const { trigger, menu } = menuFor(page, "Disk usage above 95%");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Dismiss" }).click();
  const dialog = page.getByRole("dialog", { name: "Dismiss alert" });
  const height = async () => (await dialog.boundingBox())!.height;
  const sizes = [await height()];
  await dialog.getByRole("spinbutton", { name: "Custom" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Enter how many minutes, hours or days to dismiss it for.",
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".dismiss-custom")).toHaveClass(/\bon\b/);
  await expect(
    dialog.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeDisabled();
  sizes.push(await height());
  await dialog.getByRole("spinbutton", { name: "Custom" }).fill("0");
  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter a whole number greater than zero.",
  );
  sizes.push(await height());
  await dialog.locator("label", { hasText: "Until a date" }).click();
  sizes.push(await height());
  await dialog.getByLabel("Date", { exact: true }).fill("2020-01-01");
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose a time after now",
  );
  sizes.push(await height());
  expect(new Set(sizes.map(Math.round)).size).toBe(1);
});
