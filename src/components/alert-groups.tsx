"use client";
import type { RowCommand } from "./alert-table";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ApiError, display, request, type RecordData } from "@/lib/api";
import { useSearchResource } from "@/lib/search-resource";
import { alertVocabulary, type SortItem } from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { AlertTable } from "./alert-table";
import { Menu } from "./ui";
import { personLabel, RelativeTime } from "./page";

/**
 * Grouped alert results (REV-44): one table per value of one field, with exact
 * counts from the API. The first view refreshes like a first page; once more
 * rows or groups load it keeps its snapshot until the user returns to it.
 */
export const GROUP_FIELDS = [
  ["severity", "Severity"],
  ["display_status", "Status"],
  ["name", "Alert name"],
  ["application", "Application"],
  ["component", "Component"],
  ["object", "Object"],
  ["node_name", "Node"],
  ["site", "Site"],
  ["assignee_id", "Assignee"],
  ["active_incident_id", "Incident"],
] as const;
export type GroupField = (typeof GROUP_FIELDS)[number][0];
/** Group-by fields offered in a tenant of `kind` (REV-77: Global uses v1). */
export function groupFieldsFor(kind: string | undefined): GroupField[] {
  const offered = alertVocabulary(kind).groupFields;
  return GROUP_FIELDS.map(([field]) => field).filter((field) =>
    offered.includes(field),
  );
}
export const GROUP_ROWS = 5;
export const GROUP_PAGE = 10;
// v2 and v1 (REV-77) severities, most urgent first.
const SEVERITIES = ["critical", "error", "high", "major", "warning", "clear"];
const STATUSES = ["firing", "acknowledged", "resolved"];

export function isGroupField(value: unknown): value is GroupField {
  return GROUP_FIELDS.some(([field]) => field === value);
}
export function groupFieldLabel(field: unknown) {
  return GROUP_FIELDS.find(([key]) => key === field)?.[1] ?? "No grouping";
}
export function tooManyGroups(error: unknown) {
  return error instanceof ApiError && error.code === "too_many_groups";
}

export interface AlertGroup {
  key: string | null;
  label?: string | null;
  total?: string | null;
  severity?: Record<string, string> | null;
  status?: Record<string, string> | null;
  data: RecordData[];
  next_cursor?: string | null;
}
type More = { rows: RecordData[]; cursor: string | null };

const icon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
  </svg>
);
const chevronDown = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const check = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12l5 5L20 7" />
  </svg>
);

/** Group by menu; `saved` (a preset's saved grouping) adds the Saved tag and note. */
export function GroupByControl({
  kind,
  value,
  saved,
  onChange,
}: {
  /** Tenant kind; Global offers the v1 fields (REV-77). */
  kind: string;
  value: GroupField | null;
  saved?: GroupField | null;
  onChange: (value: GroupField | null) => void;
}) {
  const current = value ? groupFieldLabel(value) : null;
  return (
    <Menu
      label={current ? `Group by ${current}` : "Group by"}
      className="btn btn-sm gb-btn"
      content={
        <>
          {icon}
          <span className="gb-lbl">Group by</span>
          {current && <span className="gb-val">{current}</span>}
          {chevronDown}
        </>
      }
    >
      {(close) => (
        <>
          <div className="gb-title" aria-hidden="true">
            Group alerts by
          </div>
          {[null, ...groupFieldsFor(kind)].map((field, index) => (
            <Fragment key={field ?? "none"}>
              {index === 1 && <div className="gb-sep" role="separator" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === field}
                className="menu-item gb-item"
                onClick={() => {
                  close();
                  if (field !== value) onChange(field);
                }}
              >
                <span className="gb-ck">{value === field && check}</span>
                {field ? groupFieldLabel(field) : "No grouping"}
                {saved !== undefined && saved === field && (
                  <span className="gb-tag">Saved</span>
                )}
              </button>
            </Fragment>
          ))}
          {saved !== undefined && (
            <>
              <div className="gb-sep" role="separator" />
              <p className="gb-note">
                A change here is for this view only. Edit the preset to change
                its saved grouping.
              </p>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

const groupId = (key: string | null) => (key === null ? "\u0000empty" : key);

/**
 * The grouped first view plus loaded continuations. `rows` fetches one group's
 * next page; `path`/`body` are the grouped route and its request.
 */
export function useAlertGroups({
  scope,
  field,
  path,
  body,
  rows,
  version,
}: {
  scope: Scope;
  /** The grouping being shown; results for another field are never rendered. */
  field: GroupField | null;
  path: string | null;
  body: Record<string, unknown> | null;
  rows: (
    group: AlertGroup,
    cursor: string,
  ) => Promise<{
    data: RecordData[];
    next_cursor?: string | null;
  }>;
  version: string | number;
}) {
  const key = path && body ? JSON.stringify([path, body]) : null;
  const [extra, setExtra] = useState<{
    key: string | null;
    more: Map<string, More>;
    groups: AlertGroup[];
    cursor?: string | null;
  }>({ key, more: new Map(), groups: [] });
  const [collapsed, setCollapsed] = useState<{
    key: string | null;
    ids: Set<string>;
  }>({
    key,
    ids: new Set(),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const current =
    extra.key === key
      ? extra
      : { key, more: new Map<string, More>(), groups: [] };
  const extended = current.more.size > 0 || current.groups.length > 0;
  const [frozen, setFrozen] = useState(version);
  useEffect(() => {
    if (!extended) setFrozen(version);
  }, [version, extended]);
  const first = useSearchResource(
    path,
    scope.session.csrf_token,
    scope.onDenied,
    body ?? undefined,
    frozen,
  );
  // While another query loads, the previous result stays only if it has the same
  // grouping field; groups of a different field would carry the wrong labels.
  const shown = field !== null && first.data?.meta?.group_by === field;
  const meta = shown ? first.data?.meta : undefined;
  const base = (shown ? first.data!.data : []) as unknown as AlertGroup[];
  const groupCursor =
    current.cursor !== undefined
      ? current.cursor
      : shown
        ? (first.data as { next_group_cursor?: string | null })
            .next_group_cursor
        : undefined;
  const groups = [...base, ...current.groups].map((group) => {
    const loaded = current.more.get(groupId(group.key));
    return {
      ...group,
      data: loaded ? [...group.data, ...loaded.rows] : group.data,
      next_cursor: loaded ? loaded.cursor : group.next_cursor,
      expanded: Boolean(loaded),
    };
  });
  const shut = collapsed.key === key ? collapsed.ids : new Set<string>();
  function failed(reason: unknown) {
    if (reason instanceof ApiError && [401, 403, 404].includes(reason.status))
      scope.onDenied();
    setError(reason);
  }
  return {
    groups,
    meta,
    first,
    /** The current query's own result has arrived (it may be refreshing). */
    settled:
      shown &&
      first.dataKey ===
        (path
          ? JSON.stringify([path, body ? JSON.stringify(body) : undefined])
          : null),
    extended,
    stale: extended && frozen !== version,
    busy,
    error,
    groupCursor,
    isCollapsed: (group: AlertGroup) => shut.has(groupId(group.key)),
    toggle(group: AlertGroup) {
      const ids = new Set(shut);
      if (!ids.delete(groupId(group.key))) ids.add(groupId(group.key));
      setCollapsed({ key, ids });
    },
    collapseAll(collapse: boolean) {
      setCollapsed({
        key,
        ids: collapse
          ? new Set(groups.map((group) => groupId(group.key)))
          : new Set(),
      });
    },
    /** Back to the first rows of the first groups; a held refresh then runs. */
    reset() {
      setExtra({ key, more: new Map(), groups: [] });
      setError(undefined);
    },
    fewer(group: AlertGroup) {
      const more = new Map(current.more);
      more.delete(groupId(group.key));
      setExtra({ ...current, more });
    },
    async more(group: AlertGroup & { next_cursor?: string | null }) {
      if (!group.next_cursor || busy) return;
      setBusy(groupId(group.key));
      setError(undefined);
      try {
        const page = await rows(group, group.next_cursor);
        const id = groupId(group.key);
        const previous = current.more.get(id);
        const more = new Map(current.more);
        more.set(id, {
          rows: [...(previous?.rows ?? []), ...page.data],
          cursor: page.next_cursor ?? null,
        });
        setExtra({ ...current, more });
      } catch (reason) {
        failed(reason);
      } finally {
        setBusy(null);
      }
    },
    async moreGroups() {
      if (!path || !body || !groupCursor || busy) return;
      setBusy("groups");
      setError(undefined);
      try {
        const page = await request<AlertGroup[]>(path, {
          method: "POST",
          csrf: scope.session.csrf_token,
          body: { ...body, group_cursor: groupCursor },
          signal: AbortSignal.timeout(15000),
        });
        setExtra({
          ...current,
          groups: [...current.groups, ...(page.data ?? [])],
          cursor:
            (page as { next_group_cursor?: string | null }).next_group_cursor ??
            null,
        });
      } catch (reason) {
        failed(reason);
      } finally {
        setBusy(null);
      }
    },
  };
}

export type AlertGroupsState = ReturnType<typeof useAlertGroups>;

const kind = (field: GroupField) => (field === "severity" ? "sev" : "st");

function GroupValue({
  scope,
  field,
  group,
}: {
  scope: Scope;
  field: GroupField;
  group: AlertGroup;
}) {
  const key = group.key;
  if (key === null)
    return (
      <span className="ag-value ag-empty">
        {field === "assignee_id"
          ? "Unassigned"
          : field === "active_incident_id"
            ? "No incident"
            : "No value"}
      </span>
    );
  if (field === "severity" || field === "display_status")
    return (
      <span className={`ag-value ${kind(field)} ${kind(field)}-${key}`}>
        {key[0].toUpperCase() + key.slice(1)}
      </span>
    );
  if (field === "assignee_id")
    return (
      <span className="ag-value">{personLabel(scope, key, group.label)}</span>
    );
  if (field === "active_incident_id")
    return (
      <span className="ag-value">
        {display(group.label ?? "Linked incident")}
      </span>
    );
  return <span className="ag-value">{key}</span>;
}

function groupText(scope: Scope, field: GroupField, group: AlertGroup) {
  if (group.key === null)
    return field === "assignee_id"
      ? "Unassigned"
      : field === "active_incident_id"
        ? "No incident"
        : "No value";
  if (field === "severity" || field === "display_status")
    return group.key[0].toUpperCase() + group.key.slice(1);
  if (field === "assignee_id")
    return personLabel(scope, group.key, group.label);
  if (field === "active_incident_id")
    return display(group.label ?? "Linked incident");
  return group.key;
}

const plural = (count: string, word: string) =>
  `${BigInt(count).toLocaleString()} ${word}${count === "1" ? "" : "s"}`;
const exact = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

function Summary({ group, field }: { group: AlertGroup; field: GroupField }) {
  const status = field === "severity" ? group.status : null;
  const parts = status
    ? STATUSES.map((name) => [name, status[name], "st"] as const)
    : SEVERITIES.map((name) => [name, group.severity?.[name], "sev"] as const);
  const shown = parts.filter(([, value]) => exact(value) && value !== "0");
  if (!shown.length) return null;
  return (
    <span className="ag-summary">
      {shown.map(([name, value, kind]) => (
        <span key={name} className={`${kind} ${kind}-${name}`}>
          {BigInt(value!).toLocaleString()}{" "}
          {name[0].toUpperCase() + name.slice(1)}
        </span>
      ))}
    </span>
  );
}

/** One panel per group, each its own alert table, then the group-list footer. */
export function AlertGroups({
  scope,
  field,
  state,
  columns,
  sort,
  onSort,
  selection,
  onSelectionChange,
  onRowCommand,
  onLinkIncident,
  command,
  busy,
  evaluated,
  onRemember,
  footnote,
}: {
  scope: Scope;
  field: GroupField;
  state: AlertGroupsState;
  columns?: string[];
  sort?: SortItem[];
  onSort?: (field: string) => void;
  selection?: Map<string, string>;
  onSelectionChange?: (next: Map<string, string>) => void;
  onRowCommand?: RowCommand;
  command?: { error?: unknown; uncertain: boolean; busy: boolean };
  onLinkIncident?: (row: RecordData) => void;
  busy?: boolean;
  evaluated?: boolean;
  onRemember: (ids: string[], current: string) => void;
  footnote?: ReactNode;
}) {
  const { groups, meta } = state;
  const total = meta?.total;
  const groupCount = meta?.group_count;
  return (
    <div
      className={`alert-groups grow ${state.first.loading ? "is-stale" : ""}`}
      role="region"
      aria-label={`Alerts grouped by ${groupFieldLabel(field)}`}
      aria-busy={state.first.loading}
      onClickCapture={(event) => {
        const link = (event.target as Element).closest?.("a[href]");
        const match = link?.getAttribute("href")?.match(/\/alerts\/([^/?#]+)$/);
        if (match)
          onRemember(
            groups.flatMap((group) => group.data.map((row) => row.id)),
            decodeURIComponent(match[1]),
          );
      }}
    >
      {groups.map((group) => {
        const text = groupText(scope, field, group);
        const collapsed = state.isCollapsed(group);
        const count = exact(group.total) ? group.total : null;
        const remaining =
          count !== null
            ? Number(BigInt(count) - BigInt(group.data.length))
            : 0;
        return (
          <section
            key={groupId(group.key)}
            className={`panel alert-group ${collapsed ? "is-collapsed" : ""}`}
            aria-label={
              count !== null ? `${text}, ${plural(count, "alert")}` : text
            }
          >
            <div className="ag-head">
              <button
                type="button"
                className="ag-toggle"
                aria-expanded={!collapsed}
                onClick={() => state.toggle(group)}
              >
                <svg
                  className="ag-chev"
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
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <GroupValue scope={scope} field={field} group={group} />
                <span className="ag-count">
                  {count !== null
                    ? plural(count, "alert")
                    : "Count unavailable"}
                </span>
              </button>
              <Summary group={group} field={field} />
            </div>
            {!collapsed && (
              <>
                <AlertTable
                  scope={scope}
                  rows={group.data}
                  columns={columns}
                  sort={sort}
                  onSort={onSort}
                  hide={field}
                  label={`Alerts: ${text}`}
                  selectAllLabel={`Select all shown in ${text}`}
                  selection={selection}
                  onSelectionChange={onSelectionChange}
                  onRowCommand={onRowCommand}
                  onLinkIncident={onLinkIncident}
                  command={command}
                  busy={busy}
                />
                {(group.next_cursor || group.expanded) && (
                  <div className="ag-foot">
                    <span>
                      Showing {group.data.length.toLocaleString()}
                      {count !== null &&
                        ` of ${BigInt(count).toLocaleString()}`}
                    </span>
                    {group.next_cursor ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-g"
                        disabled={state.busy !== null}
                        onClick={() => void state.more(group)}
                      >
                        {state.busy === groupId(group.key)
                          ? "Loading…"
                          : `Show ${Math.min(GROUP_ROWS, remaining || GROUP_ROWS)} more`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-g"
                        onClick={() => state.fewer(group)}
                      >
                        Show fewer
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
      <div className="ag-total">
        <b>
          {exact(total) ? plural(total, "matching alert") : "Count unavailable"}
        </b>
        {exact(groupCount) && (
          <span>
            in {plural(groupCount, "group")}
            {groups.length < Number(groupCount) &&
              ` · showing ${groups.length.toLocaleString()}`}
          </span>
        )}
        {evaluated && typeof meta?.evaluated_at === "string" && (
          <span>
            · evaluated <RelativeTime value={meta.evaluated_at} />
          </span>
        )}
        {state.first.loading && state.first.data && (
          <span role="status">· updating…</span>
        )}
        {meta?.updating === true && <span>· index catching up</span>}
        {footnote}
        {state.groupCursor && (
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={state.busy !== null}
            onClick={() => void state.moreGroups()}
          >
            {state.busy === "groups"
              ? "Loading…"
              : `Show ${Math.min(
                  GROUP_PAGE,
                  Number(groupCount ?? 0) - groups.length || GROUP_PAGE,
                ).toLocaleString()} more groups`}
          </button>
        )}
      </div>
    </div>
  );
}
