import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000010";
const preset = "00000000-0000-4000-8000-000000000020";
const stored = "00000000-0000-4000-8000-000000000040";
const api = `/api/tenants/${tenant}/dashboards/${id}`;
// A 1 × 1 PNG.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const count = {
  id: "00000000-0000-4000-8000-000000000030",
  preset_id: preset,
  title: "Critical",
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  thresholds: [],
};
const map = {
  id: "00000000-0000-4000-8000-000000000032",
  type: "image",
  title: "Service map",
  x: 3,
  y: 0,
  w: 4,
  h: 4,
  image_id: stored,
  url: null,
  fit: "contain",
  alt: "Checkout service map",
};
const chart = {
  id: "00000000-0000-4000-8000-000000000033",
  type: "image",
  title: null,
  x: 7,
  y: 0,
  w: 3,
  h: 3,
  image_id: null,
  url: "https://images.example.test/latency.png",
  fit: "cover",
  alt: null,
};
const gone = {
  ...chart,
  id: "00000000-0000-4000-8000-000000000034",
  title: "Old diagram",
  x: 0,
  y: 4,
  url: "https://images.example.test/missing.png",
};

async function setup(page: Page, panels: Record<string, unknown>[]) {
  const state = {
    definition: { id, name: "Images", revision: "3", panels },
    saves: [] as Record<string, unknown>[],
    counts: 0,
    uploads: [] as { headers: Record<string, string>; size: number }[],
    imageReads: [] as Record<string, string>[],
    linkReads: [] as Record<string, string>[],
  };
  await page.route("https://images.example.test/**", (route) => {
    state.linkReads.push(route.request().headers());
    return route.request().url().includes("missing")
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ contentType: "image/png", body: pixel });
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: preset, display_name: "Synthetic editor" },
          csrf_token: "images-csrf",
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
    if (path === `/api/tenants/${tenant}/dashboard-images`) {
      state.uploads.push({
        headers: request.headers(),
        size: request.postDataBuffer()?.length ?? 0,
      });
      return route.fulfill({
        status: 201,
        json: {
          data: {
            id: "00000000-0000-4000-8000-000000000041",
            media_type: "image/png",
            width: "1",
            height: "1",
            byte_size: String(pixel.length),
          },
        },
      });
    }
    if (path.startsWith(`/api/tenants/${tenant}/dashboard-images/`)) {
      state.imageReads.push(request.headers());
      return route.fulfill({ contentType: "image/png", body: pixel });
    }
    if (path === api) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        state.saves.push(body);
        state.definition = {
          ...state.definition,
          panels: body.panels,
          revision: "4",
        };
      }
      return route.fulfill({ json: { data: state.definition } });
    }
    if (path === `${api}/counts`) {
      state.counts += 1;
      return route.fulfill({
        json: {
          data: {
            observation_id: "images-observation",
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
    }
    if (path.endsWith("/presets"))
      return route.fulfill({
        json: {
          data: [
            { id: preset, name: "All alerts", revision: "1", cel: "true" },
          ],
          next_cursor: null,
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/dashboards/${id}`);
  return state;
}

async function openImageDialog(page: Page) {
  await page.getByRole("button", { name: "Create panel", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create panel",
    exact: true,
  });
  const type = dialog.getByRole("button", { name: /Panel type/ });
  await type.click();
  await dialog
    .getByRole("combobox", { name: "Search panel types" })
    .fill("image");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog
    .getByRole("combobox", { name: "Search panel types" })
    .press("Enter");
  await expect(type).toContainText("Image");
  return dialog;
}

test("image panels show uploads and links beside count panels", async ({
  page,
}) => {
  // Requirements: REV-62; dashboard operations 2, 14 and 16.
  const state = await setup(page, [count, map, chart, gone]);
  const uploaded = page.getByRole("article", {
    name: "Service map",
    exact: true,
  });
  const picture = uploaded.getByRole("img", { name: "Checkout service map" });
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute(
    "src",
    `/api/tenants/${tenant}/dashboard-images/${stored}`,
  );
  await expect(picture).toHaveCSS("object-fit", "contain");
  const linked = page.getByRole("article", {
    name: "Image panel",
    exact: true,
  });
  const linkedPicture = linked.getByRole("img", { name: "Image panel" });
  await expect(linkedPicture).toHaveCSS("object-fit", "cover");
  await expect(linkedPicture).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect.poll(() => state.linkReads.length).toBeGreaterThan(0);
  expect(state.linkReads.every((headers) => !headers.referer)).toBe(true);
  const failed = page.getByRole("article", {
    name: "Old diagram",
    exact: true,
  });
  await expect(failed).toContainText("Image unavailable");
  await expect(failed.getByRole("link", { name: "Open link" })).toHaveAttribute(
    "href",
    gone.url,
  );
  await expect(
    page.getByRole("article", { name: "Critical count", exact: true }),
  ).toContainText("12");
});

test("a dashboard of only image panels makes no count request", async ({
  page,
}) => {
  // Requirements: REV-62; dashboard operations 2 and 10.
  const state = await setup(page, [{ ...map, x: 0 }]);
  await expect(
    page.getByRole("img", { name: "Checkout service map" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh counts", exact: true })
    .click();
  await page.waitForTimeout(300);
  expect(state.counts).toBe(0);
});

test("an uploaded image panel is created, previewed and saved", async ({
  page,
}) => {
  // Requirements: REV-62; dashboard operations 3, 14 and 16.
  const state = await setup(page, [count]);
  const dialog = await openImageDialog(page);
  await expect(
    dialog.getByRole("radio", { name: "Upload a file" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Create panel", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Title (optional)").fill("Topology");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "topology.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(dialog).toContainText("topology.png");
  await expect(dialog).toContainText("1 × 1 px");
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].headers["content-type"]).toBe("image/png");
  expect(state.uploads[0].headers["x-csrf-token"]).toBe("images-csrf");
  expect(state.uploads[0].headers["idempotency-key"]).toMatch(
    /^[0-9a-f-]{36}$/,
  );
  const preview = dialog.getByRole("article", { name: "Topology" });
  await expect(preview.getByRole("img")).toBeVisible();
  await expect(preview.getByRole("img")).toHaveAttribute("src", /^blob:/);
  await dialog.getByLabel("Image description").fill("Network topology");
  await dialog.getByText("Fill the panel", { exact: true }).click();
  await expect(preview.getByRole("img")).toHaveCSS("object-fit", "cover");
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("article", { name: "Topology", exact: true })
      .getByRole("img", { name: "Network topology" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.title === "Topology",
  );
  expect(saved).toMatchObject({
    type: "image",
    image_id: "00000000-0000-4000-8000-000000000041",
    url: null,
    fit: "cover",
    alt: "Network topology",
  });
  expect(saved).not.toHaveProperty("preset_id");
});

test("files other than PNG, JPEG, GIF or WebP are refused before upload", async ({
  page,
}) => {
  // Requirements: REV-62 limits.
  const state = await setup(page, [count]);
  const dialog = await openImageDialog(page);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "diagram.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "diagram.svg can't be used",
  );
  await expect(
    dialog.getByRole("button", { name: "Choose another file" }),
  ).toBeVisible();
  expect(state.uploads).toHaveLength(0);
});

test("a linked image needs https and warns when it does not load", async ({
  page,
}) => {
  // Requirements: REV-62; dashboard operations 14 and 16.
  const state = await setup(page, [count]);
  const dialog = await openImageDialog(page);
  await dialog.getByText("Link to an image", { exact: true }).click();
  const address = dialog.getByLabel("Image address");
  await address.fill("http://images.example.test/latency.png");
  await address.blur();
  await expect(dialog).toContainText(
    "Enter an address that starts with https://.",
  );
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await address.fill("https://images.example.test/missing.png");
  await expect(dialog.getByRole("status")).toContainText(
    "No image loaded from this address",
  );
  await address.fill("https://images.example.test/latency.png");
  const preview = dialog.getByRole("article", { name: "Image panel" });
  await expect(preview.getByRole("img")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  // Switching the source keeps the address for when the user returns.
  await dialog.getByText("Upload a file", { exact: true }).click();
  await dialog.getByText("Link to an image", { exact: true }).click();
  await expect(address).toHaveValue("https://images.example.test/latency.png");
  await dialog
    .getByRole("button", { name: "Create panel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = (state.saves[0].panels as Record<string, unknown>[]).find(
    (item) => item.type === "image",
  );
  expect(saved).toMatchObject({
    image_id: null,
    url: "https://images.example.test/latency.png",
    fit: "contain",
    title: null,
  });
  expect(state.uploads).toHaveLength(0);
});

test("editing an image panel keeps its type and its upload", async ({
  page,
}) => {
  // Requirements: REV-62; dashboard operations 2 and 14.
  await setup(page, [count, map]);
  await page
    .getByRole("button", { name: "Options for Service map", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit panel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit panel", exact: true });
  await expect(
    dialog.getByRole("button", { name: /Panel type/ }),
  ).toBeDisabled();
  await expect(dialog).toContainText("Uploaded image");
  await expect(dialog.getByLabel("Image description")).toHaveValue(
    "Checkout service map",
  );
  await expect(
    dialog.getByRole("radio", { name: "Show whole image" }),
  ).toBeChecked();
  await expect(
    dialog
      .getByRole("article", { name: "Service map" })
      .getByRole("img", { name: "Checkout service map" }),
  ).toBeVisible();
});
