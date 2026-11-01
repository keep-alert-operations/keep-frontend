"use client";
import { useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, RecordData, tenantPath, timestamp } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { NavLink, Page, Severity, personLabel } from "./page";

const defaults = {
  view: "active",
  q: "",
  limit: "50",
  status: "",
  severity: "",
  assignee: "",
  origin: "",
  rule_id: "",
  alert_id: "",
  incident_id: "",
  created_from: "",
  created_to: "",
  activity_from: "",
  activity_to: "",
  resolved_from: "",
  resolved_to: "",
  sort: "last_activity",
  direction: "desc",
};
type Filters = typeof defaults;
const assigneeKindOf = (value: string) =>
  ["", "me", "unassigned"].includes(value) ? value : "id";
const uuidPattern =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const timeFields = ["created", "activity", "resolved"] as const;
const timeLabel = {
  created: "Created",
  activity: "Activity",
  resolved: "Resolved",
};
const advancedKeys = [
  "rule_id",
  "alert_id",
  "incident_id",
  "created_from",
  "created_to",
  "activity_from",
  "activity_to",
  "resolved_from",
  "resolved_to",
] as const;
const sortOptions = [
  ["last_activity:desc", "Last activity, newest"],
  ["last_activity:asc", "Last activity, oldest"],
  ["created_at:desc", "Created, newest"],
  ["created_at:asc", "Created, oldest"],
  ["severity:desc", "Severity, highest"],
  ["severity:asc", "Severity, lowest"],
  ["resolved_at:desc", "Resolved, newest"],
  ["resolved_at:asc", "Resolved, oldest"],
] as const;
/** Upper bound of the active-count query behind the view counts. */
const COUNT_LIMIT = 200;

export const INCIDENT_STATUS: Record<string, string> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

/** Reference incident status pill (Open / Investigating / Resolved). */
export function IncidentStatus({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : "";
  return (
    <span className={`ist ist-${text}`}>{INCIDENT_STATUS[text] ?? "—"}</span>
  );
}

/**
 * "3 linked · 1 suppressed · 1 unavailable" from the row's link counts (REV-56).
 * Zero parts are left out; suppressed is null while maintenance proof is pending.
 */
export function linkedSummary(row: RecordData) {
  const total = row.total_linked;
  if (typeof total !== "string") return "—";
  const parts = [`${total} linked`];
  for (const key of ["suppressed", "unavailable"] as const) {
    const value = row[key];
    if (typeof value === "string" && value !== "0")
      parts.push(`${value} ${key}`);
  }
  return parts.join(" · ");
}

/**
 * Filters named in the URL, so a link (for example from a report) opens the list
 * already filtered. Unknown keys are ignored; values are validated on apply.
 */
function linkedFilters(search: URLSearchParams): Filters {
  const filters = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Filters)[]) {
    const value = search.get(key);
    if (value !== null) filters[key] = value;
  }
  return filters;
}

export function IncidentList({ scope }: { scope: Scope }) {
  const moreId = useId();
  const searchParams = useSearchParams();
  // App Router can render before window.location updates; read the link once.
  const [linked] = useState(() => linkedFilters(searchParams));
  const [draft, setDraft] = useState<Filters>(linked);
  const [filters, setFilters] = useState<Filters>(linked);
  const [cursor, setCursor] = useState<string | null>(null);
  const [assigneeKind, setAssigneeKind] = useState(
    assigneeKindOf(linked.assignee),
  );
  const [validation, setValidation] = useState<string>();
  const [more, setMore] = useState(
    () =>
      advancedKeys.some((key) => linked[key]) ||
      assigneeKindOf(linked.assignee) === "id",
  );
  const prefix = tenantPath(scope.tenant.id);
  const params = new URLSearchParams(filters);
  for (const [key, value] of Object.entries(filters)) {
    if (!value) params.delete(key);
    else if (key.endsWith("_from") || key.endsWith("_to"))
      params.set(key, `${value}:00Z`);
  }
  if (cursor) params.set("cursor", cursor);
  const result = useResource<RecordData[]>(
    `${prefix}/incidents?${params}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  // One bounded page of active incidents gives the header and view counts.
  const active = useResource<RecordData[]>(
    `${prefix}/incidents?view=active&limit=${COUNT_LIMIT}`,
    scope.onDenied,
    scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : undefined;
  const ruleIds = new Set(
    (rows ?? [])
      .filter((row) => typeof row.origin_rule_name !== "string")
      .map((row) => row.origin_rule_id ?? row.rule_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const rules = useResource<RecordData[]>(
    ruleIds.size ? `${prefix}/correlation-rules?limit=200` : null,
    scope.onDenied,
  );
  const ruleNames = new Map(
    (Array.isArray(rules.data?.data) ? rules.data.data : []).map((rule) => [
      rule.id,
      typeof rule.name === "string" ? rule.name : "",
    ]),
  );
  const error =
    result.error ??
    (result.data && !rows
      ? new ApiError(
          502,
          "invalid_response",
          "The incident list does not match its API contract.",
        )
      : undefined);
  const activeRows = Array.isArray(active.data?.data)
    ? active.data.data
    : undefined;
  const activeCount = activeRows
    ? `${activeRows.length}${active.data?.next_cursor ? "+" : ""}`
    : undefined;
  const unassigned =
    activeRows && !active.data?.next_cursor
      ? activeRows.filter((row) => !row.assignee_id).length
      : undefined;
  const advancedCount =
    advancedKeys.filter((key) => filters[key]).length +
    (assigneeKind === "id" && filters.assignee ? 1 : 0) +
    (filters.limit !== defaults.limit ? 1 : 0);

  function refresh() {
    if (cursor) setCursor(null);
    else result.reload();
    active.reload();
  }
  /** Applies one top-row control at once, leaving other drafts untouched. */
  function applyNow(patch: Partial<Filters>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setFilters((previous) => ({ ...previous, ...patch }));
    setCursor(null);
  }
  function applyDraft() {
    for (const field of timeFields) {
      if (
        draft[`${field}_from`] &&
        draft[`${field}_to`] &&
        draft[`${field}_from`] >= draft[`${field}_to`]
      ) {
        setValidation(`${timeLabel[field]} range must end after it starts.`);
        setMore(true);
        return;
      }
    }
    setValidation(undefined);
    const applied = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, value.trim()]),
    ) as Filters;
    setFilters(applied);
    setCursor(null);
    if (!cursor && JSON.stringify(applied) === JSON.stringify(filters))
      result.reload();
  }
  function reset() {
    setDraft(defaults);
    setFilters(defaults);
    setCursor(null);
    setAssigneeKind("");
    setValidation(undefined);
  }
  const sortedBy = (key: string) =>
    filters.sort === key ? (filters.direction === "desc" ? " ↓" : " ↑") : "";

  return (
    <Page
      scope={scope}
      title="Incidents"
      crumbs={[{ label: "Incidents" }]}
      extra={
        activeCount !== undefined ? (
          <span className="page-subtitle">
            {activeCount} active
            {unassigned !== undefined ? ` · ${unassigned} unassigned` : ""}
          </span>
        ) : undefined
      }
      actions={
        scope.tenant.role !== "view" ? (
          <NavLink
            scope={scope}
            className="btn btn-p"
            href={`/tenants/${scope.tenant.id}/incidents/new`}
          >
            New incident
          </NavLink>
        ) : undefined
      }
    >
      <form
        className="inc-filters"
        aria-label="Incident filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyDraft();
        }}
      >
        <div className="inc-filter-row">
          <div className="seg" role="group" aria-label="Incident view">
            {(
              [
                ["active", "Active"],
                ["resolved", "Resolved"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filters.view === value}
                className={filters.view === value ? "on" : undefined}
                onClick={() => applyNow({ view: value })}
              >
                {label}
                {value === "active" && activeCount !== undefined && (
                  <b>{activeCount}</b>
                )}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="incident-search">
            Search incidents
          </label>
          <input
            id="incident-search"
            className="inp inc-search"
            value={draft.q}
            maxLength={256}
            placeholder="Search title and description"
            title="Matches all text terms, ignoring case, in current title, description, and non-deleted notes. Press Enter to search."
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
          <select
            className="inp"
            aria-label="Status"
            value={filters.status}
            onChange={(event) => applyNow({ status: event.target.value })}
          >
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="investigating">Investigating</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            className="inp"
            aria-label="Severity"
            value={filters.severity}
            onChange={(event) => applyNow({ severity: event.target.value })}
          >
            <option value="">Any severity</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            className="inp"
            aria-label="Assignee"
            value={assigneeKind}
            onChange={(event) => {
              const kind = event.target.value;
              setAssigneeKind(kind);
              if (kind === "id") {
                setDraft({ ...draft, assignee: "" });
                setMore(true);
              } else applyNow({ assignee: kind });
            }}
          >
            <option value="">Any assignee</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
            <option value="id">User ID…</option>
          </select>
          <select
            className="inp"
            aria-label="Creation source"
            value={filters.origin}
            onChange={(event) => applyNow({ origin: event.target.value })}
          >
            <option value="">Any source</option>
            <option value="correlation">Correlation</option>
            <option value="manual">Manual</option>
          </select>
          <button
            type="button"
            className="btn btn-g btn-sm inc-more"
            aria-expanded={more}
            aria-controls={moreId}
            onClick={() => setMore((value) => !value)}
          >
            More filters
            {advancedCount > 0 && <b>{advancedCount}</b>}
          </button>
          <span className="grow" />
          <label className="inc-sort small muted">
            Sort
            <select
              className="inp"
              value={`${filters.sort}:${filters.direction}`}
              onChange={(event) => {
                const [sort, direction] = event.target.value.split(":");
                applyNow({ sort, direction });
              }}
            >
              {sortOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {/* Enter in the search box submits the whole draft. */}
          <button type="submit" className="sr-only" tabIndex={-1}>
            Search
          </button>
        </div>
        <div id={moreId} className="panel inc-more-panel" hidden={!more}>
          <div className="inc-more-grid">
            {assigneeKind === "id" && (
              <div className="f">
                <label className="lbl" htmlFor="incident-assignee-id">
                  Assignee identifier
                </label>
                <input
                  id="incident-assignee-id"
                  className="inp mono"
                  value={draft.assignee}
                  required
                  pattern={uuidPattern}
                  onChange={(event) =>
                    setDraft({ ...draft, assignee: event.target.value })
                  }
                />
              </div>
            )}
            {(
              [
                ["incident_id", "Exact incident identifier"],
                ["rule_id", "Originating rule identifier"],
                ["alert_id", "Linked alert identifier"],
              ] as const
            ).map(([key, label]) => (
              <div className="f" key={key}>
                <label className="lbl" htmlFor={`incident-${key}`}>
                  {label}
                </label>
                <input
                  id={`incident-${key}`}
                  className="inp mono"
                  value={draft[key]}
                  pattern={uuidPattern}
                  onChange={(event) =>
                    setDraft({ ...draft, [key]: event.target.value })
                  }
                />
              </div>
            ))}
            <div className="f">
              <label className="lbl" htmlFor="incident-limit">
                Rows per page
              </label>
              <select
                id="incident-limit"
                className="inp"
                value={draft.limit}
                onChange={(event) =>
                  setDraft({ ...draft, limit: event.target.value })
                }
              >
                {[50, 100, 200].map((limit) => (
                  <option key={limit} value={limit}>
                    {limit}
                  </option>
                ))}
              </select>
            </div>
            {timeFields.map((field) =>
              (["from", "to"] as const).map((edge) => (
                <div className="f" key={`${field}_${edge}`}>
                  <label className="lbl" htmlFor={`incident-${field}-${edge}`}>
                    {timeLabel[field]} {edge === "from" ? "from" : "before"}{" "}
                    (UTC)
                  </label>
                  <input
                    id={`incident-${field}-${edge}`}
                    className="inp mono"
                    type="datetime-local"
                    step="60"
                    value={draft[`${field}_${edge}`]}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [`${field}_${edge}`]: event.target.value,
                      })
                    }
                  />
                </div>
              )),
            )}
          </div>
          <p className="help">
            Time ranges use UTC. From is inclusive; before is exclusive. All
            filters, including the selected view, apply together. Incident
            identifier breaks sort ties and unresolved incidents sort last by
            resolution time.
          </p>
          {validation && (
            <p className="banner bn-err" role="alert">
              {validation}
            </p>
          )}
          <div className="inc-more-actions">
            <button type="button" className="btn btn-sm btn-g" onClick={reset}>
              Reset filters
            </button>
            <button type="submit" className="btn btn-sm btn-p">
              Apply filters
            </button>
          </div>
        </div>
      </form>
      <ErrorNotice error={error} />
      <section className="panel table-panel grow" aria-label="Incident results">
        <div role="table" aria-label="Incidents" className="table-body">
          <div role="row" className="row head g-inc">
            <span role="columnheader">Incident</span>
            <span role="columnheader">Severity{sortedBy("severity")}</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Linked alerts</span>
            <span role="columnheader">Assignee</span>
            <span role="columnheader">
              Last activity{sortedBy("last_activity")}
            </span>
            <span role="columnheader">Origin</span>
          </div>
          {rows?.map((row) => {
            const title =
              typeof row.title === "string" && row.title ? row.title : row.id;
            const ruleId = row.origin_rule_id ?? row.rule_id;
            const rule =
              typeof row.origin_rule_name === "string"
                ? row.origin_rule_name
                : typeof ruleId === "string"
                  ? ruleNames.get(ruleId)
                  : undefined;
            const description =
              typeof row.description === "string" ? row.description : "";
            const sub =
              row.origin === "correlation" && rule
                ? `${rule}${description ? ` — ${description}` : ""}`
                : description;
            const assignee = personLabel(
              scope,
              row.assignee_id,
              row.assignee_display_name,
            );
            return (
              <div
                role="row"
                key={row.id}
                className={`row g-inc inc-row alert-link-row ${row.status === "resolved" ? "r-res" : ""}`}
              >
                <span role="cell" className="inc-title-cell">
                  <NavLink
                    scope={scope}
                    className="lnk alert-row-link"
                    href={`/tenants/${scope.tenant.id}/incidents/${row.id}`}
                  >
                    {title}
                  </NavLink>
                  {sub && <span className="sub">{sub}</span>}
                </span>
                <span role="cell">
                  <Severity value={row.severity} />
                </span>
                <span role="cell">
                  <IncidentStatus value={row.status} />
                </span>
                <span role="cell" className="cell small">
                  {linkedSummary(row)}
                </span>
                <span
                  role="cell"
                  className={`cell inc-assignee ${row.assignee_id ? "" : "ack-n"}`}
                >
                  {assignee}
                </span>
                <span role="cell" className="cell mono small">
                  {timestamp(row.last_activity)}
                </span>
                <span role="cell" className="cell small muted">
                  {row.origin === "correlation"
                    ? "Correlation"
                    : row.origin === "manual"
                      ? "Manual"
                      : "—"}
                </span>
              </div>
            );
          })}
          {result.loading && !rows && (
            <p className="inc-table-state" role="status">
              Loading incidents…
            </p>
          )}
          {rows && !rows.length && !error && (
            <div className="inc-table-state">
              <h2>No incidents found</h2>
              <p>No visible incidents match the applied filters.</p>
            </div>
          )}
        </div>
        <div className="table-footer-bar">
          {result.loading && rows ? (
            <span role="status">Loading incidents…</span>
          ) : (
            <span>
              {rows ? (
                <>
                  <b>{rows.length}</b> on this page
                </>
              ) : null}
            </span>
          )}
          {rows && (result.loading || error) && (
            <span className="muted">
              Previous successful records · updating
            </span>
          )}
          <span className="grow" />
          <span
            className="muted small inc-footer-note"
            title="Pages are not a frozen snapshot. Refresh from the first page to see reordered updates."
          >
            Pages are not a frozen snapshot
          </span>
          <button type="button" className="btn btn-sm btn-g" onClick={refresh}>
            Refresh from first page
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!cursor}
            onClick={() => setCursor(null)}
          >
            First page
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={
              !result.data?.next_cursor || result.loading || Boolean(error)
            }
            onClick={() => setCursor(result.data?.next_cursor ?? null)}
          >
            Next page
          </button>
        </div>
      </section>
    </Page>
  );
}
