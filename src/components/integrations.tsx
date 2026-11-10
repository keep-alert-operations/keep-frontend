"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request, tenantPath } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import {
  integrationPath,
  integrationTestPath,
  type TicketCountIntegration,
  type TicketCountTest,
} from "@/lib/ticket-counts";
import {
  grafanaAdminSettings,
  grafanaIntegrationPath,
  type GrafanaPanelIntegration,
} from "@/lib/grafana-panel";
import {
  serviceNowBase,
  servicenowStatusPath,
  type ServiceNowStatus,
} from "@/lib/incident-ticket";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { Page, RelativeTime } from "./page";

/**
 * Administration › Integrations (REV-65, D2): a read-only view of the ticket
 * count service for global super admins. The address is deployment
 * configuration, so the page only shows its state and can test it.
 */
export function Integrations(scope: Scope) {
  if (!scope.session.global_super_admin)
    return (
      <Page
        scope={scope}
        title="Integrations"
        crumbs={[{ label: "Administration" }]}
        className="adm-page"
      >
        <div className="panel adm-notice-panel">
          <p className="notice">
            Integrations require global administration access.
          </p>
        </div>
      </Page>
    );
  return <TicketCountIntegrationPage scope={scope} />;
}

function TicketCountIntegrationPage({ scope }: { scope: Scope }) {
  const status = useResource<TicketCountIntegration>(
    integrationPath,
    scope.onDenied,
    scope.version,
  );
  const data = status.data?.data;
  const [test, setTest] = useState<{
    busy: boolean;
    result?: TicketCountTest;
    error?: unknown;
  }>({ busy: false });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  async function runTest() {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setTest({ busy: true });
    try {
      const response = await request<TicketCountTest>(integrationTestPath, {
        method: "POST",
        csrf: scope.session.csrf_token,
        signal: controller.signal,
        body: {},
      });
      if (controller.signal.aborted) return;
      setTest({ busy: false, result: response.data });
      status.reload();
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status))
        scope.onDenied();
      setTest({ busy: false, error: failure });
    }
  }
  const configured = data?.configured === true;
  return (
    <Page
      scope={scope}
      title="Integrations"
      crumbs={[{ label: "Administration" }]}
      role="Global super admin"
      extra={
        <span className="adm-subtitle">Shown only to global super admins</span>
      }
      className="adm-page"
    >
      <section className="panel int-card" aria-labelledby="int-ticket-count">
        <div className="int-head">
          <span className="int-icon" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v2M14 11v2M14 16v2" />
            </svg>
          </span>
          <div className="int-title">
            <h2 id="int-ticket-count">ServiceNow ticket count</h2>
            <p className="help">
              Lets dashboards show how many ServiceNow incidents each team has.
              Keep only asks the service for counts; it never creates or changes
              tickets.
            </p>
          </div>
          {data && (
            <span className={`chip ${configured ? "b-green" : "b-dash"}`}>
              {configured ? "Connected" : "Not configured"}
            </span>
          )}
        </div>
        {status.error ? <ErrorNotice error={status.error} /> : null}
        {status.loading && !data && (
          <p className="help" role="status">
            Checking the ticket count service…
          </p>
        )}
        {data && (
          <dl className="int-facts">
            <div>
              <dt>Host</dt>
              <dd className="mono">{data.host ?? "—"}</dd>
            </div>
            <div>
              <dt>Last answer</dt>
              <dd>
                {data.last_success_at ? (
                  <RelativeTime value={data.last_success_at} />
                ) : (
                  "None yet"
                )}
              </dd>
            </div>
            <div>
              <dt>Last error</dt>
              <dd>
                {data.last_failure_at ? (
                  <>
                    <RelativeTime value={data.last_failure_at} />
                    {data.last_error && (
                      <span className="int-error">{data.last_error}</span>
                    )}
                  </>
                ) : (
                  "None"
                )}
              </dd>
            </div>
          </dl>
        )}
        <div className="int-row">
          <button
            type="button"
            className="btn"
            disabled={!configured || test.busy}
            onClick={() => void runTest()}
          >
            {test.busy ? "Testing…" : "Test connection"}
          </button>
          {test.result && (
            <span
              className={`int-result ${test.result.ok ? "int-ok" : "int-bad"}`}
              role={test.result.ok ? "status" : "alert"}
            >
              {test.result.message} ·{" "}
              {/^(0|[1-9][0-9]*)$/.test(test.result.elapsed_ms)
                ? BigInt(test.result.elapsed_ms).toLocaleString()
                : test.result.elapsed_ms}{" "}
              ms
            </span>
          )}
          {test.error ? <ErrorNotice error={test.error} /> : null}
        </div>
        <p className="help int-note">
          The service address is set in Keep&apos;s deployment configuration (
          <span className="mono">KEEP_TICKET_COUNT_URL</span>), so it can&apos;t
          be changed here. Keep&apos;s server calls the service; browsers never
          do.
          {data && !configured
            ? " Until it is set, editors can't add ServiceNow panels and existing ones show that ServiceNow isn't connected."
            : ""}
        </p>
      </section>
      <GrafanaPanelsCard scope={scope} />
      <ServiceNowTicketsCard scope={scope} />
    </Page>
  );
}

const ini = (lines: string[]) => (
  <pre className="int-ini">{lines.join("\n")}</pre>
);

/**
 * Administration › Integrations › Grafana panels (REV-68): which Grafana editors
 * may frame, read-only because the list is deployment configuration, and the
 * settings Grafana's own admins need for framed panels to show.
 */
function GrafanaPanelsCard({ scope }: { scope: Scope }) {
  const status = useResource<GrafanaPanelIntegration>(
    grafanaIntegrationPath,
    scope.onDenied,
    scope.version,
  );
  const answer = status.data?.data;
  // An answer that doesn't match the contract isn't shown as settings.
  const data =
    answer &&
    typeof answer.enabled === "boolean" &&
    Array.isArray(answer.origins) &&
    Array.isArray(answer.ignored)
      ? answer
      : undefined;
  const unreadable = Boolean(answer) && !data;
  const enabled = data?.enabled === true && data.origins.length > 0;
  // Keep's own address, for the frame-ancestors setting.
  const [keepOrigin, setKeepOrigin] = useState("https://keep.example");
  useEffect(() => setKeepOrigin(window.location.origin), []);
  const [copied, setCopied] = useState<"done" | "failed">();
  async function copy() {
    try {
      await navigator.clipboard.writeText(grafanaAdminSettings(keepOrigin));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <section className="panel int-card" aria-labelledby="int-grafana">
      <div className="int-head">
        <span className="int-icon" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 4h16v16H4zM4 15l4.5-4.5 3.5 3 3.5-5L20 13" />
          </svg>
        </span>
        <div className="int-title">
          <h2 id="int-grafana">Grafana panels</h2>
          <p className="help">
            Lets editors show live Grafana panels on dashboards. Browsers load
            the panels straight from Grafana; Keep&apos;s server never contacts
            Grafana for them.
          </p>
        </div>
        {data && (
          <span className={`chip ${enabled ? "b-green" : "b-dash"}`}>
            {enabled ? "On" : "Off"}
          </span>
        )}
      </div>
      {status.error ? <ErrorNotice error={status.error} /> : null}
      {unreadable && (
        <p className="notice">
          Keep couldn&apos;t read the Grafana panel settings.
        </p>
      )}
      {status.loading && !answer && (
        <p className="help" role="status">
          Loading the allowed Grafana…
        </p>
      )}
      {data && (
        <div className="int-block">
          <span className="lbl">Allowed Grafana</span>
          {enabled ? (
            <table className="int-table">
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Panels allowed under</th>
                </tr>
              </thead>
              <tbody>
                {data.origins.map((entry) => {
                  const prefix = entry.path_prefix.replace(/\/+$/, "");
                  return (
                    <tr key={`${entry.origin}${prefix}`}>
                      <td className="mono">
                        {entry.origin}
                        {prefix}
                      </td>
                      <td className="mono">{prefix}/d-solo/…</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="help int-lead">
              No Grafana is allowed, so editors can&apos;t choose Grafana panel.
              Existing panels keep their settings and show &quot;Grafana panels
              are turned off&quot;.
            </p>
          )}
          {data.ignored.length > 0 && (
            <div className="banner bn-warn int-ignored" role="status">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
              </svg>
              <div>
                <span>
                  Keep ignored{" "}
                  {data.ignored.length === 1
                    ? "this entry"
                    : `these ${data.ignored.length} entries`}{" "}
                  in the configuration:
                </span>
                <ul>
                  {data.ignored.map((item, index) => (
                    <li key={`${item.entry}-${index}`}>
                      <span className="mono">{item.entry || "(empty)"}</span>
                      {": "}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <p className="help">
            Set in deployment configuration as{" "}
            <span className="mono">KEEP_GRAFANA_PANEL_ORIGINS</span>,
            comma-separated, https only. Keep can&apos;t change it here.
            Removing a Grafana blocks its panels at once.
          </p>
        </div>
      )}
      <div className="int-block int-grafana-admins">
        <div className="int-row">
          <span className="lbl int-grow">
            Settings your Grafana admins need
          </span>
          <button type="button" className="btn" onClick={() => void copy()}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
            Copy for Grafana admins
          </button>
        </div>
        <p className="help int-copied" role="status">
          {copied === "done"
            ? "Copied. Paste it into a message to your Grafana admins."
            : copied === "failed"
              ? "Couldn't copy. Select the settings below and copy them."
              : ""}
        </p>
        <ol className="int-steps">
          <li>
            <span>
              <b>Allow embedding</b>, or panels stay blank.
              {ini(["[security]", "allow_embedding = true"])}
            </span>
          </li>
          <li>
            <span>
              <b>Keep and Grafana on different sites?</b> A framed panel gets
              the viewer&apos;s Grafana sign-in only with these. Otherwise use
              Grafana&apos;s anonymous access.
              {ini([
                "[security]",
                "cookie_samesite = none",
                "cookie_secure = true",
              ])}
            </span>
          </li>
          <li>
            <span>
              <b>Limit who can frame Grafana</b> to Keep only.
              {ini([
                "[security]",
                "content_security_policy = true",
                `content_security_policy_template = """… frame-ancestors ${keepOrigin}; …"""`,
              ])}
            </span>
          </li>
          <li>
            <span>
              <b>Single sign-on pages</b> usually refuse to be framed. Viewers
              sign in to Grafana in another tab first.
            </span>
          </li>
        </ol>
        <div className="banner bn-info int-trust">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
          </svg>
          <span>
            Only allow Grafana you trust as much as Keep: a framed panel runs
            Grafana&apos;s scripts. What it shows follows each viewer&apos;s
            Grafana access, not Keep&apos;s tenants or roles.
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * ServiceNow tickets on incidents (REV-70): read-only, since the address is
 * deployment configuration (`KEEP_SERVICENOW_URL`).
 */
function ServiceNowTicketsCard({ scope }: { scope: Scope }) {
  const status = useResource<ServiceNowStatus>(
    servicenowStatusPath(tenantPath(scope.tenant.id)),
    scope.onDenied,
    scope.version,
  );
  const data = status.data?.data;
  const base = data?.configured === true ? serviceNowBase(data.base_url) : null;
  return (
    <section className="panel int-card" aria-labelledby="int-servicenow">
      <div className="int-head">
        <span className="int-icon" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v2M14 11v2M14 16v2" />
          </svg>
        </span>
        <div className="int-title">
          <h2 id="int-servicenow">ServiceNow tickets on incidents</h2>
          <p className="help">
            Lets incident editors link a ServiceNow ticket to an incident, or
            open ServiceNow&apos;s new incident form filled in from it.
            Keep&apos;s server never contacts ServiceNow; people&apos;s browsers
            open it.
          </p>
        </div>
        {data && (
          <span className={`chip ${base ? "b-green" : "b-neutral"}`}>
            {base ? "On" : "Off"}
          </span>
        )}
      </div>
      {status.error ? <ErrorNotice error={status.error} /> : null}
      {status.loading && !data && (
        <p className="help" role="status">
          Checking the ServiceNow address…
        </p>
      )}
      {data && base && (
        <dl className="int-facts int-facts-2">
          <div>
            <dt>ServiceNow address</dt>
            <dd className="mono">{data.base_url}</dd>
          </div>
          <div>
            <dt>New tickets open</dt>
            <dd>
              The new incident form, with Ticket Title and Description filled in
            </dd>
          </div>
        </dl>
      )}
      {data && !base && (
        <p className="help">
          No ServiceNow address is set, so incidents don&apos;t show the
          ServiceNow ticket row. Tickets linked earlier still show and can be
          unlinked.
        </p>
      )}
      <p className="help int-note">
        Set in deployment configuration as{" "}
        <span className="mono">KEEP_SERVICENOW_URL</span> (https only). Keep
        can&apos;t change it here. Only links to this address can be saved on
        incidents.
      </p>
    </section>
  );
}
