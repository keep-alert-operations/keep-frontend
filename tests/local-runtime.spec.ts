/** Real interactive local stack: no request mocks or injected identity/session. */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

test.skip(
  process.env.APPCHI_LOCAL_RUNTIME_TEST !== "1",
  "Requires the running local runtime",
);

test("native alert reaches the real feed and supports browser acknowledgement and notes", async ({
  page,
}) => {
  const repository = resolve(__dirname, "../../appchi-delivery");
  const state = resolve(repository, ".local/runtime");
  mkdirSync(state, { recursive: true });
  const credentials = JSON.parse(
    readFileSync(
      resolve(repository, ".local/keycloak/credentials.json"),
      "utf8",
    ),
  );
  await page.goto("/auth/login");
  await page.locator("#username").fill("local-admin");
  await page
    .locator("#password")
    .fill(credentials.users["local-admin"].password);
  await page.locator("#kc-login").click();
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
    process.env.APPCHI_LOCAL_INGESTION_URL ?? "http://127.0.0.1:58001";
  const admission = await page.request.post(
    `${ingestion}/api/ingest/v1/alerts`,
    {
      data: {
        application: "Appchi local demo",
        object: "cpu",
        node_name: "demo-node-01",
        operator: "local-demo",
        message,
        severity: "warning",
        time_created: created,
        key_field: run,
      },
    },
  );
  expect(admission.status()).toBe(202);
  let alert = "";
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
        return Boolean(alert);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await page.screenshot({ path: resolve(state, "alerts.png"), fullPage: true });
  await page.goto(`/tenants/${tenant}/alerts/${alert}`);
  await expect(
    page.getByRole("heading", { name: message, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Assign…", exact: true }).click();
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
        tenant,
        alert,
        result: "passed",
        checks: [
          "real-username-password",
          "native-v1-admission",
          "source-processing",
          "real-elasticsearch-feed",
          "live-hints-connected",
          "browser-acknowledgement",
          "browser-note",
          "updated-search",
        ],
      },
      null,
      2,
    ),
  );
});
