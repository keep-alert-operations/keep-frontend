"use client";
import { Fragment, useEffect, useId, useState } from "react";
import { tenantPath, timestamp } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { Page } from "./page";

interface AuditEvent {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  actor_label: string;
  kind: string;
  recorded_at: string;
  dependency_protected: boolean;
  evidence: Record<string, unknown>;
  references?: { kind: string; id: string; available?: boolean }[];
}
const initial = {
  period: "recent",
  from: "",
  to: "",
  action: "",
  exactAction: "",
  actor: "",
  affected: "",
  resource: "",
  tenant: "",
};
type Filters = typeof initial;

function auditPage(value: unknown): value is AuditEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (event) =>
        event &&
        typeof event === "object" &&
        typeof event.id === "string" &&
        typeof event.kind === "string" &&
        typeof event.recorded_at === "string" &&
        (event.actor_label === null || typeof event.actor_label === "string") &&
        (event.actor_id === null || typeof event.actor_id === "string") &&
        (event.references === undefined ||
          (Array.isArray(event.references) &&
            event.references.every(
              (reference: unknown) =>
                reference &&
                typeof reference === "object" &&
                "kind" in reference &&
                typeof reference.kind === "string" &&
                "id" in reference &&
                typeof reference.id === "string",
            ))),
    )
  );
}

/** "Asia/Jerusalem (UTC+03:00)" for the browser's display timezone. */
export function timezoneLabel(date = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${zone} (UTC${sign}${pad(offset / 60)}:${pad(offset % 60)})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const words = (value: string) => {
  const text = value.replaceAll(/[-_]/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
};
const ranks: Record<string, string> = {
  "1": "View",
  "2": "Edit",
  "3": "Admin",
};
/** Role names; directory evidence records roles as ranks 1–3. */
const roleName = (role: unknown) =>
  typeof role === "number" || (typeof role === "string" && /^\d$/.test(role))
    ? (ranks[String(role)] ?? "no role")
    : typeof role === "string" && role
      ? words(role)
      : "no role";

const tenantActions: [string, string][] = [
  ["permissions-changed", "Grant changes"],
  ["tenant-renamed", "Tenant renamed"],
  ["directory_access_changed", "Directory change"],
  ["local_admin_vacancy", "Admin vacancy"],
  ["local_admin_restored", "Admin restored"],
];
const platformActions: [string, string][] = [
  ["tenant-created", "Tenant created"],
  ["source-processing-retry", "Processing repair"],
  ["global_privilege_changed", "Global admin change"],
  ["directory_baseline_established", "Directory baseline"],
  ["maintenance-capability-activated", "Maintenance activated"],
  ["permissions-changed", "Grant changes"],
  ["tenant-renamed", "Tenant renamed"],
];

type Names = Map<string, string>;

/** Chip label/colour and a one-line human summary of an audit event. */
function describe(event: AuditEvent, names: Names): [string, string, string] {
  const kind = event.kind.replaceAll("-", "_");
  const e = event.evidence ?? {};
  const str = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const who = (value: unknown, fallback = "A user or team") => {
    const id = str(value);
    return id ? (names.get(id) ?? id) : fallback;
  };
  switch (kind) {
    case "permissions_changed":
    case "grants_changed": {
      const changes = Array.isArray(e.changes)
        ? (e.changes as Record<string, unknown>[])
        : [];
      const before =
        e.before && typeof e.before === "object"
          ? (e.before as Record<string, unknown>)
          : {};
      const parts = changes.map((change) => {
        const id = str(change.principal_id);
        const name = change.principal
          ? str(change.principal)
          : who(change.principal_id);
        const kindText = change.kind ? ` (${str(change.kind)})` : "";
        const previous = change.before ?? (id ? before[id] : undefined);
        const next = change.after ?? change.role;
        const removed =
          change.action === "remove" ||
          (change.action === undefined && next === undefined);
        if (removed)
          return {
            kind: "removed",
            text: `${name}${kindText}${previous ? `, previously ${roleName(previous)}` : ""}`,
          };
        if (previous)
          return {
            kind: "changed",
            text: `${name}: ${roleName(previous)} → ${roleName(next)}`,
          };
        return {
          kind: "added",
          text: `${name}${kindText} as ${roleName(next)}`,
        };
      });
      const only = parts.length === 1 ? parts[0].kind : "";
      const [label, cls] =
        only === "added"
          ? ["Grant added", "b-green"]
          : only === "removed"
            ? ["Grant removed", "b-red"]
            : only === "changed"
              ? ["Role changed", "b-blue"]
              : ["Grants changed", "b-blue"];
      return [
        label,
        cls,
        parts.map((part) => part.text).join("; ") || "Explicit grants changed",
      ];
    }
    case "tenant_renamed":
      return [
        "Tenant renamed",
        "b-neutral",
        `${str(e.before) || "Previous name"} → ${str(e.after) || "new name"}`,
      ];
    case "tenant_created":
      return [
        "Tenant created",
        "b-green",
        `Created ${str(e.name) || "a tenant"}${e.initial_admin ? ` with ${str(e.initial_admin)} as administrator` : ""}`,
      ];
    case "directory_access_changed":
      return [
        "Directory change",
        "b-neutral",
        `${who(e.principal_id)}: ${roleName(e.before)} → ${roleName(e.after)} through the company directory`,
      ];
    case "principal_ineligible":
      return [
        "Directory change",
        "b-neutral",
        `${str(e.principal) || who(e.principal_id)} not eligible in the directory; grant kept but ineligible`,
      ];
    case "local_admin_vacancy":
      return [
        "Admin vacancy",
        "b-red",
        "No eligible administrator remains after a directory change",
      ];
    case "local_admin_restored":
      return [
        "Admin restored",
        "b-green",
        "An eligible administrator is available again",
      ];
    case "global_privilege_changed":
      return [
        "Global admin change",
        "b-blue",
        `${who(e.principal_id)} ${e.after ? "gained" : "lost"} global administration`,
      ];
    case "directory_baseline_established":
      return [
        "Directory baseline",
        "b-neutral",
        "Company directory baseline established",
      ];
    case "source_processing_retry": {
      const resumed = e.outcome === "resumed";
      return [
        resumed ? "Processing resumed" : "Repair check",
        resumed ? "b-green" : "b-amber",
        `${resumed ? "Repair verified and processing resumed" : `Repair not accepted: ${words(str(e.proof_code) || str(e.outcome) || "unknown outcome")}`}${e.reason ? ` · “${str(e.reason)}”` : ""}`,
      ];
    }
    case "source_processing_blocked":
      return [
        "Processing blocked",
        "b-red",
        `Source processing blocked for ${str(e.tenant) || "a tenant"}${e.reason ? `: ${words(str(e.reason))}` : ""}`,
      ];
    case "source_processing_repaired":
      return [
        "Processing repaired",
        "b-green",
        `Processing ${words(str(e.outcome) || "repaired").toLowerCase()} for ${str(e.tenant) || "a tenant"}`,
      ];
    default: {
      if (kind.startsWith("operator") || kind === "key_copy") {
        const action = kind.replace(/^operator_/, "");
        const operator = str(e.operator) || str(e.name);
        const until = e.retiring_key_expires_at
          ? ` · previous key valid until ${timestamp(e.retiring_key_expires_at)}`
          : "";
        return [
          action === "created" ? "Operator created" : words(action),
          action === "created" ? "b-green" : "b-neutral",
          `${operator ? `Operator ${operator}` : "Operator change"}${until}`,
        ];
      }
      const summary = Object.entries(e)
        .filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value),
        )
        .slice(0, 3)
        .map(([key, value]) => `${words(key)}: ${String(value)}`)
        .join(" · ");
      return [words(kind), "b-neutral", summary || "Recorded change"];
    }
  }
}

/** Evidence as readable key/value text (never HTML). */
function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value))
    return value.map((item) => evidenceText(item)).join("; ") || "—";
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${words(key)}: ${evidenceText(item)}`)
      .join(", ");
  return String(value);
}

export function AuditBrowser({
  scope,
  platform = false,
}: {
  scope: Scope;
  platform?: boolean;
}) {
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [cursor, setCursor] = useState<string | null>(null);
  const [zone, setZone] = useState("UTC");
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string>();
  const ids = useId();
  useEffect(() => setZone(timezoneLabel()), []);
  const allowed = platform
    ? scope.session.global_super_admin
    : scope.tenant.role === "admin";
  const endpoint = platform
    ? "/api/admin/access-audit"
    : `${tenantPath(scope.tenant.id)}/audit`;
  const [known] = useState(() => new Map<string, string>());
  const params = new URLSearchParams({ period: applied.period });
  if (applied.from) params.set("from_at", new Date(applied.from).toISOString());
  if (applied.to) params.set("to_at", new Date(applied.to).toISOString());
  for (const [key, value] of [
    ["action", applied.exactAction.trim() || applied.action],
    ["actor_id", applied.actor],
    ["affected_principal_id", applied.affected],
    ["resource_id", applied.resource],
    ["tenant_id", platform ? applied.tenant : ""],
  ])
    if (value.trim()) params.set(key, value.trim());
  const result = useResource<AuditEvent[]>(
    allowed
      ? `${endpoint}?${params}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : null,
    scope.onDenied,
  );
  const roster = useResource<{ principal_id: string; display_name: string }[]>(
    allowed && !platform ? `${tenantPath(scope.tenant.id)}/permissions` : null,
    () => {},
  );
  const rows = auditPage(result.data?.data) ? result.data.data : undefined;
  const invalidResponse = Boolean(result.data && !rows);
  // Names seen on this page, the tenant roster and the signed-in user.
  const names: Names = new Map(known);
  names.set(scope.session.principal.id, scope.session.principal.display_name);
  if (Array.isArray(roster.data?.data))
    for (const grant of roster.data.data)
      if (grant && typeof grant.principal_id === "string")
        names.set(grant.principal_id, grant.display_name);
  for (const event of rows ?? [])
    if (event.actor_id && event.actor_label)
      names.set(event.actor_id, event.actor_label);
  useEffect(() => {
    for (const [id, name] of names) known.set(id, name);
  });
  const crumbs = platform
    ? [
        { label: "Administration" },
        { label: "Platform", href: `/tenants/${scope.tenant.id}/platform` },
      ]
    : [{ label: "Administration" }];
  const title = platform ? "Platform access audit" : "Access audit";
  if (!allowed)
    return (
      <Page
        scope={scope}
        title={title}
        crumbs={crumbs}
        className="adm-page"
        role={platform ? "Global super admin" : undefined}
      >
        <div className="panel adm-notice-panel">
          <p className="notice">
            {platform
              ? "Platform audit requires global administration access."
              : "Access audit requires tenant administration access."}
          </p>
        </div>
      </Page>
    );
  function resolve(value: string, label: string): string | null {
    const text = value.trim();
    if (!text || UUID.test(text)) return text;
    if (text.toLowerCase() === "system") return "system";
    for (const [id, name] of names)
      if (name.toLowerCase() === text.toLowerCase()) return id;
    setFilterError(
      `No known user or team named “${text}” for ${label}. Choose a suggested name or enter an immutable ID.`,
    );
    return null;
  }
  function apply(next: Filters) {
    setFilterError(undefined);
    const actor = resolve(next.actor, "Actor");
    if (actor === null) return;
    const affected = resolve(next.affected, "Affected user or team");
    if (affected === null) return;
    setApplied({ ...next, actor, affected });
    setCursor(null);
    setOpen(null);
  }
  const actionOptions = platform ? platformActions : tenantActions;
  const nameOptions = Array.from(new Set(names.values())).sort();
  const input = (
    key: keyof Filters,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <div className="f">
      <label className="lbl" htmlFor={`${ids}-${key}`}>
        {label}
      </label>
      <input
        id={`${ids}-${key}`}
        className="inp"
        value={draft[key]}
        maxLength={key === "exactAction" ? 128 : 64}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        {...props}
      />
    </div>
  );
  return (
    <Page
      scope={scope}
      title={title}
      crumbs={crumbs}
      role={platform ? "Global super admin" : undefined}
      extra={
        <span className="adm-subtitle">Read-only · kept for 365 days</span>
      }
      className="adm-page"
      actions={
        <button
          type="button"
          className="btn"
          aria-label="Refresh audit"
          disabled={result.loading}
          onClick={() => {
            setCursor(null);
            result.reload();
          }}
        >
          Refresh
        </button>
      }
    >
      <form
        className="adm-toolbar"
        aria-label="Audit filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <div className="seg" role="group" aria-label="Audit period">
          {[
            ["recent", "Last 30 days"],
            ["retained", "Full retained period"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={applied.period === value}
              onClick={() => {
                const next = { ...draft, period: value };
                setDraft(next);
                setApplied({ ...applied, period: value });
                setCursor(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className="inp"
          aria-label="Action"
          value={draft.action}
          onChange={(event) =>
            setDraft({ ...draft, action: event.target.value })
          }
        >
          <option value="">Any action</option>
          {actionOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`${ids}-actor`}>
          Actor
        </label>
        <input
          id={`${ids}-actor`}
          className="inp adm-actor"
          placeholder="Actor"
          list={`${ids}-names`}
          maxLength={100}
          value={draft.actor}
          onChange={(event) =>
            setDraft({ ...draft, actor: event.target.value })
          }
        />
        <label className="sr-only" htmlFor={`${ids}-affected`}>
          Affected user or team
        </label>
        <input
          id={`${ids}-affected`}
          className="inp adm-affected"
          placeholder="Affected user or team"
          list={`${ids}-names`}
          maxLength={100}
          value={draft.affected}
          onChange={(event) =>
            setDraft({ ...draft, affected: event.target.value })
          }
        />
        <datalist id={`${ids}-names`}>
          <option value="system">System</option>
          {nameOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button className="btn btn-sm">Apply filters</button>
        <button
          type="button"
          className="btn btn-sm btn-g"
          aria-expanded={more}
          aria-controls={`${ids}-more`}
          onClick={() => setMore(!more)}
        >
          More filters
        </button>
      </form>
      {more && (
        <section
          id={`${ids}-more`}
          className="panel adm-au-more"
          aria-label="More filters"
        >
          {input("from", "Recorded from (inclusive)", {
            type: "datetime-local",
          })}
          {input("to", "Recorded before (exclusive)", {
            type: "datetime-local",
          })}
          {input("exactAction", "Exact action", {
            placeholder: "Recorded action code",
          })}
          {input("resource", "Affected resource ID", {
            placeholder: "Tenant or queued source-item UUID",
          })}
          {platform &&
            input("tenant", "Affected tenant ID", {
              placeholder: "Immutable tenant UUID",
            })}
          <p className="help">
            A supplied start overrides the 30-day default. Resource filters
            match recorded tenant and source-item references; they do not search
            note or resource content. Apply filters to use these values.
          </p>
        </section>
      )}
      {filterError && (
        <div role="alert" className="notice error">
          {filterError}
        </div>
      )}
      <ErrorNotice error={result.error} />
      <ErrorNotice
        error={
          invalidResponse
            ? new Error(
                "The audit response does not match its API contract. Refresh to try again.",
              )
            : undefined
        }
      />
      <div className="panel table-panel">
        <div
          role="table"
          aria-label="Audit events"
          className="table-body adm-table-scroll"
        >
          <div role="row" className="row head g-au">
            <span role="columnheader">Recorded ↓</span>
            <span role="columnheader">Action</span>
            <span role="columnheader">What changed</span>
            <span role="columnheader">Actor</span>
            <span role="columnheader">
              <span className="sr-only">Details</span>
            </span>
          </div>
          {rows?.map((event) => {
            const [label, cls, summary] = describe(event, names);
            const expanded = open === event.id;
            const actor =
              event.actor_id && event.actor_id === scope.session.principal.id
                ? `${event.actor_label} (you)`
                : event.actor_label ||
                  (event.actor_id ? event.actor_id : "System");
            return (
              <Fragment key={event.id}>
                <div
                  role="row"
                  aria-label="Audit event"
                  className="row g-au adm-au-row"
                >
                  <span role="cell" className="mono small">
                    <time
                      dateTime={event.recorded_at}
                      title={event.recorded_at}
                    >
                      {timestamp(event.recorded_at)}
                    </time>
                  </span>
                  <span role="cell">
                    <span className={`chip ${cls}`}>{label}</span>
                  </span>
                  <span role="cell" className="cell" style={{ fontSize: 13 }}>
                    {summary}
                  </span>
                  <span role="cell" className="cell small">
                    {actor}
                  </span>
                  <span role="cell">
                    <button
                      type="button"
                      className="ibtn adm-expand"
                      aria-label="Show event details"
                      aria-expanded={expanded}
                      aria-controls={`${ids}-${event.id}`}
                      onClick={() => setOpen(expanded ? null : event.id)}
                    >
                      {expanded ? "⌄" : "›"}
                    </button>
                  </span>
                </div>
                {expanded && (
                  <div
                    role="row"
                    id={`${ids}-${event.id}`}
                    aria-label="Audit details"
                    className="row g-au adm-au-details-row"
                  >
                    <div role="cell" className="adm-au-details">
                      <dl>
                        <div className="fld">
                          <dt>Action code</dt>
                          <dd className="mono">{event.kind}</dd>
                        </div>
                        <div className="fld">
                          <dt>Stored UTC</dt>
                          <dd className="mono">{event.recorded_at}</dd>
                        </div>
                        <div className="fld">
                          <dt>Actor</dt>
                          <dd>
                            {event.actor_label}
                            {event.actor_id ? (
                              <span className="mono muted">
                                {" "}
                                · {event.actor_id}
                              </span>
                            ) : (
                              " · System actor"
                            )}
                          </dd>
                        </div>
                        <div className="fld">
                          <dt>Event</dt>
                          <dd className="mono">
                            {event.id}
                            {event.dependency_protected
                              ? " · Dependency-protected evidence"
                              : ""}
                          </dd>
                        </div>
                        {event.references?.map((reference) => (
                          <div
                            className="fld"
                            key={`${reference.kind}:${reference.id}`}
                          >
                            <dt>Reference · {words(reference.kind)}</dt>
                            <dd className="mono">
                              {reference.id}
                              {reference.available === false
                                ? " · Referenced resource unavailable"
                                : ""}
                            </dd>
                          </div>
                        ))}
                        {Object.entries(event.evidence ?? {}).map(
                          ([key, value]) => (
                            <div className="fld" key={`evidence:${key}`}>
                              <dt>{words(key)}</dt>
                              <dd>{evidenceText(value)}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
          {result.loading && !rows && (
            <div className="adm-empty-row" role="status">
              Loading audit records…
            </div>
          )}
          {rows && !result.error && !rows.length && (
            <div className="adm-empty-row">
              No audit records match these filters.
            </div>
          )}
        </div>
        <div className="table-footer-bar">
          <span>
            {result.data && (result.loading || !!result.error)
              ? "Previous audit page · updating or unavailable"
              : "Newest first"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={!cursor || result.loading}
            onClick={() => setCursor(null)}
          >
            First page
          </button>
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={
              !result.data?.next_cursor ||
              result.loading ||
              !!result.error ||
              invalidResponse
            }
            onClick={() => setCursor(result.data?.next_cursor ?? null)}
          >
            Older records
          </button>
          <div className="adm-spacer" />
          <span>Times in {zone}</span>
        </div>
      </div>
    </Page>
  );
}
