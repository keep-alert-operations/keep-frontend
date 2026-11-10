"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  request,
  display,
  RecordData,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice } from "./ui";
import { Page, useConfirm } from "./page";

/* ------------------------------------------------------------------ labels */

const humanize = (value: unknown) => {
  const text = typeof value === "string" ? value.replaceAll("_", " ") : "";
  return text ? text[0].toUpperCase() + text.slice(1) : "—";
};

/** Operator lifecycle chip (reference: Ready green, Setup pending blue). */
export function lifecycleChip(value: unknown): [string, string] {
  switch (value) {
    case "ready":
      return ["Ready", "b-green"];
    case "setup_pending":
    case "pending":
      return ["Setup pending", "b-blue"];
    case "deleted":
      return ["Deleted", "b-neutral"];
    case "needs_attention":
      return ["Needs attention", "b-red"];
    default:
      return [humanize(value), "b-neutral"];
  }
}

/** Integration health chip (In sync green, Pending amber, attention red). */
export function integrationChip(value: unknown): [string, string] {
  switch (value) {
    case "in_sync":
    case "healthy":
      return ["In sync", "b-green"];
    case "pending":
      return ["Pending", "b-amber"];
    case "needs_attention":
    case "blocked":
      return ["Needs attention", "b-red"];
    default:
      return [humanize(value), "b-neutral"];
  }
}

export function Chip({ value }: { value: [string, string] }) {
  return <span className={`chip ${value[1]}`}>{value[0]}</span>;
}

type Key = {
  id: string;
  state: string;
  expires_at?: string | null;
  created_at?: string | null;
  revoked_at?: string | null;
};
const keyRank: Record<string, number> = {
  current: 0,
  retiring: 1,
  prepared: 2,
};
/** Keys with usable ones first (current, retiring, prepared), newest first. */
const operatorKeys = (operator: RecordData): Key[] =>
  Array.isArray(operator.keys)
    ? [...(operator.keys as Key[])].sort(
        (a, b) =>
          (keyRank[a.state] ?? 3) - (keyRank[b.state] ?? 3) ||
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      )
    : [];

function hoursUntil(value: unknown) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60000));
  return minutes >= 120
    ? `${Math.round(minutes / 60)}h`
    : minutes >= 60
      ? "1h"
      : `${minutes}m`;
}

/** Human "Current key" summary from key availability, state and expiry. */
export function currentKeyText(operator: RecordData) {
  const keys = operatorKeys(operator);
  const current = keys.find((key) => key.state === "current");
  if (operator.retiring_key_deadline) {
    const left = hoursUntil(operator.retiring_key_deadline);
    return `Rotating · old key valid ${left ?? "until its deadline"}`;
  }
  if (operator.current_key_available)
    return current?.expires_at
      ? `Active · expires ${timestamp(current.expires_at).split(" ")[0]}`
      : "Active";
  if (keys.some((key) => key.state === "prepared"))
    return "Key prepared · not active yet";
  return "No active key";
}

export const routingLabel = (name: unknown) => `Keep - ${display(name)}`;

const operationKinds: Record<string, string> = {
  setup: "Setup",
  create_key: "Create key",
  rotate: "Rotate",
  rename: "Rename",
  delete: "Deletion",
  cancel: "Cancellation",
  cleanup: "Key cleanup",
  repair: "Repair",
  reconcile: "Reconcile",
};
function operationChip(job: {
  kind: string;
  state: string;
  created_at?: string | null;
}): [string, string] {
  const kind = operationKinds[job.kind] ?? humanize(job.kind);
  const age =
    typeof job.created_at === "string"
      ? Date.now() - Date.parse(job.created_at)
      : 0;
  switch (job.state) {
    case "completed":
      return [`${kind} · done`, "b-green"];
    case "cancelled":
    case "superseded":
      return [`${kind} · ${job.state}`, "b-neutral"];
    case "needs_attention":
      return [`${kind} · needs attention`, "b-red"];
    default:
      return age >= 15 * 60000
        ? [`${kind} · needs attention`, "b-red"]
        : [`${kind} · in progress`, "b-amber"];
  }
}

const activityKinds: Record<string, string> = {
  operator_created: "Setup requested",
  operator_rotate: "Key rotation requested",
  operator_key_rotated: "Key rotated",
  operator_create_key: "Key creation requested",
  operator_revoke: "Key revoked",
  operator_key_revoked: "Key revoked",
  operator_revoke_all: "All keys revoked",
  operator_rename: "Rename requested",
  operator_delete: "Deletion requested",
  operator_retry: "Retry requested",
  operator_cancel: "Cancellation requested",
  key_copy: "Current key copied",
};
const activityLabel = (kind: string) => {
  const key = kind.replaceAll("-", "_");
  return activityKinds[key] ?? humanize(key.replace(/^operator_/, ""));
};

function adminNotice(scope: Scope, title: string, text: string) {
  return (
    <Page
      scope={scope}
      title={title}
      crumbs={[{ label: "Administration" }]}
      className="adm-page"
    >
      <div className="panel adm-notice-panel">
        <p className="notice">{text}</p>
      </div>
    </Page>
  );
}

/* ---------------------------------------------------------- new operator */

export function OperatorCreate(scope: Scope) {
  const [name, setName] = useState(""),
    [created, setCreated] = useState<RecordData>();
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const nameId = useId();
  const failureFields =
    command.error instanceof ApiError ? command.error.fields : null;
  const failedOperator =
    failureFields &&
    typeof failureFields === "object" &&
    "operator_id" in failureFields &&
    typeof failureFields.operator_id === "string"
      ? failureFields.operator_id
      : null;
  useDirtyWarning(!!name && !created);
  useEffect(() => {
    scope.setDirty(!!name && !created);
    return () => scope.setDirty(false);
  }, [name, created, scope.setDirty]);
  const list = `/tenants/${scope.tenant.id}/operators`;
  if (scope.tenant.role !== "admin" || scope.tenant.kind === "global")
    return adminNotice(
      scope,
      "New operator",
      "Managed operators require administration access to a specific tenant.",
    );
  return (
    <Page
      scope={scope}
      title="New operator"
      crumbs={[{ label: "Administration" }, { label: "Operators", href: list }]}
      className="adm-page"
      actions={
        <>
          <button
            type="button"
            className="btn btn-g"
            onClick={() => scope.navigate(list)}
          >
            {created ? "Back to operators" : "Discard"}
          </button>
          <button
            type="submit"
            form="operator-create"
            className="btn btn-p"
            disabled={
              command.busy || !!created || !!failedOperator || !name.trim()
            }
          >
            {command.uncertain ? "Retry original command" : "Create operator"}
          </button>
        </>
      }
    >
      <div className="adm-split">
        <section className="panel">
          <form
            id="operator-create"
            className="adm-stack"
            style={{ padding: "18px 20px", gap: 18 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await command.execute<{ operator: RecordData }>(
                `${tenantPath(scope.tenant.id)}/operators`,
                { name },
              );
              if (result) {
                setCreated(result.data.operator);
                scope.setDirty(false);
              }
            }}
          >
            <div className="f">
              <label className="lbl" htmlFor={nameId}>
                Operator name
              </label>
              <input
                id={nameId}
                className="inp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={128}
                required
                disabled={!!created || command.busy || command.uncertain}
                placeholder="Up to 128 characters"
              />
              <span className="help">
                Names are unique across Keep. Senders authenticate with this
                operator&apos;s own API key.
              </span>
            </div>
            <div className="f">
              <span className="lbl">Grafana routing label</span>
              <div className="adm-label-row">
                <code className="mono adm-label-code">
                  {routingLabel(name.trim() || "operator name")} =
                  &quot;true&quot;
                </code>
              </div>
              <span className="help">
                Alerts from the shared company Grafana reach this operator when
                they carry this label.
              </span>
            </div>
            <div className="banner bn-info adm-banner-top">
              <InfoIcon />
              <span>
                Setup reserves the name and prepares a key. Ingestion and Copy
                become available after verified Kong and Grafana provisioning.
              </span>
            </div>
            <CommandFeedback command={command} />
            {command.busy && <p role="status">Verifying operator setup…</p>}
            {failedOperator && (
              <button
                type="button"
                className="btn"
                onClick={() => scope.navigate(`${list}/${failedOperator}`)}
              >
                Open operator to inspect and retry
              </button>
            )}
            {created && (
              <div className="banner bn-ok" role="status">
                <span>
                  <b>Operator ready.</b> Provisioning was verified.
                </span>
                <span className="adm-spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => scope.navigate(`${list}/${created.id}`)}
                >
                  Open operator
                </button>
              </div>
            )}
          </form>
        </section>
        <aside className="adm-col">
          <section className="panel">
            <div className="panel-h">
              <h2>What happens next</h2>
            </div>
            <ol className="adm-stack adm-stack-16 adm-steps">
              <li>
                <b>Name reserved.</b> The name and its routing label are held
                for this operator.
              </li>
              <li>
                <b>Key prepared.</b> A key is created for the Kong gateway but
                cannot send alerts yet.
              </li>
              <li>
                <b>Grafana routing verified.</b> The exact label route is added
                to the shared company Grafana.
              </li>
              <li>
                <b>Ready.</b> Copy the key and configure the alert source.
              </li>
            </ol>
          </section>
          <section className="panel adm-help-panel">
            <span className="lbl">If setup stalls</span>
            <p className="help">
              Failed setup requires an explicit retry from the operator page.
              Keep does not retry provisioning in the background.
            </p>
          </section>
        </aside>
      </div>
    </Page>
  );
}

function InfoIcon() {
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
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
function ClockIcon() {
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
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/* ------------------------------------------------------- operator detail */

/** Loads one operator and renders its administration page (reference S17). */
export function OperatorDetail(scope: Scope & { id: string }) {
  const path = `${tenantPath(scope.tenant.id)}/operators/${scope.id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const operator = result.data?.data;
  if (!operator)
    return (
      <Page
        scope={scope}
        title="Operator"
        crumbs={[
          { label: "Administration" },
          {
            label: "Operators",
            href: `/tenants/${scope.tenant.id}/operators`,
          },
        ]}
        className="adm-page"
      >
        <ErrorNotice error={result.error} />
        {result.loading && (
          <div className="panel adm-notice-panel" role="status">
            Loading operator…
          </div>
        )}
      </Page>
    );
  return (
    <OperatorTools
      key={operator.id}
      scope={scope}
      operator={operator}
      install={(row) => result.install({ data: row })}
      stale={result.error}
    />
  );
}

type Job = {
  id: string;
  kind: string;
  state: string;
  step?: string | null;
  attempts?: string | number | null;
  next_attempt_at?: string | null;
  created_at?: string | null;
  error_code?: string | null;
  restoring_cancellation?: boolean;
  cancellation_kind?: string | null;
};

/**
 * Operator administration page: keys, Grafana routing, status, provisioning
 * operations and operator activity. Commands carry the observed revision.
 */
export function OperatorTools({
  scope,
  operator,
  install,
  stale,
}: {
  scope: Scope;
  operator: RecordData;
  install: (row: RecordData) => void;
  stale?: unknown;
}) {
  const [name, setName] = useState(""),
    [base, setBase] = useState<string>(),
    [renaming, setRenaming] = useState(false),
    [copied, setCopied] = useState(false),
    [labelCopied, setLabelCopied] = useState<boolean | null>(null),
    [copyError, setCopyError] = useState<unknown>();
  const command = useCommand(scope.session.csrf_token, scope.onDenied),
    copyCommand = useCommand(scope.session.csrf_token, scope.onDenied);
  const [dialog, confirm] = useConfirm();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    scope.setDirty(!!name);
    return () => scope.setDirty(false);
  }, [name, scope.setDirty]);
  useDirtyWarning(!!name);
  const path = `${tenantPath(scope.tenant.id)}/operators/${operator.id}`;
  const list = `/tenants/${scope.tenant.id}/operators`;
  const admin = scope.tenant.role === "admin";
  const job = (operator.operation as Job | null | undefined) ?? null;
  const keys = operatorKeys(operator);
  const operatorName = display(operator.name);
  async function act(
    suffix: string,
    body: Record<string, unknown> = {},
    method = "POST",
  ) {
    const headers =
      method === "DELETE"
        ? {
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"${operator.revision}"`,
          }
        : undefined;
    const response = await command.execute<{ operator: RecordData }>(
      path + suffix,
      { expected_revision: operator.revision, ...body },
      method,
      headers,
    );
    if (response) {
      install(response.data.operator);
      setCopied(false);
      return true;
    }
    try {
      const refreshed = await request<RecordData>(path);
      install(refreshed.data);
    } catch {
      /* Keep the command failure visible if refresh also fails. */
    }
    return false;
  }
  async function copyKey() {
    setCopied(false);
    setCopyError(undefined);
    const response = await copyCommand.execute<{ key: string }>(
      path + "/keys/current/copy",
      { expected_revision: operator.revision },
    );
    if (response && alive.current) {
      try {
        await navigator.clipboard.writeText(response.data.key);
        if (alive.current) setCopied(true);
      } catch {
        if (alive.current)
          setCopyError(
            new Error(
              "Clipboard write failed. Retry Copy; the key was not displayed.",
            ),
          );
      } finally {
        response.data.key = "";
      }
    }
  }
  const renameBlocked =
    (!!job && job.kind !== "setup") ||
    !!operator.deletion_pending ||
    !!operator.pending_name;
  const header = (
    <span className="adm-chips">
      <Chip value={lifecycleChip(operator.lifecycle)} />
      <Chip value={integrationChip(operator.integration_health)} />
      {!!operator.deletion_pending && (
        <span className="chip b-red">Deletion pending</span>
      )}
      {typeof operator.pending_name === "string" && operator.pending_name && (
        <span className="chip b-blue">Renaming to {operator.pending_name}</span>
      )}
    </span>
  );
  return (
    <Page
      scope={scope}
      title={operatorName}
      crumbs={[{ label: "Administration" }, { label: "Operators", href: list }]}
      extra={header}
      className="adm-page"
      actions={
        admin && (
          <>
            <button
              type="button"
              className="btn"
              disabled={command.busy || renameBlocked}
              title={
                renameBlocked
                  ? "Wait for the current operation to finish before renaming."
                  : undefined
              }
              onClick={() => setRenaming(true)}
            >
              Request rename
            </button>
            <button
              type="button"
              className="btn btn-d"
              disabled={command.busy || !!operator.deletion_pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Request deletion of “${operatorName}”?`,
                    body: (
                      <p>
                        Retained alerts and pending inputs block it. Once
                        accepted, new ingestion and Copy are blocked until
                        deletion or verified cancellation completes.
                      </p>
                    ),
                    confirmLabel: "Request deletion",
                    danger: true,
                  })
                )
                  void act("", {}, "DELETE");
              }}
            >
              Request deletion
            </button>
          </>
        )
      }
    >
      {dialog}
      {stale ? (
        <div className="banner bn-warn" role="status">
          <span>
            <b>Showing the last loaded state.</b> The operator could not be
            refreshed.
          </span>
        </div>
      ) : null}
      {!renaming && (command.error || command.uncertain) ? (
        <CommandFeedback command={command} />
      ) : null}
      <div className="adm-split">
        <div className="adm-col">
          <section className="panel" aria-label="API keys">
            <div className="panel-h">
              <h2>API keys</h2>
              <div className="adm-spacer" />
              {admin && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={
                      copyCommand.busy ||
                      !operator.current_key_available ||
                      !!operator.deletion_pending
                    }
                    onClick={() => void copyKey()}
                  >
                    Copy current key
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={
                      command.busy ||
                      !!job ||
                      !operator.current_key_available ||
                      !!operator.retiring_key_deadline
                    }
                    onClick={() => void act("/keys/rotate")}
                  >
                    Rotate key
                  </button>
                  {!operator.current_key_available && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={
                        command.busy ||
                        (!!job && !["cleanup", "cancel"].includes(job.kind)) ||
                        (!!operator.deletion_pending &&
                          !(
                            job?.restoring_cancellation &&
                            job.cancellation_kind === "delete"
                          )) ||
                        !!operator.current_key_available ||
                        !!operator.retiring_key_deadline
                      }
                      onClick={() => void act("/keys/create")}
                    >
                      Create key
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-d"
                    disabled={command.busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Revoke all keys for “${operatorName}”?`,
                          body: (
                            <p>
                              All current and retiring senders lose access
                              immediately, and pending key setup is cancelled.
                            </p>
                          ),
                          confirmLabel: "Revoke all keys",
                          danger: true,
                        })
                      )
                        void act("/keys/revoke-all");
                    }}
                  >
                    Revoke all keys
                  </button>
                </>
              )}
            </div>
            <div className="adm-feedback">
              {copied && (
                <div className="banner bn-ok" role="status">
                  <span>Current key copied to clipboard.</span>
                </div>
              )}
              <ErrorNotice error={copyError} />
              {(copyCommand.error || copyCommand.uncertain) && (
                <CommandFeedback command={copyCommand} />
              )}
            </div>
            {!admin ? (
              <p className="adm-empty-row">
                Operator management and key audit require tenant administration
                access.
              </p>
            ) : (
              <>
                {!!operator.retiring_key_deadline && (
                  <div className="banner bn-info adm-key-banner">
                    <ClockIcon />
                    <span>
                      Rotation in progress. The previous key keeps working until{" "}
                      <span className="mono">
                        {timestamp(operator.retiring_key_deadline)}
                      </span>{" "}
                      so senders can switch over.
                    </span>
                  </div>
                )}
                <div className="adm-table-scroll">
                  <div role="table" aria-label="Keys">
                    <div role="row" className="row head g-key">
                      <span role="columnheader">Key</span>
                      <span role="columnheader">State</span>
                      <span role="columnheader">Expires</span>
                      <span role="columnheader">
                        <span className="sr-only">Actions</span>
                      </span>
                    </div>
                    {keys.length === 0 && (
                      <div role="row" className="row">
                        <span role="cell" className="adm-note">
                          No keys yet.
                        </span>
                      </div>
                    )}
                    {keys.map((key) => {
                      const active = [
                        "current",
                        "retiring",
                        "prepared",
                      ].includes(key.state);
                      return (
                        <div
                          role="row"
                          key={key.id}
                          className={`row g-key${active ? "" : " r-res"}`}
                        >
                          <span
                            role="cell"
                            className="mono small cell"
                            title={`Credential ${key.id}`}
                          >
                            ••••••••••{key.id.replaceAll("-", "").slice(-4)}
                          </span>
                          <span role="cell">
                            <Chip value={keyChip(key.state)} />
                          </span>
                          <span role="cell" className="mono small">
                            {key.expires_at ? timestamp(key.expires_at) : "—"}
                          </span>
                          <span role="cell" className="adm-row-actions">
                            {active && (
                              <button
                                type="button"
                                className="ibtn"
                                disabled={command.busy}
                                aria-label={`Revoke ${key.state} key ending ${key.id.replaceAll("-", "").slice(-4)}`}
                                onClick={async () => {
                                  if (
                                    await confirm({
                                      title: `Revoke this ${key.state} key?`,
                                      body: (
                                        <p>
                                          Its senders lose access immediately.
                                          {key.state === "current"
                                            ? " A retiring key remains usable until its original expiry unless you revoke all keys."
                                            : ""}
                                        </p>
                                      ),
                                      confirmLabel: "Revoke key",
                                      danger: true,
                                    })
                                  )
                                    void act(`/keys/${key.id}/revoke`);
                                }}
                              >
                                Revoke
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>Grafana routing</h2>
            </div>
            <div className="adm-stack">
              <span className="small muted">
                Alerts from the shared company Grafana reach this operator when
                they carry this label:
              </span>
              <div className="adm-label-row">
                <code className="mono adm-label-code">
                  {routingLabel(operator.name)} = &quot;true&quot;
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        routingLabel(operator.name),
                      );
                      setLabelCopied(true);
                    } catch {
                      setLabelCopied(false);
                    }
                  }}
                >
                  Copy label
                </button>
              </div>
              {labelCopied !== null && (
                <span className="small muted" role="status">
                  {labelCopied
                    ? "Label name copied. Set its value to the string true."
                    : "Clipboard write failed. Select the label above to copy it."}
                </span>
              )}
            </div>
          </section>
        </div>
        <aside className="adm-col">
          <section className="panel">
            <div className="panel-h">
              <h2>Status</h2>
            </div>
            <dl
              className="adm-fields adm-stack-16"
              style={{ padding: "14px 16px" }}
            >
              <div className="fld">
                <dt>Lifecycle</dt>
                <dd>{lifecycleChip(operator.lifecycle)[0]}</dd>
              </div>
              <div className="fld">
                <dt>Integration</dt>
                <dd>{integrationChip(operator.integration_health)[0]}</dd>
              </div>
              <div className="fld">
                <dt>Created</dt>
                <dd className="mono">{timestamp(operator.created_at)}</dd>
              </div>
              <div className="fld">
                <dt>Last reconciled</dt>
                <dd
                  className={operator.last_reconciled_at ? "mono" : undefined}
                >
                  {operator.last_reconciled_at
                    ? timestamp(operator.last_reconciled_at)
                    : "Not yet"}
                </dd>
              </div>
              <div className="fld">
                <dt>Revision</dt>
                <dd>{display(operator.revision)}</dd>
              </div>
              <div className="fld">
                <dt>Tenant</dt>
                <dd>{scope.tenant.name}</dd>
              </div>
            </dl>
          </section>
          <section className="panel adm-panel-fill">
            <div className="panel-h">
              <h2>Provisioning operations</h2>
            </div>
            <div className="adm-stack adm-stack-16">
              {!admin ? (
                <p className="adm-note">
                  Provisioning details require tenant administration access.
                </p>
              ) : job ? (
                <div className="adm-op-block" role="status">
                  <div className="adm-op-line">
                    <Chip value={operationChip(job)} />
                    {job.created_at && (
                      <span className="small muted mono">
                        {timestamp(job.created_at)}
                      </span>
                    )}
                    <span className="adm-spacer" />
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Retry provisioning now"
                      disabled={command.busy}
                      onClick={() => void act(`/operations/${job.id}/retry`)}
                    >
                      Retry
                    </button>
                    {["rotate", "rename", "delete"].includes(job.kind) && (
                      <button
                        type="button"
                        className="ibtn"
                        aria-label="Request cancellation"
                        disabled={command.busy}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Request cancellation?",
                              body: (
                                <p>
                                  Any affected Grafana configuration must be
                                  restored before cancellation completes.
                                </p>
                              ),
                              confirmLabel: "Request cancellation",
                            })
                          )
                            void act(`/operations/${job.id}/cancel`);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <span className="adm-op-detail">
                    {[
                      job.step ? `Step: ${humanize(job.step)}` : "",
                      job.attempts !== undefined && job.attempts !== null
                        ? `Attempts: ${job.attempts}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {job.error_code && (
                    <span className="adm-op-detail">
                      <span className="mono">{job.error_code}.</span>{" "}
                      Provisioning remains incomplete until its dependencies are
                      verified.
                    </span>
                  )}
                </div>
              ) : (
                <span className="adm-note">
                  No provisioning operation in progress.
                </span>
              )}
              <p className="help">
                Failed operations require an explicit retry. You can retry or
                request cancellation from here.
              </p>
              {admin && (
                <>
                  <hr className="adm-divider" />
                  <OperatorActivity scope={scope} path={`${path}/audit`} />
                </>
              )}
            </div>
          </section>
        </aside>
      </div>
      {renaming && (
        <RenameDialog
          current={operatorName}
          name={name}
          busy={command.busy}
          blocked={!!job && job.kind !== "setup"}
          command={command}
          onName={(value) => {
            if (!name) setBase(operator.revision);
            setName(value);
          }}
          onCancel={() => {
            setRenaming(false);
            setName("");
            setBase(undefined);
          }}
          onSubmit={async () => {
            if (
              await act(
                "",
                { name, expected_revision: base ?? operator.revision },
                "PATCH",
              )
            ) {
              setName("");
              setBase(undefined);
              setRenaming(false);
            }
          }}
        />
      )}
    </Page>
  );
}

function keyChip(state: string): [string, string] {
  switch (state) {
    case "current":
      return ["Current", "b-green"];
    case "retiring":
      return ["Retiring", "b-amber"];
    case "prepared":
      return ["Prepared", "b-blue"];
    default:
      return [humanize(state), "b-neutral"];
  }
}

function RenameDialog({
  current,
  name,
  busy,
  blocked,
  command,
  onName,
  onCancel,
  onSubmit,
}: {
  current: string;
  name: string;
  busy: boolean;
  blocked: boolean;
  command: { error?: unknown; uncertain: boolean; busy: boolean };
  onName: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const inputId = useId();
  useEffect(() => {
    opener.current = document.activeElement;
    input.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
    >
      <div
        className="dlg adm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
      >
        <h2 id="rename-title">Rename “{current}”</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="f">
            <label className="lbl" htmlFor={inputId}>
              New operator name
            </label>
            <input
              ref={input}
              id={inputId}
              className="inp"
              value={name}
              maxLength={128}
              required
              disabled={blocked || busy || command.uncertain}
              onChange={(event) => onName(event.target.value)}
            />
          </div>
          {name.trim() && (
            <span className="small muted">
              New routing label{" "}
              <span className="mono">{routingLabel(name.trim())}</span>
            </span>
          )}
          <p className="help">
            The current name and both name reservations remain until Grafana
            verifies the rename.
          </p>
          <CommandFeedback command={command} />
          <div className="dlg-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="btn btn-sm btn-p"
              disabled={busy || !name.trim() || blocked}
            >
              {command.uncertain ? "Retry original command" : "Request rename"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type Activity = {
  id: string;
  kind: string;
  recorded_at: string;
  actor_id?: string | null;
  actor_label?: string | null;
};

/** Operator audit (activity) as a compact, paged list. */
function OperatorActivity({ scope, path }: { scope: Scope; path: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useResource<Activity[]>(
    `${path}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : null;
  return (
    <section aria-label="Operator activity" className="adm-op-block">
      <span className="lbl">Recent activity</span>
      <ErrorNotice error={result.error} />
      {result.loading && !rows && (
        <span className="adm-note" role="status">
          Loading activity…
        </span>
      )}
      {rows && !rows.length && (
        <span className="adm-note">No recorded activity.</span>
      )}
      {rows && rows.length > 0 && (
        <ul className="adm-activity">
          {rows.map((row) => (
            <li key={row.id}>
              <span className="chip b-neutral">{activityLabel(row.kind)}</span>
              <span className="small muted mono">
                {timestamp(row.recorded_at)}
              </span>
              <span className="small muted">
                {row.actor_id === scope.session.principal.id
                  ? `${row.actor_label ?? "You"} (you)`
                  : (row.actor_label ?? "System")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(cursor || result.data?.next_cursor) && (
        <div className="adm-op-line">
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={!cursor || result.loading}
            onClick={() => setCursor(null)}
          >
            Newest activity
          </button>
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={!result.data?.next_cursor || result.loading}
            onClick={() => setCursor(result.data?.next_cursor ?? null)}
          >
            Older activity
          </button>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------- shared helpers */

export function MaintenanceEditor({
  scope,
  window,
  onSaved,
}: {
  scope: Scope;
  window: RecordData;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState("metadata"),
    [name, setName] = useState(String(window.name)),
    [reason, setReason] = useState(String(window.reason ?? "")),
    [zone, setZone] = useState(String(window.timezone)),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [cel, setCel] = useState(String(window.cel)),
    [startChoice, setStartChoice] = useState(""),
    [endChoice, setEndChoice] = useState(""),
    [dirty, setDirty] = useState(false);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
  return (
    <form
      className="editor"
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        const body: Record<string, unknown> = {
          kind,
          expected_revision: window.revision,
        };
        if (kind === "metadata") Object.assign(body, { name, reason });
        else if (kind === "timezone") body.timezone = zone;
        else
          Object.assign(body, {
            timezone: zone,
            ...(!window.started_lock ? { cel } : {}),
            ...(start
              ? {
                  start_local: start.length === 16 ? start + ":00" : start,
                  ...(startChoice ? { start_occurrence: startChoice } : {}),
                }
              : {}),
            ...(end
              ? {
                  end_local: end.length === 16 ? end + ":00" : end,
                  ...(endChoice ? { end_occurrence: endChoice } : {}),
                }
              : {}),
          });
        if (
          await command.execute(
            `${tenantPath(scope.tenant.id)}/maintenance/${window.id}`,
            body,
            "PATCH",
          )
        ) {
          setDirty(false);
          scope.setDirty(false);
          onSaved();
        }
      }}
    >
      <h1>Edit maintenance</h1>
      <p>
        Base revision {window.revision}. Current UTC interval:{" "}
        {display(window.start_at)} – {display(window.end_at)}
      </p>
      <label>
        Change
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="metadata">Name and reason</option>
          <option value="timezone">Display timezone only</option>
          <option value="schedule">Schedule or CEL</option>
        </select>
      </label>
      {kind === "metadata" ? (
        <>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label>
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={10000}
            />
          </label>
        </>
      ) : (
        <label>
          IANA timezone
          <input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            required
          />
        </label>
      )}
      {kind === "timezone" && (
        <p>Changing the display timezone preserves the UTC start and end.</p>
      )}
      {kind === "schedule" && (
        <>
          <p className="notice">
            Leave an endpoint blank to preserve it. The server rejects changes
            forbidden after the window starts or ends.
          </p>
          <label>
            Changed start local time
            <input
              type="datetime-local"
              step={1}
              value={start}
              disabled={!!window.started_lock}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            Changed end local time
            <input
              type="datetime-local"
              step={1}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          {[
            ["Start", startChoice, setStartChoice],
            ["End", endChoice, setEndChoice],
          ].map(([label, value, setter]) => (
            <label key={String(label)}>
              {String(label)} repeated local time
              <select
                value={String(value)}
                onChange={(e) =>
                  (setter as (v: string) => void)(e.target.value)
                }
              >
                <option value="">Let server validate</option>
                <option value="first">First occurrence</option>
                <option value="second">Second occurrence</option>
              </select>
            </label>
          ))}
          <label>
            CEL
            <textarea
              value={cel}
              onChange={(e) => setCel(e.target.value)}
              required
              disabled={!!window.started_lock}
            />
          </label>
        </>
      )}
      <CommandFeedback command={command} />
      <button
        disabled={
          command.busy || (kind === "schedule" && !!window.started_lock && !end)
        }
      >
        {command.uncertain
          ? "Retry original command"
          : "Save maintenance change"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (!dirty || globalThis.confirm("Discard maintenance changes?")) {
            setDirty(false);
            scope.setDirty(false);
            onSaved();
          }
        }}
      >
        Discard
      </button>
    </form>
  );
}
