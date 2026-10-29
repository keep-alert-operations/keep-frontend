/** Opt-in real browser/API/PostgreSQL smoke. No route interception or app bypass. */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const adminUrl = process.env.APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL;
const frontend = resolve(__dirname, "..");
const repository = resolve(frontend, "../appchi-delivery");
const python =
  process.env.APPCHI_REAL_BROWSER_PYTHON ??
  join(
    repository,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );

// These synthetic identities and sessions exist only in a disposable test DB.
// Nothing in the application imports this fixture or accepts a test credential.
const fixture = String.raw`
import asyncio, base64, hashlib, ipaddress, json, os, re, secrets, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import psycopg
from psycopg import sql
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from appchi.db import Database
from appchi.migrate import migrate, migration_directory
from appchi.shared.crypto import EnvelopeCipher
from appchi.ingestion.kafka_admission import KafkaAdmission
from appchi.ingestion.native import canonical
from appchi.kafka_source import RECEIVE_LEAD_MARGIN, ReceiveTimeAhead, apply_record

class Capture:
    def __init__(self): self.records=[]
    async def publish(self, topic, key, value): self.records.append((topic,key,value))

name=os.environ['APPCHI_BROWSER_DATABASE_NAME']
if not re.fullmatch(r'appchi_browser_test_[a-f0-9]{16}', name):
    raise RuntimeError('Refusing an unexpected test database name')
action=sys.argv[1]
if action=='drop':
    with psycopg.connect(os.environ['APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL'], autocommit=True) as conn:
        conn.execute('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()', (name,))
        conn.execute(sql.SQL('DROP DATABASE IF EXISTS {}').format(sql.Identifier(name)))
elif action=='setup':
    with psycopg.connect(os.environ['APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL'], autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    dsn=os.environ['APPCHI_DATABASE_URL']
    migrate(dsn, migration_directory())
    cipher=EnvelopeCipher({'browser-test': b'k'*32}, 'browser-test')
    db=Database(dsn)
    principal=uuid4(); handle=secrets.token_urlsafe(32); csrf=secrets.token_urlsafe(32)
    hashed=hashlib.sha256(handle.encode()).digest()
    with db.transaction() as conn:
        conn.execute("UPDATE capability_gates SET ready=true WHERE capability='human_auth'")
        conn.execute("INSERT INTO principals(id,directory_source,object_id,kind,display_name,eligible,evidence_generation,verified_at) VALUES(%s,'browser-test',%s,'user','Synthetic browser user',true,1,clock_timestamp())", (principal,str(principal)))
        conn.execute("INSERT INTO auth_sessions(handle_hash,principal_id,issuer,subject,provider_sid,csrf_hash,csrf_cipher,auth_time,activity_at,absolute_at,deployment_epoch) VALUES(%s,%s,'https://synthetic.invalid',%s,%s,%s,%s,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour','browser-test')", (hashed,principal,str(principal),str(principal),hashlib.sha256(csrf.encode()).digest(),cipher.seal(csrf.encode(),'session-csrf:'+hashed.hex())))
        tenant=conn.execute("SELECT id FROM tenants WHERE kind='global'").fetchone()['id']
    native={'application':'browser-smoke-'+str(uuid4()),'object':'cpu','node_name':'synthetic-node','message':'Real database browser smoke','operator':'synthetic-legacy','time_created':'22-09-2026 12:00:00','severity':'error'}
    temp=Path(os.environ['APPCHI_BROWSER_TEMP'])
    # Kafka-first seed: the admission envelope a broker would carry, applied by
    # the source processor's own PostgreSQL step. No broker or receipt lookup.
    clock=temp/'clock.json'
    clock.write_text(json.dumps({'synchronized':True,'offset_seconds':0,'measured_at':datetime.now(timezone.utc).isoformat()}))
    config=SimpleNamespace(clock_health_file=clock,environment='browser-test',global_tenant_id=tenant,kafka_bootstrap=None)
    publisher=Capture()
    status,_=asyncio.run(KafkaAdmission(publisher,environment=config.environment,global_tenant_id=tenant).admit(canonical(native),'v1'))
    if status!=202: raise RuntimeError('Synthetic admission was not accepted')
    topic,key,value=publisher.records[-1]
    for attempt in range(4):
        try:
            changed=apply_record(db,topic=topic,partition=0,offset=0,key=key,value=value,settings=config,profile=None)
            break
        except ReceiveTimeAhead as ahead:
            # The receipt is stamped from this host's clock; wait out its lead.
            if attempt==3: raise
            time.sleep(ahead.lead+RECEIVE_LEAD_MARGIN)
    alert=json.loads(changed)['alert_id']
    db.close()
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    now=datetime.now(timezone.utc)
    subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
    certificate=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))
    (temp/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    (temp/'cert.pem').write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    print(json.dumps({'tenant':str(tenant),'alert':str(alert),'handle':handle}))
elif action=='verify':
    with psycopg.connect(os.environ['APPCHI_DATABASE_URL']) as conn:
        assignee,revision=conn.execute('SELECT assignee_id,revision FROM alerts WHERE id=%s',(os.environ['APPCHI_BROWSER_ALERT_ID'],)).fetchone()
        count=conn.execute('SELECT count(*) FROM alert_notes WHERE alert_id=%s AND text=%s AND NOT deleted',(os.environ['APPCHI_BROWSER_ALERT_ID'],'Real browser investigation note')).fetchone()[0]
        print(json.dumps({'assigned':assignee is not None,'revision':str(revision),'note_count':count}))
else: raise RuntimeError('Unknown fixture action')
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port allocated");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function launch(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  let log = "";
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (data: Buffer) => {
    log = (log + data.toString()).slice(-12000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => {
    log += error.message;
  });
  return { child, diagnostics: () => log };
}

async function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Terminate only the process tree started and retained by this fixture.
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* It may have exited during teardown. */
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function healthy(
  request: APIRequestContext,
  url: string,
  process: ReturnType<typeof launch>,
) {
  await expect
    .poll(
      async () => {
        if (process.child.exitCode !== null)
          throw new Error(`Test service exited: ${process.diagnostics()}`);
        try {
          return (await request.get(url, { timeout: 3000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 120000, intervals: [250, 500, 1000] },
    )
    .toBe(200);
}

type Stack = {
  seeded: { tenant: string; alert: string; handle: string };
  page: import("@playwright/test").Page;
  origin: string;
  environment: NodeJS.ProcessEnv;
};

/** Start a disposable database, API and UI, run `body`, then remove them all. */
async function withStack(
  browser: import("@playwright/test").Browser,
  playwright: {
    request: {
      newContext: (options: {
        ignoreHTTPSErrors: boolean;
      }) => Promise<APIRequestContext>;
    };
  },
  extra: Record<string, string>,
  body: (stack: Stack) => Promise<void>,
) {
  const databaseName = `appchi_browser_test_${randomBytes(8).toString("hex")}`;
  const dsn = new URL(adminUrl!);
  dsn.pathname = `/${databaseName}`;
  const temporary = mkdtempSync(join(tmpdir(), "appchi-real-browser-"));
  const backendPort = await freePort(),
    frontendPort = await freePort();
  const origin = `https://127.0.0.1:${frontendPort}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: "",
    APPCHI_BROWSER_DATABASE_NAME: databaseName,
    APPCHI_BROWSER_REPOSITORY: repository,
    APPCHI_BROWSER_TEMP: temporary,
    APPCHI_DATABASE_URL: dsn.href,
    APPCHI_WRAPPING_KEY: Buffer.alloc(32, "k").toString("base64"),
    APPCHI_WRAPPING_KEY_ID: "browser-test",
    APPCHI_DEPLOYMENT_EPOCH: "browser-test",
    APPCHI_PUBLIC_ORIGIN: origin,
    APPCHI_CAPACITY_PROFILE: join(
      repository,
      "qualification",
      "development-capacity.json",
    ),
    APPCHI_ENVIRONMENT: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    APPCHI_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
    ...extra,
  };
  let backendProcess: ReturnType<typeof launch> | undefined,
    frontendProcess: ReturnType<typeof launch> | undefined;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const health = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    const seeded = JSON.parse(
      execFileSync(python, ["-c", fixture, "setup"], {
        cwd: repository,
        env: environment,
        windowsHide: true,
        encoding: "utf8",
        timeout: 45000,
      }),
    ) as { tenant: string; alert: string; handle: string };
    backendProcess = launch(
      python,
      [
        "-m",
        "uvicorn",
        "appchi.main:create_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        String(backendPort),
        "--no-access-log",
      ],
      environment,
      repository,
    );
    await healthy(
      health,
      `http://127.0.0.1:${backendPort}/livez`,
      backendProcess,
    );
    frontendProcess = launch(
      process.execPath,
      [
        join(frontend, "node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(frontendPort),
        "--experimental-https",
        "--experimental-https-key",
        join(temporary, "key.pem"),
        "--experimental-https-cert",
        join(temporary, "cert.pem"),
      ],
      environment,
      frontend,
    );
    await healthy(health, origin, frontendProcess);
    await context.addCookies([
      {
        name: "__Host-appchi_session",
        value: seeded.handle,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await body({ seeded, page, origin, environment });
  } finally {
    await context.close();
    await health.dispose();
    await stop(frontendProcess?.child);
    await stop(backendProcess?.child);
    try {
      execFileSync(python, ["-c", fixture, "drop"], {
        cwd: repository,
        env: environment,
        windowsHide: true,
        encoding: "utf8",
        timeout: 60000,
      });
    } finally {
      // Verify the exact generated temporary root before any recursive removal.
      if (
        dirname(resolve(temporary)) !== resolve(tmpdir()) ||
        !basename(temporary).startsWith("appchi-real-browser-")
      )
        throw new Error("Unsafe fixture cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

test("real HTTPS browser acknowledges an admitted alert and commits its note to PostgreSQL", async ({
  browser,
  playwright,
}) => {
  test.skip(
    !adminUrl,
    "Opt in with APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL pointing to an isolated local PostgreSQL administrator database",
  );
  test.setTimeout(180000);
  await withStack(
    browser,
    playwright,
    {},
    async ({ seeded, page, origin, environment }) => {
      await page.goto(
        `${origin}/tenants/${seeded.tenant}/alerts/${seeded.alert}`,
      );
      await expect(
        page.getByRole("heading", {
          name: "Real database browser smoke",
          exact: true,
        }),
      ).toBeVisible();
      const acknowledged = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/alerts/${seeded.alert}/commands`) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Assign…", exact: true }).click();
      await page
        .getByRole("button", { name: "Assign to me", exact: true })
        .click();
      expect((await acknowledged).status()).toBe(200);
      await expect(page.locator(".ad-marks .st-acknowledged")).toBeVisible();
      await page
        .getByRole("textbox", { name: "Add a note", exact: true })
        .fill("Real browser investigation note");
      const note = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/alerts/${seeded.alert}/notes`) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Add note", exact: true }).click();
      expect((await note).status()).toBe(201);
      await expect(
        page
          .locator(".ad-note-text")
          .filter({ hasText: "Real browser investigation note" }),
      ).toBeVisible();
      const persisted = JSON.parse(
        execFileSync(python, ["-c", fixture, "verify"], {
          cwd: repository,
          env: { ...environment, APPCHI_BROWSER_ALERT_ID: seeded.alert },
          windowsHide: true,
          encoding: "utf8",
          timeout: 15000,
        }),
      );
      expect(persisted).toEqual({
        assigned: true,
        revision: "3",
        note_count: 1,
      });
    },
  );
});

/**
 * Requirements: REV-49; alert operations 29. Dismiss, change and undismiss on
 * the alert page against the real API and PostgreSQL, then let a one-minute
 * dismissal end by time alone.
 */
test("real HTTPS browser dismisses an alert for a time window and it returns on time", async ({
  browser,
  playwright,
}) => {
  test.skip(
    !adminUrl,
    "Opt in with APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL pointing to an isolated local PostgreSQL administrator database",
  );
  test.setTimeout(600000);
  await withStack(
    browser,
    playwright,
    { APPCHI_ALERT_DISMISSAL_ENABLED: "true" },
    async ({ seeded, page, origin }) => {
      const commands = (body: (value: Record<string, unknown>) => boolean) =>
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/alerts/${seeded.alert}/commands`) &&
            response.request().method() === "POST" &&
            body(response.request().postDataJSON()),
        );
      await page.goto(
        `${origin}/tenants/${seeded.tenant}/alerts/${seeded.alert}`,
      );
      await page.getByRole("button", { name: "Dismiss…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Dismiss alert" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "1 hour" })).toBeChecked();
      // The custom field is always shown; typing selects it.
      await dialog.getByRole("spinbutton", { name: "Custom" }).fill("90");
      await expect(
        dialog.getByRole("radio", { name: "1 hour" }),
      ).not.toBeChecked();
      await expect(dialog.getByRole("status")).toContainText(
        "in 1 hour 30 min",
      );
      await dialog.locator("label", { hasText: "Until a date" }).click();
      await dialog.getByLabel("Date", { exact: true }).fill("2020-01-01");
      await expect(dialog.getByRole("alert")).toContainText(
        "Choose a time after now",
      );
      await expect(
        dialog.getByRole("button", { name: "Dismiss", exact: true }),
      ).toBeDisabled();
      await page.screenshot({
        path: test.info().outputPath("dismiss-error.png"),
      });
      await dialog.locator("label", { hasText: "For a duration" }).click();
      await dialog.locator("label", { hasText: "4 hours" }).click();
      await dialog
        .getByRole("textbox", { name: /Reason/ })
        .fill("Known backlog; DBA is expanding the volume");
      await page.screenshot({
        path: test.info().outputPath("dismiss-dialog.png"),
      });
      const dismissed = commands((body) => body.kind === "set_dismissal");
      await dialog
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      const response = await dismissed;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().value).toEqual({
        duration_seconds: 14400,
        reason: "Known backlog; DBA is expanding the volume",
      });
      await expect(dialog).toBeHidden();
      const band = page.locator(".ad-dismissal");
      await expect(band).toContainText("Suppressed until");
      await expect(band).toContainText("in 4 hours");
      await expect(band).toContainText("Dismissed by Synthetic browser user (you)");
      await expect(page.locator(".ad-marks .chip-supp")).toHaveText(
        "Suppressed",
      );
      await expect(
        page.getByRole("button", { name: "Dismiss…", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("dismiss-band.png"),
        fullPage: true,
      });
      await page.reload();
      await expect(band).toContainText("in 4 hours");
      await expect(
        page.locator(".ad-note-text").filter({ hasText: "Known backlog" }),
      ).toBeVisible();

      // Change to a one-minute window, then let it end by time alone.
      await band.getByRole("button", { name: "Change…" }).click();
      const change = page.getByRole("dialog", { name: "Change dismissal" });
      await expect(
        change.getByRole("radio", { name: "Until a date" }),
      ).toBeChecked();
      await change.locator("label", { hasText: "For a duration" }).click();
      await change.getByRole("spinbutton", { name: "Custom" }).fill("1");
      const changed = commands((body) => body.kind === "set_dismissal");
      await change.getByRole("button", { name: "Update dismissal" }).click();
      expect((await changed).status()).toBe(200);
      await expect(band).toContainText("in 1 minute");
      await expect(band).toBeHidden({ timeout: 100000 });
      await expect(page.locator(".ad-marks .chip-supp")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Dismiss…", exact: true }),
      ).toBeVisible();

      // Undismiss ends a running dismissal at once.
      await page.getByRole("button", { name: "Dismiss…", exact: true }).click();
      const again = commands((body) => body.kind === "set_dismissal");
      await page
        .getByRole("dialog", { name: "Dismiss alert" })
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      expect((await again).status()).toBe(200);
      const undo = commands(
        (body) => body.kind === "set_dismissal" && body.value === null,
      );
      await band.getByRole("button", { name: "Undismiss" }).click();
      expect((await undo).status()).toBe(200);
      await expect(band).toBeHidden();
      await page.getByRole("tab", { name: /History/ }).click();
      await expect(page.locator(".tl")).toContainText("Dismissal ended early.");
      await expect(page.locator(".tl")).toContainText("Dismissal changed.");
      await expect(page.locator(".tl")).toContainText("Dismissed.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Dismiss…", exact: true }).click();
      await page.screenshot({
        path: test.info().outputPath("dismiss-narrow.png"),
      });
    },
  );
});
