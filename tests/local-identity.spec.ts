/** Opt-in actual local Keycloak username/password -> Appchi session acceptance. */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repository = resolve(__dirname, "../..");
function credentials() {
  return JSON.parse(
    readFileSync(
      resolve(repository, ".local/keycloak/credentials.json"),
      "utf8",
    ),
  );
}
function otp(username: string) {
  return execFileSync(
    resolve(repository, "backend/.venv/Scripts/python.exe"),
    [resolve(repository, "scripts/local_identity.py"), "otp", username],
    { encoding: "utf8" },
  ).trim();
}
const usedOtpSteps = new Map<string, number>();
async function freshOtp(username: string) {
  const step = Math.floor(Date.now() / 30000);
  if (usedOtpSteps.get(username) === step) {
    // Keycloak correctly rejects replay of a TOTP used by an earlier login.
    await new Promise((resolve) =>
      setTimeout(resolve, 30500 - (Date.now() % 30000)),
    );
  }
  usedOtpSteps.set(username, Math.floor(Date.now() / 30000));
  return otp(username);
}
async function signIn(page: Page, username: string) {
  await page.goto("/auth/login");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(credentials().users[username].password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL(/^https:\/\/localhost:3443\//);
  const response = await page.request.get("/auth/session");
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test.skip(
  process.env.APPCHI_LOCAL_IDENTITY_TEST !== "1",
  "Requires the isolated local identity stack",
);

for (const username of ["local-admin", "local-editor", "local-viewer"]) {
  test(`${username} signs in through actual Keycloak username and password only`, async ({
    page,
  }) => {
    const value = await signIn(page, username);
    // Do not print tokens, cookies, passwords or the private local fixture.
    expect(value.principal.display_name).toBe(
      credentials().users[username].label,
    );
    expect(value.global_super_admin).toBe(username === "local-admin");
  });
}

test("native groups give the local demo tenant admin, edit and view access", async ({
  page,
  browser,
}) => {
  const admin = await signIn(page, "local-admin");
  let tenant = admin.tenants.find(
    (item: { name: string }) => item.name === "Local Demo",
  );
  if (!tenant) {
    const grants = [];
    for (const [name, role] of [
      ["Appchi Administrators", "admin"],
      ["Developers", "edit"],
      ["Observers", "view"],
    ]) {
      const response = await page.request.get(
        "/api/admin/directory/principals",
        { params: { q: name } },
      );
      expect(response.ok()).toBeTruthy();
      const principal = (await response.json()).data.find(
        (item: { display_name: string }) => item.display_name === name,
      );
      expect(principal.selectable).toBe(true);
      grants.push({ principal_id: principal.id, role });
    }
    const created = await page.request.post("/api/tenants", {
      headers: {
        Origin: "https://localhost:3443",
        "X-CSRF-Token": admin.csrf_token,
      },
      data: {
        command_id: randomUUID(),
        name: "Local Demo",
        initial_grants: grants,
      },
    });
    expect(created.status()).toBe(201);
    tenant = (await created.json()).data;
  }
  for (const [username, role] of [
    ["local-editor", "edit"],
    ["local-viewer", "view"],
  ]) {
    const context = await browser.newContext({
      baseURL: "https://localhost:3443",
      ignoreHTTPSErrors: true,
    });
    try {
      const userPage = await context.newPage();
      const session = await signIn(userPage, username);
      expect(
        session.tenants.find((item: { id: string }) => item.id === tenant.id)
          ?.role,
      ).toBe(role);
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

test("live group removal changes access and signed provider logout revokes the session", async ({
  page,
  browser,
}) => {
  test.skip(
    !credentials().console_otp_secret,
    "Enroll the local console administrator TOTP first",
  );
  const viewer = await signIn(page, "local-viewer");
  const tenant = viewer.tenants.find(
    (item: { name: string }) => item.name === "Local Demo",
  );
  expect(tenant).toBeDefined();
  const consoleContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const consolePage = await consoleContext.newPage();
  let authorization = "";
  consolePage.on("request", (request) => {
    if (
      request.url().startsWith("https://localhost:58443/admin/") &&
      request.headers().authorization
    ) {
      authorization = request.headers().authorization;
    }
  });
  const local = credentials();
  const user = local.users["local-viewer"].id;
  const group = local.groups.Observers;
  const memberUrl = `https://localhost:58443/admin/realms/appchi-local/users/${user}/groups/${group}`;
  const settings = JSON.parse(
    readFileSync(
      resolve(repository, ".local/keycloak/app-environment.json"),
      "utf8",
    ),
  );
  function syncDirectory() {
    execFileSync(
      resolve(repository, "backend/.venv/Scripts/python.exe"),
      [
        "-m",
        "appchi.identity.local_keycloak_worker",
        "--config",
        resolve(repository, ".local/keycloak/directory.json"),
        "--once",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          ...settings,
          APPCHI_DATABASE_URL: settings.APPCHI_LOCAL_WORKER_DATABASE_URL,
        },
        stdio: "pipe",
        timeout: 15000,
      },
    );
  }
  try {
    await consolePage.goto("https://localhost:58443/admin/master/console/");
    await consolePage.locator("#username").fill(local.console_username);
    await consolePage.locator("#password").fill(local.console_password);
    await consolePage.locator("#kc-login").click();
    await consolePage
      .locator("#otp")
      .fill(await freshOtp(local.console_username));
    await consolePage.locator("#kc-login").click();
    await expect.poll(() => Boolean(authorization)).toBe(true);
    const headers = { Authorization: authorization };
    try {
      expect(
        (await consoleContext.request.delete(memberUrl, { headers })).status(),
      ).toBe(204);
      syncDirectory();
      expect(
        (await page.request.get(`/api/tenants/${tenant.id}`)).status(),
      ).toBe(404);
    } finally {
      expect(
        (await consoleContext.request.put(memberUrl, { headers })).status(),
      ).toBe(204);
      syncDirectory();
    }
    expect((await page.request.get(`/api/tenants/${tenant.id}`)).status()).toBe(
      200,
    );
    const logout = await consoleContext.request.post(
      `https://localhost:58443/admin/realms/appchi-local/users/${user}/logout`,
      { headers },
    );
    expect(logout.status()).toBe(204);
    await expect
      .poll(async () => (await page.request.get("/auth/session")).status(), {
        timeout: 10000,
      })
      .toBe(401);
  } finally {
    await consoleContext.close();
  }
});
