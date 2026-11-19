/**
 * Opt-in browser step of smoke baseline S3 (native v2 isolation) against the
 * real local stack: after `local_v2_verify.py send`, every alert it recorded is
 * shown in Local Demo's Feed and detail, and the same IDs under Global return
 * 404 with no detail. No request mocks or injected session.
 *
 * Requirements: smoke S3 (keep-delivery development runbook, "Critical smoke
 * scenarios and expected results"); REV-54 alert names; tenant isolation of
 * alert detail.
 *
 * `KEEP_LOCAL_DELIVERY_DIR` names the keep-delivery checkout that holds the
 * running stack's `.local` state. `KEEP_SMOKE_S3_RUN` (optional) is the sender
 * run the evidence must come from, so stale evidence fails instead of passing.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repository =
  process.env.KEEP_LOCAL_DELIVERY_DIR ??
  resolve(__dirname, "../../keep-delivery");

type Evidence = {
  tenant_id: string;
  alert_ids: string[];
  run: string;
  count: number;
  global_detail_denied: boolean;
};

test.skip(
  process.env.KEEP_LOCAL_V2_BROWSER_TEST !== "1",
  "Requires the running local v2 stack and a fresh local_v2_verify.py send",
);

test("the sent v2 alerts show in Local Demo and stay hidden under Global", async ({
  page,
}) => {
  const evidence: Evidence = JSON.parse(
    readFileSync(
      resolve(repository, ".local/operators/alerts-evidence.json"),
      "utf8",
    ),
  );
  const expectedRun = process.env.KEEP_SMOKE_S3_RUN;
  if (expectedRun) expect(evidence.run).toBe(expectedRun);
  expect(evidence.alert_ids.length).toBeGreaterThanOrEqual(3);
  expect(evidence.global_detail_denied).toBe(true);
  const credentials = JSON.parse(
    readFileSync(
      resolve(repository, ".local/identity/credentials.json"),
      "utf8",
    ),
  );
  await page.goto("/sign-in");
  await page.getByLabel("Username", { exact: true }).fill("local-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials.users["local-admin"].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  const sessionResponse = await page.request.get("/auth/session");
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()).data;
  const demo = evidence.tenant_id;
  expect(session.tenants.some((item: { id: string }) => item.id === demo)).toBe(
    true,
  );
  const global = session.tenants.find(
    (item: { kind: string }) => item.kind === "global",
  ).id;
  expect(global).not.toBe(demo);

  // The stored records give the titles the browser must show (REV-54).
  const titles = new Map<string, string>();
  for (const id of evidence.alert_ids) {
    const response = await page.request.get(
      `/api/tenants/${demo}/alerts/${id}`,
    );
    expect(response.status()).toBe(200);
    const alert = (await response.json()).data;
    expect(alert.node_name).toBe(evidence.run);
    titles.set(id, String(alert.name ?? alert.message ?? alert.application));
  }

  // Feed: the run's alerts, found with the same CEL the helper uses.
  await page.goto(`/tenants/${demo}/alerts`);
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("CEL expression", { exact: true })
    .fill(`alert.node_name == "${evidence.run}"`);
  await page.getByRole("button", { name: "Run query" }).click();
  for (const title of new Set(titles.values())) {
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  }

  // Detail works in the owning tenant only.
  for (const [id, title] of titles) {
    await page.goto(`/tenants/${demo}/alerts/${id}`);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    const details = page.getByRole("region", { name: "Details" });
    await expect(
      details.locator(".fld", { hasText: "Node name" }).locator("dd"),
    ).toHaveText(evidence.run);

    const hidden = await page.request.get(
      `/api/tenants/${global}/alerts/${id}`,
    );
    expect(hidden.status()).toBe(404);
    await page.goto(`/tenants/${global}/alerts/${id}`);
    await expect(
      page.getByRole("heading", { name: "Alert unavailable", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(0);
  }
});
