import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const alert = "00000000-0000-4000-8000-000000000002";
const event = "00000000-0000-4000-8000-000000000003";
const note = "00000000-0000-4000-8000-000000000004";
const path = `/api/tenants/${tenant}/alerts/${alert}`;
const malicious =
  '<script>window.sourceExecuted=true</script><img src="https://invalid.example/pixel">';

async function setup(page: Page) {
  const state = {
    sourceReads: 0,
    direction: "",
    historyPages: [] as string[],
    denied: false,
    denyOlderHistory: false,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: {
            id: "00000000-0000-4000-8000-000000000099",
            display_name: "Evidence viewer",
          },
          csrf_token: "fixture",
          tenants: state.denied
            ? []
            : [
                {
                  id: tenant,
                  name: "Global",
                  kind: "global",
                  role: "view",
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
    if (url.pathname.endsWith("/health"))
      return route.fulfill({ json: { data: { source: "healthy" } } });
    if (url.pathname === path)
      return route.fulfill({
        json: {
          data: {
            id: alert,
            revision: "1",
            message: "Evidence alert",
            severity: "high",
            status: "firing",
          },
        },
      });
    if (url.pathname === path + "/notes")
      return route.fulfill({
        json: {
          data: [
            {
              id: note,
              text: "Current note",
              created_at: "2026-09-23T10:00:00Z",
              actor_id: "Fixture actor",
            },
            ...(url.searchParams.get("include_deleted") === "true"
              ? [
                  {
                    id: event,
                    text: null,
                    deleted: true,
                    created_at: "2026-09-23T09:00:00Z",
                    actor_id: "Fixture actor",
                  },
                ]
              : []),
          ],
          next_cursor: null,
        },
      });
    if (url.pathname.includes("/notes/") && url.pathname.endsWith("/history")) {
      state.historyPages.push(url.searchParams.get("cursor") ?? "first");
      if (state.denyOlderHistory && url.searchParams.has("cursor"))
        state.denied = true;
      if (state.denied)
        return route.fulfill({
          status: 403,
          json: { error: { code: "forbidden", message: "Access changed" } },
        });
      const older = url.searchParams.has("cursor");
      return route.fulfill({
        json: {
          data: [
            {
              revision: older ? "1" : "2",
              text: older
                ? "Original retained <b>text</b>"
                : "Deleted revision text",
              deleted: !older,
              recorded_at: "2026-09-23T10:00:00Z",
              actor_id: "Fixture actor",
            },
          ],
          next_cursor: older ? null : "opaque-history",
        },
      });
    }
    if (url.pathname === path + "/source-events") {
      state.direction = url.searchParams.get("direction") ?? "desc";
      return route.fulfill({
        json: {
          data: [
            {
              id: event,
              admission_order: "9007199254740999",
              received_at: "2026-09-23T10:00:00Z",
              time_defaulted: true,
            },
          ],
          next_cursor: null,
        },
      });
    }
    if (url.pathname === path + "/source-events/" + event) {
      state.sourceReads++;
      return route.fulfill({
        json: {
          data: {
            id: event,
            raw_json: JSON.stringify({ message: malicious }),
            payload: { message: malicious },
            occurrence_id: alert,
            adapter_version: null,
          },
        },
      });
    }
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/alerts/${alert}`);
  await expect(
    page.getByRole("heading", { name: "Evidence alert" }),
  ).toBeVisible();
  return state;
}

test("source details load on demand and display received markup as plain text", async ({
  page,
}) => {
  const state = await setup(page);
  let external = 0;
  await page.route("https://invalid.example/**", (route) => {
    external++;
    return route.abort();
  });
  await page.getByRole("tab", { name: /^Source events/ }).click();
  await expect(
    page.getByRole("tab", { name: /^Source events/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("article", { name: "Source event", exact: true }),
  ).toContainText("9007199254740999");
  expect(state.sourceReads).toBe(0);
  await page.getByRole("button", { name: "View source details" }).click();
  const details = page.getByRole("region", { name: "Source event details" });
  await expect(details).toContainText(malicious);
  await expect(details.locator("img,script")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { sourceExecuted?: boolean }).sourceExecuted,
    ),
  ).toBeUndefined();
  expect(external).toBe(0);
  await page.getByRole("button", { name: "Close source details" }).click();
  await expect(details).toHaveCount(0);
  await page.getByLabel("Order", { exact: true }).selectOption("asc");
  await expect.poll(() => state.direction).toBe("asc");
  await expect(details).toHaveCount(0);
});

test("viewer discovers deleted notes and traverses retained revisions", async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Show deleted", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Hide deleted", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Deleted note Â· current text hidden"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit note", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "View note history" }).last().click();
  const history = page.getByRole("region", { name: "Alert note history" });
  await expect(history).toContainText("Revision 2 Â· Deleted");
  await history.getByRole("button", { name: "Older revisions" }).click();
  await expect(history).toContainText("Original retained <b>text</b>");
  await expect(history.locator("b")).toHaveCount(0);
  // Live reconciliation may refresh the same page; traversal must preserve its cursor.
  expect(
    state.historyPages.filter(
      (value, index, pages) => index === 0 || value !== pages[index - 1],
    ),
  ).toEqual(["first", "opaque-history"]);
  await history.getByRole("button", { name: "Newest revisions" }).click();
  await expect(history).toContainText("Revision 2 Â· Deleted");
});

test("access loss clears retained note evidence", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "View note history" }).click();
  await expect(page.getByText("Deleted revision text")).toBeVisible();
  state.denyOlderHistory = true;
  await page.getByRole("button", { name: "Older revisions" }).click();
  await expect(page.getByText("Deleted revision text")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Evidence alert" }),
  ).toHaveCount(0);
});
