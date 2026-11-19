/**
 * Opt-in local sign-in acceptance against the real local stack: Keep's
 * `/sign-in` page, one OpenLDAP bind and the mock ADAPI (REV-73). No request
 * mocks, test login route or injected session.
 *
 * Requirements: REV-73; identity configuration 2-5, 10 and 14; plan A1, A2,
 * A8, A13 and A24. Smoke baseline S1 (keep-delivery development runbook,
 * "Critical smoke scenarios and expected results").
 *
 * `KEEP_LOCAL_DELIVERY_DIR` names the keep-delivery checkout that holds the
 * running stack's `.local` state; it defaults to the sibling checkout.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repository =
  process.env.KEEP_LOCAL_DELIVERY_DIR ??
  resolve(__dirname, "../../keep-delivery");
const origin = "https://localhost:3443";
const adapi = process.env.KEEP_LOCAL_ADAPI_URL ?? "http://127.0.0.1:58092";
const python =
  process.env.KEEP_LOCAL_IDENTITY_PYTHON ??
  resolve(repository, ".venv/Scripts/python.exe");
type Credentials = {
  users: Record<string, { password: string; label: string }>;
};
function credentials(): Credentials {
  return JSON.parse(
    readFileSync(
      resolve(repository, ".local/identity/credentials.json"),
      "utf8",
    ),
  );
}
async function signIn(page: Page, username: string, password?: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page
    .getByLabel("Password", { exact: true })
    .fill(password ?? credentials().users[username].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function signedIn(page: Page, username: string) {
  await signIn(page, username);
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page).toHaveURL(/^https:\/\/localhost:3443\//);
  const response = await page.request.get("/auth/session");
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
/** One trusted refresh, as `local-identity.ps1 -Action Refresh` runs it. */
function refreshDirectory() {
  const settings = JSON.parse(
    readFileSync(
      resolve(repository, ".local/identity/app-environment.json"),
      "utf8",
    ),
  );
  execFileSync(python, ["-m", "keep.worker", "directory", "--once"], {
    cwd: repository,
    env: {
      ...process.env,
      ...settings,
      KEEP_DATABASE_URL: settings.KEEP_LOCAL_WORKER_DATABASE_URL,
      KEEP_DIRECTORY_BOOTSTRAP_QUALIFIED: "false",
    },
    stdio: "pipe",
    timeout: 60000,
  });
}

test.skip(
  process.env.KEEP_LOCAL_IDENTITY_TEST !== "1",
  "Requires the isolated local identity stack",
);

for (const username of ["local-admin", "local-editor", "local-viewer"]) {
  test(`${username} signs in on the Keep sign-in page with username and password only`, async ({
    page,
  }) => {
    const value = await signedIn(page, username);
    // Do not print cookies, passwords or the private local fixture.
    expect(value.principal.display_name).toBe(
      credentials().users[username].label,
    );
    expect(value.global_super_admin).toBe(username === "local-admin");
    expect(value).not.toHaveProperty("refresh_uncertain");
  });
}

test("a wrong password is refused with one message and no session", async ({
  page,
}) => {
  const login = page.waitForResponse("**/auth/login");
  await signIn(page, "local-viewer", `not-the-password-${randomUUID()}`);
  // Requirements: smoke S1. The refusal is 401 authentication_rejected.
  const refused = await login;
  expect(refused.status()).toBe(401);
  expect((await refused.json()).error.code).toBe("authentication_rejected");
  await expect(
    page.getByRole("alert").filter({
      hasText: "The username or password wasn't accepted.",
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.get("/auth/session")).status()).toBe(401);
});

test("a signed-out visit opens the sign-in page and returns to the address", async ({
  page,
}) => {
  await page.goto("/tenants?view=local");
  await expect(page).toHaveURL(
    `${origin}/sign-in?return_to=${encodeURIComponent("/tenants?view=local")}`,
  );
  await page.getByLabel("Username", { exact: true }).fill("local-viewer");
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials().users["local-viewer"].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  expect((await page.request.get("/auth/session")).status()).toBe(200);
});

test("directory groups give the local demo tenant admin, edit and view access", async ({
  page,
  browser,
}) => {
  const admin = await signedIn(page, "local-admin");
  const headers = { Origin: origin, "X-CSRF-Token": admin.csrf_token };
  let tenant = admin.tenants.find(
    (item: { name: string }) => item.name === "Local Demo",
  );
  if (!tenant) {
    // REV-71: a tenant starts with no grants; its groups are saved on pick.
    const created = await page.request.post("/api/tenants", {
      headers,
      data: {
        command_id: randomUUID(),
        name: "Local Demo",
        initial_grants: [],
      },
    });
    expect(created.status()).toBe(201);
    tenant = (await created.json()).data;
    const operations = [];
    for (const [username, role] of [
      ["keep-administrators", "admin"],
      ["keep-developers", "edit"],
      ["keep-observers", "view"],
    ]) {
      const saved = await page.request.post(
        `/api/tenants/${tenant.id}/permission-principals/resolve`,
        { headers, data: { kind: "team", username } },
      );
      expect(saved.status()).toBe(200);
      const principal = (await saved.json()).data;
      expect(principal.selectable).toBe(true);
      operations.push({ principal_id: principal.id, action: "set", role });
    }
    const roster = await page.request.get(
      `/api/tenants/${tenant.id}/permissions`,
    );
    expect(roster.ok()).toBeTruthy();
    const granted = await page.request.patch(
      `/api/tenants/${tenant.id}/permissions`,
      {
        headers,
        data: {
          command_id: randomUUID(),
          expected_revision: (await roster.json()).meta.revision,
          operations,
        },
      },
    );
    expect(granted.ok()).toBeTruthy();
  }
  for (const [username, role] of [
    ["local-editor", "edit"],
    ["local-viewer", "view"],
  ]) {
    const context = await browser.newContext({
      baseURL: origin,
      ignoreHTTPSErrors: true,
    });
    try {
      const userPage = await context.newPage();
      const session = await signedIn(userPage, username);
      expect(
        session.tenants.find((item: { id: string }) => item.id === tenant.id)
          ?.role,
      ).toBe(role);
      // Requirements: smoke S1. Global keeps its separate edit baseline
      // for every eligible person, whatever their Local Demo role.
      expect(
        session.tenants.find((item: { kind: string }) => item.kind === "global")
          ?.role,
      ).toBe("edit");
      expect(
        (
          await userPage.request.get(`/api/tenants/${tenant.id}/permissions`)
        ).status(),
      ).toBe(403);
    } finally {
      await context.close();
    }
  }
});

test("a group change reaches access through the refresh, and sign-out is local", async ({
  page,
  browser,
}) => {
  const viewer = await signedIn(page, "local-viewer");
  const tenant = viewer.tenants.find(
    (item: { name: string }) => item.name === "Local Demo",
  );
  expect(tenant).toBeDefined();
  const membership = { group: "keep-observers", member: "local-viewer" };
  async function hook(body: Record<string, unknown>) {
    const response = await page.request.post(`${adapi}/__set`, { data: body });
    expect(response.status()).toBe(200);
  }
  try {
    await hook({ remove_member: membership });
    refreshDirectory();
    expect((await page.request.get(`/api/tenants/${tenant.id}`)).status()).toBe(
      404,
    );
  } finally {
    await hook({ add_member: membership });
    refreshDirectory();
  }
  expect((await page.request.get(`/api/tenants/${tenant.id}`)).status()).toBe(
    200,
  );
  await page.goto(`/tenants/${tenant.id}/alerts`);
  // Kept in memory only, to replay the signed-out session; never printed.
  const before = await page.context().cookies();
  const logout = page.waitForResponse("**/auth/logout");
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const answer = await logout;
  expect(answer.status()).toBe(200);
  expect((await answer.json()).data).not.toHaveProperty("logout_url");
  await expect(page).toHaveURL(`${origin}/signed-out`);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in",
  );
  expect((await page.request.get("/auth/session")).status()).toBe(401);
  // Requirements: smoke S1. The old session itself is revoked, not only the
  // browser's cookie: replaying it in a fresh context returns 401.
  const replay = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  try {
    await replay.addCookies(before);
    expect((await replay.request.get("/auth/session")).status()).toBe(401);
  } finally {
    await replay.close();
  }
});
