import { expect, test, type Page } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const incident = "00000000-0000-4000-8000-000000000023";
const note = "00000000-0000-4000-8000-000000000024";
const actor = "00000000-0000-4000-8000-000000000099";
const originalRevision = "9007199254740999";
const path = `/api/tenants/${tenant}/incidents/${incident}`;
async function setup(page: Page, role = "edit") {
  const state = {
    role,
    revision: originalRevision,
    text: "Original plain <b>note</b>\nSecond line",
    deleted: false,
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: actor, display_name: "Synthetic note editor" },
          csrf_token: "notes-csrf",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: state.role,
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
      return route.fulfill({
        json: { data: { source: "healthy", search: "healthy" } },
      });
    if (url.pathname === path)
      return route.fulfill({
        json: {
          data: {
            id: incident,
            revision: state.revision,
            title: "Resolved incident",
            status: "resolved",
            severity: "high",
          },
        },
      });
    if (url.pathname === `${path}/notes`)
      return route.fulfill({
        json: {
          data:
            state.deleted && url.searchParams.get("include_deleted") !== "true"
              ? []
              : [
                  {
                    id: note,
                    text: state.deleted ? null : state.text,
                    deleted: state.deleted,
                    revision: "2",
                    actor_id: actor,
                    created_at: "2026-09-22T11:00:00Z",
                  },
                ],
          meta: { revision: state.revision },
          next_cursor: null,
        },
      });
    return route.fulfill({ json: { data: [], next_cursor: null } });
  });
  await page.goto(`/tenants/${tenant}/incidents/${incident}`);
  await page.getByRole("tab", { name: /^Notes/ }).click();
  await expect(
    page.getByRole("article", { name: "Incident note", exact: true }),
  ).toBeVisible();
  return state;
}

test("resolved incident notes use the coherent parent revision and remain plain text", async ({
  page,
}) => {
  const state = await setup(page);
  const requests: Record<string, unknown>[] = [];
  await page.route(`**${path}/notes/${note}`, async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers()["x-csrf-token"]).toBe("notes-csrf");
    const body = route.request().postDataJSON();
    requests.push(body);
    state.text = body.text;
    state.revision = "9007199254741000";
    await route.fulfill({
      json: { data: { id: note, revision: state.revision } },
    });
  });
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page
    .getByLabel("Edit incident note", { exact: true })
    .fill("Edited <script>alert(1)</script>\nStill plain text");
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("tab", { name: /^Notes/ }).click();
  await expect(
    page.getByLabel("Edit incident note", { exact: true }),
  ).toHaveValue("Edited <script>alert(1)</script>\nStill plain text");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Incident note", exact: true }),
  ).toContainText("Edited <script>alert(1)</script>");
  expect(requests[0].expected_revision).toBe(originalRevision);
  expect(requests[0].command_id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(
    page.getByLabel("Edit incident note", { exact: true }),
  ).toHaveCount(0);
});

test("conflicts preserve draft and captured revision until explicit discard and review", async ({
  page,
}) => {
  const state = await setup(page);
  const submissions: Record<string, unknown>[] = [];
  await page.route(`**${path}/notes/${note}`, (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      state.text = "Someone else's new note";
      state.revision = "9007199254741001";
      return route.fulfill({
        status: 409,
        json: {
          error: { code: "revision_conflict", message: "Incident changed." },
        },
      });
    }
    state.text = String(submissions[1].text);
    return route.fulfill({
      json: { data: { id: note, revision: "9007199254741002" } },
    });
  });
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page
    .getByLabel("Edit incident note", { exact: true })
    .fill("My preserved draft");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(
    page.getByText("Your draft was preserved.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh notes", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Incident note", exact: true }),
  ).toContainText("Someone else's new note");
  await expect(
    page.getByLabel("Edit incident note", { exact: true }),
  ).toHaveValue("My preserved draft");
  await expect(
    page.getByRole("button", { name: "Save note", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Discard note draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page
    .getByLabel("Edit incident note", { exact: true })
    .fill("Reviewed replacement");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].expected_revision).toBe(originalRevision);
  expect(submissions[1].expected_revision).toBe("9007199254741001");
  expect(submissions[1].command_id).not.toBe(submissions[0].command_id);
});

test("deletion requires confirmation and uncertain retry preserves exact headers", async ({
  page,
}) => {
  const state = await setup(page);
  const headers: Record<string, string>[] = [];
  await page.route(`**${path}/notes/${note}`, (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postData()).toBeNull();
    headers.push(route.request().headers());
    if (headers.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Outcome uncertain" } },
      });
    state.deleted = true;
    return route.fulfill({
      json: { data: { id: note, deleted: true, revision: "9007199254741000" } },
    });
  });
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Delete this incident note?",
  });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(headers).toHaveLength(0);
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await confirm
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry original note command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard note draft" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry original note command" })
    .click();
  await expect(page.getByText("No current notes.")).toBeVisible();
  expect(headers).toHaveLength(2);
  expect(headers[1]["idempotency-key"]).toBe(headers[0]["idempotency-key"]);
  expect(headers[1]["if-match"]).toBe(`"${originalRevision}"`);
  expect(headers[1]["x-csrf-token"]).toBe("notes-csrf");
});

test("readers see note text without mutation controls", async ({ page }) => {
  await setup(page, "view");
  await expect(
    page.getByRole("article", { name: "Incident note", exact: true }),
  ).toContainText("Original plain <b>note</b>");
  await expect(
    page.getByRole("button", { name: "Edit note", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete note", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("New incident note", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add note", exact: true }),
  ).toHaveCount(0);
});

test("new notes freeze text and reuse their original command after uncertainty", async ({
  page,
}) => {
  const state = await setup(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**${path}/notes`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("notes-csrf");
    if (bodies.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Response uncertain" } },
      });
    state.text = String(bodies[1].text);
    return route.fulfill({
      status: 201,
      json: { data: { id: note, revision: "9007199254741000" } },
    });
  });
  await page
    .getByLabel("New incident note", { exact: true })
    .fill("Reviewed 😀 evidence\nPlain second line");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry original note command" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("New incident note", { exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry original note command" })
    .click();
  await expect(
    page.getByRole("article", { name: "Incident note", exact: true }),
  ).toContainText("Reviewed 😀 evidence");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[1].expected_revision).toBe(originalRevision);
});

test("current permission loss removes note draft and all write controls", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route(`**${path}/notes/${note}`, (route) => {
    state.role = "view";
    return route.fulfill({
      status: 403,
      json: {
        error: { code: "forbidden", message: "Edit permission was removed." },
      },
    });
  });
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page
    .getByLabel("Edit incident note", { exact: true })
    .fill("Draft before role loss");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(
    page.getByLabel("Edit incident note", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit note", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete note", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("New incident note", { exact: true }),
  ).toHaveCount(0);
});

test("readers can discover deleted notes and page immutable plain-text history", async ({
  page,
}) => {
  const state = await setup(page, "view");
  state.deleted = true;
  const cursor = "opaque-note-page/+==";
  const seen: (string | null)[] = [];
  await page.route(`**${path}/notes/${note}/history?**`, (route) => {
    const position = new URL(route.request().url()).searchParams.get("cursor");
    seen.push(position);
    return route.fulfill({
      json: {
        data: [
          {
            note_id: note,
            revision: position ? "1" : "2",
            text: position
              ? "Original historical text"
              : "Deleted <script>plain text</script>\nPreserved line",
            deleted: !position,
            actor_id: actor,
            actor_display_name: position ? null : "Historical <b>author</b>",
            recorded_at: "2026-09-22T12:00:00Z",
          },
        ],
        meta: { upper_revision: "2" },
        next_cursor: position ? null : cursor,
      },
    });
  });
  await page
    .getByRole("button", { name: "Refresh notes", exact: true })
    .click();
  await expect(page.getByText("No current notes.")).toBeVisible();
  await page.getByLabel("Show deleted notes", { exact: true }).check();
  const current = page.getByRole("article", {
    name: "Incident note",
    exact: true,
  });
  await expect(current).toContainText("Deleted note · current text hidden");
  await expect(current).not.toContainText("Original plain");
  await page
    .getByRole("button", { name: "View note history", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "Incident note revision history",
    exact: true,
  });
  await expect(history).toContainText("Deletion record");
  await expect(history).toContainText("Historical <b>author</b>");
  await expect(history).toContainText("Deleted <script>plain text</script>");
  await expect(history.locator("script,b")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Older revisions", exact: true })
    .click();
  await expect(history).toContainText("Historical name unavailable");
  await expect(history).toContainText("Original historical text");
  expect(seen[0]).toBeNull();
  expect(seen.filter((position) => position !== null)).toEqual([cursor]);
  await expect(
    page.getByRole("button", { name: "Older revisions", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "First revision page", exact: true })
    .click();
  await expect(history).toContainText("Deletion record");
  await expect(
    page.getByRole("button", { name: "Edit note", exact: true }),
  ).toHaveCount(0);
});

test("retired incident history clears previously displayed historical text", async ({
  page,
}) => {
  await setup(page, "view");
  let retired = false;
  await page.route(`**${path}/notes/${note}/history?**`, (route) =>
    retired
      ? route.fulfill({
          status: 404,
          json: {
            error: { code: "not_found", message: "Incident unavailable." },
          },
        })
      : route.fulfill({
          json: {
            data: [
              {
                note_id: note,
                revision: "1",
                text: "Retained historical proof",
                deleted: false,
                actor_id: actor,
                actor_display_name: "Captured actor",
                recorded_at: "2026-09-22T12:00:00Z",
              },
            ],
            next_cursor: null,
          },
        }),
  );
  await page
    .getByRole("button", { name: "View note history", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "Incident note revision history",
    exact: true,
  });
  await expect(history).toContainText("Retained historical proof");
  retired = true;
  await page
    .getByRole("button", { name: "Refresh note history", exact: true })
    .click();
  await expect(history).toContainText("Incident unavailable.");
  await expect(history).not.toContainText("Retained historical proof");
});
