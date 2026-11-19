/**
 * Opt-in smoke baseline S4 (manual incident lifecycle) against the real local
 * stack, as local-editor through the normal HTTPS UI: create an incident with
 * an explicit severity, link an unowned alert, add a note, resolve and reopen,
 * reloading after each step. No request mocks or injected session.
 *
 * Requirements: smoke S4 (keep-delivery development runbook, "Critical smoke
 * scenarios and expected results"); incident operations (keep-design
 * spec-incident-operations.md): manual creation, membership, notes,
 * resolve/reopen cycles and immutable severity.
 *
 * The alert comes from this run's S2 (`KEEP_SMOKE_S2_ALERT`) when no active
 * incident owns it; otherwise the spec sends its own v1 alert. It never takes
 * an alert from another incident: if its own alert is owned too, the ledger
 * records `blocked` with the owner. Everything this run creates is recorded in
 * the ledger (`KEEP_SMOKE_LEDGER`) before it is changed, and cleanup touches
 * only the ledger's incident. `KEEP_SMOKE_S4_CLEANUP=1` runs that cleanup alone
 * for a ledger an interrupted run left behind.
 */
import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
} from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const repository =
  process.env.KEEP_LOCAL_DELIVERY_DIR ??
  resolve(__dirname, "../../keep-delivery");
const origin = "https://localhost:3443";
const ingestion =
  process.env.KEEP_LOCAL_INGESTION_URL ?? "http://127.0.0.1:58001";
const run = process.env.KEEP_SMOKE_RUN ?? randomUUID();
const ledgerPath =
  process.env.KEEP_SMOKE_LEDGER ??
  resolve(repository, `.local/verification/${run}/s4.json`);

type Ledger = {
  run: string;
  tenant_id?: string;
  alert_id?: string;
  alert_source?: "s2" | "own";
  s2_alert_owner?: string | null;
  alert_status_before?: string;
  incident_id?: string;
  title: string;
  outcome: "running" | "passed" | "failed" | "blocked";
  reason?: string;
  steps: string[];
  cleaned: boolean;
  cleanup?: string;
};
type Session = {
  csrf_token: string;
  principal: { id: string };
  tenants: { id: string; kind: string; role: string }[];
};

function save(ledger: Ledger) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

async function signIn(page: Page): Promise<Session> {
  const credentials = JSON.parse(
    readFileSync(
      resolve(repository, ".local/identity/credentials.json"),
      "utf8",
    ),
  );
  await page.goto("/sign-in");
  await page.getByLabel("Username", { exact: true }).fill("local-editor");
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials.users["local-editor"].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  const response = await page.request.get("/auth/session");
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

/** Fails with the step, HTTP status and error code (never a body with secrets). */
async function expectOk(response: APIResponse | Response, step: string) {
  if (response.ok()) return;
  let code = "";
  try {
    code = String((await response.json()).error?.code ?? "");
  } catch {
    code = "no JSON body";
  }
  throw new Error(`${step} returned ${response.status()} ${code}`.trim());
}

/** Opens the Notes tab of the incident records and finds the note. */
async function showsNote(page: Page, note: string) {
  await page.getByRole("tab", { name: /^Notes/ }).click();
  await expect(
    page.locator("#inc-pane-notes .inc-note-text").filter({ hasText: note }),
  ).toBeVisible();
}

async function read(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data;
}

async function linkedIds(
  request: APIRequestContext,
  tenant: string,
  incident: string,
): Promise<string[]> {
  const rows = await read(
    request,
    `/api/tenants/${tenant}/incidents/${incident}/alerts`,
  );
  return rows.map((row: Record<string, unknown>) =>
    String(row.alert_id ?? row.id),
  );
}

/**
 * Unlinks the ledger's alert while the ledger's incident is active, then
 * resolves that incident (development runbook, S4 cleanup). Refuses any
 * incident whose title is not the one this run created.
 */
async function cleanup(page: Page, session: Session, ledger: Ledger) {
  if (!ledger.incident_id || !ledger.tenant_id) {
    ledger.cleaned = true;
    ledger.cleanup = "nothing created";
    save(ledger);
    return;
  }
  const base = `/api/tenants/${ledger.tenant_id}/incidents/${ledger.incident_id}`;
  const headers = { Origin: origin, "X-CSRF-Token": session.csrf_token };
  let incident = await read(page.request, base);
  if (incident.title !== ledger.title)
    throw new Error(
      `Refusing cleanup: incident ${ledger.incident_id} is not this run's`,
    );
  const steps: string[] = [];
  if (incident.status !== "resolved") {
    if (
      ledger.alert_id &&
      (
        await linkedIds(page.request, ledger.tenant_id, ledger.incident_id)
      ).includes(ledger.alert_id)
    ) {
      const unlinked = await page.request.post(`${base}/alerts/unlink`, {
        headers,
        data: {
          command_id: randomUUID(),
          expected_revision: incident.revision,
          alert_ids: [ledger.alert_id],
        },
      });
      await expectOk(unlinked, "cleanup unlink");
      steps.push("unlinked alert");
      incident = await read(page.request, base);
    }
    const resolved = await page.request.post(`${base}/status`, {
      headers,
      data: {
        command_id: randomUUID(),
        expected_revision: incident.revision,
        status: "resolved",
      },
    });
    await expectOk(resolved, "cleanup resolve");
    steps.push("resolved incident");
  } else {
    steps.push("already resolved");
  }
  ledger.cleaned = true;
  ledger.cleanup = steps.join(", ");
  save(ledger);
}

/** The run's alert, or `blocked` when every candidate has an active owner. */
async function chooseAlert(page: Page, session: Session, ledger: Ledger) {
  const s2Alert = process.env.KEEP_SMOKE_S2_ALERT;
  const tenant =
    process.env.KEEP_SMOKE_S2_TENANT ??
    session.tenants.find((item) => item.kind === "global")!.id;
  ledger.tenant_id = tenant;
  if (s2Alert) {
    const alert = await read(
      page.request,
      `/api/tenants/${tenant}/alerts/${s2Alert}`,
    );
    ledger.s2_alert_owner = alert.active_incident_id ?? null;
    if (!alert.active_incident_id) {
      ledger.alert_id = s2Alert;
      ledger.alert_source = "s2";
      ledger.alert_status_before = alert.status;
      return alert;
    }
  }
  // Own synthetic v1 alert, like S2's, tagged with this run.
  const message = `smoke-${run} incident alert`;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const created = `${pad(now.getUTCDate())}-${pad(now.getUTCMonth() + 1)}-${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
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
        key_field: `smoke-${run}`,
      },
    },
  );
  expect(admission.status()).toBe(202);
  let alert: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/tenants/${tenant}/alerts`,
          { params: { q: `smoke-${run}` } },
        );
        if (response.status() !== 200) return false;
        alert = (await response.json()).data.find(
          (item: { message: string }) => item.message === message,
        );
        return Boolean(alert);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const stored = await read(
    page.request,
    `/api/tenants/${tenant}/alerts/${alert!.id}`,
  );
  ledger.alert_id = String(stored.id);
  ledger.alert_source = "own";
  ledger.alert_status_before = stored.status;
  if (stored.active_incident_id) {
    ledger.outcome = "blocked";
    ledger.reason = `alert ${stored.id} already belongs to incident ${stored.active_incident_id}`;
    save(ledger);
    throw new Error(`S4 blocked: ${ledger.reason}`);
  }
  return stored;
}

test.skip(
  process.env.KEEP_LOCAL_INCIDENT_TEST !== "1",
  "Requires the running local stack",
);

if (process.env.KEEP_SMOKE_S4_CLEANUP === "1") {
  test("cleanup of an interrupted run touches only the ledger's incident", async ({
    page,
  }) => {
    const ledger: Ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const session = await signIn(page);
    await cleanup(page, session, ledger);
  });
} else {
  test("an editor creates, links, notes, resolves and reopens an incident", async ({
    page,
  }) => {
    const ledger: Ledger = {
      run,
      title: `smoke-${run} incident`,
      outcome: "running",
      steps: [],
      cleaned: false,
    };
    save(ledger);
    const session = await signIn(page);
    try {
      const alert = await chooseAlert(page, session, ledger);
      const tenant = ledger.tenant_id!;
      const alertId = ledger.alert_id!;
      expect(session.tenants.find((item) => item.id === tenant)?.role).toBe(
        "edit",
      );
      save(ledger);

      // Create with an explicit severity: open and unassigned.
      await page.goto(`/tenants/${tenant}/incidents`);
      await page
        .getByRole("link", { name: "New incident", exact: true })
        .click();
      await page.getByLabel("Title", { exact: true }).fill(ledger.title);
      await page
        .getByLabel("Description (optional)")
        .fill(`smoke-${run}: created by the S4 smoke journey.`);
      await page.getByRole("radio", { name: "Low", exact: true }).click();
      const creating = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/api/tenants/${tenant}/incidents`),
      );
      await page
        .getByRole("button", { name: "Create incident", exact: true })
        .click();
      const created = await creating;
      await expectOk(created, "create");
      const id = String((await created.json()).data.id);
      ledger.incident_id = id;
      ledger.steps.push("created");
      save(ledger);
      const base = `/api/tenants/${tenant}/incidents/${id}`;
      await expect(page).toHaveURL(new RegExp(`/incidents/${id}$`));
      const status = page.getByRole("group", { name: "Status" });
      await expect(
        status.getByRole("button", { name: "Open", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      let incident = await read(page.request, base);
      expect(incident.status).toBe("open");
      expect(incident.assignee_id ?? null).toBeNull();
      expect(incident.severity).toBe("low");
      expect(incident.origin).toBe("manual");

      // Link the run's alert on detail.
      await page
        .getByRole("button", { name: "Link alerts…", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Link alerts" });
      await dialog.getByText("Enter known alert IDs").click();
      await dialog
        .getByLabel("Alert IDs, separated by spaces or newlines")
        .fill(alertId);
      const linking = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`${base}/alerts/link`),
      );
      await dialog
        .getByRole("button", { name: "Link selected alerts", exact: true })
        .click();
      await expectOk(await linking, "link");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      ledger.steps.push("linked");
      save(ledger);

      // Reload: the link persists, and the note composer starts from the
      // incident revision after the link.
      const linkedTable = page.getByRole("table", { name: "Linked alerts" });
      const alertTitle = String(
        alert.name ?? alert.message ?? alert.application,
      );
      await page.reload();
      await expect(linkedTable.getByText(alertTitle).first()).toBeVisible();

      // A uniquely tagged note.
      const note = `smoke-${run} note`;
      await page.getByLabel("New incident note", { exact: true }).fill(note);
      const noting = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`${base}/notes`),
      );
      await page.getByRole("button", { name: "Add note", exact: true }).click();
      await expectOk(await noting, "note");
      await showsNote(page, note);
      ledger.steps.push("noted");

      // Reload: link, note and severity persist.
      await page.reload();
      await showsNote(page, note);
      await expect(linkedTable.getByText(alertTitle).first()).toBeVisible();
      await expect(page.locator(".inc-head-sev")).toHaveText("Low");
      expect(await linkedIds(page.request, tenant, id)).toContain(alertId);
      const owned = await read(
        page.request,
        `/api/tenants/${tenant}/alerts/${alertId}`,
      );
      expect(owned.active_incident_id).toBe(id);

      // Resolve: the alert's own status does not change.
      const resolving = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`${base}/status`),
      );
      await status
        .getByRole("button", { name: "Resolved", exact: true })
        .click();
      await expectOk(await resolving, "resolve");
      await page.reload();
      await expect(
        status.getByRole("button", { name: "Resolved", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByText("Reopen the incident to change its links."),
      ).toBeVisible();
      incident = await read(page.request, base);
      expect(incident.status).toBe("resolved");
      expect(incident.severity).toBe("low");
      const afterResolve = await read(
        page.request,
        `/api/tenants/${tenant}/alerts/${alertId}`,
      );
      expect(afterResolve.status).toBe(ledger.alert_status_before);
      ledger.steps.push("resolved");
      save(ledger);

      // Reopen: a new cycle that keeps the link and the history.
      const reopening = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`${base}/status`),
      );
      await status.getByRole("button", { name: "Open", exact: true }).click();
      await expectOk(await reopening, "reopen");
      await page.reload();
      await expect(
        status.getByRole("button", { name: "Open", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await showsNote(page, note);
      await expect(linkedTable.getByText(alertTitle).first()).toBeVisible();
      incident = await read(page.request, base);
      expect(incident.status).toBe("open");
      expect(incident.severity).toBe("low");
      expect(await linkedIds(page.request, tenant, id)).toContain(alertId);
      const cycles = await read(page.request, `${base}/cycles`);
      expect(cycles.length).toBeGreaterThanOrEqual(2);
      const activity = await read(page.request, `${base}/activity`);
      expect(activity.length).toBeGreaterThan(0);
      ledger.steps.push("reopened");
      ledger.outcome = "passed";
      save(ledger);
    } catch (failure) {
      if (ledger.outcome === "running") {
        ledger.outcome = "failed";
        // Plain text for the report: drop the terminal colour codes.
        ledger.reason = (
          failure instanceof Error ? failure.message : String(failure)
        ).replace(/\u001b\[[0-9;]*m/g, "");
        save(ledger);
      }
      throw failure;
    } finally {
      await cleanup(page, session, ledger);
    }
  });
}
