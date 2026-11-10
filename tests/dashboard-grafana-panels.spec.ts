import { expect, test, type Page } from "@playwright/test";

// Requirements: REV-68; dashboard operations 2, 3, 14 and 16.
const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const grafana = "https://grafana.ops.example.test";
const good = `${grafana}/d-solo/ck81x/checkout?orgId=1&from=now-6h&to=now&refresh=1m&var-env=prod&panelId=4`;
const embed = `<iframe src="${good.replace(/&/g, "&amp;")}" width="450" height="200" frameborder="0"></iframe>`;
const origins = [
  { origin: grafana, path_prefix: "" },
  { origin: "https://tools.example.test", path_prefix: "/grafana" },
];

const gf = (
  n: number,
  url: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-00000000005${n}`,
  type: "grafana",
  title: null,
  url,
  x: 6 * (n % 2),
  y: 6 * Math.floor(n / 2),
  w: 6,
  h: 6,
  link: null,
  ...extra,
});
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 20,
  w: 3,
  h: 2,
  thresholds: [],
};

async function setup(
  page: Page,
  panels: Record<string, unknown>[],
  options: {
    enabled?: boolean;
    role?: string;
    superAdmin?: boolean;
    path?: string;
    /** Milliseconds Grafana takes to answer a framed panel. */
    frameDelay?: number;
    integration?: Record<string, unknown>;
    saveError?: { status: number; json: unknown };
  } = {},
) {
  const enabled = options.enabled ?? true;
  const state = {
    definition: { id, name: "Checkout health", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    counted: [] as string[][],
    frames: [] as string[],
    statuses: 0,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "grafana-csrf",
          global_super_admin: options.superAdmin ?? false,
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: options.role ?? (options.superAdmin ? "admin" : "edit"),
              kind: "specific",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  // The synthetic Grafana: a page that shows which theme it was asked for.
  await page.route(
    /^https:\/\/(grafana\.ops|tools)\.example\.test\//,
    async (route) => {
      state.frames.push(route.request().url());
      if (options.frameDelay)
        await new Promise((resolve) => setTimeout(resolve, options.frameDelay));
      const theme = new URL(route.request().url()).searchParams.get("theme");
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><body style="margin:0;font:12px sans-serif"><p id="g">Grafana panel · ${theme}</p></body>`,
      });
    },
  );
  await page.route("**/api/admin/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/integrations/grafana-panels")
      return route.fulfill({
        json: {
          data: options.integration ?? {
            enabled,
            origins: enabled ? origins : [],
            ignored: [],
          },
          meta: {},
        },
      });
    if (path === "/api/admin/integrations/ticket-count")
      return route.fulfill({
        json: {
          data: {
            configured: false,
            host: null,
            last_success_at: null,
            last_failure_at: null,
            last_error: null,
          },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.route("**/api/tenants/**", async (route) => {
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
        json: { data: { committed_seq: "1", searchable_seq: "1" } },
      });
    if (path === `/api/tenants/${tenant}/grafana-panels/status`) {
      state.statuses += 1;
      return route.fulfill({
        json: {
          data: { enabled, origins: enabled ? origins : [] },
          meta: {},
        },
      });
    }
    if (path === `/api/tenants/${tenant}/ticket-counts/status`)
      return route.fulfill({ json: { data: { configured: true } } });
    if (path === api) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        state.saves.push(body);
        if (options.saveError) return route.fulfill(options.saveError);
        state.definition = {
          ...state.definition,
          panels: body.panels,
          revision: "4",
        };
      }
      return route.fulfill({ json: { data: state.definition } });
    }
    if (path === `${api}/counts`) {
      const counted = (
        state.definition.panels as { id: string; type?: string }[]
      ).filter((item) => (item.type ?? "count") === "count");
      state.counted.push(counted.map((item) => item.id));
      return route.fulfill({
        json: {
          data: {
            observation_id: "grafana-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-10T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: counted.map((item) => ({
              panel_id: item.id,
              preset_id: preset,
              preset_name: "Critical alerts",
              count: "4",
            })),
          },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(options.path ?? `/tenants/${tenant}/dashboards/${id}`);
  return state;
}

async function openCreate(page: Page) {
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const type = dialog.getByRole("button", { name: /Panel type/ });
  return { dialog, type };
}
async function chooseGrafana(page: Page) {
  const { dialog, type } = await openCreate(page);
  await type.click();
  await dialog.getByRole("option", { name: /Grafana panel/ }).click();
  await expect(type).toContainText("Grafana panel");
  const address = dialog.getByRole("textbox", { name: "Panel address" });
  return { dialog, type, address };
}
const sandbox =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

test("Grafana panel is listed last and is unavailable while no Grafana is allowed", async ({
  page,
}) => {
  // Requirements: REV-68 sections 1 and 3; dashboard operations 2 and 16.
  await setup(page, [count], { enabled: false });
  const { dialog, type } = await openCreate(page);
  await type.click();
  const options = dialog.getByRole("option");
  await expect(options.last()).toContainText("Grafana panel");
  const option = dialog.getByRole("option", { name: /Grafana panel/ });
  await expect(option).toHaveAttribute("aria-disabled", "true");
  await expect(option).toContainText(
    "Not available. An admin allows Grafana addresses in deployment configuration.",
  );
  await option.click({ force: true });
  await expect(type).toContainText("Alert count");
});

test("an editor creates a Grafana panel from embed code and saves its parsed address", async ({
  page,
}) => {
  // Requirements: REV-68 sections 2, 5 and 8; dashboard operations 3 and 14.
  const state = await setup(page, [count]);
  const { dialog, type } = await openCreate(page);
  await type.click();
  const option = dialog.getByRole("option", { name: /Grafana panel/ });
  await expect(option).toContainText(
    "One live panel from a Grafana dashboard.",
  );
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await option.click();
  await expect(dialog.getByLabel("Title (optional)")).toHaveValue("");
  await expect(dialog).toContainText(
    "Grafana already shows the panel's own title. Leave this blank so it isn't shown twice.",
  );
  // Empty: nothing is framed and the panel can't be created yet.
  await expect(dialog).toContainText("Paste a panel address to see it here.");
  await expect(dialog).toContainText("Shown at the new panel size, 6 × 6.");
  const create = dialog.getByRole("button", {
    name: "Create panel",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: 'Add "Open in Grafana" link' }),
  ).toBeDisabled();
  await expect(dialog).toContainText(
    "Allowed Grafana: grafana.ops.example.test, tools.example.test/grafana.",
  );
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);

  await dialog.getByRole("textbox", { name: "Panel address" }).fill(embed);
  await expect(
    dialog.getByRole("status").filter({ hasText: "Using" }),
  ).toHaveText(`Using ${good}`);
  const facts = dialog.locator("dl");
  await expect(facts).toContainText("Grafanagrafana.ops.example.test");
  await expect(facts).toContainText("Dashboardcheckout (ck81x)");
  await expect(facts).toContainText("Panel#4 · org 1");
  await expect(facts).toContainText("Time rangeLast 6 hours");
  await expect(facts).toContainText("RefreshEvery 1m");
  await expect(facts).toContainText("Variablesenv = prod");
  await expect(dialog).toContainText(
    "Live from Grafana, shown at the new panel size, 6 × 6.",
  );
  await expect(dialog).toContainText("Blank or asking to sign in?");
  const frame = dialog.locator("iframe");
  await expect(frame).toHaveAttribute("src", `${good}&theme=light`);
  await expect(frame).toHaveAttribute("sandbox", sandbox);
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("title", "Grafana panel");

  await create.click();
  await expect(dialog).toBeHidden();
  const tile = page.getByRole("article", {
    name: "Grafana panel",
    exact: true,
  });
  await expect(tile.locator("iframe")).toHaveAttribute(
    "src",
    `${good}&theme=light`,
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "grafana",
  );
  expect(saved).toMatchObject({
    type: "grafana",
    title: null,
    url: good,
    w: 6,
    h: 6,
    link: null,
  });
  expect(saved).not.toHaveProperty("preset_id");
  // Grafana panels are never part of count batches.
  await expect
    .poll(() => state.counted.at(-1))
    .toEqual(["00000000-0000-4000-8000-000000000030"]);
});

test("the dialog reports the first broken address rule", async ({ page }) => {
  // Requirements: REV-68 section 4 (browser checks 2-11).
  await setup(page, [count]);
  const { dialog, address } = await chooseGrafana(page);
  const error = dialog.getByRole("alert");
  const cases: [string, string][] = [
    [
      "<p>No frame here</p>",
      "No Grafana address found in that code. Copy it again from Share › Embed.",
    ],
    ["grafana dashboard", "This isn't a valid address."],
    [
      "ftp://grafana.ops.example.test/d-solo/a/b",
      "The address must start with https://.",
    ],
    [
      "https:grafana.ops.example.test/d-solo/a/b",
      "The address must start with https://.",
    ],
    [
      "http://127.0.0.1:3447/d-solo/a/b",
      "Keep's own pages can't be shown in a Grafana panel.",
    ],
    [
      // Credentials are reported before the allowlist.
      "https://admin:s3cret@grafana-old.example.test/d-solo/a/b?panelId=4",
      "Remove the user name and password. The address is saved in the dashboard, where everyone could read it.",
    ],
    [
      "https://grafana-old.example.test/d-solo/ck81x/checkout?orgId=1&panelId=4",
      "grafana-old.example.test isn't an allowed Grafana.",
    ],
    [
      `${grafana}/d/ck81x/checkout?orgId=1&viewPanel=4`,
      "Use a single-panel address from Share › Embed. Whole dashboards can't be shown.",
    ],
    [
      `${good}&x=${"a".repeat(2050)}`,
      "The address is longer than 2,048 characters.",
    ],
  ];
  for (const [text, message] of cases) {
    await address.fill(text);
    await expect(error).toHaveText(message);
    await expect(address).toHaveAttribute("aria-invalid", "true");
    const preview = dialog.getByRole("article", {
      name: "Grafana panel, blocked",
    });
    await expect(preview).toContainText("Grafana panel blocked");
    await expect(preview).toContainText(message);
    await expect(preview.locator("iframe")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Create panel", exact: true }),
    ).toBeDisabled();
  }
  await address.fill(good);
  await expect(error).toHaveCount(0);
  await expect(dialog.locator("iframe")).toHaveCount(1);
  // A plain address shows no "Using" line.
  await expect(dialog.getByText(/^Using /)).toHaveCount(0);
});

test("Add Open in Grafana link fills the panel link with the dashboard view", async ({
  page,
}) => {
  // Requirements: REV-68 section 2 (with REV-66); dashboard operations 3.
  const state = await setup(page, [count]);
  const { dialog, address } = await chooseGrafana(page);
  await address.fill(good);
  await dialog
    .getByRole("button", { name: 'Add "Open in Grafana" link' })
    .click();
  const view = `${grafana}/d/ck81x/checkout?orgId=1&from=now-6h&to=now&refresh=1m&var-env=prod&viewPanel=4`;
  await expect(dialog.getByLabel("Link (optional)")).toHaveValue(view);
  await expect(dialog.getByLabel("Button text (optional)")).toHaveValue(
    "Open in Grafana",
  );
  await expect(
    dialog.getByRole("status").filter({ hasText: "Link added to Panel link" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: 'Add "Open in Grafana" link' }),
  ).toHaveCount(0);
  // The preview shows the link over the untitled frame.
  await expect(
    dialog.getByRole("link", { name: "Open in Grafana (opens in a new tab)" }),
  ).toHaveAttribute("href", view);
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  const tile = page.getByRole("article", {
    name: "Grafana panel",
    exact: true,
  });
  await expect(
    tile.getByRole("link", { name: "Open in Grafana (opens in a new tab)" }),
  ).toHaveAttribute("href", view);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "grafana",
  );
  expect(saved?.link).toEqual({ url: view, label: "Open in Grafana" });
});

test("the board frames allowed panels in the viewer's Keep theme and keeps them on refresh", async ({
  page,
}) => {
  // Requirements: REV-68 sections 2 and 5; dashboard operations 3 and 14.
  const state = await setup(
    page,
    [
      gf(0, `${good}&theme=dark`),
      gf(
        1,
        `https://tools.example.test/grafana/d-solo/s2/orders?orgId=3&panelId=2`,
        {
          title: "Orders per minute",
          link: {
            url: "https://tools.example.test/grafana/d/s2/orders",
            label: "Open in Grafana",
          },
        },
      ),
      count,
    ],
    { role: "view" },
  );
  const bare = page.getByRole("article", {
    name: "Grafana panel",
    exact: true,
  });
  const frame = bare.locator("iframe");
  // The saved theme is replaced by the viewer's.
  await expect(frame).toHaveAttribute("src", `${good}&theme=light`);
  await expect(frame).toHaveAttribute("sandbox", sandbox);
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("loading", "lazy");
  expect(await frame.getAttribute("sandbox")).not.toContain(
    "allow-top-navigation",
  );
  await expect(bare).toHaveAttribute("data-grafana-state", "ready");
  await expect(
    page
      .frameLocator('article[aria-label="Grafana panel"] iframe')
      .locator("#g"),
  ).toHaveText("Grafana panel · light");

  const titled = page.getByRole("article", { name: "Orders per minute" });
  await expect(titled.locator(".pn-head")).toContainText("Orders per minute");
  await expect(titled.locator("iframe")).toHaveAttribute(
    "title",
    "Orders per minute",
  );
  await expect(
    titled.locator(".pn-head").getByRole("link", { name: /Open in Grafana/ }),
  ).toBeVisible();

  // Dark mode switches the frames to Grafana's dark theme.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(frame).toHaveAttribute("src", `${good}&theme=dark`);
  await expect(
    page
      .frameLocator('article[aria-label="Grafana panel"] iframe')
      .locator("#g"),
  ).toHaveText("Grafana panel · dark");

  // Refresh counts reloads counts, not frames, and doesn't read the status again.
  await expect(bare).toHaveAttribute("data-grafana-state", "ready");
  const frames = state.frames.length;
  const statuses = state.statuses;
  const batches = state.counted.length;
  await page.getByRole("button", { name: "Refresh counts" }).click();
  await expect.poll(() => state.counted.length).toBeGreaterThan(batches);
  await page.waitForTimeout(400);
  expect(state.frames.length).toBe(frames);
  expect(state.statuses).toBe(statuses);
});

test("a frame shows a loading placeholder until Grafana answers", async ({
  page,
}) => {
  // Requirements: REV-68 section 5 (loading).
  await setup(page, [gf(0, good)], { frameDelay: 1500, role: "view" });
  const tile = page.getByRole("article", { name: "Grafana panel" });
  await expect(tile).toHaveAttribute("aria-busy", "true");
  await expect(tile.getByRole("status")).toHaveText("Loading from Grafana…");
  await expect(tile).toHaveAttribute("data-grafana-state", "ready");
  await expect(tile.getByText("Loading from Grafana…")).toHaveCount(0);
});

test("panels that are no longer allowed are blocked, with Edit panel for editors", async ({
  page,
}) => {
  // Requirements: REV-68 sections 3 and 4 (render-time check); dashboard operations 3.
  const old =
    "https://grafana-old.example.test/d-solo/ck81x/checkout?orgId=1&panelId=4";
  const state = await setup(page, [gf(0, old), gf(1, good)]);
  const blocked = page.getByRole("article", { name: "Grafana panel, blocked" });
  await expect(blocked).toContainText("Grafana panel blocked");
  await expect(blocked).toContainText(
    "grafana-old.example.test isn't an allowed Grafana.",
  );
  await expect(blocked.locator("iframe")).toHaveCount(0);
  expect(state.frames.every((url) => !url.includes("grafana-old"))).toBe(true);
  await blocked.getByRole("button", { name: "Edit panel" }).click();
  const edit = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(edit.getByRole("button", { name: /Panel type/ })).toBeDisabled();
  await expect(
    edit.getByRole("textbox", { name: "Panel address" }),
  ).toHaveValue(old);
  await expect(edit.getByRole("alert")).toHaveText(
    "grafana-old.example.test isn't an allowed Grafana.",
  );
  // An unchanged saved address may stay while other settings change.
  await edit.getByLabel("Title (optional)").fill("Old checkout");
  await edit.getByRole("button", { name: "Apply changes" }).click();
  await expect(edit).toBeHidden();
  await expect(
    page.getByRole("article", { name: "Old checkout, blocked" }),
  ).toBeVisible();
});

test("viewers see blocked and turned-off panels without Edit panel", async ({
  page,
}) => {
  // Requirements: REV-68 sections 3 and 4; dashboard operations 3.
  await setup(
    page,
    [gf(0, "https://grafana-old.example.test/d-solo/a/b?panelId=1")],
    { role: "view" },
  );
  const blocked = page.getByRole("article", { name: "Grafana panel, blocked" });
  await expect(blocked).toContainText("Grafana panel blocked");
  await expect(blocked.getByRole("button")).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setup(page, [gf(0, good)], { role: "view", enabled: false });
  const off = page.getByRole("article", {
    name: "Grafana panel, Grafana panels are turned off",
  });
  await expect(off).toContainText("Grafana panels are turned off");
  await expect(off).toContainText(
    "An admin allows Grafana addresses in deployment configuration.",
  );
  await expect(off.locator("iframe")).toHaveCount(0);
});

test("a cover pauses Grafana frames while a panel is moved", async ({
  page,
}) => {
  // Requirements: REV-68 section 5 (moving and resizing); dashboard operations 3.
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page, [gf(0, good), gf(1, good, { title: "Second" })]);
  const tile = page.getByRole("article", {
    name: "Grafana panel",
    exact: true,
  });
  await expect(tile).toHaveAttribute("data-grafana-state", "ready");
  const cover = page.getByText("Paused while you move it");
  await expect(cover).toHaveCount(2);
  await expect(cover.first()).toBeHidden();
  const handle = page.getByRole("button", { name: "Move Grafana panel" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 });
  await expect(cover.first()).toBeVisible();
  await expect(cover.last()).toBeVisible();
  await page.mouse.up();
  await expect(cover.first()).toBeHidden();
});

test("an HTML panel with an iframe offers to switch to a Grafana panel", async ({
  page,
}) => {
  // Requirements: REV-68 section 8 (HTML panel hint); REV-57.
  await setup(page, [count]);
  const { dialog, type } = await openCreate(page);
  await type.click();
  await dialog.getByRole("option", { name: /^HTML/ }).click();
  const html = dialog.getByLabel("HTML", { exact: true });
  await html.fill("<p>p95 should stay under 600 ms.</p>");
  await expect(dialog.getByText("Showing a Grafana panel?")).toHaveCount(0);
  await html.fill(`${embed}\n<p>p95 should stay under 600 ms.</p>`);
  const hint = dialog.getByRole("status").filter({
    hasText: "Showing a Grafana panel?",
  });
  await expect(hint).toContainText(
    "HTML panels remove iframes. A Grafana panel shows it live, and keeps this address.",
  );
  await hint
    .getByRole("button", { name: "Use a Grafana panel instead" })
    .click();
  await expect(type).toContainText("Grafana panel");
  await expect(
    dialog.getByRole("textbox", { name: "Panel address" }),
  ).toHaveValue(good);
  await expect(dialog.locator("iframe")).toHaveAttribute(
    "src",
    `${good}&theme=light`,
  );
});

test("the save reports an address the server rejects", async ({ page }) => {
  // Requirements: REV-68 section 4 (server results).
  await setup(page, [count], {
    saveError: {
      status: 422,
      json: {
        error: {
          code: "grafana_url_invalid",
          message: "grafana.ops.example.test isn't an allowed Grafana.",
        },
      },
    },
  });
  const { dialog, address } = await chooseGrafana(page);
  await address.fill(good);
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("grafana.ops.example.test isn't an allowed Grafana."),
  ).toBeVisible();
});

test("super admins see the allowed Grafana and the settings for Grafana admins", async ({
  page,
  context,
}) => {
  // Requirements: REV-68 section 7; dashboard operations 16.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page, [], {
    superAdmin: true,
    path: `/tenants/${tenant}/integrations`,
    integration: {
      enabled: true,
      origins,
      ignored: [
        {
          entry: "http://grafana-old.example.test",
          reason: "Only https addresses are allowed.",
        },
      ],
    },
  });
  const card = page.getByRole("region", { name: "Grafana panels" });
  await expect(card).toContainText("On");
  const rows = card.getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText(`${grafana}/d-solo/…`);
  await expect(rows.nth(2)).toContainText(
    "https://tools.example.test/grafana/grafana/d-solo/…",
  );
  await expect(card).not.toContainText("Used by");
  await expect(card).toContainText(
    "http://grafana-old.example.test: Only https addresses are allowed.",
  );
  await expect(card).toContainText("KEEP_GRAFANA_PANEL_ORIGINS");
  await expect(card).toContainText("allow_embedding = true");
  await expect(card).toContainText("frame-ancestors http://127.0.0.1:3447;");
  await card.getByRole("button", { name: "Copy for Grafana admins" }).click();
  await expect(card.getByText(/^Copied\./)).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("allow_embedding = true");
  expect(copied).toContain("frame-ancestors http://127.0.0.1:3447;");
  // Read-only: nothing to type or save.
  await expect(card.getByRole("textbox")).toHaveCount(0);
});

test("the Integrations card shows Off when no Grafana is allowed", async ({
  page,
}) => {
  // Requirements: REV-68 sections 3 and 7.
  await setup(page, [], {
    superAdmin: true,
    enabled: false,
    path: `/tenants/${tenant}/integrations`,
  });
  const card = page.getByRole("region", { name: "Grafana panels" });
  await expect(card).toContainText("Off");
  await expect(card).toContainText(
    "No Grafana is allowed, so editors can't choose Grafana panel.",
  );
  await expect(card.getByRole("table")).toHaveCount(0);
});
