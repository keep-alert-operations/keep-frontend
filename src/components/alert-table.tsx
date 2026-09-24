"use client";
import { useEffect, useRef, useState } from "react";
import { display, RecordData, tenantPath, timestamp } from "@/lib/api";
import { useCommand } from "@/lib/hooks";
import { DEFAULT_SORT, fieldLabel, type SortItem } from "@/lib/preset-choices";
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
    cel: 'alert.severity == "critical"',
    severity: true,
  },
  {
    key: "high",
    label: "High",
    cel: 'alert.severity == "high"',
    severity: true,
  },
  {
    key: "warning",
    label: "Warning",
    cel: 'alert.severity == "warning"',
    severity: true,
  },
  {
    key: "unacknowledged",
    label: "Unacknowledged",
    cel: '!alert.acknowledged && alert.status == "firing"',
  },
  {
    key: "unassigned",
    label: "Unassigned",
    cel: 'alert.assignee_id == null && alert.status == "firing"',
  },
] as const;
export type QuickViewKey = (typeof QUICK_VIEWS)[number]["key"];

export function composeCel(base: string, key: QuickViewKey) {
  const view = QUICK_VIEWS.find((item) => item.key === key);
  return view?.cel ? `(${base}) && (${view.cel})` : base;
}

/**
 * Exact totals for every quick view plus the number of suppressed alerts the
 * current view hides. `fetchTotal` returns meta.total for one expression.
 */
export function useQuickViewCounts(
  fetchTotal: (
    cel: string,
    includeSuppressed: boolean,
    signal: AbortSignal,
  ) => Promise<unknown>,
  base: string | null,
  includeSuppressed: boolean,
  key: string,
) {
  const [state, setState] = useState<{
    key: string;
    counts: Partial<Record<QuickViewKey, string>>;
    hidden?: string;
  }>({ key: "", counts: {} });
  const fetcher = useRef(fetchTotal);
  fetcher.current = fetchTotal;
  useEffect(() => {
    if (base === null) return;
    const controller = new AbortController();
    const numeric = (value: unknown) =>
      typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
    void Promise.all(
      QUICK_VIEWS.map((view) =>
        fetcher
          .current(
            composeCel(base, view.key),
            includeSuppressed,
            controller.signal,
          )
          .then(numeric)
          .catch(() => undefined),
      ),
    ).then(async (totals) => {
      if (controller.signal.aborted) return;
      let hidden: string | undefined;
      if (!includeSuppressed && totals[0] !== undefined) {
        const all = await fetcher
          .current(base, true, controller.signal)
          .then(numeric)
          .catch(() => undefined);
        if (all !== undefined) {
          const difference = BigInt(all) - BigInt(totals[0]);
          hidden = difference > 0n ? difference.toString() : undefined;
        }
      }
      if (controller.signal.aborted) return;
      setState({
        key,
        counts: Object.fromEntries(
          QUICK_VIEWS.map((view, index) => [view.key, totals[index]]),
        ),
        hidden,
      });
    });
    return () => controller.abort();
  }, [base, includeSuppressed, key]);
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
  kind: "set_status" | "set_acknowledged",
  value: string | boolean,
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
  if (field === "status") return <AlertStatus value={value} />;
  if (field === "assignee_id" || field === "acknowledged_by")
    return personLabel(
      scope,
      value,
      row[
        field === "assignee_id"
          ? "assignee_display_name"
          : "acknowledged_by_display_name"
      ],
    );
  if (
    [
      "timestamp",
      "last_received_at",
      "time_created",
      "first_received_at",
      "opened_at",
      "resolved_at",
      "acknowledged_at",
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
}: {
  field: string;
  label?: string;
  sort: SortItem[];
}) {
  const index = sort.findIndex((item) => item.field === field);
  const direction = index < 0 ? undefined : sort[index].direction;
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
      {label}
      {direction &&
        ` ${direction === "asc" ? "↑" : "↓"}${sort.length > 1 ? index + 1 : ""}`}
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
}) {
  const grid = columns ? "g-custom" : narrow ? "g-narrow" : "g-full";
  const needsOpen = Boolean(columns && !columns.includes("message"));
  const showControls = !narrow || needsOpen;
  const widths = columns?.map((field) => (field === "message" ? 280 : 146));
  const gridStyle = widths
    ? {
        gridTemplateColumns: `18px ${widths.map((width) => `minmax(${width}px, 1fr)`).join(" ")}${showControls ? " 132px" : ""}`,
        minWidth:
          54 +
          widths.reduce((total, width) => total + width + 14, 0) +
          (showControls ? 146 : 0),
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
    <div role="table" aria-label="Alerts" className="table-body">
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
            <ColumnHeading key={field} field={field} sort={sort} />
          ))
        ) : (
          <>
            <ColumnHeading field="severity" sort={sort} />
            <span role="columnheader">Alert</span>
            <ColumnHeading field="status" sort={sort} />
            <ColumnHeading field="timestamp" sort={sort} />
            {!narrow && (
              <>
                <span role="columnheader">Ownership</span>
                <span role="columnheader">Incident</span>
              </>
            )}
          </>
        )}
        {showControls && (
          <span role="columnheader">
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
            className={`row arow ${grid} ${resolved ? "r-res" : ""} ${selected ? "r-sel" : ""}`}
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
                        className="msg"
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
                      className="msg"
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
                  <AlertStatus value={row.status} />
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
                      <span
                        className={`cell ${row.acknowledged ? "ack-y" : "ack-n"}`}
                        style={{ fontSize: 11.5 }}
                      >
                        {row.acknowledged
                          ? "Acknowledged"
                          : resolved
                            ? "—"
                            : "Not acknowledged"}
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
              <span role="cell" className={needsOpen ? "alert-cell" : "acts"}>
                {needsOpen && (
                  <>
                    <NavLink
                      scope={scope}
                      className="lnk"
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
                          "set_acknowledged",
                          !row.acknowledged,
                        )
                      }
                    >
                      {row.acknowledged ? "Unack" : "Ack"}
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
 * Floating bulk bar (reference S05): acknowledge, resolve, assign to me or
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
    kind: "set_status" | "set_acknowledged" | "set_assignee",
    value: string | boolean | null,
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
          <DirectoryPicker
            endpoint={`${tenantPath(scope.tenant.id)}/assignees`}
            label="Assign selected alerts to"
            disabled={command.busy}
            onDenied={scope.onDenied}
            onChoose={(principal) => void apply("set_assignee", principal.id)}
          />
        </div>
      )}
      <div role="toolbar" aria-label="Bulk actions" className="bulkbar">
        <strong>{selection.size} selected</strong>
        <button
          type="button"
          className="btn btn-sm btn-light"
          disabled={command.busy}
          onClick={() => void apply("set_acknowledged", true)}
        >
          Acknowledge
        </button>
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
          disabled={command.busy}
          onClick={() => void apply("set_assignee", scope.session.principal.id)}
        >
          Assign to me
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
