import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-58; preset operations 3, 8 and 16.
 * A noisy preset loops the alarm while its results page shows an exact total
 * above zero. Mute lasts for the tab, a browser that blocks sound waits for a
 * click, and the editor's Sound tab saves the flag and plays a sample.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const noisy = "00000000-0000-4000-8000-000000000002";
const quiet = "00000000-0000-4000-8000-000000000003";
const me = "00000000-0000-4000-8000-000000000004";

function preset(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    revision: "3",
    name,
    cel: 'severity == "critical"',
    columns: ["severity", "message"],
    sort: [{ field: "timestamp", direction: "desc" }],
    group_by: null,
    updated_by: me,
    updated_by_display_name: "Test operator",
    updated_at: "2026-11-03T09:00:00Z",
    ...extra,
  };
}

function alert(n: number) {
  return {
    id: `00000000-0000-4000-8000-00000000010${n}`,
    revision: "1",
    message: `Disk full ${n}`,
    severity: "critical",
    status: "firing",
    display_status: "firing",
    timestamp: "2026-11-03T09:00:00Z",
  };
}

async function setup(page: Page, alerts = 3) {
  const state = { alerts, generation: 1 };
  const saves: Record<string, unknown>[] = [];
  const presets: Record<string, Record<string, unknown>> = {
    [noisy]: preset(noisy, "Night on-call", { noisy: true }),
    [quiet]: preset(quiet, "Daytime review"),
  };
  // Record the alarm instead of playing it; a test can make the browser refuse.
  await page.addInitScript(() => {
    const audio = { plays: 0, playing: false, blocked: false, src: "" };
    Object.assign(window, { __audio: audio });
    HTMLMediaElement.prototype.play = function () {
      if (audio.blocked)
        return Promise.reject(
          new DOMException("No gesture", "NotAllowedError"),
        );
      audio.plays += 1;
      audio.playing = true;
      audio.src = this.src;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      audio.playing = false;
    };
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: me, display_name: "Test operator" },
          csrf_token: "noisy-test-csrf",
          tenants: [
            {
              id: tenant,
              name: "Payments",
              kind: "managed",
              role: "edit",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: state\ndata: {"view_generation":"${state.generation}"}\n\n`,
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({
        json: { data: { view_generation: String(state.generation) } },
      });
    const id = Object.keys(presets).find((key) =>
      path.endsWith(`/presets/${key}`),
    );
    if (id && request.method() === "PUT") {
      const body = request.postDataJSON();
      saves.push(body);
      Object.assign(presets[id], body, { revision: "4" });
      return route.fulfill({ json: { data: presets[id] } });
    }
    if (id) return route.fulfill({ json: { data: presets[id] } });
    if (path.endsWith("/presets") && request.method() === "GET")
      return route.fulfill({
        json: { data: Object.values(presets), next_cursor: null },
      });
    if (path.endsWith("/presets/preview")) {
      const rows = Array.from({ length: state.alerts }, (_, i) => alert(i));
      return route.fulfill({
        json: {
          data: rows,
          meta: { total: String(rows.length) },
          next_cursor: null,
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  return { state, saves };
}

const audio = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __audio: Record<string, unknown> }).__audio,
  );

test("a noisy preset sounds while alerts match and mutes for this tab", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/tenants/${tenant}/presets`);
  const rows = page.getByRole("table", { name: "Presets" });
  await expect(
    rows.getByRole("row").filter({ hasText: "Night on-call" }),
  ).toContainText("Noisy");
  await expect(
    rows.getByRole("row").filter({ hasText: "Daytime review" }),
  ).not.toContainText("Noisy");

  await page.getByRole("link", { name: "Night on-call", exact: true }).click();
  await expect(page.getByText("Alarm playing.")).toBeVisible();
  await expect(page.getByText("3 alerts match this preset.")).toBeVisible();
  await expect.poll(async () => (await audio(page)).playing).toBe(true);
  expect(String((await audio(page)).src)).toMatch(/\.wav$/);

  await page.getByRole("button", { name: "Mute on this screen" }).click();
  await expect(page.getByText("Alarm muted on this screen.")).toBeVisible();
  expect((await audio(page)).playing).toBe(false);
  await page.getByRole("button", { name: "Unmute" }).click();
  await expect.poll(async () => (await audio(page)).playing).toBe(true);

  // Leaving the page stops the alarm.
  await page
    .getByRole("link", { name: "Presets", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Presets" })).toBeVisible();
  expect((await audio(page)).playing).toBe(false);
});

test("the alarm waits for alerts, follows the total and never sounds for a silent preset", async ({
  page,
}) => {
  const { state } = await setup(page, 0);
  await page.goto(`/tenants/${tenant}/presets/${quiet}`);
  await expect(page.getByText("0 matching alerts")).toBeVisible();
  await page.goto(`/tenants/${tenant}/presets/${noisy}`);
  await expect(page.getByText("0 matching alerts")).toBeVisible();
  await expect(page.getByText("Noisy · quiet")).toBeVisible();
  await expect(page.getByText("Alarm playing.")).toHaveCount(0);
  expect((await audio(page)).plays).toBe(0);

  state.alerts = 1;
  await page.getByRole("button", { name: "More preset actions" }).click();
  await page.getByRole("menuitem", { name: "Refresh results" }).click();
  await expect(page.getByText("1 alert matches this preset.")).toBeVisible();
  await expect.poll(async () => (await audio(page)).playing).toBe(true);

  state.alerts = 0;
  await page.getByRole("button", { name: "More preset actions" }).click();
  await page.getByRole("menuitem", { name: "Refresh results" }).click();
  await expect(page.getByText("Noisy · quiet")).toBeVisible();
  expect((await audio(page)).playing).toBe(false);
});

test("a browser that blocks sound starts the alarm on the next click", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    (window as unknown as { __audio: { blocked: boolean } }).__audio.blocked =
      true;
  });
  await page.goto(`/tenants/${tenant}/presets/${noisy}`);
  await expect(page.getByText("The alarm is waiting for sound.")).toBeVisible();
  expect((await audio(page)).playing).toBe(false);
  await page.evaluate(() => {
    (window as unknown as { __audio: { blocked: boolean } }).__audio.blocked =
      false;
  });
  await page.getByRole("button", { name: "Turn on sound" }).click();
  await expect(page.getByText("Alarm playing.")).toBeVisible();
  expect((await audio(page)).playing).toBe(true);
});

test("the Sound tab plays a sample and saves the alarm setting", async ({
  page,
}) => {
  const { saves } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${quiet}/edit`);
  const sound = page.getByRole("tab", { name: /^Sound/ });
  await sound.click();
  const toggle = page.getByRole("switch", { name: "Noisy preset" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Play sample" }).click();
  await expect(page.getByRole("button", { name: "Stop sample" })).toBeVisible();
  expect((await audio(page)).playing).toBe(true);
  await page.getByRole("button", { name: "Stop sample" }).click();
  expect((await audio(page)).playing).toBe(false);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(sound).toHaveText("Sound On");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(`/tenants/${tenant}/presets/${quiet}`);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ noisy: true, expected_revision: "3" });
  await expect(page.getByText("Alarm playing.")).toBeVisible();
});
