"use client";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  alertSubtitle,
  alertTitle,
  ApiError,
  display,
  providerLabel,
  RecordData,
  request,
  tenantPath,
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
import {
  DismissalValue,
  DismissDialog,
  dismissedUntil,
  SuppressedChip,
} from "./dismiss-dialog";
import { DirectoryPicker } from "./directory-picker";
import { ErrorNotice, Menu } from "./ui";
import {
  AlertStatus,
  NavLink,
  personLabel,
  RelativeTime,
  Severity,
} from "./page";

/**
 * Transient quick views (reference S02/S05); never saved into a preset.
 * REV-43 drops the former Active view; every severity and status view
 * carries a colored dot. REV-45 adds Assigned to me for the signed-in user.
 */
export const QUICK_VIEWS = [
  { key: "all", label: "All", cel: "" },
  { key: "critical", label: "Critical", cel: 'severity == "critical"' },
  { key: "high", label: "High", cel: 'severity == "high"' },
  { key: "warning", label: "Warning", cel: 'severity == "warning"' },
  { key: "firing", label: "Firing", cel: 'display_status == "firing"' },
  {
    key: "acknowledged",
    label: "Acknowledged",
    cel: 'display_status == "acknowledged"',
  },
  { key: "resolved", label: "Resolved", cel: 'status == "resolved"' },
  {
    key: "mine",
    label: "Assigned to me",
    cel: (me: string) => `assignee_id == ${JSON.stringify(me)}`,
  },
] as const;
export type QuickViewKey = (typeof QUICK_VIEWS)[number]["key"];

/** `me` is the signed-in principal ID, used by Assigned to me. */
export function composeCel(base: string, key: QuickViewKey, me: string) {
  const view = QUICK_VIEWS.find((item) => item.key === key);
  const cel = typeof view?.cel === "function" ? view.cel(me) : view?.cel;
  return cel ? `(${base}) && (${cel})` : base;
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
          cel: composeCel(
            base!,
            view.key,
            current.current.session.principal.id,
          ),
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
  actions,
}: {
  value: QuickViewKey;
  onChange: (value: QuickViewKey) => void;
  counts?: Partial<Record<QuickViewKey, string>>;
  hidden?: string;
  includeSuppressed: boolean;
  onIncludeSuppressed: (value: boolean) => void;
  disabled?: boolean;
  /** View controls, such as Group by, placed before Include suppressed. */
  actions?: ReactNode;
}) {
  return (
    <div className="quick-view-bar">
      <div
        role="group"
        aria-label="Quick views, not saved"
        title="Quick views are not saved"
        className="quick-view-group"
      >
        {QUICK_VIEWS.map((view) => (
          <Fragment key={view.key}>
            {(view.key === "firing" || view.key === "mine") && (
              <span className="qv-div" aria-hidden="true" />
            )}
            <button
              type="button"
              className={`qv ${value === view.key ? "qv-on" : ""}`}
              aria-pressed={value === view.key}
              aria-label={view.label}
              disabled={disabled}
              // Pressing the selected view again returns to All (REV-45).
              onClick={() => onChange(value === view.key ? "all" : view.key)}
            >
              {view.key !== "all" && view.key !== "mine" && (
                <span className={`qv-dot qv-${view.key}`} aria-hidden="true" />
              )}
              {view.label}
              {counts?.[view.key] !== undefined && (
                <span className="qv-count">
                  {BigInt(counts[view.key]!).toLocaleString()}
                </span>
              )}
            </button>
          </Fragment>
        ))}
      </div>
      {/* One right-aligned cluster, so Include suppressed stays beside the view controls. */}
      <div className="quick-view-end">
        {actions && (
          <>
            <div className="quick-view-actions">{actions}</div>
            <span className="qv-div" aria-hidden="true" />
          </>
        )}
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
    </div>
  );
}

export type RowCommand = (
  row: RecordData,
  kind: AlertCommandKind,
  value: string | DismissalValue | null,
) => Promise<boolean> | void;
export type AlertCommandKind = "set_status" | "set_assignee" | "set_dismissal";

/** One saved-column cell, shared with alert table panels (REV-63). */
export function AlertField({
  field,
  row,
  scope,
}: {
  field: string;
  row: RecordData;
  scope: Scope;
}) {
  const value = row[field];
  if (field === "severity") return <Severity value={value} plain />;
  if (field === "display_status" || field === "status")
    return (
      <AlertStatus value={row.status} assigneeId={row.assignee_id} plain />
    );
  if (field === "assignee_id")
    return personLabel(scope, value, row.assignee_display_name);
  if (field === "operator") return alertOperatorLabel(row);
  if (field === "provider") return providerLabel(value);
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
    return <RelativeTime value={value} className="ago" />;
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

const dots = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

/**
 * Explicit columns render in their configured order, including preset defaults.
 * Without columns, use the compact alert grid. `narrow` hides row actions.
 * Rows show severity and status as colored text and times relative to now;
 * the ⋯ menu holds assignment and resolution (REV-43). In grouped results
 * (REV-44) `hide` drops the grouped field's column and `label` names the group.
 */
export function AlertTable({
  scope,
  rows,
  selection,
  onSelectionChange,
  onRowCommand,
  onLinkIncident,
  command,
  busy,
  narrow,
  columns,
  sort = DEFAULT_SORT,
  onSort,
  hide,
  label = "Alerts",
  selectAllLabel = "Select all on this page",
}: {
  scope: Scope;
  rows: RecordData[];
  selection?: Map<string, string>;
  onSelectionChange?: (next: Map<string, string>) => void;
  onRowCommand?: RowCommand;
  /** Opens Link to incident for the row (REV-48). */
  onLinkIncident?: (row: RecordData) => void;
  /** The caller's command state, shown inside the dismiss dialog. */
  command?: { error?: unknown; uncertain: boolean; busy: boolean };
  busy?: boolean;
  narrow?: boolean;
  columns?: string[];
  sort?: SortItem[];
  onSort?: (field: string) => void;
  hide?: string;
  label?: string;
  selectAllLabel?: string;
}) {
  const latest = useRef({ rows, onSelectionChange });
  latest.current = { rows, onSelectionChange };
  const drag = useRef<{
    start: string;
    base: Map<string, string>;
    adding: boolean;
    active: boolean;
  } | null>(null);
  const swallowClick = useRef(false);
  const stopDrag = useRef<() => void>(() => {});
  const [dragging, setDragging] = useState(false);
  const [dismissing, setDismissing] = useState<RecordData | null>(null);
  useEffect(() => () => stopDrag.current(), []);
  if (columns) {
    columns = currentAlertColumns(columns);
    if (hide && columns.length > 1)
      columns = columns.filter((field) => field !== hide);
  }
  const shown = (field: string) => columns !== undefined || field !== hide;
  const needsOpen = Boolean(columns && !columns.includes("message"));
  const showControls = needsOpen || (!narrow && scope.tenant.role !== "view");
  const grid = columns
    ? "g-custom"
    : narrow
      ? "g-narrow"
      : `g-full ${showControls ? "" : "g-full-no-actions"}`;
  const widths = columns?.map((field) => (field === "message" ? 280 : 146));
  const controlsWidth = needsOpen ? 196 : 48;
  // The default grid's fixed tracks; a hidden grouped field drops its track.
  const tracks = [
    ["severity", 96],
    ["message", 0],
    ["display_status", 128],
    ["timestamp", 132],
    ...(narrow
      ? []
      : [
          ["assignee_id", 150],
          ["active_incident_id", 168],
        ]),
  ] as [string, number][];
  const dropped =
    !columns && hide ? tracks.find(([field]) => field === hide) : undefined;
  const gridStyle = widths
    ? {
        gridTemplateColumns: `18px ${widths.map((width) => `minmax(${width}px, 1fr)`).join(" ")}${showControls ? ` ${controlsWidth}px` : ""}`,
        minWidth:
          54 +
          widths.reduce((total, width) => total + width + 14, 0) +
          (showControls ? controlsWidth + 14 : 0),
      }
    : dropped
      ? {
          gridTemplateColumns: `18px ${tracks
            .filter(([field]) => field !== hide)
            .map(([, width]) => (width ? `${width}px` : "minmax(0, 1fr)"))
            .join(" ")}${showControls ? " 48px" : ""}`,
          minWidth: narrow
            ? undefined
            : (showControls ? 1052 : 1004) - dropped[1] - 14,
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
  /**
   * Press on a row and drag over others to select them until release: the
   * rows between the pressed row and the one under the pointer follow the
   * pressed row's state (select, or deselect when it was already selected).
   */
  function pressRow(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !selectable ||
      busy ||
      event.pointerType !== "mouse" ||
      event.button !== 0
    )
      return;
    const target = event.target as Element;
    if (target.closest("input, button, [role=menuitem], [role=columnheader]"))
      return;
    const id = target.closest<HTMLElement>("[data-alert-id]")?.dataset.alertId;
    if (!id) return;
    drag.current = {
      start: id,
      base: new Map(selection),
      adding: !selection!.has(id),
      active: false,
    };
    const end = () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stopDrag.current = () => {};
      const wasActive = drag.current?.active;
      drag.current = null;
      setDragging(false);
      // The click that follows a drag must not open the alert under the pointer.
      if (wasActive) setTimeout(() => (swallowClick.current = false), 0);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    stopDrag.current = end;
  }
  function dragOver(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    if ((event.buttons & 1) === 0) return stopDrag.current();
    const id = (event.target as Element).closest<HTMLElement>("[data-alert-id]")
      ?.dataset.alertId;
    if (!id || (id === state.start && !state.active)) return;
    const { rows: current, onSelectionChange: change } = latest.current;
    const from = current.findIndex((item) => item.id === state.start);
    const to = current.findIndex((item) => item.id === id);
    if (from < 0 || to < 0 || !change) return;
    if (!state.active) {
      state.active = true;
      swallowClick.current = true;
      setDragging(true);
    }
    window.getSelection()?.removeAllRanges();
    const next = new Map(state.base);
    const step = to >= from ? 1 : -1;
    for (let index = from; index !== to + step; index += step) {
      const item = current[index];
      if (!state.adding) next.delete(item.id);
      else if (next.size < 100) next.set(item.id, item.revision);
    }
    change(next);
  }
  return (
    <div
      role="table"
      aria-label={label}
      className={`table-body alert-results ${dragging ? "alert-dragging" : ""}`}
      onPointerDown={pressRow}
      onPointerMove={dragOver}
      onDragStart={(event) => {
        if (drag.current) event.preventDefault();
      }}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div role="row" className={`row head ${grid}`} style={gridStyle}>
        <span role="columnheader">
          {selectable ? (
            <input
              type="checkbox"
              aria-label={selectAllLabel}
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
            {shown("severity") && (
              <ColumnHeading field="severity" sort={sort} onSort={onSort} />
            )}
            <span role="columnheader">Alert</span>
            {shown("display_status") && (
              <ColumnHeading
                field="display_status"
                sort={sort}
                onSort={onSort}
              />
            )}
            <ColumnHeading field="timestamp" sort={sort} onSort={onSort} />
            {!narrow && (
              <>
                {shown("assignee_id") && (
                  <ColumnHeading
                    field="assignee_id"
                    label="Ownership"
                    sort={sort}
                    onSort={onSort}
                  />
                )}
                {shown("active_incident_id") && (
                  <span role="columnheader">Incident</span>
                )}
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
        const title = alertTitle(row);
        const subtitle = alertSubtitle(row);
        const selected = selection?.has(row.id) ?? false;
        const resolved = row.status === "resolved";
        const mine = row.assignee_id === scope.session.principal.id;
        const assignee = personLabel(
          scope,
          row.assignee_id,
          row.assignee_display_name,
        );
        return (
          <div
            role="row"
            key={row.id}
            data-alert-id={row.id}
            className={`row arow alert-link-row ${grid} ${resolved ? "r-res" : ""} ${selected ? "r-sel" : ""}`}
            style={gridStyle}
          >
            <span role="cell">
              {selectable && (
                <input
                  type="checkbox"
                  aria-label={`Select ${title}`}
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
                    <>
                      <span className="alert-title">
                        <NavLink
                          scope={scope}
                          className="msg alert-row-link"
                          href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                          aria-label={`Open ${title}`}
                        >
                          {title}
                        </NavLink>
                        <SuppressedChip alert={row} />
                      </span>
                      {subtitle && (
                        <span className="alert-sub">{subtitle}</span>
                      )}
                    </>
                  ) : (
                    <AlertField field={field} row={row} scope={scope} />
                  )}
                </span>
              ))
            ) : (
              <>
                {shown("severity") && (
                  <span role="cell" className="cell">
                    <Severity value={row.severity} plain />
                  </span>
                )}
                <span role="cell" className="alert-cell">
                  <span className="alert-title">
                    <NavLink
                      scope={scope}
                      className="msg alert-row-link"
                      href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                      aria-label={`Open ${title}`}
                    >
                      {title}
                    </NavLink>
                    <SuppressedChip alert={row} />
                  </span>
                  {subtitle && <span className="alert-sub">{subtitle}</span>}
                </span>
                {shown("display_status") && (
                  <span role="cell" className="cell">
                    <AlertStatus
                      value={row.status}
                      assigneeId={row.assignee_id}
                      plain
                    />
                  </span>
                )}
                <span role="cell" className="cell">
                  <RelativeTime value={row.timestamp} className="ago" />
                </span>
                {!narrow && (
                  <>
                    {shown("assignee_id") && (
                      <span role="cell" className="owner-cell">
                        <span className="cell" style={{ fontSize: 13 }}>
                          {assignee}
                        </span>
                      </span>
                    )}
                    {shown("active_incident_id") && (
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
                    )}
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
                      aria-label={`Open ${title}`}
                    >
                      Open alert
                    </NavLink>
                    <SuppressedChip alert={row} />
                  </>
                )}
                {actions && !narrow && (
                  <Menu
                    label={`Actions for ${title}`}
                    className="row-menu"
                    content={dots}
                    flip
                  >
                    {(close) => (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="menu-item"
                          disabled={busy}
                          onClick={() => {
                            close();
                            onRowCommand!(
                              row,
                              "set_assignee",
                              mine ? null : scope.session.principal.id,
                            );
                          }}
                        >
                          {mine ? "Unassign" : "Assign to me"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="menu-item"
                          disabled={busy}
                          onClick={() => {
                            close();
                            onRowCommand!(
                              row,
                              "set_status",
                              resolved ? "firing" : "resolved",
                            );
                          }}
                        >
                          {resolved ? "Reopen" : "Resolve"}
                        </button>
                        {onLinkIncident && (
                          <button
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            disabled={busy}
                            onClick={() => {
                              close();
                              onLinkIncident(row);
                            }}
                          >
                            Link to incident
                          </button>
                        )}
                        {dismissedUntil(row) ? (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item"
                              disabled={busy}
                              onClick={() => {
                                close();
                                setDismissing(row);
                              }}
                            >
                              Change dismissal
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item"
                              disabled={busy}
                              onClick={() => {
                                close();
                                void onRowCommand!(row, "set_dismissal", null);
                              }}
                            >
                              Undismiss
                            </button>
                          </>
                        ) : (
                          !resolved && (
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item"
                              disabled={busy}
                              onClick={() => {
                                close();
                                setDismissing(row);
                              }}
                            >
                              Dismiss
                            </button>
                          )
                        )}
                      </>
                    )}
                  </Menu>
                )}
              </span>
            )}
          </div>
        );
      })}
      {dismissing && onRowCommand && (
        <DismissDialog
          alert={dismissing}
          command={command ?? { busy: Boolean(busy), uncertain: false }}
          onClose={() => setDismissing(null)}
          onSubmit={async (value) =>
            (await onRowCommand(dismissing, "set_dismissal", value)) === true
          }
        />
      )}
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
