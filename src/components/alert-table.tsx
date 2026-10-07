"use client";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  display,
  RecordData,
  request,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { alertOperatorLabel } from "@/lib/alert-operator";
import { useCommand } from "@/lib/hooks";
import {
  currentAlertColumns,
  DEFAULT_SORT,
  fieldLabel,
  SORT_FIELDS,
  type SortItem,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { DirectoryPicker } from "./directory-picker";
import { ErrorNotice } from "./ui";
import { AlertStatus, NavLink, personLabel, Severity, TimeCell } from "./page";

/** Transient quick views (reference S02/S05); never saved into a preset. */
export const QUICK_VIEWS = [
  { key: "all", label: "All", cel: "" },
  {
    key: "critical",
    label: "Critical",
    cel: 'severity == "critical"',
    severity: true,
  },
  {
    key: "high",
    label: "High",
    cel: 'severity == "high"',
    severity: true,
  },
  {
    key: "warning",
    label: "Warning",
    cel: 'severity == "warning"',
    severity: true,
  },
  {
    key: "firing",
    label: "Firing",
    cel: 'display_status == "firing"',
  },
  {
    key: "acknowledged",
    label: "Acknowledged",
    cel: 'display_status == "acknowledged"',
  },
  { key: "active", label: "Active", cel: 'status == "firing"' },
  { key: "resolved", label: "Resolved", cel: 'status == "resolved"' },
] as const;
export type QuickViewKey = (typeof QUICK_VIEWS)[number]["key"];

export function composeCel(base: string, key: QuickViewKey) {
  const view = QUICK_VIEWS.find((item) => item.key === key);
  return view?.cel ? `(${base}) && (${view.cel})` : base;
}

/**
 * Fetch exact quick-view totals and the hidden-suppression difference in one batch.
 */
export function useQuickViewCounts(
  scope: Scope,
  base: string | null,
  includeSuppressed: boolean,
  q: string,
  version: string,
) {
  const key = JSON.stringify([scope.tenant.id, base, includeSuppressed, q]);
  const [state, setState] = useState<{
    key: string;
    counts: Partial<Record<QuickViewKey, string>>;
    hidden?: string;
  }>({ key: "", counts: {} });
  const current = useRef(scope);
  current.current = scope;
  const trigger = useRef<() => void>(() => {});
  useEffect(() => {
    if (base === null) return;
    let stopped = false,
      busy = false,
      pending = false;
    async function run() {
      if (stopped || document.visibilityState !== "visible") return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        const queries = QUICK_VIEWS.map((view) => ({
          id: view.key,
          cel: composeCel(base!, view.key),
          q,
          include_suppressed: includeSuppressed,
        }));
        if (!includeSuppressed)
          queries.push({
            id: "including_suppressed" as QuickViewKey,
            cel: base!,
            q,
            include_suppressed: true,
          });
        const result = await request<{ counts: Record<string, string> }>(
          `${tenantPath(current.current.tenant.id)}/alerts/counts`,
          {
            method: "POST",
            csrf: current.current.session.csrf_token,
            body: { queries },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (stopped) return;
        const counts = result.data.counts ?? {};
        const valid = (value: unknown): value is string =>
          typeof value === "string" && /^\d+$/.test(value);
        const all = counts.all,
          including = counts.including_suppressed;
        const hidden =
          !includeSuppressed &&
          valid(all) &&
          valid(including) &&
          BigInt(including) > BigInt(all)
            ? (BigInt(including) - BigInt(all)).toString()
            : undefined;
        setState({
          key,
          counts: Object.fromEntries(
            Object.entries(counts).filter(([, v]) => valid(v)),
          ),
          hidden,
        });
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          current.current.onDenied();
        setState({ key, counts: {} });
      } finally {
        busy = false;
        if (pending && !stopped) {
          pending = false;
          void run();
        }
      }
    }
    trigger.current = () => void run();
    return () => {
      stopped = true;
      trigger.current = () => {};
    };
  }, [key]);
  useEffect(() => trigger.current(), [key, version]);
  return state.key === key ? state : { key, counts: {}, hidden: undefined };
}

export function QuickViews({
  value,
  onChange,
  counts,
  hidden,
  includeSuppressed,
  onIncludeSuppressed,
  disabled,
}: {
  value: QuickViewKey;
  onChange: (value: QuickViewKey) => void;
  counts?: Partial<Record<QuickViewKey, string>>;
  hidden?: string;
  includeSuppressed: boolean;
  onIncludeSuppressed: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="quick-view-bar">
      <div
        role="group"
        aria-label="Quick views, not saved"
        className="quick-view-group"
      >
        {QUICK_VIEWS.map((view) => (
          <button
            key={view.key}
            type="button"
            className={`qv ${value === view.key ? "qv-on" : ""}`}
            aria-pressed={value === view.key}
            aria-label={view.label}
            disabled={disabled}
            onClick={() => onChange(view.key)}
          >
            {"severity" in view && (
              <span className={`sev sev-${view.key}`} aria-hidden="true">
                <i />
              </span>
            )}
            {view.label}
            {counts?.[view.key] !== undefined && (
              <b>{BigInt(counts[view.key]!).toLocaleString()}</b>
            )}
          </button>
        ))}
      </div>
      <span className="help" style={{ marginLeft: 6 }}>
        Quick views are not saved
      </span>
      <div style={{ flexGrow: 1 }} />
      <label className="plain">
        <input
          type="checkbox"
          checked={includeSuppressed}
          disabled={disabled}
          onChange={(event) => onIncludeSuppressed(event.target.checked)}
        />
        Include suppressed
      </label>
      {!includeSuppressed && hidden && (
        <span className="chip chip-supp">
          {BigInt(hidden).toLocaleString()} hidden
        </span>
      )}
    </div>
  );
}

type RowCommand = (
  row: RecordData,
  kind: "set_status" | "set_assignee",
  value: string | null,
) => void;

function AlertField({
  field,
  row,
  scope,
}: {
  field: string;
  row: RecordData;
  scope: Scope;
}) {
  const value = row[field];
  if (field === "severity") return <Severity value={value} />;
  if (field === "display_status" || field === "status")
    return <AlertStatus value={row.status} assigneeId={row.assignee_id} />;
  if (field === "assignee_id")
    return personLabel(scope, value, row.assignee_display_name);
  if (field === "operator") return alertOperatorLabel(row);
  if (
    [
      "timestamp",
      "last_received_at",
      "time_created",
      "first_received_at",
      "opened_at",
      "resolved_at",
    ].includes(field)
  )
    return <TimeCell value={timestamp(value)} />;
  if (field === "active_incident_id" && typeof value === "string")
    return (
      <NavLink
        scope={scope}
        className="chip chip-inc"
        href={`/tenants/${scope.tenant.id}/incidents/${value}`}
      >
        {display(row.active_incident_title ?? value)}
      </NavLink>
    );
  return display(value);
}

function ColumnHeading({
  field,
  label = fieldLabel(field),
  sort,
  onSort,
}: {
  field: string;
  label?: string;
  sort: SortItem[];
  onSort?: (field: string) => void;
}) {
  const sortField = field === "last_received_at" ? "timestamp" : field;
  const index = sort.findIndex((item) => item.field === sortField);
  const direction = index < 0 ? undefined : sort[index].direction;
  const text = `${label}${direction ? ` ${direction === "asc" ? "↑" : "↓"}${sort.length > 1 ? index + 1 : ""}` : ""}`;
  const sortable =
    onSort &&
    (SORT_FIELDS.includes(sortField) ||
      [
        "first_received_at",
        "occurrence_number",
        "opened_at",
        "resolved_at",
      ].includes(sortField));
  return (
    <span
      role="columnheader"
      aria-sort={
        index === 0
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      {sortable ? (
        <button
          type="button"
          className="alert-sort-heading"
          onClick={() => onSort(sortField)}
          title="Sort ascending, descending, then restore regular order"
        >
          {text}
        </button>
      ) : (
        text
      )}
    </span>
  );
}

/**
 * Explicit columns render in their configured order, including preset defaults.
 * Without columns, use the compact alert grid. `narrow` hides row actions.
 */
export function AlertTable({
  scope,
  rows,
  selection,
  onSelectionChange,
  onRowCommand,
  busy,
  narrow,
  newIds,
  columns,
  sort = DEFAULT_SORT,
  onSort,
}: {
  scope: Scope;
  rows: RecordData[];
  selection?: Map<string, string>;
  onSelectionChange?: (next: Map<string, string>) => void;
  onRowCommand?: RowCommand;
  busy?: boolean;
  narrow?: boolean;
  newIds?: Set<string>;
  columns?: string[];
  sort?: SortItem[];
  onSort?: (field: string) => void;
}) {
  if (columns) columns = currentAlertColumns(columns);
  const needsOpen = Boolean(columns && !columns.includes("message"));
  const showControls = needsOpen || (!narrow && scope.tenant.role !== "view");
  const grid = columns
    ? "g-custom"
    : narrow
      ? "g-narrow"
      : `g-full ${showControls ? "" : "g-full-no-actions"}`;
  const widths = columns?.map((field) => (field === "message" ? 280 : 146));
  const gridStyle = widths
    ? {
        gridTemplateColumns: `18px ${widths.map((width) => `minmax(${width}px, 1fr)`).join(" ")}${showControls ? " 196px" : ""}`,
        minWidth:
          54 +
          widths.reduce((total, width) => total + width + 14, 0) +
          (showControls ? 210 : 0),
      }
    : undefined;
  const selectable = Boolean(selection && onSelectionChange);
  const actions = Boolean(onRowCommand) && scope.tenant.role !== "view";
  const allSelected =
    rows.length > 0 && rows.every((row) => selection?.has(row.id));
  function toggle(row: RecordData) {
    if (!selection || !onSelectionChange) return;
    const next = new Map(selection);
    if (next.has(row.id)) next.delete(row.id);
    else if (next.size < 100) next.set(row.id, row.revision);
    onSelectionChange(next);
  }
  return (
    <div role="table" aria-label="Alerts" className="table-body alert-results">
      <div role="row" className={`row head ${grid}`} style={gridStyle}>
        <span role="columnheader">
          {selectable ? (
            <input
              type="checkbox"
              aria-label="Select all on this page"
              checked={allSelected}
              disabled={busy}
              onChange={(event) => {
                const next = new Map(selection);
                for (const row of rows) {
                  if (event.target.checked) {
                    if (next.size < 100) next.set(row.id, row.revision);
                  } else next.delete(row.id);
                }
                onSelectionChange!(next);
              }}
            />
          ) : (
            <span className="sr-only">Selection</span>
          )}
        </span>
        {columns ? (
          columns.map((field) => (
            <ColumnHeading
              key={field}
              field={field}
              sort={sort}
              onSort={onSort}
            />
          ))
        ) : (
          <>
            <ColumnHeading field="severity" sort={sort} onSort={onSort} />
            <span role="columnheader">Alert</span>
            <ColumnHeading field="display_status" sort={sort} onSort={onSort} />
            <ColumnHeading field="timestamp" sort={sort} onSort={onSort} />
            {!narrow && (
              <>
                <ColumnHeading
                  field="assignee_id"
                  label="Ownership"
                  sort={sort}
                  onSort={onSort}
                />
                <span role="columnheader">Incident</span>
              </>
            )}
          </>
        )}
        {showControls && (
          <span role="columnheader" className="alert-actions-cell">
            <span className="sr-only">Actions</span>
          </span>
        )}
      </div>
      {rows.map((row) => {
        const message = display(row.message ?? row.application);
        const selected = selection?.has(row.id) ?? false;
        const resolved = row.status === "resolved";
        const assignee = personLabel(
          scope,
          row.assignee_id,
          row.assignee_display_name,
        );
        return (
          <div
            role="row"
            key={row.id}
            className={`row arow alert-link-row ${grid} ${resolved ? "r-res" : ""} ${selected ? "r-sel" : ""}`}
            style={gridStyle}
          >
            <span role="cell">
              {selectable && (
                <input
                  type="checkbox"
                  aria-label={`Select ${message}`}
                  checked={selected}
                  disabled={busy}
                  onChange={() => toggle(row)}
                />
              )}
            </span>
            {columns ? (
              columns.map((field) => (
                <span
                  role="cell"
                  className={field === "message" ? "alert-cell" : "cell"}
                  key={field}
                >
                  {field === "message" ? (
                    <span className="alert-title">
                      <NavLink
                        scope={scope}
                        className="msg alert-row-link"
                        href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                        aria-label={`Open ${message}`}
                      >
                        {message}
                      </NavLink>
                      {newIds?.has(row.id) && (
                        <span className="chip chip-new">New</span>
                      )}
                      {row.suppressed === true && (
                        <span className="chip chip-supp">Suppressed</span>
                      )}
                    </span>
                  ) : (
                    <AlertField field={field} row={row} scope={scope} />
                  )}
                </span>
              ))
            ) : (
              <>
                <span role="cell" className="cell">
                  <Severity value={row.severity} />
                </span>
                <span role="cell" className="alert-cell">
                  <span className="alert-title">
                    <NavLink
                      scope={scope}
                      className="msg alert-row-link"
                      href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                      aria-label={`Open ${message}`}
                    >
                      {message}
                    </NavLink>
                    {newIds?.has(row.id) && (
                      <span className="chip chip-new">New</span>
                    )}
                    {row.suppressed === true && (
                      <span className="chip chip-supp">Suppressed</span>
                    )}
                  </span>
                  <span className="sub">
                    {[row.application, row.component, row.node_name, row.site]
                      .map(display)
                      .join(" · ")}
                  </span>
                </span>
                <span role="cell" className="cell">
                  <AlertStatus
                    value={row.status}
                    assigneeId={row.assignee_id}
                  />
                </span>
                <span role="cell">
                  <TimeCell value={timestamp(row.timestamp)} />
                </span>
                {!narrow && (
                  <>
                    <span role="cell" className="owner-cell">
                      <span className="cell" style={{ fontSize: 13 }}>
                        {assignee}
                      </span>
                    </span>
                    <span role="cell" style={{ minWidth: 0 }}>
                      {typeof row.active_incident_id === "string" && (
                        <NavLink
                          scope={scope}
                          className="chip chip-inc"
                          href={`/tenants/${scope.tenant.id}/incidents/${row.active_incident_id}`}
                          title={display(
                            row.active_incident_title ?? "Linked incident",
                          )}
                        >
                          {display(
                            row.active_incident_title ?? "Linked incident",
                          )}
                        </NavLink>
                      )}
                    </span>
                  </>
                )}
              </>
            )}
            {showControls && (
              <span
                role="cell"
                className={`alert-actions-cell ${needsOpen ? "alert-cell" : "acts"}`}
              >
                {needsOpen && (
                  <>
                    <NavLink
                      scope={scope}
                      className="lnk alert-row-link"
                      href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                      aria-label={`Open ${message}`}
                    >
                      Open alert
                    </NavLink>
                    {row.suppressed === true && (
                      <span className="chip chip-supp">Suppressed</span>
                    )}
                  </>
                )}
                {actions && !narrow && (
                  <>
                    <button
                      type="button"
                      className="ibtn"
                      disabled={busy}
                      onClick={() =>
                        onRowCommand!(
                          row,
                          "set_assignee",
                          row.assignee_id === scope.session.principal.id
                            ? null
                            : scope.session.principal.id,
                        )
                      }
                    >
                      {row.assignee_id === scope.session.principal.id
                        ? "Unassign"
                        : "Assign to me"}
                    </button>
                    <button
                      type="button"
                      className="ibtn"
                      disabled={busy}
                      onClick={() =>
                        onRowCommand!(
                          row,
                          "set_status",
                          resolved ? "firing" : "resolved",
                        )
                      }
                    >
                      {resolved ? "Reopen" : "Resolve"}
                    </button>
                    <NavLink
                      scope={scope}
                      className="ibtn"
                      href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                      aria-label={`More actions for ${message}`}
                    >
                      ⋯
                    </NavLink>
                  </>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Floating bulk bar (reference S05): resolve, assign to me or
 * assign to a chosen user, applied atomically to at most 100 selected alerts.
 */
export function BulkBar({
  scope,
  selection,
  onDone,
  onClear,
}: {
  scope: Scope;
  selection: Map<string, string>;
  onDone: () => void;
  onClear: () => void;
}) {
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [picking, setPicking] = useState(false);
  if (!selection.size || scope.tenant.role === "view") return null;
  async function apply(
    kind: "set_status" | "set_assignee",
    value: string | null,
  ) {
    const result = await command.execute(
      `${tenantPath(scope.tenant.id)}/alerts/bulk-commands`,
      {
        kind,
        value,
        items: Array.from(selection, ([alert_id, expected_revision]) => ({
          alert_id,
          expected_revision,
        })),
      },
    );
    if (result) {
      setPicking(false);
      onDone();
    }
  }
  return (
    <div className="bulkbar-wrap">
      {(command.error || command.uncertain) && (
        <div className="bulkbar-feedback">
          <ErrorNotice error={command.error} />
          {command.uncertain && (
            <p className="notice" role="status">
              The outcome is uncertain. Retry repeats the original command.
            </p>
          )}
        </div>
      )}
      {picking && (
        <div className="bulkbar-picker panel">
          <div className="ad-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={command.busy || command.uncertain}
              onClick={() =>
                void apply("set_assignee", scope.session.principal.id)
              }
            >
              Assign to me
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={command.busy || command.uncertain}
              onClick={() => void apply("set_assignee", null)}
            >
              Unassign
            </button>
          </div>
          <DirectoryPicker
            endpoint={`${tenantPath(scope.tenant.id)}/assignees`}
            label="Assign selected alerts to"
            disabled={command.busy || command.uncertain}
            onDenied={scope.onDenied}
            onChoose={(principal) => void apply("set_assignee", principal.id)}
          />
        </div>
      )}
      <div role="toolbar" aria-label="Bulk actions" className="bulkbar">
        <strong>{selection.size} selected</strong>
        <button
          type="button"
          className="btn btn-sm"
          disabled={command.busy}
          onClick={() => void apply("set_status", "resolved")}
        >
          Resolve
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={picking}
          disabled={command.busy}
          onClick={() => setPicking(!picking)}
        >
          Assign…
        </button>
        <span className="bulkbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="btn btn-sm btn-g"
          disabled={command.busy}
          onClick={onClear}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
