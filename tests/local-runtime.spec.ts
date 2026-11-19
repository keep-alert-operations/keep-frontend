/**
 * Real interactive local stack: no request mocks or injected identity/session.
 * Smoke baseline S2 (keep-delivery development runbook, "Critical smoke
 * scenarios and expected results").
 *
 * `KEEP_LOCAL_DELIVERY_DIR` names the keep-delivery checkout that holds the
 * running stack's `.local` state; it defaults to the sibling checkout.
 * `KEEP_SMOKE_RUN` (optional) is recorded in the evidence so a smoke run can
 * tell its own evidence from an older run's.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.KEEP_LOCAL_RUNTIME_TEST !== "1",
  "Requires the running local runtime",
);

test("native alert reaches the real feed and supports browser acknowledgement and notes", async ({
  page,
}) => {
  const repository =
    process.env.KEEP_LOCAL_DELIVERY_DIR ??
    resolve(__dirname, "../../keep-delivery");
  const state = resolve(repository, ".local/runtime");
  mkdirSync(state, { recursive: true });
  const credentials = JSON.parse(
    readFileSync(
      resolve(repository, ".local/identity/credentials.json"),
      "utf8",
    ),
  );
  // Keep's own sign-in page and one local OpenLDAP bind (REV-73).
  await page.goto("/sign-in");
  await page.getByLabel("Username", { exact: true }).fill("local-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials.users["local-admin"].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page).toHaveURL(/^https:\/\/localhost:3443\//);
  const sessionResponse = await page.request.get("/auth/session");
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()).data;
  const tenant = session.tenants.find(
    (item: { kind: string }) => item.kind === "global",
  ).id;
  const run = randomUUID();
  const message = `Local demo ${run}: CPU usage needs investigation`;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const created = `${pad(now.getUTCDate())}-${pad(now.getUTCMonth() + 1)}-${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const ingestion =
    process.env.KEEP_LOCAL_INGESTION_URL ?? "http://127.0.0.1:58001";
  const admission = await page.request.post(
    `${ingestion}/api/ingest/v1/alerts`,
    {
      data: {
        application: "Keep local demo",
        object: "cpu",
        node_name: "demo-node-01",
        operator: "local-demo",
        message,
        severity: "major",
        time_created: created,
        key_field: run,
      },
    },
  );
  expect(admission.status()).toBe(202);
  let alert = "";
  let stored: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/tenants/${tenant}/alerts`,
          { params: { q: run } },
        );
        if (response.status() !== 200) return false;
        const item = (await response.json()).data.find(
          (item: { id: string; message: string }) => item.message === message,
        );
        alert = item?.id ?? "";
        stored = item ?? {};
        return Boolean(alert);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  // Requirements: REV-77; alert operations 3. A v1 alert is stored as sent:
  // object stays object and major stays major.
  expect(stored.object).toBe("cpu");
  expect(stored.component ?? null).toBeNull();
  expect(stored.severity).toBe("major");
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  // Requirements: REV-43. Healthy delivery shows no header notice.
  await expect(
    page.locator('[data-live-status="Live hints connected"]'),
  ).toBeAttached({ timeout: 45000 });
  await expect(page.locator(".update-note")).toBeEmpty();
  await page.screenshot({ path: resolve(state, "alerts.png"), fullPage: true });
  await page.goto(`/tenants/${tenant}/alerts/${alert}`);
  await expect(
    page.getByRole("heading", { name: message, exact: true }),
  ).toBeVisible();
  // Requirements: REV-77; alert operations 3. Details show v1 fields.
  const details = page.getByRole("region", { name: "Details" });
  await expect(
    details.locator(".fld", { hasText: "Object" }).locator("dd"),
  ).toHaveText("cpu");
  await expect(details.locator(".fld", { hasText: "Component" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect(page.locator(".ad-marks .st-acknowledged")).toBeVisible();
  const note =
    "Local runtime verified: received, indexed and reviewed through the browser.";
  await page
    .getByRole("textbox", { name: "Add a note", exact: true })
    .fill(note);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.locator(".ad-note-text").filter({ hasText: note }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".ad-note-text").filter({ hasText: note }),
  ).toBeVisible();
  // Requirements: smoke S2. After a reload the assignee is still the acting
  // user, in the page and in the stored alert.
  await expect(page.locator(".ad-marks .st-acknowledged")).toBeVisible();
  await expect(page.locator(".ad-marks .chip.b-neutral")).toHaveText(
    `${session.principal.display_name} (you)`,
  );
  const reloaded = await page.request.get(
    `/api/tenants/${tenant}/alerts/${alert}`,
  );
  expect(reloaded.status()).toBe(200);
  expect((await reloaded.json()).data.assignee_id).toBe(session.principal.id);
  await page.screenshot({
    path: resolve(state, "alert-detail.png"),
    fullPage: true,
  });
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/tenants/${tenant}/alerts`,
          { params: { cel: 'alert.display_status == "acknowledged"' } },
        );
        if (response.status() !== 200) return false;
        return (await response.json()).data.some(
          (item: { id: string }) => item.id === alert,
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  writeFileSync(
    resolve(state, "browser-evidence.json"),
    JSON.stringify(
      {
        tested_at: new Date().toISOString(),
        smoke_run: process.env.KEEP_SMOKE_RUN ?? null,
        tenant,
        alert,
        result: "passed",
        checks: [
          "real-username-password",
          "native-v1-admission",
          "native-v1-as-sent",
          "source-processing",
          "real-elasticsearch-feed",
          "live-hints-connected",
          "browser-acknowledgement",
          "browser-note",
          "assignee-after-reload",
          "updated-search",
        ],
      },
      null,
      2,
    ),
  );
});
