/**
 * Keep's own sign-in page (REV-73) with synthetic Product API answers. These
 * cases do not reach LDAP or ADAPI; the local identity suite does.
 */
import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const session = {
  principal: {
    id: "00000000-0000-4000-8000-000000000099",
    display_name: "J Doe",
  },
  csrf_token: "test-csrf",
  global_super_admin: false,
  absolute_at: "2026-11-16T12:00:00Z",
  tenants: [
    { id: tenant, name: "Global", kind: "global", role: "edit", revision: "1" },
  ],
};

/** A signed-in workspace behind the page, and a count of session checks. */
async function workspace(page: Page) {
  const seen = { sessions: 0 };
  await page.route("**/auth/session", (route) => {
    seen.sessions++;
    return route.fulfill({ json: { data: session } });
  });
  await page.route("**/api/tenants/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: state\ndata: {"view_generation":"1"}\n\n',
      });
    if (path.endsWith("/view-state"))
      return route.fulfill({ json: { data: { view_generation: "1" } } });
    return route.fulfill({
      json: { data: [], meta: { total: "0" }, next_cursor: null },
    });
  });
  return seen;
}

async function fill(page: Page, username: string, password: string) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
}

/** The form's message (Next.js also renders an empty route-announcer alert). */
function message(page: Page) {
  return page.getByRole("alert").and(page.locator("#sign-in-error"));
}

function refuse(page: Page, status: number, code: string, message: string) {
  return page.route("**/auth/login", (route) =>
    route.fulfill({
      status,
      json: { error: { code, message, request_id: "req-1" } },
    }),
  );
}

/** Requirements: REV-73; identity configuration 2–3 and 5; plan A1, A24. */
test("signing in posts the username and password once and opens the return address", async ({
  page,
}) => {
  const seen = await workspace(page);
  const returnTo = `/tenants/${tenant}/alerts?view=mine`;
  let login: Request | undefined;
  await page.route("**/auth/login", (route) => {
    login = route.request();
    return route.fulfill({
      json: {
        data: { return_to: returnTo, absolute_at: session.absolute_at },
        meta: {},
      },
    });
  });
  await page.goto(`/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Username", { exact: true })).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  // The sign-in page never runs the workspace session check.
  expect(seen.sessions).toBe(0);
  await fill(page, "jdoe", "Pässwörd שלום 1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(returnTo);
  expect(login?.method()).toBe("POST");
  expect(login?.headers()["content-type"]).toContain("application/json");
  expect(login?.headers()["x-csrf-token"]).toBeUndefined();
  expect(login?.postDataJSON()).toEqual({
    username: "jdoe",
    password: "Pässwörd שלום 1",
    return_to: returnTo,
  });
  expect(login?.url()).not.toContain("Pässwörd");
  await expect(
    page.getByRole("button", { name: "Account: J Doe", exact: true }),
  ).toBeVisible();
});

/** Requirements: REV-73; identity configuration 3; plan A10. Before the page's
 * script runs, a click would submit the form natively: the served form posts
 * and its button is disabled, so a password never lands in the address. */
test("the served form posts and can't be submitted before the page is ready", async ({
  page,
}) => {
  const html = await (await page.request.get("/sign-in")).text();
  const form = html.match(/<form[^>]*class="sign-in-form"[^>]*>/)?.[0] ?? "";
  expect(form).toContain('method="post"');
  const submit =
    html.match(/<button[^>]*class="[^"]*sign-in-submit[^"]*"[^>]*>/)?.[0] ?? "";
  expect(submit).toContain("disabled");
  await workspace(page);
  await page.goto("/sign-in");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/sign-in$/);
});

/** Requirements: REV-73; identity configuration 3; plan A1. Someone who types
 * while the page's script is still loading keeps what they typed, and the
 * script, not the browser, sends it. */
test("what is typed before the page is ready is kept and sent", async ({
  page,
}) => {
  await workspace(page);
  let login: Request | undefined;
  await page.route("**/auth/login", (route) => {
    login = route.request();
    return route.fulfill({
      json: {
        data: { return_to: "/", absolute_at: session.absolute_at },
        meta: {},
      },
    });
  });
  const held: Route[] = [];
  let release = false;
  // Hold only scripts: a held stylesheet would also hold the HTML parser.
  await page.route("**/_next/static/**", (route) =>
    release || route.request().resourceType() !== "script"
      ? route.continue()
      : void held.push(route),
  );
  // The held scripts keep the load events from firing; the served form is there.
  await page.goto("/sign-in", { waitUntil: "commit" });
  const button = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await fill(page, "jdoe", "early-Pass-1");
  await expect(button).toBeDisabled();
  release = true;
  for (const route of held.splice(0)) await route.continue();
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(() => login?.postDataJSON())
    .toMatchObject({ username: "jdoe", password: "early-Pass-1" });
  expect(page.url()).not.toContain("early-Pass-1");
});

/** Requirements: REV-73; identity configuration 2. Only a local path is sent
 * or followed; anything else returns to the workspace root. */
test("an unsafe return address is neither sent nor followed", async ({
  page,
}) => {
  await workspace(page);
  let sent: unknown;
  await page.route("**/auth/login", (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      json: { data: { return_to: "https://elsewhere.invalid/" }, meta: {} },
    });
  });
  await page.goto(
    `/sign-in?return_to=${encodeURIComponent("//elsewhere.invalid/x")}`,
  );
  await fill(page, "jdoe", "secret");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tenants/${tenant}/alerts$`));
  expect(sent).toMatchObject({ return_to: null });
});

/** Requirements: REV-73; identity configuration 3; plan A2. One message for
 * every refusal, focused, with the password cleared and the fields marked. */
test("a wrong password shows one message and keeps the user on the page", async ({
  page,
}) => {
  await refuse(
    page,
    401,
    "authentication_rejected",
    "The username or password wasn't accepted.",
  );
  await page.goto("/sign-in");
  await fill(page, "jdoe", "wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const alert = message(page);
  await expect(alert).toHaveText(
    "The username or password wasn't accepted. Check them and try again.",
  );
  await expect(alert).toBeFocused();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(
    "jdoe",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});

/** Requirements: REV-73; identity configuration 3. */
for (const [code, text] of [
  ["account_not_in_directory", "Your account isn't in the company directory."],
  [
    "account_ambiguous",
    "More than one directory account has this username. Contact your administrator.",
  ],
]) {
  test(`a correct bind refused as ${code} shows its message`, async ({
    page,
  }) => {
    await refuse(page, 403, code, text);
    await page.goto("/sign-in");
    await fill(page, "jdoe", "right");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(message(page)).toContainText(text);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
      "right",
    );
  });
}

/** Requirements: REV-73; identity configuration 2–3 and 9; plan A5. */
test("an unavailable directory shows the unavailable message and retries", async ({
  page,
}) => {
  await refuse(
    page,
    503,
    "sign_in_unavailable",
    "Sign-in is unavailable right now. Try again shortly.",
  );
  await page.goto("/sign-in");
  await fill(page, "jdoe", "right");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(message(page)).toContainText(
    "Sign-in is unavailable right now. Try again in a moment.",
  );
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});

/** Requirements: REV-73; identity configuration 2 (an empty password never
 * reaches the Product API from this page); plan A3. */
test("empty fields are refused before any request, and the button shows progress", async ({
  page,
}) => {
  let posts = 0;
  let release: (() => void) | undefined;
  await page.route("**/auth/login", async (route) => {
    posts++;
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({
      status: 401,
      json: { error: { code: "authentication_rejected", message: "No" } },
    });
  });
  await page.goto("/sign-in");
  await page.getByLabel("Username", { exact: true }).fill("jdoe");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(message(page)).toHaveText("Enter your username and password.");
  expect(posts).toBe(0);
  await page.getByLabel("Password", { exact: true }).fill("secret");
  await page.getByLabel("Password", { exact: true }).press("Enter");
  const busy = page.getByRole("button", { name: "Signing in…", exact: true });
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => posts).toBe(1);
  release?.();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});

/** Requirements: REV-73; identity configuration 1 (password visibility). */
test("the password visibility control is a labelled toggle", async ({
  page,
}) => {
  await page.goto("/sign-in");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("secret");
  await expect(password).toHaveAttribute("type", "password");
  const show = page.getByRole("button", { name: "Show password" });
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await show.click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(
    page.getByRole("button", { name: "Hide password" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByText("Need help signing in?").click();
  await expect(
    page.getByText("contact your company’s IT support", { exact: false }),
  ).toBeVisible();
});

/** Requirements: REV-73; identity configuration 2; plan A24. A workspace
 * visit without a session lands on the sign-in page with its path and query. */
test("a 401 in the workspace lands on the sign-in page with the return address", async ({
  page,
}) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated", message: "Sign in" } },
    }),
  );
  const address = `/tenants/${tenant}/alerts?view=mine`;
  await page.goto(address);
  await expect(page).toHaveURL(
    `/sign-in?return_to=${encodeURIComponent(address)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

/** Requirements: REV-73; identity configuration 2 and 4; plan A24. A session
 * lost after admission keeps its recovery card, whose link keeps the address. */
test("a session lost in the workspace offers sign-in for the same address", async ({
  page,
}) => {
  await workspace(page);
  const address = `/tenants/${tenant}/alerts?view=mine`;
  await page.goto(address);
  await expect(
    page.getByRole("button", { name: "Account: J Doe", exact: true }),
  ).toBeVisible();
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated", message: "Sign in" } },
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toHaveAttribute(
    "href",
    `/sign-in?return_to=${encodeURIComponent(address)}`,
  );
  await expect(page.locator(".shell")).toHaveCount(0);
  await expect(
    page.getByText("Sessions last 24 hours.", { exact: false }),
  ).toBeVisible();
});
