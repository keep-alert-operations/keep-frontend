"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import {
  integrationPath,
  integrationTestPath,
  type TicketCountIntegration,
  type TicketCountTest,
} from "@/lib/ticket-counts";
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
    </Page>
  );
}
