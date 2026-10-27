"use client";
import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { Tenant, timestamp } from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import { CommandFeedback, ErrorNotice } from "./ui";
import { AuditBrowser } from "./audit-browser";
import { Page } from "./page";
import type { Scope } from "./workspace";

interface ProcessingHealth {
  blocked: boolean;
  block_generation: string;
  failures?: string;
  head?: { id: string; received_at: string; admission_order: string } | null;
  last_repair?: {
    recorded_at: string;
    outcome: string;
    proof_code: string | null;
  } | null;
}

const words = (value: unknown) => {
  const text = typeof value === "string" ? value.replaceAll(/[-_]/g, " ") : "";
  return text ? text[0].toUpperCase() + text.slice(1) : "—";
};

/** Records when a resource last loaded successfully. */
function useCheckedAt(data: unknown) {
  const [at, setAt] = useState<string>();
  useEffect(() => {
    if (data !== undefined) setAt(new Date().toISOString());
  }, [data]);
  return at;
}

function ErrorIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16h.01" />
    </svg>
  );
}
function OkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}

function SourceRepair({
  scope,
  onDirty,
}: {
  scope: Scope;
  onDirty: (dirty: boolean) => void;
}) {
  const [tenantId, setTenantId] = useState(scope.tenant.id);
  const target =
    scope.session.tenants.find((tenant) => tenant.id === tenantId) ??
    scope.tenant;
  const path = `/api/admin/tenants/${target.id}/processing`;
  const health = useResource<ProcessingHealth>(
    path,
    scope.onDenied,
    scope.version,
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [reason, setReason] = useState("");
  const [generation, setGeneration] = useState<string>();
  const [resumed, setResumed] = useState(false);
  const reasonId = useId();
  const checked = useCheckedAt(health.data);
  useEffect(() => {
    onDirty(!!reason);
  }, [reason, onDirty]);
  const state =
    health.data?.data && typeof health.data.data === "object"
      ? health.data.data
      : undefined;
  const failures =
    typeof state?.failures === "string" && /^\d+$/.test(state.failures)
      ? state.failures
      : null;
  return (
    <section className="panel" aria-label="Source processing">
      <div className="panel-h">
        <h2>Source processing</h2>
        <div className="adm-spacer" />
        {scope.session.tenants.length > 1 && (
          <>
            <label className="sr-only" htmlFor={`${reasonId}-tenant`}>
              Tenant
            </label>
            <select
              id={`${reasonId}-tenant`}
              className="inp adm-tenant-select"
              value={target.id}
              disabled={!!reason || command.busy || command.uncertain}
              title={
                reason
                  ? "Clear the repair reason before choosing another tenant."
                  : undefined
              }
              onChange={(event) => {
                setTenantId(event.target.value);
                setGeneration(undefined);
                setResumed(false);
              }}
            >
              {scope.session.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <div className="adm-stack">
        <ErrorNotice error={health.error} />
        {health.loading && !state && (
          <p role="status" className="adm-note">
            Checking processing…
          </p>
        )}
        {state && (
          <>
            {state.blocked ? (
              <div className="banner bn-err adm-banner-top">
                <ErrorIcon />
                <span>
                  <b>Processing is blocked</b> for {target.name}
                  {failures ? ` after ${failures} consecutive failures` : ""}.
                  New source events wait in the queue until processing resumes.
                  Repair the reported condition before requesting a retry.
                </span>
              </div>
            ) : (
              <div className="banner bn-ok adm-banner-top" role="status">
                <OkIcon />
                <span>
                  <b>Source processing is running</b> for {target.name}. Nothing
                  is waiting on a repair.
                </span>
              </div>
            )}
            <dl className="adm-fields">
              {state.blocked && (
                <>
                  <div className="fld">
                    <dt>Oldest queued item received</dt>
                    <dd className={state.head ? "mono" : undefined}>
                      {state.head
                        ? timestamp(state.head.received_at)
                        : "No queued item"}
                    </dd>
                  </div>
                  <div className="fld">
                    <dt>Admission order</dt>
                    <dd className="mono">
                      {state.head?.admission_order ?? "—"}
                    </dd>
                  </div>
                </>
              )}
              <div className="fld">
                <dt>Last repair</dt>
                <dd>
                  {state.last_repair
                    ? `${words(state.last_repair.outcome)}${state.last_repair.proof_code ? ` · ${words(state.last_repair.proof_code)}` : ""} · ${timestamp(state.last_repair.recorded_at)}`
                    : state.blocked
                      ? "None for this block"
                      : "None recorded"}
                </dd>
              </div>
              <div className="fld">
                <dt>Status checked</dt>
                <dd className="mono">{checked ? timestamp(checked) : "—"}</dd>
              </div>
            </dl>
            {(state.blocked || command.uncertain) && (
              <form
                className="adm-stack"
                style={{ padding: 0 }}
                onSubmit={async (event) => {
                  event.preventDefault();
                  const result = await command.execute(path + "/retry", {
                    expected_block_generation:
                      generation ?? state.block_generation,
                    reason,
                  });
                  if (result) {
                    setResumed(true);
                    setReason("");
                    setGeneration(undefined);
                    health.reload();
                  }
                }}
              >
                <div className="f">
                  <label className="lbl" htmlFor={reasonId}>
                    Repair reason
                  </label>
                  <textarea
                    id={reasonId}
                    className="inp"
                    rows={2}
                    required
                    maxLength={1000}
                    placeholder="What was fixed, so the audit trail explains the resume"
                    value={reason}
                    disabled={command.busy || command.uncertain}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setGeneration(generation ?? state.block_generation);
                      setResumed(false);
                    }}
                  />
                  <span className="help">
                    The server checks the same queued item before resuming it.
                    This action does not skip or discard alerts.
                  </span>
                </div>
                <CommandFeedback command={command} />
                <div className="adm-op-line" style={{ gap: 8 }}>
                  <button
                    className="btn btn-p"
                    disabled={command.busy || !reason.trim() || !!health.error}
                  >
                    {command.uncertain
                      ? "Retry original request"
                      : "Verify repair and resume"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-g"
                    disabled={command.busy || command.uncertain}
                    onClick={() => {
                      setGeneration(undefined);
                      health.reload();
                    }}
                  >
                    Refresh status
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {resumed && (
          <div className="banner bn-ok" role="status">
            <span>
              Repair verified. The queued item is ready for the source worker.
            </span>
          </div>
        )}
        {!(state && (state.blocked || command.uncertain)) && (
          <div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={command.busy || command.uncertain}
              onClick={() => {
                setGeneration(undefined);
                health.reload();
              }}
            >
              Refresh status
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function TenantCreate({
  scope,
  onDirty,
}: {
  scope: Scope;
  onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Tenant>();
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const nameId = useId();
  useEffect(() => {
    onDirty(!!name && !created);
  }, [name, created, onDirty]);
  return (
    <section className="panel" aria-label="Create tenant">
      <div className="panel-h">
        <h2>Create tenant</h2>
      </div>
      <form
        className="adm-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await command.execute<Tenant>("/api/tenants", {
            name,
            initial_grants: [
              { principal_id: scope.session.principal.id, role: "admin" },
            ],
          });
          if (result) setCreated(result.data);
        }}
      >
        <div className="adm-create-row">
          <div className="f">
            <label className="lbl" htmlFor={nameId}>
              Tenant name
            </label>
            <input
              id={nameId}
              className="inp"
              required
              maxLength={128}
              placeholder="Up to 128 characters"
              value={name}
              disabled={command.busy || command.uncertain || !!created}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button
            className="btn"
            disabled={command.busy || !!created || !name.trim()}
          >
            {command.uncertain ? "Retry tenant creation" : "Create tenant"}
          </button>
        </div>
        <p className="help">
          You become the tenant&apos;s first administrator. Tenants cannot be
          deleted or disabled after creation.
        </p>
        <CommandFeedback command={command} />
        {created && (
          <div className="banner bn-ok" role="status">
            <span>
              <b>Created {created.name}.</b> Manage additional access from its
              Permissions page.
            </span>
            <span className="adm-spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                scope.onDenied();
                scope.navigate(`/tenants/${created.id}/permissions`);
              }}
            >
              Open tenant permissions
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

type Check = { name: string; detail: string; state: string; cls: string };
const capabilityNames: Record<string, string> = {
  v2_ingress: "Alert intake (v2)",
  search: "Search index",
  human_auth: "Identity directory",
  recovery: "Recovery",
  audit_retention: "Audit retention",
};
const capabilityOrder = Object.keys(capabilityNames);

/** Named checks derived from /api/admin/health (capability gates). */
function healthChecks(data: unknown): Check[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const checks: Check[] = [];
  const capabilities = Array.isArray(record.capabilities)
    ? (record.capabilities as Record<string, unknown>[])
    : [];
  const sorted = [...capabilities].sort((a, b) => {
    const rank = (value: unknown) => {
      const index = capabilityOrder.indexOf(String(value));
      return index < 0 ? capabilityOrder.length : index;
    };
    return rank(a.capability) - rank(b.capability);
  });
  for (const gate of sorted) {
    if (!gate || typeof gate.capability !== "string") continue;
    const ready = gate.ready === true;
    checks.push({
      name: capabilityNames[gate.capability] ?? words(gate.capability),
      detail: words(gate.reason),
      state: ready ? "Ready" : "Not ready",
      cls: ready ? "b-green" : "b-amber",
    });
  }
  if (Array.isArray(record.source_processing)) {
    const blocked = (record.source_processing as Record<string, unknown>[])
      .filter((row) => row && row.blocked === true)
      .map((row) => String(row.tenant ?? row.tenant_id ?? "a tenant"));
    checks.splice(Math.min(1, checks.length), 0, {
      name: "Source processing",
      detail: blocked.length
        ? `${blocked.length} tenant${blocked.length === 1 ? "" : "s"} blocked: ${blocked.join(", ")}`
        : "No tenant is blocked",
      state: blocked.length ? "Blocked" : "Healthy",
      cls: blocked.length ? "b-red" : "b-green",
    });
  }
  for (const [key, value] of Object.entries(record))
    if (typeof value === "boolean")
      checks.push({
        name: words(key),
        detail: "Reported by the platform health endpoint",
        state: value ? "Ready" : "Not ready",
        cls: value ? "b-green" : "b-amber",
      });
  return checks;
}

function PlatformHealth({ scope }: { scope: Scope }) {
  const platform = useResource<unknown>(
    "/api/admin/health",
    scope.onDenied,
    scope.version,
  );
  const checked = useCheckedAt(platform.data);
  const checks = healthChecks(platform.data?.data);
  return (
    <section
      className="panel"
      aria-label="Platform health"
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div className="panel-h">
        <h2>Platform health</h2>
        <div className="adm-spacer" />
        {checked && (
          <span className="small muted">
            Checked <span className="mono">{timestamp(checked)}</span>
          </span>
        )}
      </div>
      <div>
        {platform.error ? (
          <div className="adm-stack">
            <ErrorNotice error={platform.error} />
          </div>
        ) : null}
        {platform.loading && !platform.data && (
          <p className="adm-empty-row" role="status">
            Checking platform health…
          </p>
        )}
        {platform.data && !checks.length && (
          <p className="adm-empty-row">No health checks were reported.</p>
        )}
        {checks.map((check) => (
          <div className="hl" key={check.name}>
            <div className="hl-text">
              <span className="hl-name">{check.name}</span>
              <span className="cell small muted">{check.detail}</span>
            </div>
            <span className="hl-state">
              <span className={`chip ${check.cls}`}>{check.state}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Administration(scope: Scope) {
  const pathname = usePathname();
  const [repairDirty, setRepairDirty] = useState(false),
    [tenantDirty, setTenantDirty] = useState(false);
  useDirtyWarning(repairDirty || tenantDirty);
  useEffect(() => {
    scope.setDirty(repairDirty || tenantDirty);
    return () => scope.setDirty(false);
  }, [repairDirty, tenantDirty, scope.setDirty]);
  if (!scope.session.global_super_admin)
    return (
      <Page
        scope={scope}
        title="Platform administration"
        crumbs={[{ label: "Administration" }]}
        className="adm-page"
      >
        <div className="panel adm-notice-panel">
          <p className="notice">
            Platform administration requires global administration access.
          </p>
        </div>
      </Page>
    );
  if (pathname.replace(/\/$/, "").endsWith("/platform/audit"))
    return <AuditBrowser key="platform-audit" scope={scope} platform />;
  return (
    <Page
      scope={scope}
      title="Platform administration"
      crumbs={[{ label: "Administration" }]}
      role="Global super admin"
      extra={
        <span className="adm-subtitle">Shown only to global super admins</span>
      }
      className="adm-page"
      actions={
        <button
          type="button"
          className="btn"
          onClick={() =>
            scope.navigate(`/tenants/${scope.tenant.id}/platform/audit`)
          }
        >
          Platform access audit
        </button>
      }
    >
      <div className="adm-split adm-split-half">
        <div className="adm-col">
          <SourceRepair scope={scope} onDirty={setRepairDirty} />
          <TenantCreate scope={scope} onDirty={setTenantDirty} />
        </div>
        <PlatformHealth scope={scope} />
      </div>
    </Page>
  );
}
