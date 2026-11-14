/** Opt-in actual local Authelia username/password -> Keep session acceptance. */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repository = resolve(__dirname, "../../keep-delivery");
// The delivery repo's local identity fixture generator owns this directory. It
// replaced the former `.local/keycloak` tree when Keycloak was dropped for the
// OpenLDAP + Authelia dev stack; confirm the exact path in keep-delivery.
const identityState = resolve(repository, ".local/identity");
function credentials() {
  return JSON.parse(
    readFileSync(resolve(identityState, "credentials.json"), "utf8"),
  );
}
async function signIn(page: Page, username: string) {
  await page.goto("/auth/login");
  // Authelia stock login portal selectors. The portal renders name="username"
  // and name="password" inputs and a sign-in submit button (#sign-in-button in
  // the current portal). These track Authelia's portal markup rather than
  // Keycloak's #kc-login form; confirm against the live portal if it changes.
  await page.locator('input[name="username"]').fill(username);
  await page
    .locator('input[name="password"]')
    .fill(credentials().users[username].password);
  await page.locator("#sign-in-button").click();
  // One-factor policy auto-redirects back to the application origin.
  await expect(page).toHaveURL(/^https:\/\/localhost:3443\//);
  const response = await page.request.get("/auth/session");
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test.skip(
  process.env.KEEP_LOCAL_IDENTITY_TEST !== "1",
  "Requires the isolated local identity stack",
);

for (const username of ["local-admin", "local-editor", "local-viewer"]) {
  test(`${username} signs in through actual Authelia username and password only`, async ({
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
      ["Keep Administrators", "admin"],
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

test("live group removal changes access and local logout ends the session", async ({
  page,
}) => {
  const viewer = await signIn(page, "local-viewer");
  const tenant = viewer.tenants.find(
    (item: { name: string }) => item.name === "Local Demo",
  );
  expect(tenant).toBeDefined();

  const local = credentials();
  // The local fixture now emits LDAP distinguished names instead of Keycloak
  // UUIDs. The user DN is removed from / restored to the Observers group entry's
  // `member` attribute directly in the dev OpenLDAP that backs Authelia.
  const ldap = local.ldap;
  const userDn = local.users["local-viewer"].dn;
  const groupDn = local.groups.Observers.dn;

  // Apply an LDIF membership change against the local OpenLDAP. This shells out
  // to the OpenLDAP client `ldapmodify`; if the client tools are not on PATH in
  // the dev environment, run it inside the OpenLDAP container instead
  // (e.g. `docker exec <openldap> ldapmodify ...`). Connection + admin bind
  // parameters come from the local fixture. Confirm the group schema uses the
  // `member` attribute (groupOfNames) against the live directory.
  function setMembership(action: "delete" | "add") {
    const ldif = [
      `dn: ${groupDn}`,
      "changetype: modify",
      `${action}: member`,
      `member: ${userDn}`,
      "",
    ].join("\n");
    execFileSync(
      "ldapmodify",
      ["-x", "-H", ldap.uri, "-D", ldap.bind_dn, "-w", ldap.bind_password],
      { input: ldif, stdio: "pipe", timeout: 15000 },
    );
  }

  const settings = JSON.parse(
    readFileSync(resolve(identityState, "app-environment.json"), "utf8"),
  );
  // Re-sync through the production Keep LDAP directory worker (the same module
  // used in deployment, run once), NOT the removed local Keycloak worker and NOT
  // any identity-provider admin REST API.
  function syncDirectory() {
    execFileSync(
      resolve(repository, ".venv/Scripts/python.exe"),
      [
        "-m",
        "keep.identity.worker",
        "--config",
        resolve(identityState, "directory.json"),
        "--once",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          ...settings,
          KEEP_DATABASE_URL: settings.KEEP_LOCAL_WORKER_DATABASE_URL,
        },
        stdio: "pipe",
        timeout: 15000,
      },
    );
  }

  try {
    setMembership("delete");
    syncDirectory();
    expect((await page.request.get(`/api/tenants/${tenant.id}`)).status()).toBe(
      404,
    );
  } finally {
    setMembership("add");
    syncDirectory();
  }
  expect((await page.request.get(`/api/tenants/${tenant.id}`)).status()).toBe(
    200,
  );

  // Back-channel provider logout is no longer relied upon. Assert the retained
  // local logout: after /auth/logout the opaque session is cleared and
  // /auth/session answers 401. (RP-initiated end_session still redirects the
  // browser to Authelia, but no back-channel logout token is asserted here.)
  const logout = await page.request.post("/auth/logout", {
    headers: {
      Origin: "https://localhost:3443",
      "X-CSRF-Token": viewer.csrf_token,
    },
  });
  expect(logout.ok()).toBeTruthy();
  await expect
    .poll(async () => (await page.request.get("/auth/session")).status(), {
      timeout: 10000,
    })
    .toBe(401);
});
