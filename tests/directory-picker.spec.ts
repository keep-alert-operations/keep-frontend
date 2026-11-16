/**
 * The permissions picker with ADAPI search answers and save on pick (REV-73)
 * from synthetic Product API answers.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const global = "00000000-0000-4000-8000-000000000001",
  tenant = "00000000-0000-4000-8000-000000000002",
  saved = "00000000-0000-4000-8000-000000000031";
const session = {
  principal: {
    id: "00000000-0000-4000-8000-000000000099",
    display_name: "Synthetic admin",
  },
  csrf_token: "test-csrf",
  tenants: [
    { id: global, name: "Global", kind: "global", role: "edit", revision: "1" },
    {
      id: tenant,
      name: "Payments",
      kind: "specific",
      role: "admin",
      revision: "1",
    },
  ],
};
/** An ADAPI match Keep has not saved (`id: null`, not selectable). */
const unsaved = {
  id: null,
  directory_source: "adapi",
  object_id: "keep-developers",
  display_name: "Developers",
  kind: "team",
  eligible: true,
  deleted: false,
  selectable: false,
  verification: "unverified",
  verified_at: null,
};
const stored = {
  ...unsaved,
  id: saved,
  selectable: true,
  verification: "verified",
  verified_at: "2026-11-15T10:00:00Z",
};

async function setup(page: Page, meta: Record<string, unknown> = {}) {
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { data: session } }),
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
    if (url.pathname.endsWith("/permissions"))
      return route.fulfill({
        json: {
          data: [],
          meta: { revision: "1", has_local_admin: true },
          next_cursor: null,
        },
      });
    if (url.pathname.endsWith("/permission-principals"))
      return route.fulfill({
        json: {
          data: [unsaved],
          meta: { cached: false, type_more: false, ...meta },
          next_cursor: null,
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
}

/** Routes POST and GET `…/permission-principals/resolve` to `handle`. */
async function resolve(
  page: Page,
  handle: (route: Route, method: string) => Promise<void> | void,
) {
  await page.route(
    (url) => url.pathname.endsWith("/permission-principals/resolve"),
    (route) => handle(route, route.request().method()),
  );
}

async function search(page: Page) {
  await page.goto(`/tenants/${tenant}/permissions`);
  await page
    .getByRole("textbox", {
      name: "Add a user or team from the company directory",
    })
    .fill("dev");
  await expect(
    page.getByRole("button", { name: "Choose Developers" }),
  ).toBeVisible();
}

const pending = {
  status: 202,
  json: { data: { status: "pending" }, meta: {} },
};

/** Requirements: REV-73; tenant access 5 (search); plan A14. */
test("a capped directory search asks the user to type more", async ({
  page,
}) => {
  await setup(page, { type_more: true, search_complete: false });
  await search(page);
  await expect(
    page.getByText("Too many results — type more to narrow the search.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Verification pending")).toHaveCount(0);
  await expect(
    page.getByText("Team · Not saved in Keep yet", { exact: true }),
  ).toBeVisible();
});

/** Requirements: REV-73; tenant access 5 (save on pick, picker). A pick too
 * large for the request is pending, polled 3 seconds after each answer, and
 * becomes selectable once saved. */
test("a pending save polls after each answer until the group is saved", async ({
  page,
}) => {
  await setup(page);
  const posts: unknown[] = [];
  const polls: { at: number; query: string }[] = [];
  let answered = 0;
  await resolve(page, async (route, method) => {
    if (method === "POST") {
      posts.push(route.request().postDataJSON());
      expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
      return route.fulfill(pending);
    }
    polls.push({
      at: Date.now(),
      query: new URL(route.request().url()).search,
    });
    if (polls.length === 1) {
      // A slow answer: the next poll waits 3 seconds after it, not after the
      // request started.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      answered = Date.now();
      return route.fulfill(pending);
    }
    return route.fulfill({ json: { data: stored, meta: {} } });
  });
  await search(page);
  const choose = page.getByRole("button", { name: "Choose Developers" });
  await choose.click();
  await expect(
    page.getByText("Team · Saving from the directory…", { exact: true }),
  ).toBeVisible();
  await expect(choose).toBeDisabled();
  expect(posts).toEqual([{ kind: "team", username: "keep-developers" }]);
  await expect.poll(() => polls.length, { timeout: 10000 }).toBe(2);
  expect(polls[0].query).toBe("?kind=team&username=keep-developers");
  expect(polls[1].at - answered).toBeGreaterThanOrEqual(2900);
  await expect(choose).toBeEnabled();
  await expect(page.getByText("Team · Saving", { exact: false })).toHaveCount(
    0,
  );
  await choose.click();
  await expect(
    page.getByRole("textbox", {
      name: "Add a user or team from the company directory",
    }),
  ).toHaveValue("Developers");
  await expect(
    page.getByRole("button", { name: "Add", exact: true }),
  ).toBeEnabled();
  expect(posts).toHaveLength(1);
});

/** Requirements: REV-73; tenant access 5 (picker). A failed background save
 * offers Try again, which repeats the pick with `retry: true`; an inline
 * save completes the pick at once. */
test("a failed save offers Try again, which retries and completes the pick", async ({
  page,
}) => {
  await setup(page);
  const posts: unknown[] = [];
  await resolve(page, (route, method) => {
    if (method === "POST") {
      posts.push(route.request().postDataJSON());
      return posts.length === 1
        ? route.fulfill(pending)
        : route.fulfill({ json: { data: stored, meta: {} } });
    }
    return route.fulfill({
      status: 503,
      headers: { "Retry-After": "5" },
      json: {
        error: {
          code: "directory_unavailable",
          message: "Keep couldn't save this from the directory. Try again.",
          request_id: "req-1",
        },
      },
    });
  });
  await search(page);
  await page.getByRole("button", { name: "Choose Developers" }).click();
  await expect(
    page.getByText(
      "Team · Couldn't add this group. The company directory didn't answer.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Try again Developers" }).click();
  await expect(
    page.getByRole("textbox", {
      name: "Add a user or team from the company directory",
    }),
  ).toHaveValue("Developers");
  expect(posts).toEqual([
    { kind: "team", username: "keep-developers" },
    { kind: "team", username: "keep-developers", retry: true },
  ]);
  await expect(
    page.getByRole("button", { name: "Add", exact: true }),
  ).toBeEnabled();
});

/** Requirements: REV-73; tenant access 5. A name ADAPI doesn't know saves
 * nothing and shows the reason. */
test("a pick the directory refuses shows its message and cannot be chosen", async ({
  page,
}) => {
  await setup(page);
  await resolve(page, (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: {
          code: "principal_not_in_directory",
          message: "The directory has no user or group with this username.",
        },
      },
    }),
  );
  await search(page);
  const choose = page.getByRole("button", { name: "Choose Developers" });
  await choose.click();
  await expect(
    page.getByText(
      "Team · The directory has no user or group with this username.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(choose).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add", exact: true }),
  ).toBeDisabled();
});

/** Requirements: REV-73; tenant access 5 (picker). Leaving the page stops the
 * polls; the Product API finishes the save anyway. */
test("leaving the page stops polling a pending save", async ({ page }) => {
  await setup(page);
  let polls = 0;
  await resolve(page, (route, method) => {
    if (method === "GET") polls++;
    return route.fulfill(pending);
  });
  await search(page);
  await page.getByRole("button", { name: "Choose Developers" }).click();
  await expect(
    page.getByText("Team · Saving from the directory…", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Tenant navigation" })
    .getByRole("link", { name: "Feed" })
    .click();
  await expect(page).toHaveURL(`/tenants/${tenant}/alerts`);
  await page.waitForTimeout(4000);
  expect(polls).toBe(0);
});
