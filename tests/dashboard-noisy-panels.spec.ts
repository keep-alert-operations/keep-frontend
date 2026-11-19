import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * Requirements: REV-78; dashboard operations 14 and 16.
 * A noisy preset sounds on dashboards: one alarm for every unmuted noisy Alert count
 * or Alert table panel with alerts, a bell per panel that mutes it in this tab only,
 * and a status chip beside the dashboard name and in the fullscreen bar.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const me = "00000000-0000-4000-8000-000000000004";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const loudA = "00000000-0000-4000-8000-000000000021";
const loudB = "00000000-0000-4000-8000-000000000022";
const quiet = "00000000-0000-4000-8000-000000000023";
const loudTable = "00000000-0000-4000-8000-000000000024";
const presetNames: Record<string, string> = {
  [loudA]: "Payments critical",
  [loudB]: "DB errors",
  [quiet]: "All firing",
  [loudTable]: "Core network",
};

type Panel = Record<string, unknown> & { id: string; type?: string };
const at = (x: number, y: number, w = 3, h = 2) => ({ x, y, w, h });
const payments: Panel = {
  id: "00000000-0000-4000-8000-000000000031",
  preset_id: loudA,
  title: "Payments",
  thresholds: [],
  ...at(0, 0),
};
const database: Panel = {
  id: "00000000-0000-4000-8000-000000000032",
  preset_id: loudB,
  title: "Database",
  thresholds: [],
  ...at(3, 0),
};
const firing: Panel = {
  id: "00000000-0000-4000-8000-000000000033",
  preset_id: quiet,
  title: "All firing",
  thresholds: [],
  ...at(6, 0),
};
const incidents: Panel = {
  id: "00000000-0000-4000-8000-000000000034",
  type: "incident_count",
  preset_id: loudA,
  incident_status: "both",
  title: "Open incidents",
  thresholds: [],
  ...at(9, 0),
};
const notes: Panel = {
  id: "00000000-0000-4000-8000-000000000035",
  type: "html",
  html: "<p>Network · ext 4410</p>",
  title: "On-call",
  ...at(0, 2),
};
const picture: Panel = {
  id: "00000000-0000-4000-8000-000000000036",
  type: "image",
  url: "https://images.example/map.png",
  fit: "contain",
  alt: null,
  title: "Map",
  ...at(3, 2),
};
const tickets: Panel = {
  id: "00000000-0000-4000-8000-000000000037",
  type: "servicenow",
  team: "NOC",
  ticket_state: "open",
  detection: "hamal",
  title: "Tickets",
  thresholds: [],
  ...at(6, 2),
};
const grafana: Panel = {
  id: "00000000-0000-4000-8000-000000000038",
  type: "grafana",
  url: "https://grafana.example/d-solo/ck81x/checkout?orgId=1&panelId=4",
  title: "Latency",
  ...at(9, 2),
};
const network: Panel = {
  id: "00000000-0000-4000-8000-000000000039",
  type: "table",
  preset_id: loudTable,
  title: "Core network",
  rows: 3,
  ...at(0, 4, 12, 6),
};

type Sound = "ok" | "blocked" | "failed";

async function setup(
  page: Page,
  options: {
    role: "view" | "edit";
    panels: Panel[];
    counts?: Record<string, string>;
    totals?: Record<string, number>;
    sound?: Sound;
  },
) {
  const state = {
    definition: {
      id,
      name: "NOC overview",
      revision: "3",
      panels: options.panels,
    },
    noisy: {
      [loudA]: true,
      [loudB]: true,
      [quiet]: false,
      [loudTable]: true,
    } as Record<string, boolean>,
    counts: { ...options.counts } as Record<string, string>,
    totals: { ...options.totals } as Record<string, number>,
    countStatus: 200,
    hold: undefined as Promise<void> | undefined,
    previewDelay: 0,
    requests: [] as string[],
  };
  // Record the alarm instead of playing it: instances, play() calls and how many
  // elements are playing. A test can make the browser refuse or fail to play.
  await page.addInitScript((sound: Sound) => {
    const audio = {
      mode: sound,
      instances: 0,
      calls: 0,
      elements: [] as HTMLMediaElement[],
    };
    Object.assign(window, { __audio: audio });
    const Native = window.Audio;
    window.Audio = class extends Native {
      constructor(src?: string) {
        super(src);
        audio.instances += 1;
        audio.elements.push(this);
      }
    };
    const playing = new WeakSet<HTMLMediaElement>();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return !playing.has(this);
      },
    });
    HTMLMediaElement.prototype.play = function () {
      audio.calls += 1;
      if (audio.mode === "blocked")
        return Promise.reject(
          new DOMException("No gesture", "NotAllowedError"),
        );
      if (audio.mode === "failed")
        return Promise.reject(
          new DOMException("No decoder", "NotSupportedError"),
        );
      playing.add(this);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      playing.delete(this);
    };
    // Keep the live stream open so it never reconnects during a test.
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).endsWith("/events"))
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: state\ndata: {"view_generation":"1"}\n\n',
                  ),
                );
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      return fetch(input, init);
    };
  }, options.sound ?? "ok");
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))
      state.requests.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("https://images.example/**", (route) => route.abort());
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: me, display_name: "Synthetic operator" },
          csrf_token: "noisy-dashboard-csrf",
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: options.role,
              kind: "specific",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  const preset = (key: string) => ({
    id: key,
    name: presetNames[key],
    revision: "1",
    noisy: state.noisy[key],
    cel: "true",
    columns: ["severity", "message", "timestamp"],
    sort: [{ field: "timestamp", direction: "desc" }],
    group_by: null,
  });
  await page.route("**/api/tenants/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (path.endsWith("/health"))
      return route.fulfill({
        json: { data: { committed_seq: "1", searchable_seq: "1" } },
      });
    if (path.endsWith("/grafana-panels/status"))
      return route.fulfill({
        json: { data: { enabled: false, origins: [] }, meta: {} },
      });
    if (path.endsWith("/ticket-counts/status"))
      return route.fulfill({ json: { data: { configured: false } } });
    if (path === api)
      return route.fulfill({ json: { data: state.definition } });
    // One retained revision, so the history view can open it as a draft.
    if (path === `${api}/history`)
      return route.fulfill({
        json: {
          data: [
            {
              revision: "2",
              recorded_at: "2026-11-18T10:00:00Z",
              definition_available: true,
              activity_available: false,
            },
          ],
          next_cursor: null,
        },
      });
    if (path === `${api}/history/2`)
      return route.fulfill({
        json: {
          data: {
            definition: { ...state.definition, revision: "2" },
            before_definition: { ...state.definition, revision: "1" },
            activity: null,
          },
        },
      });
    if (path === `${api}/counts`) {
      await state.hold;
      // A refusal makes the page re-read its session and count again; later
      // counts wait, so the test sees one refusal instead of a retry loop.
      if (state.countStatus === 403) state.hold = new Promise(() => {});
      if (state.countStatus !== 200)
        return route.fulfill({
          status: state.countStatus,
          json: {
            error: {
              code: state.countStatus === 404 ? "not_found" : "unavailable",
              message:
                state.countStatus === 404
                  ? "Resource unavailable."
                  : "Search unavailable",
            },
          },
        });
      const counted = state.definition.panels.filter((panel) =>
        ["count", "incident_count"].includes(panel.type ?? "count"),
      );
      return route.fulfill({
        json: {
          data: {
            observation_id: `observation-${state.requests.length}`,
            dashboard_revision: state.definition.revision,
            preset_revisions: Object.fromEntries(
              counted.map((panel) => [panel.preset_id, "1"]),
            ),
            evaluated_at: "2026-11-19T10:00:00Z",
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: counted.map((panel) => {
              const key = String(panel.preset_id);
              return {
                panel_id: panel.id,
                preset_id: key,
                preset_name: presetNames[key],
                preset_noisy: state.noisy[key],
                ...(panel.type === "incident_count"
                  ? { count: "4", alerts: "9", linked_alerts: "6" }
                  : { count: state.counts[key] ?? "0" }),
              };
            }),
          },
        },
      });
    }
    if (path.endsWith("/presets/preview")) {
      const body = request.postDataJSON();
      if (state.previewDelay)
        await new Promise((resolve) => setTimeout(resolve, state.previewDelay));
      const total = state.totals[body.preset_id] ?? 0;
      const rows = Array.from(
        { length: Math.min(total, Number(body.limit)) },
        (_, n) => ({
          id: `00000000-0000-4000-8000-00000000010${n}`,
          revision: "1",
          message: `BGP session down ${n}`,
          severity: "critical",
          status: "firing",
          display_status: "firing",
          timestamp: "2026-11-19T09:58:00Z",
        }),
      );
      return route.fulfill({
        json: {
          data: rows,
          meta: {
            total: String(total),
            applied: {
              definition: preset(body.preset_id),
            },
          },
          next_cursor: null,
        },
      });
    }
    const presetId = Object.keys(presetNames).find((key) =>
      path.endsWith(`/presets/${key}`),
    );
    if (presetId) return route.fulfill({ json: { data: preset(presetId) } });
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: { data: Object.keys(presetNames).map(preset), next_cursor: null },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

async function sound(page: Page) {
  return page.evaluate(() => {
    const audio = (
      window as unknown as {
        __audio: {
          instances: number;
          calls: number;
          elements: HTMLMediaElement[];
        };
      }
    ).__audio;
    return {
      instances: audio.instances,
      calls: audio.calls,
      playing: audio.elements.filter((element) => !element.paused).length,
    };
  });
}

const setSound = (page: Page, mode: Sound) =>
  page.evaluate((value) => {
    (window as unknown as { __audio: { mode: string } }).__audio.mode = value;
  }, mode);

/** The alarm chip beside the dashboard's name. */
const header = (page: Page) => page.locator(".page-title [data-alarm-state]");
const bell = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name: `Mute ${name}`, exact: true });

/** Requests other than the live stream's own reads. */
const sent = (requests: string[]) =>
  requests.filter(
    (item) =>
      !/^GET .*\/(events|view-state|health)$/.test(item) &&
      item !== "GET /auth/session",
  );

for (const role of ["view", "edit"] as const) {
  test(`two noisy panels make one sound and each bell mutes only its panel (${role})`, async ({
    page,
  }) => {
    const state = await setup(page, {
      role,
      panels: [payments, database, firing, incidents],
      counts: { [loudA]: "12", [loudB]: "3", [quiet]: "40" },
    });
    const status = header(page);
    await expect(status).toContainText("Alarm playing · 2 panels");
    await expect(
      status.getByRole("button", { name: "Mute all" }),
    ).toBeVisible();
    await expect
      .poll(() => sound(page))
      .toEqual({ instances: 1, calls: 1, playing: 1 });
    const bellA = bell(page, "Payments");
    const bellB = bell(page, "Database");
    await expect(bellA).toHaveAttribute("aria-pressed", "false");
    await expect(bellA).toHaveAttribute("data-bell-state", "sounding");
    await expect(bellB).toHaveAttribute("data-bell-state", "sounding");
    // Only noisy Alert count panels have bells: not the quiet preset, and not the
    // incident count on a noisy preset.
    await expect(page.locator(".pn-bell")).toHaveCount(2);
    if (role === "edit") {
      // The bell ends the title row, beside the layout tile's options menu.
      const options = page.getByRole("button", {
        name: "Options for Payments",
        exact: true,
      });
      const [ring, menu] = await Promise.all([
        bellA.boundingBox(),
        options.boundingBox(),
      ]);
      expect(ring!.x + ring!.width).toBeLessThanOrEqual(menu!.x);
      expect(Math.abs(ring!.y - menu!.y)).toBeLessThan(12);
    }

    // Let the page's own first live refresh finish, so only the mutes are measured.
    await expect
      .poll(
        async () => {
          const seen = state.requests.length;
          await page.waitForTimeout(1500);
          return state.requests.length - seen;
        },
        { timeout: 15000 },
      )
      .toBe(0);
    const url = page.url();
    const before = state.requests.length;
    await bellA.click();
    await expect(bellA).toHaveAttribute("aria-pressed", "true");
    await expect(bellA).toHaveAttribute("data-bell-state", "muted");
    // A muted bell is an icon only.
    await expect(bellA).toHaveText("");
    expect(page.url()).toBe(url);
    await expect(status).toContainText("Alarm playing · 1 panel");
    await expect(bellB).toHaveAttribute("aria-pressed", "false");
    expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });

    // Muting the last sounding panel stops the alarm.
    await bellB.click();
    await expect(status).toContainText("Alarm muted · 2 panels have alerts");
    await expect.poll(async () => (await sound(page)).playing).toBe(0);
    // Muting is local to this tab: nothing is sent.
    await page.waitForTimeout(500);
    expect(sent(state.requests.slice(before))).toEqual([]);
    expect(page.url()).toBe(url);

    await status.getByRole("button", { name: "Unmute all" }).click();
    await expect(status).toContainText("Alarm playing · 2 panels");
    await expect.poll(async () => (await sound(page)).playing).toBe(1);
    await expect(bellA).toHaveAttribute("aria-pressed", "false");
    await expect(bellB).toHaveAttribute("aria-pressed", "false");

    await status.getByRole("button", { name: "Mute all" }).click();
    await expect(bellA).toHaveAttribute("aria-pressed", "true");
    await expect(bellB).toHaveAttribute("aria-pressed", "true");
    await expect(status).toContainText("Alarm muted · 2 panels have alerts");
    await expect.poll(async () => (await sound(page)).playing).toBe(0);
    expect((await sound(page)).instances).toBe(1);
  });
}

test("a quiet noisy panel shows a grey bell, other panels have none, and failures keep the last state", async ({
  page,
}) => {
  const state = await setup(page, {
    role: "view",
    panels: [payments, firing, incidents, notes, picture, tickets, grafana],
    counts: { [loudA]: "0", [quiet]: "40" },
  });
  const status = header(page);
  await expect(status).toContainText("Alarm · quiet");
  await expect(status.getByRole("button")).toHaveCount(0);
  const bellA = bell(page, "Payments");
  await expect(bellA).toHaveAttribute("data-bell-state", "quiet");
  await expect(bellA).toHaveAttribute("aria-pressed", "false");
  // Non-noisy, incident count, HTML, image, ServiceNow and Grafana panels have none.
  await expect(page.locator(".pn-bell")).toHaveCount(1);
  for (const name of ["Open incidents count", "On-call", "Map", "Latency"])
    await expect(
      page.getByRole("article", { name, exact: true }).locator(".pn-bell"),
    ).toHaveCount(0);
  expect(await sound(page)).toEqual({ instances: 0, calls: 0, playing: 0 });

  state.counts[loudA] = "5";
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(status).toContainText("Alarm playing · 1 panel");
  await expect(bellA).toHaveAttribute("data-bell-state", "sounding");
  await expect
    .poll(() => sound(page))
    .toEqual({
      instances: 1,
      calls: 1,
      playing: 1,
    });

  // A failed batch keeps the last state; it never counts as zero.
  state.countStatus = 503;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Search unavailable" }),
  ).toBeVisible();
  await expect(status).toContainText("Alarm playing · 1 panel");
  await expect(bellA).toHaveAttribute("data-bell-state", "sounding");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });

  // So does a batch still loading.
  state.countStatus = 200;
  state.counts[loudA] = "0";
  let release = () => {};
  state.hold = new Promise((resolve) => (release = resolve));
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await page.waitForTimeout(500);
  await expect(status).toContainText("Alarm playing · 1 panel");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
  release();
  await expect(status).toContainText("Alarm · quiet");
  await expect(bellA).toHaveAttribute("data-bell-state", "quiet");
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
});

test("an alert table panel on a noisy preset sounds while alerts match", async ({
  page,
}) => {
  const state = await setup(page, {
    role: "view",
    panels: [network],
    totals: { [loudTable]: 7 },
  });
  const panel = page.getByRole("article", {
    name: "Core network",
    exact: true,
  });
  await expect(panel).toContainText("Showing 3 of 7 matching alerts");
  const status = header(page);
  await expect(status).toContainText("Alarm playing · 1 panel");
  await expect(bell(panel, "Core network")).toHaveAttribute(
    "data-bell-state",
    "sounding",
  );
  await expect
    .poll(() => sound(page))
    .toEqual({
      instances: 1,
      calls: 1,
      playing: 1,
    });

  state.totals[loudTable] = 0;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(panel).toContainText("No alerts match this preset");
  await expect(bell(panel, "Core network")).toHaveAttribute(
    "data-bell-state",
    "quiet",
  );
  await expect(status).toContainText("Alarm · quiet");
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
});

test("a browser that refuses sound waits for a click", async ({ page }) => {
  await setup(page, {
    role: "view",
    panels: [payments, database],
    counts: { [loudA]: "12", [loudB]: "3" },
    sound: "blocked",
  });
  const status = header(page);
  await expect(status).toContainText("Alarm waiting for a click · 2 panels");
  expect((await sound(page)).playing).toBe(0);
  await setSound(page, "ok");
  await status.getByRole("button", { name: "Turn on sound" }).click();
  await expect(status).toContainText("Alarm playing · 2 panels");
  await expect.poll(async () => (await sound(page)).playing).toBe(1);
  expect((await sound(page)).instances).toBe(1);
});

test("a browser that cannot play the alarm says so and keeps the bells", async ({
  page,
}) => {
  await setup(page, {
    role: "view",
    panels: [payments, database],
    counts: { [loudA]: "12", [loudB]: "3" },
    sound: "failed",
  });
  await expect(header(page)).toContainText(
    "Alarm can't play in this browser · 2 panels",
  );
  await expect(header(page).getByRole("button")).toHaveCount(0);
  // Bells still show which panels have alerts.
  await expect(bell(page, "Payments")).toHaveAttribute(
    "data-bell-state",
    "sounding",
  );
});

test("fullscreen shows the same alarm and bells without restarting the sound", async ({
  page,
}) => {
  await setup(page, {
    role: "view",
    panels: [payments, database],
    counts: { [loudA]: "12", [loudB]: "3" },
  });
  await expect(header(page)).toContainText("Alarm playing · 2 panels");
  await expect
    .poll(() => sound(page))
    .toEqual({
      instances: 1,
      calls: 1,
      playing: 1,
    });
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "NOC overview" });
  const inside = dialog.locator("[data-alarm-state]");
  await expect(inside).toContainText("Alarm playing · 2 panels");
  await expect(inside.getByRole("button", { name: "Mute all" })).toBeVisible();
  await bell(dialog, "Payments").click();
  await expect(bell(dialog, "Payments")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(inside).toContainText("Alarm playing · 1 panel");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
  await dialog.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(dialog).toBeHidden();
  // The mute outlives the remounted tiles.
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  await expect(bell(page, "Payments")).toHaveAttribute("aria-pressed", "true");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
});

test("fullscreen keeps a sounding table panel's alarm while its rows reload", async ({
  page,
}) => {
  const state = await setup(page, {
    role: "view",
    panels: [network],
    totals: { [loudTable]: 7 },
  });
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  await expect
    .poll(() => sound(page))
    .toEqual({
      instances: 1,
      calls: 1,
      playing: 1,
    });
  // The remounted table reads its rows again; meanwhile the alarm goes on.
  state.previewDelay = 1500;
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "NOC overview" });
  await expect(dialog.locator("[data-alarm-state]")).toContainText(
    "Alarm playing · 1 panel",
  );
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
  await expect(
    dialog.getByRole("article", { name: "Core network", exact: true }),
  ).toContainText("Showing 3 of 7 matching alerts");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
  await dialog.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect(dialog).toBeHidden();
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
  await expect(
    page.getByRole("article", { name: "Core network", exact: true }),
  ).toContainText("Showing 3 of 7 matching alerts");
  expect(await sound(page)).toEqual({ instances: 1, calls: 1, playing: 1 });
});

test("a mute lasts through zero and back, and a reload starts unmuted", async ({
  page,
}) => {
  const state = await setup(page, {
    role: "view",
    panels: [payments],
    counts: { [loudA]: "7" },
  });
  const status = header(page);
  const bellA = bell(page, "Payments");
  await expect(status).toContainText("Alarm playing · 1 panel");
  await bellA.click();
  await expect(status).toContainText("Alarm muted · 1 panel has alerts");
  await expect(bellA).toHaveAttribute(
    "title",
    "Muted on this screen while 7 alerts match · click to unmute",
  );

  state.counts[loudA] = "0";
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(
    page.getByRole("article", { name: "Payments count" }),
  ).toContainText("0");
  await expect(status).toContainText("Alarm · quiet");
  await expect(bellA).toHaveAttribute("aria-pressed", "true");

  state.counts[loudA] = "3";
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(status).toContainText("Alarm muted · 1 panel has alerts");
  await expect(bellA).toHaveAttribute("aria-pressed", "true");
  expect((await sound(page)).playing).toBe(0);

  // Leaving the dashboard and coming back in the same tab keeps the mute.
  await page
    .getByRole("navigation", { name: "Tenant navigation" })
    .getByRole("link", { name: "Dashboards" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dashboards", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(header(page)).toContainText("Alarm muted · 1 panel has alerts");
  await expect(bell(page, "Payments")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  expect((await sound(page)).playing).toBe(0);

  await page.reload();
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  await expect(bell(page, "Payments")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await sound(page)).playing).toBe(1);
});

test("the alarm never moves panels, and dialog previews, history and the list stay silent", async ({
  page,
}) => {
  await setup(page, {
    role: "edit",
    panels: [payments, database, firing],
    counts: { [loudA]: "12", [loudB]: "3", [quiet]: "40" },
  });
  const status = header(page);
  await expect(status).toContainText("Alarm playing · 2 panels");
  const boxes = () =>
    page
      .locator(".de-grid > .pn")
      .evaluateAll((panels) =>
        panels.map((panel) => panel.getBoundingClientRect().toJSON()),
      );
  const playing = await boxes();
  await status.getByRole("button", { name: "Mute all" }).click();
  await expect(status).toContainText("Alarm muted · 2 panels have alerts");
  expect(await boxes()).toEqual(playing);
  await status.getByRole("button", { name: "Unmute all" }).click();
  await expect(status).toContainText("Alarm playing · 2 panels");
  expect(await boxes()).toEqual(playing);
  await expect(
    page.getByRole("article", { name: "Payments count" }),
  ).toContainText("12");

  // The panel dialog's preview never sounds and has no bell: no new audio and no
  // new play() while it is open.
  await expect.poll(async () => (await sound(page)).playing).toBe(1);
  const before = await sound(page);
  await page
    .getByRole("button", { name: "Options for Payments", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Edit panel/ }).click();
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("article").first()).toBeVisible();
  await expect(dialog.locator(".pn-bell")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await sound(page)).toEqual({ ...before, instances: 1 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // History and its restore draft, reached in the same document so the audio
  // counters carry over: leaving the dashboard stops the alarm, and the draft of
  // a retained revision (two noisy panels with alerts) never starts it.
  await page
    .getByRole("button", { name: "More dashboard actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}/history$`));
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
  const left = await sound(page);
  expect(left.instances).toBe(1);
  await page
    .getByRole("button", { name: "Use this revision", exact: true })
    .click();
  await expect(page.getByText("Draft from retained revision 2.")).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Payments count" }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator(".pn-bell")).toHaveCount(0);
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  expect(await sound(page)).toEqual(left);

  // The list, also reached in the same document, stays silent.
  await page
    .getByRole("link", { name: "Dashboards", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Dashboards", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  expect(await sound(page)).toEqual(left);
});

test("a draft that deletes or repoints a sounding panel stops its part", async ({
  page,
}) => {
  await setup(page, {
    role: "edit",
    panels: [payments, database],
    counts: { [loudA]: "12", [loudB]: "3" },
  });
  const status = header(page);
  await expect(status).toContainText("Alarm playing · 2 panels");
  await page
    .getByRole("button", { name: "Options for Payments", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete panel", exact: true })
    .click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(status).toContainText("Alarm playing · 1 panel");
  expect((await sound(page)).playing).toBe(1);

  await page
    .getByRole("button", { name: "Options for Database", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Edit panel/ }).click();
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await dialog.getByRole("combobox", { name: "Preset", exact: true }).click();
  await dialog.getByRole("option", { name: "All firing" }).click();
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  // The draft's panel no longer shows the counted preset, so it stops sounding.
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  await expect(page.locator(".pn-bell")).toHaveCount(0);
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
});

test("a deleted dashboard stops sounding", async ({ page }) => {
  const state = await setup(page, {
    role: "view",
    panels: [payments],
    counts: { [loudA]: "12" },
  });
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  await expect.poll(async () => (await sound(page)).playing).toBe(1);
  state.countStatus = 404;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  await expect(page.locator(".pn-bell")).toHaveCount(0);
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
});

test("a denied dashboard stops sounding", async ({ page }) => {
  const state = await setup(page, {
    role: "view",
    panels: [payments],
    counts: { [loudA]: "12" },
  });
  await expect(header(page)).toContainText("Alarm playing · 1 panel");
  await expect.poll(async () => (await sound(page)).playing).toBe(1);
  state.countStatus = 403;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  await expect(page.locator(".pn-bell")).toHaveCount(0);
  await expect.poll(async () => (await sound(page)).playing).toBe(0);
  // It stays silent while the next count is pending.
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-alarm-state]")).toHaveCount(0);
  expect((await sound(page)).playing).toBe(0);
});
