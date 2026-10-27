import { expect, test, type Page } from "@playwright/test";

/*
 * Requirements: REV-45; preset operations 6.
 * The Assigned to me quick view filters on the signed-in principal's ID,
 * counts like the other views and is never saved. Pressing the selected
 * view again returns to All.
 */

const tenant = "00000000-0000-4000-8000-000000000001";
const presetId = "00000000-0000-4000-8000-000000000003";
const me = "00000000-0000-4000-8000-000000000004";
const mine = `assignee_id == "${me}"`;
const row = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: "4",
  message: "Database latency",
  application: "payments",
  component: "postgres",
  severity: "critical",
  status: "firing",
  display_status: "acknowledged",
  assignee_id: me,
  timestamp: "2026-10-27T10:00:00Z",
};

async function setup(page: Page) {
  const feeds: URLSearchParams[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: me, display_name: "Design reviewer" },
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
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state") || path.endsWith("/health"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    if (route.request().method() === "POST")
      posts.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith("/alerts/counts")) {
      const queries = route.request().postDataJSON().queries as {
        id: string;
      }[];
      return route.fulfill({
        json: {
          data: {
            counts: Object.fromEntries(
              queries.map((query) => [
                query.id,
                query.id === "mine" ? "1" : "3",
              ]),
            ),
          },
        },
      });
    }
    if (path.endsWith(`/presets/${presetId}`))
      return route.fulfill({
        json: {
          data: {
            id: presetId,
            name: "Payments on-call",
            cel: 'application == "payments"',
            sort: [{ field: "timestamp", direction: "desc" }],
            columns: ["severity", "display_status", "message", "assignee_id"],
            group_by: null,
            revision: "12",
          },
        },
      });
    if (path.endsWith("/alerts")) feeds.push(url.searchParams);
    return route.fulfill({
      json: { data: [row], meta: { total: "1" }, next_cursor: null },
    });
  });
  return { feeds, posts };
}

test("Assigned to me filters the Feed on the signed-in user and shows its count", async ({
  page,
}) => {
  const { feeds, posts } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const group = page.getByRole("group", { name: "Quick views, not saved" });
  const view = group.getByRole("button", { name: "Assigned to me" });
  await expect(view).toHaveText(/^Assigned to me1$/);
  const counts = posts.find((post) => post.path.endsWith("/alerts/counts"));
  expect(counts?.body.queries).toContainEqual(
    expect.objectContaining({ id: "mine", cel: `(true) && (${mine})` }),
  );
  await view.click();
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => feeds.at(-1)?.get("cel")).toBe(`(true) && (${mine})`);
  await group.getByRole("button", { name: "All", exact: true }).click();
  await expect.poll(() => feeds.at(-1)?.get("cel")).toBe("true");
});

test("pressing the selected quick view again returns to All", async ({
  page,
}) => {
  const { feeds } = await setup(page);
  await page.goto(`/tenants/${tenant}/alerts`);
  const group = page.getByRole("group", { name: "Quick views, not saved" });
  const all = group.getByRole("button", { name: "All", exact: true });
  for (const [name, cel] of [
    ["Critical", 'severity == "critical"'],
    ["Assigned to me", mine],
  ]) {
    const view = group.getByRole("button", { name, exact: true });
    await view.click();
    await expect(view).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => feeds.at(-1)?.get("cel"))
      .toBe(`(true) && (${cel})`);
    await view.click();
    await expect(view).toHaveAttribute("aria-pressed", "false");
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => feeds.at(-1)?.get("cel")).toBe("true");
  }
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
});

test("Assigned to me narrows saved preset results without saving", async ({
  page,
}) => {
  const { posts } = await setup(page);
  await page.goto(`/tenants/${tenant}/presets/${presetId}`);
  await page
    .getByRole("group", { name: "Quick views, not saved" })
    .getByRole("button", { name: "Assigned to me" })
    .click();
  await expect
    .poll(
      () =>
        posts.filter((post) => post.path.endsWith("/presets/preview")).at(-1)
          ?.body.cel,
    )
    .toBe(`(application == "payments") && (${mine})`);
  expect(posts.some((post) => post.path.endsWith(`/presets/${presetId}`))).toBe(
    false,
  );
});
