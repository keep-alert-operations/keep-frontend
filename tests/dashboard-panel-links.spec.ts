import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
const runbook = {
  url: "https://runbooks.example/payments/critical",
  label: "Runbook",
};
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 0,
  w: 3,
  h: 3,
  thresholds: [],
  link: runbook,
};
const plain = {
  id: "00000000-0000-4000-8000-000000000031",
  preset_id: preset,
  title: "Plain",
  x: 3,
  y: 0,
  w: 3,
  h: 3,
  thresholds: [],
  link: null,
};
const notes = {
  id: "00000000-0000-4000-8000-000000000032",
  type: "html",
  title: null,
  x: 6,
  y: 0,
  w: 3,
  h: 3,
  html: "<p>Change freeze until Friday.</p>",
  link: { url: "http://calendar.internal:8080/changes", label: null },
};
const image = {
  id: "00000000-0000-4000-8000-000000000033",
  type: "image",
  title: null,
  x: 9,
  y: 0,
  w: 3,
  h: 3,
  image_id: null,
  url: "https://images.example/map.png",
  fit: "contain",
  alt: "Service map",
  link: { url: "https://grafana.example/d/abc", label: "Open in Grafana" },
};
const table = {
  id: "00000000-0000-4000-8000-000000000034",
  type: "table",
  preset_id: preset,
  title: "Latest",
  x: 0,
  y: 3,
  w: 6,
  h: 4,
  rows: 5,
  link: { url: "https://wiki.example/escalation", label: "Escalation" },
};

async function setup(page: Page, panels: Record<string, unknown>[]) {
  const state = {
    definition: { id, name: "Links", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
  };
  await page.route("https://images.example/**", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "links-csrf",
          tenants: [
            {
              id: tenant,
              name: "Synthetic",
              role: "edit",
              kind: "specific",
              revision: "1",
            },
          ],
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
        json: { data: { committed_seq: "1", searchable_seq: "1" } },
      });
    if (path === api) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        state.saves.push(body);
        state.definition = {
          ...state.definition,
          panels: body.panels,
          revision: "4",
        };
      }
      return route.fulfill({ json: { data: state.definition } });
    }
    if (path === `${api}/counts`)
      return route.fulfill({
        json: {
          data: {
            observation_id: "links-observation",
            dashboard_revision: state.definition.revision,
            evaluated_at: "2026-11-09T10:00:00Z",
            preset_revisions: { [preset]: "1" },
            relative: false,
            updating: false,
            updating_suppression: false,
            panels: (state.definition.panels as { id: string; type?: string }[])
              .filter((item) => (item.type ?? "count") === "count")
              .map((item) => ({
                panel_id: item.id,
                preset_id: preset,
                preset_name: "All alerts",
                count: "12",
              })),
          },
        },
      });
    if (path.endsWith("/alerts/counts"))
      return route.fulfill({ json: { data: { counts: { total: "42" } } } });
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            {
              id: preset,
              name: "All alerts",
              revision: "1",
              cel: "true",
              columns: ["severity", "name"],
            },
          ],
          next_cursor: null,
        },
      });
    if (path.endsWith(`/presets/${preset}`))
      return route.fulfill({
        json: {
          data: {
            id: preset,
            name: "All alerts",
            revision: "1",
            cel: "true",
            columns: ["severity", "name"],
          },
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

test("every panel type shows its link button and opens it in a new tab", async ({
  page,
}) => {
  // Requirements: REV-66; dashboard operations 3 and 16.
  await setup(page, [count, plain, notes, image, table]);
  const critical = page.getByRole("article", {
    name: "Critical count",
    exact: true,
  });
  await expect(critical).toContainText("12");
  const button = critical.getByRole("link", {
    name: "Runbook (opens in a new tab)",
  });
  await expect(button).toHaveAttribute("href", runbook.url);
  await expect(button).toHaveAttribute("target", "_blank");
  await expect(button).toHaveAttribute("rel", "noopener noreferrer");
  await expect(button).toHaveAttribute(
    "title",
    "Runbook · runbooks.example/payments/critical",
  );
  // The count panel's preset link still opens the preset.
  await expect(
    critical.getByRole("link", { name: "Critical", exact: true }),
  ).toHaveAttribute("href", new RegExp(`/presets/${preset}`));
  // A panel without a link has no button.
  await expect(
    page
      .getByRole("article", { name: "Plain count", exact: true })
      .getByRole("link", { name: /opens in a new tab/ }),
  ).toHaveCount(0);
  // An untitled HTML panel shows the default text in a row of its own.
  await expect(
    page
      .getByRole("article", { name: "HTML panel", exact: true })
      .getByRole("link", { name: "Open link (opens in a new tab)" }),
  ).toHaveAttribute("href", notes.link.url);
  // An untitled image floats the button over its corner.
  const floating = page
    .getByRole("article", { name: "Image panel", exact: true })
    .getByRole("link", { name: "Open in Grafana (opens in a new tab)" });
  await expect(floating).toHaveClass(/pn-go-float/);
  await expect(
    page
      .getByRole("article", { name: "Latest", exact: true })
      .getByRole("link", { name: "Escalation (opens in a new tab)" }),
  ).toHaveAttribute("href", table.link.url);

  // Clicking opens a new tab without navigating the dashboard.
  await page
    .context()
    .route("https://runbooks.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Runbook</p>" }),
    );
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    button.click(),
  ]);
  await expect(popup).toHaveURL(runbook.url);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
});

test("a narrow panel shows only the icon and keeps the name", async ({
  page,
}) => {
  // Requirements: REV-66; dashboard operations 16.
  await page.setViewportSize({ width: 1024, height: 800 });
  await setup(page, [count]);
  const button = page
    .getByRole("article", { name: "Critical count", exact: true })
    .getByRole("link", { name: "Runbook (opens in a new tab)" });
  await expect(button).toBeVisible();
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(
      '[aria-label="Critical count"]',
    );
    if (panel) panel.style.width = "190px";
  });
  await expect(button.locator(".pn-go-text")).toBeHidden();
  await expect(button).toBeVisible();
});

test("the dialog adds, checks, previews and removes a panel link", async ({
  page,
}) => {
  // Requirements: REV-66; dashboard operations 2, 3 and 16.
  const state = await setup(page, [plain]);
  await page
    .getByRole("button", { name: "Options for Plain", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit panel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  const address = dialog.getByLabel("Link (optional)");
  const text = dialog.getByLabel("Button text (optional)");
  await expect(address).toHaveValue("");
  await expect(text).toBeDisabled();
  const preview = dialog.getByRole("article", { name: /count$/ });
  await expect(preview.getByRole("link", { name: /new tab/ })).toHaveCount(0);

  // Other schemes are refused before saving.
  await address.fill("javascript:alert(1)");
  await address.blur();
  await expect(dialog).toContainText(
    "Enter a full address that starts with https:// or http://.",
  );
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(address).toBeFocused();
  await expect(dialog).toBeVisible();

  await address.fill("https://runbooks.example/payments");
  await expect(address).not.toHaveAttribute("aria-invalid", "true");
  await expect(
    preview.getByRole("link", { name: "Open link (opens in a new tab)" }),
  ).toBeVisible();
  await text.fill("x".repeat(41));
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(dialog).toContainText(
    "Use single-line button text of up to 40 characters.",
  );
  await text.fill("  Runbook ");
  await expect(
    preview.getByRole("link", { name: "Runbook (opens in a new tab)" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("article", { name: "Plain count", exact: true })
      .getByRole("link", { name: "Runbook (opens in a new tab)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect((state.saves[0].panels as Record<string, unknown>[])[0]).toMatchObject(
    { link: { url: "https://runbooks.example/payments", label: "Runbook" } },
  );

  // Remove link clears both fields and the saved panel has none.
  await page
    .getByRole("button", { name: "Options for Plain", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit panel", exact: true }).click();
  await expect(address).toHaveValue("https://runbooks.example/payments");
  await expect(text).toHaveValue("Runbook");
  await dialog.getByRole("button", { name: "Remove link" }).click();
  await expect(address).toHaveValue("");
  await expect(address).toBeFocused();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(
    (state.saves[1].panels as Record<string, unknown>[])[0].link,
  ).toBeNull();
});

test("the link follows the panel across types while creating", async ({
  page,
}) => {
  // Requirements: REV-66; dashboard operations 2 and 16.
  const state = await setup(page, []);
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  await dialog.getByLabel("Link (optional)").fill("https://wiki.example/notes");
  await dialog.getByLabel("Button text (optional)").fill("Wiki");
  await dialog.getByRole("button", { name: /Panel type/ }).click();
  await page.getByRole("option", { name: /^HTML/ }).click();
  await expect(dialog.getByLabel("Link (optional)")).toHaveValue(
    "https://wiki.example/notes",
  );
  await dialog.getByLabel("HTML", { exact: true }).fill("<p>Notes</p>");
  await expect(
    dialog
      .getByRole("article", { name: "HTML panel preview" })
      .getByRole("link", { name: "Wiki (opens in a new tab)" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect((state.saves[0].panels as Record<string, unknown>[])[0]).toMatchObject(
    {
      type: "html",
      link: { url: "https://wiki.example/notes", label: "Wiki" },
    },
  );
});
