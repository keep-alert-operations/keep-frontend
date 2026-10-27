"use client";
import { useEffect, useRef, useState } from "react";
import type { components } from "@/lib/generated";
import { alertOperatorLabel } from "@/lib/alert-operator";
import { count, display, RecordData, request, tenantPath } from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import { useSearchResource } from "@/lib/search-resource";
import {
  DEFAULT_SORT,
  nextQuickSort,
  type SortItem,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { DirectoryPicker } from "./directory-picker";
import { CelEditor } from "./cel-editor";
import { AlertNoteHistory, SourceEvent } from "./alert-evidence";
import { CommandFeedback, ErrorNotice } from "./ui";
import {
  AlertStatus,
  NavLink,
  Page,
  RelativeTime,
  SearchInput,
  Severity,
  personLabel,
  useConfirm,
  type Crumb,
} from "./page";
import {
  AlertTable,
  BulkBar,
  QuickViews,
  composeCel,
  useQuickViewCounts,
  type QuickViewKey,
} from "./alert-table";
import {
  AlertGroups,
  GROUP_PAGE,
  GROUP_ROWS,
  GroupByControl,
  groupFieldLabel,
  tooManyGroups,
  useAlertGroups,
  type AlertGroup,
  type GroupField,
} from "./alert-groups";

export function Alerts(props: Scope & { id?: string }) {
  return props.id ? (
    <AlertDetail key={props.id} {...props} id={props.id} />
  ) : (
    <AlertFeed {...props} />
  );
}

/* ------------------------------------------------------------------------ */
/* List navigation context (crumb + previous/next on the alert detail page). */

interface AlertListContext {
  label: string;
  href: string;
  ids: string[];
  current: string;
}
const listKey = (tenantId: string) => `appchi.alert-list:${tenantId}`;

/**
 * Remembers the list an alert was opened from so the detail page can show it
 * in the breadcrumb and step through its rows. Lists call this when a row
 * link is followed; the context is only used for the alert that was opened.
 */
export function rememberAlertList(tenantId: string, context: AlertListContext) {
  try {
    sessionStorage.setItem(listKey(tenantId), JSON.stringify(context));
  } catch {
    // Storage may be unavailable; the detail page then shows plain crumbs.
  }
}
function readAlertList(tenantId: string, id: string) {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(listKey(tenantId)) ?? "null",
    ) as AlertListContext | null;
    if (
      value &&
      typeof value.label === "string" &&
      typeof value.href === "string" &&
      value.href.startsWith(`/tenants/${tenantId}/`) &&
      Array.isArray(value.ids) &&
      value.current === id &&
      value.ids.includes(id)
    )
      return value;
  } catch {
    // Ignore unreadable context.
  }
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* S02 · Feed (ad-hoc alert queries)                                         */

export function AlertFeed(scope: Scope) {
  const [quickView, setQuickView] = useState<QuickViewKey>("all");
  const [cel, setCel] = useState("true"),
    [q, setQ] = useState(""),
    [suppressed, setSuppressed] = useState(false);
  const [applied, setApplied] = useState({
      cel: "true",
      q: "",
      include_suppressed: false,
    }),
    [cursor, setCursor] = useState<string | null>(null),
    [pageIndex, setPageIndex] = useState(0),
    [limit, setLimit] = useState(50);
  const [selection, setSelection] = useState<Map<string, string>>(new Map());
  const [quickSort, setQuickSort] = useState<SortItem | null>(null);
  // Transient like the rest of the ad-hoc feed; Save as preset carries it (REV-44).
  const [groupBy, setGroupBy] = useState<GroupField | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState(scope.version);
  useEffect(() => {
    if (!cursor) setSnapshotVersion(scope.version);
  }, [scope.version, cursor]);
  const base = tenantPath(scope.tenant.id);
  const query = new URLSearchParams({
    cel: composeCel(applied.cel, quickView, scope.session.principal.id),
    q: applied.q,
    include_suppressed: String(applied.include_suppressed),
  });
  if (quickSort) {
    query.set("sort", quickSort.field);
    query.set("direction", quickSort.direction);
  }
  const params = new URLSearchParams(query);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const grouped = useAlertGroups({
    scope,
    field: groupBy,
    path: groupBy ? `${base}/alerts/groups` : null,
    body: groupBy
      ? {
          ...Object.fromEntries(query),
          include_suppressed: applied.include_suppressed,
          group_by: groupBy,
          group_limit: GROUP_PAGE,
          rows_per_group: GROUP_ROWS,
        }
      : null,
    version: scope.version,
    rows: (group: AlertGroup, next: string) => {
      const page = new URLSearchParams(query);
      page.set("group_by", groupBy!);
      if (group.key === null) page.set("group_empty", "true");
      else page.set("group_key", group.key);
      page.set("limit", String(GROUP_ROWS));
      page.set("cursor", next);
      return request<RecordData[]>(`${base}/alerts?${page}`, {
        csrf: scope.session.csrf_token,
        signal: AbortSignal.timeout(15000),
      });
    },
  });
  const tooMany = groupBy !== null && tooManyGroups(grouped.first.error);
  const showGroups = groupBy !== null && !tooMany;
  const feed = useSearchResource(
    showGroups ? null : `${base}/alerts?${params}`,
    scope.session.csrf_token,
    scope.onDenied,
    undefined,
    snapshotVersion,
  );
  const counts = useQuickViewCounts(
    scope,
    applied.cel,
    applied.include_suppressed,
    applied.q,
    JSON.stringify([
      (showGroups ? grouped.meta : feed.data?.meta)?.evaluated_at,
    ]),
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const rows = feed.data?.data ?? [];
  const locked = command.busy || command.uncertain;
  const expandedGroups = grouped.groups.some(
    (group) => !grouped.isCollapsed(group),
  );

  function reset() {
    setCursor(null);
    setPageIndex(0);
    setSelection(new Map());
  }
  function refresh() {
    if (showGroups) grouped.first.reload();
    else feed.reload();
  }
  function run() {
    if (locked) return;
    setApplied({ cel, q, include_suppressed: suppressed });
    reset();
    refresh();
  }
  async function rowCommand(
    row: RecordData,
    kind: "set_status" | "set_assignee",
    value: string | null,
  ) {
    if (
      await command.execute(`${base}/alerts/${row.id}/commands`, {
        expected_revision: row.revision,
        kind,
        value,
      })
    )
      refresh();
  }
  const first = pageIndex * limit + 1;
  const total = feed.data?.meta?.total;
  const stale = Boolean(cursor) && scope.version !== snapshotVersion;
  return (
    <Page
      scope={scope}
      title="Feed"
      className="alerts-page"
      crumbs={[{ label: "Feed" }]}
      extra={
        <span className="page-subtitle">
          Ad-hoc feed · nothing here is saved until you save it as a preset
        </span>
      }
      actions={
        scope.tenant.role !== "view" && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              scope.navigate(
                `/tenants/${scope.tenant.id}/presets/new?${new URLSearchParams({
                  cel,
                  ...(groupBy ? { group_by: groupBy } : {}),
                })}`,
              )
            }
          >
            Save as preset…
          </button>
        )
      }
    >
      <form
        className="alerts-filter"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <CelEditor
          scope={scope}
          value={cel}
          onChange={setCel}
          rows={1}
          onRun={run}
          compact
        />
        <SearchInput
          id="alert-search"
          label="Search text"
          value={q}
          maxLength={256}
          onChange={setQ}
        />
      </form>
      <QuickViews
        value={quickView}
        onChange={(view) => {
          setQuickView(view);
          reset();
        }}
        counts={counts.counts}
        hidden={counts.hidden}
        includeSuppressed={suppressed}
        disabled={locked}
        actions={
          <>
            {showGroups && grouped.groups.length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-g"
                onClick={() => grouped.collapseAll(expandedGroups)}
              >
                {expandedGroups ? "Collapse all" : "Expand all"}
              </button>
            )}
            <GroupByControl
              value={groupBy}
              onChange={(value) => {
                setGroupBy(value);
                reset();
              }}
            />
          </>
        }
        onIncludeSuppressed={(checked) => {
          setSuppressed(checked);
          setApplied((previous) => ({
            ...previous,
            include_suppressed: checked,
          }));
          reset();
        }}
      />
      {stale && (
        <div className="banner bn-info" role="status">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12l7-7 7 7" />
          </svg>
          <span>
            <b>New results available.</b> Alerts changed since this page was
            opened. This page stays as it was so rows don&apos;t move while you
            work.
          </span>
          <div className="grow" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            onClick={reset}
          >
            Back to first page
          </button>
        </div>
      )}
      {grouped.stale && showGroups && (
        <div className="banner bn-info" role="status">
          <span>
            <b>New results available.</b> Alerts changed since these groups were
            loaded. They stay as they were so rows don&apos;t move while you
            work.
          </span>
          <div className="grow" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            onClick={grouped.reset}
          >
            Back to first groups
          </button>
        </div>
      )}
      {tooMany && (
        <div className="banner bn-info" role="status">
          Too many values to group by {groupFieldLabel(groupBy).toLowerCase()}:
          more than 1,000. Showing one table; narrow the query to group it.
        </div>
      )}
      <ErrorNotice
        error={showGroups ? (grouped.error ?? grouped.first.error) : feed.error}
      />
      {!showGroups && feed.data && Boolean(feed.error) && (
        <div className="banner bn-warn" role="status">
          Previous successful results are shown while the requested snapshot is
          unavailable.
        </div>
      )}
      <CommandFeedback command={command} />
      {showGroups && grouped.groups.length > 0 && (
        <AlertGroups
          scope={scope}
          field={groupBy}
          state={grouped}
          sort={quickSort ? [quickSort] : DEFAULT_SORT}
          onSort={(field) => {
            setQuickSort((current) => nextQuickSort(current, field));
            reset();
          }}
          selection={scope.tenant.role === "view" ? undefined : selection}
          onSelectionChange={
            scope.tenant.role === "view" || locked ? undefined : setSelection
          }
          onRowCommand={(row, kind, value) => void rowCommand(row, kind, value)}
          busy={locked}
          onRemember={(ids, current) =>
            rememberAlertList(scope.tenant.id, {
              label: "Feed",
              href: `/tenants/${scope.tenant.id}/alerts`,
              ids,
              current,
            })
          }
        />
      )}
      {showGroups && grouped.groups.length === 0 && (
        <section
          className="panel table-panel grow"
          aria-label="Matching alerts"
        >
          <div className="alerts-empty">
            {grouped.first.error ? null : !grouped.settled ? (
              <p role="status">Loading alerts…</p>
            ) : (
              <>
                <h2>No matching alerts</h2>
                <p>Try a different query or include suppressed alerts.</p>
              </>
            )}
          </div>
        </section>
      )}
      {!showGroups && (
        <section
          className="panel table-panel grow"
          aria-label="Matching alerts"
          aria-busy={feed.loading}
          onClickCapture={(event) => {
            const link = (event.target as Element).closest?.("a[href]");
            const match = link
              ?.getAttribute("href")
              ?.match(/\/alerts\/([^/?#]+)$/);
            if (match)
              rememberAlertList(scope.tenant.id, {
                label: "Feed",
                href: `/tenants/${scope.tenant.id}/alerts`,
                ids: rows.map((row) => row.id),
                current: decodeURIComponent(match[1]),
              });
          }}
        >
          {rows.length ? (
            <AlertTable
              scope={scope}
              rows={rows}
              selection={scope.tenant.role === "view" ? undefined : selection}
              onSelectionChange={
                scope.tenant.role === "view" || locked
                  ? undefined
                  : setSelection
              }
              onRowCommand={(row, kind, value) =>
                void rowCommand(row, kind, value)
              }
              busy={locked}
              sort={quickSort ? [quickSort] : DEFAULT_SORT}
              onSort={(field) => {
                setQuickSort((current) => nextQuickSort(current, field));
                reset();
              }}
            />
          ) : (
            <div className="alerts-empty">
              {feed.loading && !feed.data ? (
                <p role="status">Loading alerts…</p>
              ) : feed.error ? null : (
                <>
                  <h2>No matching alerts</h2>
                  <p>Try a different query or include suppressed alerts.</p>
                </>
              )}
            </div>
          )}
          <div className="table-footer-bar">
            <span>
              <b>
                {count(total) === "Unavailable"
                  ? "Count unavailable"
                  : `${count(total)} matching alerts`}
              </b>
              {rows.length > 0 && ` · rows ${first}–${first + rows.length - 1}`}{" "}
              · page {pageIndex + 1}
            </span>
            {feed.loading && feed.data && (
              <span role="status" className="muted">
                Updating…
              </span>
            )}
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!cursor || locked}
              onClick={reset}
            >
              First page
            </button>
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!feed.data?.next_cursor || feed.loading || locked}
              onClick={() => {
                setCursor(feed.data?.next_cursor ?? null);
                setPageIndex((index) => index + 1);
                setSelection(new Map());
              }}
            >
              Next page
            </button>
            <div className="alerts-rows">
              <label htmlFor="alert-rows-per-page">Rows per page</label>
              <select
                id="alert-rows-per-page"
                className="inp"
                value={limit}
                disabled={locked}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  reset();
                }}
              >
                {[50, 100, 200].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      <BulkBar
        scope={scope}
        selection={selection}
        onDone={() => {
          setSelection(new Map());
          refresh();
        }}
        onClear={() => setSelection(new Map())}
      />
    </Page>
  );
}

/* ------------------------------------------------------------------------ */
/* S03 · Alert detail                                                        */

const MEANINGFUL_FIELDS = [
  "severity",
  "status",
  "acknowledged",
  "assignee_id",
  "message",
  "impact",
  "runbook_url",
  "suppressed",
  "application",
  "component",
  "node_name",
  "site",
  "operator",
  "occurrence_number",
] as const;
const FIELD_LABELS: Record<string, string> = {
  node_name: "Node name",
  assignee_id: "Assignee",
  runbook_url: "Runbook",
  occurrence_number: "Occurrence",
};
function fieldLabel(field: string) {
  return (
    FIELD_LABELS[field] ??
    field[0].toUpperCase() + field.slice(1).replaceAll("_", " ")
  );
}
function titleCase(value: unknown) {
  const text = display(value);
  return text === "—" ? text : text[0].toUpperCase() + text.slice(1);
}
function plain(value: unknown) {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "string" ? value : JSON.stringify(value);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

interface Described {
  what: string;
  detail: string;
  dot: string;
  who: string;
  changes: { field: string; before: unknown; after: unknown }[];
}

/**
 * Human sentence for one alert activity row (reference S03 history). Kinds
 * follow the backend causes (source, set_*, note-*, incident/correlation link
 * changes, inactivity, maintenance); unknown kinds fall back to their name.
 */
function describeActivity(
  row: RecordData,
  alert: RecordData,
  scope: Scope,
): Described {
  const kind = display(row.kind ?? row.action ?? "activity")
    .toLowerCase()
    .replaceAll("_", "-");
  const evidence = isRecord(row.evidence) ? row.evidence : {};
  const before = isRecord(evidence.before) ? evidence.before : undefined;
  const after = isRecord(evidence.after) ? evidence.after : undefined;
  const changes = after
    ? MEANINGFUL_FIELDS.filter(
        (field) =>
          before !== undefined &&
          JSON.stringify(before[field] ?? null) !==
            JSON.stringify(after[field] ?? null),
      ).map((field) => ({
        field,
        before: before?.[field],
        after: after[field],
      }))
    : [];
  const change = (field: string) =>
    changes.find((item) => item.field === field);
  const description =
    typeof row.description === "string" ? row.description : "";
  const sourceActor = alertOperatorLabel(alert);
  const namedActor =
    (typeof row.actor_display_name === "string" && row.actor_display_name) ||
    (typeof row.actor_label === "string" && row.actor_label) ||
    (typeof row.actor_id === "string" && row.actor_id
      ? personLabel(scope, row.actor_id, null)
      : "");
  let who =
    namedActor && typeof row.actor_id === "string"
      ? personLabel(scope, row.actor_id, namedActor)
      : namedActor;
  const out = (what: string, detail: string, dot: string): Described => ({
    what,
    detail,
    dot,
    who,
    changes,
  });
  const incidentTitle =
    typeof row.incident_id === "string" &&
    row.incident_id === alert.active_incident_id &&
    typeof alert.active_incident_title === "string"
      ? alert.active_incident_title
      : "";

  if (kind === "source" || kind === "source-update") {
    who = who || sourceActor;
    if (!before && after) {
      const number = after.occurrence_number;
      return out(
        `Occurrence${number !== undefined ? ` #${display(number)}` : ""} opened.`,
        `${titleCase(after.status)} with severity ${titleCase(after.severity)}.`,
        "tl-src",
      );
    }
    const occurrence = change("occurrence_number");
    if (occurrence)
      return out(
        `Occurrence #${display(occurrence.after)} opened.`,
        `${titleCase(after?.status)} with severity ${titleCase(after?.severity)}.`,
        "tl-src",
      );
    const severity = change("severity");
    if (severity)
      return out(
        "Severity changed",
        `from ${titleCase(severity.before)} to ${titleCase(severity.after)} by the source.`,
        "tl-sev",
      );
    const status = change("status");
    if (status)
      return out(
        status.after === "resolved"
          ? "Resolved by the source."
          : "Firing again.",
        "",
        "tl-src",
      );
    const first = changes[0];
    return out(
      "Source update.",
      first
        ? `${fieldLabel(first.field)} changed to “${plain(first.after)}”.`
        : "Repeat event received; no field changes.",
      "tl-src",
    );
  }
  if (kind === "occurrence-opened") {
    who = who || sourceActor;
    const number = row.occurrence_number ?? after?.occurrence_number;
    return out(
      `Occurrence${number !== undefined ? ` #${display(number)}` : ""} opened.`,
      after
        ? `${titleCase(after.status)} with severity ${titleCase(after.severity)}.`
        : "",
      "tl-src",
    );
  }
  if (kind === "severity-changed") {
    who = who || sourceActor;
    const from = change("severity")?.before ?? evidence.before;
    const to = change("severity")?.after ?? evidence.after;
    return out(
      "Severity changed",
      typeof from === "string" && typeof to === "string"
        ? `from ${titleCase(from)} to ${titleCase(to)}.`
        : "",
      "tl-sev",
    );
  }
  who = who || "System";
  if (kind === "set-status") {
    const resolved = (after?.status ?? change("status")?.after) === "resolved";
    return out(resolved ? "Resolved." : "Reopened.", "", "tl-user");
  }
  if (kind === "set-acknowledged")
    return out(
      after?.acknowledged === false
        ? "Acknowledgement cleared."
        : "Acknowledged.",
      "",
      "tl-user",
    );
  if (kind === "set-assignee") {
    const assignee = after?.assignee_id;
    return typeof assignee === "string" && assignee
      ? out(
          "Assigned",
          `to ${personLabel(scope, assignee, after?.assignee_display_name ?? (assignee === alert.assignee_id ? alert.assignee_display_name : null))}.`,
          "tl-user",
        )
      : out("Unassigned.", "", "tl-user");
  }
  if (kind === "note-create" || kind === "note-added")
    return out("Note added.", "", "tl-user");
  if (kind === "note-edit" || kind === "note-edited")
    return out("Note edited.", "", "tl-user");
  if (kind === "note-delete" || kind === "note-deleted")
    return out(
      "Note deleted.",
      "Its retained history remains available.",
      "tl-user",
    );
  if (
    kind === "incident-link" ||
    kind === "incident-linked" ||
    kind === "correlation-link"
  ) {
    const byRule = kind === "correlation-link" || /correlation rule/i.test(who);
    return out(
      "Added to incident",
      `${incidentTitle || "an incident"}${byRule ? " by a correlation rule" : ""}.`,
      "tl-inc",
    );
  }
  if (kind === "incident-unlink")
    return out("Removed from incident.", "", "tl-inc");
  if (kind === "incident-move")
    return out("Moved to another incident.", "", "tl-inc");
  if (kind === "incident-status")
    return out("Linked incident status changed.", "", "tl-inc");
  if (kind === "incident-inactivity")
    return out(
      "Released from its incident",
      "after the incident was inactive.",
      "tl-inc",
    );
  if (kind === "incident-alerts-resolved")
    return out(
      "Released from its incident",
      "after all of the incident's linked alerts resolved.",
      "tl-inc",
    );
  if (kind === "source-inactivity")
    return out(
      "Resolved automatically",
      "after 30 days without source activity.",
      "tl-src",
    );
  if (kind === "eligibility-lost")
    return out(
      "Assignment cleared",
      "because the assignee lost access to this tenant.",
      "tl-user",
    );
  if (kind === "maintenance-materialization") {
    const suppression = change("suppressed");
    return out(
      suppression
        ? suppression.after
          ? "Suppressed"
          : "Suppression ended."
        : "Maintenance evaluated.",
      suppression?.after ? "by a maintenance window." : "",
      "tl-src",
    );
  }
  if (kind.startsWith("maintenance-qualifier-"))
    return out(
      `Maintenance window ${kind.slice("maintenance-qualifier-".length).replaceAll("-", " ")}.`,
      "",
      "tl-src",
    );
  const name = kind.replaceAll("-", " ");
  return out(
    `${name[0].toUpperCase()}${name.slice(1)}.`,
    description,
    "tl-src",
  );
}

function TimelineItem({
  dot,
  what,
  detail,
  meta,
  children,
}: {
  dot: string;
  what: React.ReactNode;
  detail?: React.ReactNode;
  meta: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="tl-i">
      <i className={dot} aria-hidden="true" />
      <div>
        <div className="tl-t">
          <b>{what}</b>
          {detail ? (
            <>
              {" "}
              <span>{detail}</span>
            </>
          ) : null}
        </div>
        <div className="tl-m">{meta}</div>
        {children}
      </div>
    </li>
  );
}

function ActivityItem({
  row,
  alert,
  scope,
}: {
  row: RecordData;
  alert: RecordData;
  scope: Scope;
}) {
  const item = describeActivity(row, alert, scope);
  const extra = item.changes.length > 1 ? item.changes : [];
  return (
    <TimelineItem
      dot={item.dot}
      what={item.what}
      detail={item.detail}
      meta={
        <>
          <RelativeTime value={row.recorded_at ?? row.created_at} /> ·{" "}
          {item.who}
        </>
      }
    >
      {extra.length > 0 && (
        <details className="tl-more">
          <summary>Details</summary>
          <ul>
            {extra.map((change) => (
              <li key={change.field}>
                {fieldLabel(change.field)}: {plain(change.before)} →{" "}
                {plain(change.after)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </TimelineItem>
  );
}

type Tab = "history" | "notes" | "occurrences" | "source-events";
const TABS: { key: Tab; label: string }[] = [
  { key: "history", label: "History" },
  { key: "notes", label: "Notes" },
  { key: "occurrences", label: "Occurrences" },
  { key: "source-events", label: "Source events" },
];

function pageCount(
  data: { data?: unknown[]; next_cursor?: string | null } | undefined,
) {
  if (!data || !Array.isArray(data.data)) return undefined;
  return `${data.data.length}${data.next_cursor ? "+" : ""}`;
}

function AlertDetail(scope: Scope & { id: string }) {
  const path = `${tenantPath(scope.tenant.id)}/alerts/${encodeURIComponent(scope.id)}`;
  const detail = useResource<RecordData>(path, scope.onDenied, scope.version);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmDialog, confirm] = useConfirm();
  const [viewingJson, setViewingJson] = useState(false);
  const jsonDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = jsonDialog.current;
    if (!element) return;
    if (viewingJson && !element.open) element.showModal();
    else if (!viewingJson && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [viewingJson]);
  const [tab, setTab] = useState<Tab>("history"),
    [note, setNote] = useState(""),
    [noteRevision, setNoteRevision] = useState<string>();
  const [editingNote, setEditingNote] = useState<string>(),
    [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [historyDirection, setHistoryDirection] = useState("desc");
  const [assigning, setAssigning] = useState(false);
  const assignBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!assigning) return;
    const close = (event: MouseEvent) => {
      if (!assignBox.current?.contains(event.target as Node))
        setAssigning(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [assigning]);
  const [list, setList] = useState<AlertListContext>();
  useEffect(() => {
    setList(readAlertList(scope.tenant.id, scope.id));
  }, [scope.tenant.id, scope.id]);
  const childQuery = new URLSearchParams({ direction: historyDirection });
  if (historyCursor) childQuery.set("cursor", historyCursor);
  const child = useResource<RecordData[]>(
    `${path}/${tab}?${childQuery}`,
    scope.onDenied,
    historyCursor ? 0 : scope.version,
  );
  const [notesCursor, setNotesCursor] = useState<string | null>(null);
  const notesQuery = new URLSearchParams({
    include_deleted: String(includeDeleted),
    direction: "desc",
  });
  if (notesCursor) notesQuery.set("cursor", notesCursor);
  const notes = useResource<RecordData[]>(
    `${path}/notes?${notesQuery}`,
    scope.onDenied,
    notesCursor ? 0 : scope.version,
  );
  // Tab counts: the first page of each collection (shown as "50+" beyond it).
  const occurrenceCount = useResource<RecordData[]>(
    `${path}/occurrences?limit=50`,
    scope.onDenied,
    scope.version,
  );
  const sourceCount = useResource<RecordData[]>(
    `${path}/source-events?limit=50`,
    scope.onDenied,
    scope.version,
  );
  const dirty = note.length > 0;
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
  const alert = detail.data?.data;
  const edit = scope.tenant.role !== "view";
  async function execute(
    kind: components["schemas"]["AlertCommand"]["kind"],
    value: components["schemas"]["AlertCommand"]["value"],
  ) {
    if (!alert) return;
    const result = await command.execute<RecordData>(`${path}/commands`, {
      expected_revision: alert.revision,
      kind,
      value,
    });
    if (result) {
      detail.install(result);
      child.reload();
      notes.reload();
    }
  }
  async function addNote() {
    if (!alert) return;
    if (
      await command.execute(
        `${path}/notes${editingNote ? `/${editingNote}` : ""}`,
        { expected_revision: noteRevision ?? alert.revision, text: note },
        editingNote ? "PATCH" : "POST",
      )
    ) {
      setNote("");
      setNoteRevision(undefined);
      setEditingNote(undefined);
      detail.reload();
      child.reload();
      notes.reload();
    }
  }
  async function removeNote(id: string) {
    if (!alert) return;
    const confirmed = await confirm({
      title: "Delete this note?",
      body: "The note is hidden from the alert. Its retained audit history remains available.",
      confirmLabel: "Delete note",
      danger: true,
    });
    if (!confirmed) return;
    if (
      await command.execute(`${path}/notes/${id}`, {}, "DELETE", {
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": `"${alert.revision}"`,
      })
    ) {
      detail.reload();
      child.reload();
      notes.reload();
    }
  }
  function step(offset: number) {
    if (!list) return;
    const index = list.ids.indexOf(scope.id) + offset;
    const target = list.ids[index];
    if (!target) return;
    rememberAlertList(scope.tenant.id, { ...list, current: target });
    scope.navigate(`/tenants/${scope.tenant.id}/alerts/${target}`);
  }
  const position = list ? list.ids.indexOf(scope.id) : -1;
  const fromPreset = list?.href.startsWith(
    `/tenants/${scope.tenant.id}/presets/`,
  );
  const crumbs: Crumb[] =
    list && fromPreset
      ? [
          { label: "Presets", href: `/tenants/${scope.tenant.id}/presets` },
          { label: list.label, href: list.href },
        ]
      : [{ label: "Feed", href: `/tenants/${scope.tenant.id}/alerts` }];
  const title = alert
    ? display(alert.message ?? alert.application)
    : detail.error
      ? "Alert unavailable"
      : "Alert";
  const runbook =
    alert &&
    typeof alert.runbook_url === "string" &&
    /^https?:\/\//.test(alert.runbook_url)
      ? alert.runbook_url
      : undefined;
  const noteRows = notes.data?.data ?? [];
  const counts: Partial<Record<Tab, string | undefined>> = {
    notes: pageCount(notes.data),
    occurrences: pageCount(occurrenceCount.data),
    "source-events": pageCount(sourceCount.data),
  };
  const fields: [string, React.ReactNode][] = alert
    ? [
        ["Application", display(alert.application)],
        ["Component", display(alert.component)],
        ["Node name", display(alert.node_name)],
        ["Site", display(alert.site)],
        ["Operator", alertOperatorLabel(alert)],
        ["Impact", display(alert.impact)],
        [
          "First received",
          <RelativeTime
            key="first"
            value={alert.first_received_at ?? alert.opened_at}
          />,
        ],
        ["Last received", <RelativeTime key="last" value={alert.timestamp} />],
        [
          "Occurrence",
          alert.occurrence_number !== undefined &&
          alert.occurrence_number !== null ? (
            <>
              #{display(alert.occurrence_number)}
              {typeof alert.opened_at === "string" && (
                <>
                  , opened <RelativeTime value={alert.opened_at} />
                </>
              )}
            </>
          ) : (
            "—"
          ),
        ],
        ["Schema", display(alert.schema_version)],
      ]
    : [];
  return (
    <Page
      scope={scope}
      title={title}
      crumbs={crumbs}
      className="alert-detail-page"
      actions={
        list && (
          <>
            {fromPreset && (
              <NavLink scope={scope} className="btn" href={list.href}>
                ← Back to preset
              </NavLink>
            )}
            <button
              type="button"
              className="btn"
              aria-label="Previous alert in list"
              disabled={position <= 0}
              onClick={() => step(-1)}
            >
              ↑ Previous
            </button>
            <button
              type="button"
              className="btn"
              aria-label="Next alert in list"
              disabled={position < 0 || position >= list.ids.length - 1}
              onClick={() => step(1)}
            >
              Next ↓
            </button>
          </>
        )
      }
    >
      {confirmDialog}
      <ErrorNotice error={detail.error} />
      {detail.loading && !alert && <p role="status">Loading alert…</p>}
      {alert && (
        <div className="ad-grid grow">
          <div className="ad-main">
            <section className="panel ad-summary" aria-label="Alert summary">
              <div className="ad-marks">
                <Severity value={alert.severity} />
                <AlertStatus
                  value={alert.status}
                  assigneeId={alert.assignee_id}
                />
                <span className="chip b-neutral">
                  {personLabel(
                    scope,
                    alert.assignee_id,
                    alert.assignee_display_name,
                  )}
                </span>
                {alert.suppressed === true && (
                  <span className="chip chip-supp">Suppressed</span>
                )}
              </div>
              {(edit || runbook || alert) && (
                <div className="ad-actions">
                  {alert && (
                    <button
                      type="button"
                      className="btn"
                      aria-haspopup="dialog"
                      onClick={() => setViewingJson(true)}
                    >
                      View alert
                    </button>
                  )}
                  {edit && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={command.busy}
                        onClick={() =>
                          void execute(
                            "set_status",
                            alert.status === "resolved" ? "firing" : "resolved",
                          )
                        }
                      >
                        {alert.status === "resolved"
                          ? "Reopen alert"
                          : "Resolve alert"}
                      </button>
                      <div className="ad-assign" ref={assignBox}>
                        <button
                          type="button"
                          className="btn"
                          aria-expanded={assigning}
                          aria-controls="alert-assignment-options"
                          disabled={command.busy}
                          onClick={() => setAssigning((shown) => !shown)}
                        >
                          Assign…
                        </button>
                        {assigning && (
                          <div
                            id="alert-assignment-options"
                            className="panel ad-pop"
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setAssigning(false);
                            }}
                          >
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={
                                command.busy ||
                                command.uncertain ||
                                alert.assignee_id === scope.session.principal.id
                              }
                              onClick={() => {
                                setAssigning(false);
                                void execute(
                                  "set_assignee",
                                  scope.session.principal.id,
                                );
                              }}
                            >
                              Assign to me
                            </button>
                            {Boolean(alert.assignee_id) && (
                              <button
                                type="button"
                                className="btn btn-sm btn-g"
                                disabled={command.busy || command.uncertain}
                                onClick={() => {
                                  setAssigning(false);
                                  void execute("set_assignee", null);
                                }}
                              >
                                Unassign
                              </button>
                            )}
                            <DirectoryPicker
                              key={scope.tenant.id}
                              label="Assign alert to a user"
                              endpoint={`${tenantPath(scope.tenant.id)}/assignees`}
                              disabled={command.busy || command.uncertain}
                              onDenied={scope.onDenied}
                              onChoose={(principal) => {
                                setAssigning(false);
                                void execute("set_assignee", principal.id);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  <div className="grow" />
                  {runbook && (
                    <a
                      className="btn"
                      href={runbook}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open runbook ↗
                    </a>
                  )}
                </div>
              )}
              <CommandFeedback command={command} />
            </section>
            <section className="panel ad-records">
              <div className="ad-tabs">
                <div
                  className="tabbar"
                  role="tablist"
                  aria-label="Alert records"
                >
                  {TABS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      id={`alert-tab-${key}`}
                      aria-selected={tab === key}
                      aria-controls="alert-tabpanel"
                      className={`tab ${tab === key ? "tab-on" : ""}`}
                      onClick={() => {
                        setTab(key);
                        setHistoryCursor(null);
                      }}
                    >
                      {label}
                      {counts[key] !== undefined && <b>{counts[key]}</b>}
                    </button>
                  ))}
                </div>
                <div className="ad-order">
                  <label htmlFor="alert-history-order">Order</label>
                  <select
                    id="alert-history-order"
                    className="inp"
                    value={historyDirection}
                    onChange={(event) => {
                      setHistoryDirection(event.target.value);
                      setHistoryCursor(null);
                    }}
                  >
                    <option value="desc">Newest first</option>
                    <option value="asc">Oldest first</option>
                  </select>
                </div>
              </div>
              <div
                className="ad-tabpanel"
                role="tabpanel"
                id="alert-tabpanel"
                aria-labelledby={`alert-tab-${tab}`}
              >
                <ErrorNotice error={child.error} />
                {child.loading && !child.data && (
                  <p role="status" className="muted small">
                    Loading {tab.replace("-", " ")}…
                  </p>
                )}
                {child.data &&
                  (child.data.data.length === 0 ? (
                    <p className="muted small">
                      {tab === "history"
                        ? "No history entries."
                        : tab === "notes"
                          ? "No notes yet."
                          : tab === "occurrences"
                            ? "No occurrences."
                            : "No source events."}
                    </p>
                  ) : tab === "source-events" ? (
                    <ul className="tl ad-tl">
                      {child.data.data.map((item) => (
                        <SourceEvent
                          key={item.id}
                          path={path}
                          event={item}
                          scope={scope}
                        />
                      ))}
                    </ul>
                  ) : (
                    <ul className="tl ad-tl" aria-label="Activity history">
                      {child.data.data.map((item, index) =>
                        tab === "history" ? (
                          <ActivityItem
                            key={item.id ?? index}
                            row={item}
                            alert={alert}
                            scope={scope}
                          />
                        ) : tab === "notes" ? (
                          <TimelineItem
                            key={item.id ?? index}
                            dot="tl-user"
                            what={item.deleted ? "Note deleted." : "Note."}
                            detail={
                              item.deleted
                                ? "Current text hidden."
                                : `“${display(item.text)}”`
                            }
                            meta={
                              <>
                                <RelativeTime value={item.created_at} /> ·{" "}
                                {personLabel(
                                  scope,
                                  item.actor_id,
                                  item.actor_display_name,
                                  "—",
                                )}
                              </>
                            }
                          />
                        ) : (
                          <TimelineItem
                            key={item.id ?? index}
                            dot="tl-src"
                            what={`Occurrence #${display(item.occurrence_number ?? item.number)} opened.`}
                            detail={
                              typeof item.resolved_at === "string" ? (
                                <>
                                  Resolved{" "}
                                  <RelativeTime value={item.resolved_at} />.
                                </>
                              ) : (
                                "Still open."
                              )
                            }
                            meta={
                              <>
                                <RelativeTime
                                  value={item.opened_at ?? item.recorded_at}
                                />
                                {typeof item.actor_display_name === "string" &&
                                  ` · ${item.actor_display_name}`}
                              </>
                            }
                          />
                        ),
                      )}
                    </ul>
                  ))}
                {(historyCursor || child.data?.next_cursor) && (
                  <div className="ad-pager">
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!historyCursor}
                      onClick={() => setHistoryCursor(null)}
                    >
                      {historyDirection === "desc"
                        ? "Newest page"
                        : "First page"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!child.data?.next_cursor}
                      onClick={() =>
                        setHistoryCursor(child.data?.next_cursor ?? null)
                      }
                    >
                      {historyDirection === "desc"
                        ? "Older entries"
                        : "Newer entries"}
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>
          <aside className="ad-side">
            {typeof alert.active_incident_id === "string" && (
              <section
                className="panel ad-incident"
                aria-label="Linked incident"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--incident-ink)"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M12 3 2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <div>
                  <NavLink
                    scope={scope}
                    href={`/tenants/${scope.tenant.id}/incidents/${alert.active_incident_id}`}
                  >
                    {display(alert.active_incident_title ?? "Linked incident")}
                  </NavLink>
                  <span className="small muted">
                    {[
                      "Incident",
                      typeof alert.active_incident_status === "string"
                        ? titleCase(alert.active_incident_status)
                        : null,
                      typeof alert.active_incident_severity === "string"
                        ? titleCase(alert.active_incident_severity)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              </section>
            )}
            <section className="panel" aria-labelledby="alert-details-h">
              <div className="panel-h">
                <h2 id="alert-details-h">Details</h2>
              </div>
              <dl className="ad-fields">
                {fields.map(([label, value]) => (
                  <div className="fld" key={label}>
                    <dt>{label}</dt>
                    <dd title={typeof value === "string" ? value : undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="panel ad-notes" aria-labelledby="alert-notes-h">
              <div className="panel-h">
                <h2 id="alert-notes-h">Notes</h2>
                {counts.notes !== undefined && (
                  <span className="small muted">{counts.notes}</span>
                )}
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-g btn-sm"
                  aria-pressed={includeDeleted}
                  onClick={() => {
                    setIncludeDeleted(!includeDeleted);
                    setNotesCursor(null);
                  }}
                >
                  {includeDeleted ? "Hide deleted" : "Show deleted"}
                </button>
              </div>
              <div className="ad-note-list">
                <ErrorNotice error={notes.error} />
                {notes.loading && !notes.data && (
                  <p role="status" className="muted small">
                    Loading notes…
                  </p>
                )}
                {notes.data &&
                  (noteRows.length ? (
                    noteRows.map((item) => (
                      <article
                        className="ad-note"
                        key={item.id}
                        aria-label="Note"
                      >
                        <span className="small muted">
                          <b>
                            {personLabel(
                              scope,
                              item.actor_id,
                              item.actor_display_name,
                              "—",
                            )}
                          </b>{" "}
                          · <RelativeTime value={item.created_at} />
                        </span>
                        <span
                          className={`ad-note-text ${item.deleted ? "muted" : ""}`}
                        >
                          {item.deleted
                            ? "Deleted note · current text hidden"
                            : display(item.text)}
                        </span>
                        <div className="ad-note-acts">
                          {edit && !item.deleted && (
                            <>
                              <button
                                type="button"
                                className="cel-link"
                                disabled={command.busy || dirty}
                                onClick={() => {
                                  setEditingNote(item.id);
                                  setNote(String(item.text ?? ""));
                                  setNoteRevision(alert.revision);
                                }}
                              >
                                Edit note
                              </button>
                              <button
                                type="button"
                                className="cel-link ad-danger"
                                disabled={command.busy}
                                onClick={() => void removeNote(item.id)}
                              >
                                Delete note
                              </button>
                            </>
                          )}
                          <AlertNoteHistory
                            path={path}
                            noteId={item.id}
                            scope={scope}
                          />
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="muted small">
                      {includeDeleted ? "No retained notes." : "No notes yet."}
                    </p>
                  ))}
                {(notesCursor || notes.data?.next_cursor) && (
                  <div className="ad-pager">
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!notesCursor}
                      onClick={() => setNotesCursor(null)}
                    >
                      First notes page
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!notes.data?.next_cursor || notes.loading}
                      onClick={() =>
                        setNotesCursor(notes.data?.next_cursor ?? null)
                      }
                    >
                      Next notes page
                    </button>
                  </div>
                )}
              </div>
              {edit && (
                <form
                  className="ad-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addNote();
                  }}
                >
                  {editingNote && (
                    <span className="help">
                      Editing a note · plain text · base alert revision{" "}
                      {noteRevision ?? alert.revision}
                    </span>
                  )}
                  <div className="ad-composer-row">
                    <label className="sr-only" htmlFor="alert-note">
                      {editingNote ? "Edit note content" : "Add a note"}
                    </label>
                    <textarea
                      id="alert-note"
                      className="inp"
                      rows={2}
                      placeholder="Add a note"
                      value={note}
                      onChange={(event) => {
                        if (!note) setNoteRevision(alert.revision);
                        setNote(event.target.value);
                      }}
                      required
                      maxLength={10000}
                    />
                    <div className="ad-composer-btns">
                      {editingNote && (
                        <button
                          type="button"
                          className="btn btn-sm btn-g"
                          onClick={() => {
                            setEditingNote(undefined);
                            setNote("");
                            setNoteRevision(undefined);
                          }}
                        >
                          Discard note edit
                        </button>
                      )}
                      <button
                        type="submit"
                        className="btn btn-sm"
                        disabled={command.busy || !note.trim()}
                      >
                        {command.uncertain
                          ? "Retry original command"
                          : editingNote
                            ? "Save note"
                            : "Add note"}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </section>
          </aside>
        </div>
      )}
      {alert && (
        <dialog
          ref={jsonDialog}
          className="ad-json-dialog"
          aria-labelledby="alert-json-title"
          onClose={() => setViewingJson(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget)
              jsonDialog.current?.close();
          }}
        >
          <div className="ad-json-content">
            <div className="ad-json-header">
              <h2 id="alert-json-title">Alert JSON</h2>
              <button
                type="button"
                className="btn btn-sm"
                autoFocus
                onClick={() => jsonDialog.current?.close()}
              >
                Close
              </button>
            </div>
            <pre role="region" aria-label="Current alert JSON" tabIndex={0}>
              {JSON.stringify(alert, null, 2)}
            </pre>
          </div>
        </dialog>
      )}
    </Page>
  );
}
