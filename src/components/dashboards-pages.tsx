"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { ApiError, display, RecordData, tenantPath } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { thresholdColorCss } from "@/lib/threshold-colors";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { NavLink, Page, personLabel, RelativeTime, SearchInput } from "./page";
import { DashboardWorkspace } from "./dashboard-workspace";
import { ConfigurationHistory } from "./configuration-history";
import {
  isCountPanel,
  isServiceNowPanel,
  useDashboard,
  type Panel,
} from "./dashboard-counts";
import { useLeave } from "./presets-pages";

/** Routes this area's list, detail, editor and history screens. */
export function DashboardPages(
  scope: Scope & { section: string; id?: string },
) {
  const pathname = usePathname();
  const sub = pathname.split("/").filter(Boolean)[4];
  const [deletionNotice, setDeletionNotice] = useState(false);
  if (!scope.id)
    return (
      <DashboardList
        key={scope.tenant.id}
        scope={scope}
        deletionNotice={deletionNotice}
      />
    );
  if (scope.id === "new")
    return <NewDashboard key={`${scope.tenant.id}:new`} scope={scope} />;
  if (sub === "history")
    return (
      <ConfigurationHistory
        key={`${scope.tenant.id}:dashboards:${scope.id}`}
        scope={scope}
        section="dashboards"
        id={scope.id}
      />
    );
  return (
    <DashboardDetail
      key={`${scope.tenant.id}:${scope.id}`}
      scope={scope}
      id={scope.id}
      onDeletedClean={() => {
        setDeletionNotice(true);
        scope.navigate(`/tenants/${scope.tenant.id}/dashboards`);
      }}
    />
  );
}

function NewDashboard({ scope }: { scope: Scope }) {
  const leave = useLeave(scope);
  const list = `/tenants/${scope.tenant.id}/dashboards`;
  return (
    <DashboardWorkspace
      scope={scope}
      onSaved={(row) => leave(row?.id ? `${list}/${row.id}` : list)}
      onDiscard={() => leave(list)}
    />
  );
}

function useDebounced(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/* ------------------------------------------------------------------ */
/* S14 · dashboard cards                                               */
/* ------------------------------------------------------------------ */

const ORDERS = [
  ["name:asc", "Name A–Z"],
  ["name:desc", "Name Z–A"],
  ["updated_at:desc", "Recently updated"],
  ["updated_at:asc", "Least recently updated"],
] as const;

function miniTones(row: RecordData) {
  const panels = Array.isArray(row.panels) ? (row.panels as Panel[]) : null;
  const countValue =
    typeof row.panel_count === "string" && /^\d+$/.test(row.panel_count)
      ? Number(row.panel_count)
      : panels?.length;
  const tones = panels
    ? panels.slice(0, 6).map((panel) => {
        const thresholds =
          isCountPanel(panel) || isServiceNowPanel(panel)
            ? (panel.thresholds ?? [])
            : [];
        return thresholds.length
          ? thresholds[thresholds.length - 1].color
          : "none";
      })
    : Array.from({ length: Math.min(6, countValue ?? 0) }, () => "none");
  while (tones.length < 6) tones.push("empty");
  return { tones, count: countValue };
}

function DashboardList({
  scope,
  deletionNotice,
}: {
  scope: Scope;
  deletionNotice?: boolean;
}) {
  const [state, setState] = useState<"active" | "deleted">("active");
  const [search, setSearch] = useState("");
  const filter = useDebounced(search.trim());
  const [order, setOrder] = useState<string>("name:asc");
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, direction] = order.split(":");
  const params = new URLSearchParams({ limit: "50", state, sort, direction });
  if (filter) params.set("name", filter);
  if (cursor) params.set("cursor", cursor);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/dashboards?${params}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  useEffect(() => setCursor(null), [filter, state, order]);
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  const canEdit = scope.tenant.role !== "view";
  const base = `/tenants/${scope.tenant.id}/dashboards`;
  return (
    <Page
      scope={scope}
      className="dashboard-list"
      title="Dashboards"
      crumbs={[{ label: "Dashboards" }]}
      extra={
        <span className="page-subtitle">
          Shared count boards built from presets
        </span>
      }
      actions={
        canEdit && (
          <NavLink scope={scope} className="btn btn-p" href={`${base}/new`}>
            New dashboard
          </NavLink>
        )
      }
    >
      {deletionNotice && (
        <p className="banner bn-warn" role="status">
          The open dashboard was deleted. Its retained history is available
          under Deleted.
        </p>
      )}
      <div className="list-bar">
        <div className="seg" role="group" aria-label="Show">
          {(
            [
              ["active", "Active"],
              ["deleted", "Deleted"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state === value}
              className={state === value ? "on" : undefined}
              onClick={() => setState(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ flexGrow: 1 }} />
        <label className="sr-only" htmlFor="dashboard-order">
          Sort dashboards by
        </label>
        <select
          id="dashboard-order"
          className="inp db-order"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
        >
          {ORDERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <SearchInput
          id="dashboard-search"
          label="Search dashboards by name"
          value={search}
          maxLength={128}
          width={280}
          onChange={setSearch}
        />
      </div>
      <ErrorNotice error={result.error} />
      {result.loading && !result.data && (
        <p className="sr-only" role="status">
          Loading dashboards…
        </p>
      )}
      {rows.length ? (
        <div className="db-cards">
          {rows.map((row) => {
            const isDeleted = state === "deleted" || Boolean(row.deleted_at);
            const { tones, count: panelCount } = miniTones(row);
            const editor = personLabel(
              scope,
              isDeleted ? (row.deleted_by ?? row.updated_by) : row.updated_by,
              isDeleted
                ? (row.deleted_by_display_name ?? row.updated_by_display_name)
                : row.updated_by_display_name,
              "",
            );
            return (
              <NavLink
                key={row.id}
                scope={scope}
                className="panel db-card"
                href={`${base}/${row.id}${isDeleted ? "/history" : ""}`}
              >
                <span className="db-card-h">
                  <span className="db-card-name">{display(row.name)}</span>
                  <span style={{ flexGrow: 1 }} />
                  {panelCount !== undefined && (
                    <span className="small muted">
                      {panelCount} panel{panelCount === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
                <span className="db-minis" aria-hidden="true">
                  {tones.map((tone, index) =>
                    tone === "none" || tone === "empty" ? (
                      <span key={index} className={`mn-${tone}`} />
                    ) : (
                      <span
                        key={index}
                        className="mn-toned"
                        style={
                          {
                            "--pn-tone": thresholdColorCss(tone),
                          } as CSSProperties
                        }
                      />
                    ),
                  )}
                </span>
                <span className="small muted">
                  {isDeleted ? "Deleted" : "Updated"}
                  {editor ? ` by ${editor}` : ""} ·{" "}
                  <RelativeTime
                    value={
                      isDeleted
                        ? (row.deleted_at ?? row.recorded_at)
                        : row.updated_at
                    }
                  />
                </span>
              </NavLink>
            );
          })}
        </div>
      ) : (
        result.data && (
          <div className="panel db-empty">
            <h2>
              {filter
                ? `No dashboards match “${filter}”`
                : state === "deleted"
                  ? "No deleted dashboards"
                  : "No dashboards yet"}
            </h2>
            <p>
              {state === "deleted"
                ? "Deleted dashboards keep their retained history here."
                : canEdit
                  ? "Create a dashboard to count saved presets on one shared board."
                  : "Dashboards created by editors appear here."}
            </p>
          </div>
        )
      )}
      {(cursor || result.data?.next_cursor) && (
        <div className="db-pager">
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={!cursor}
            onClick={() => setCursor(null)}
          >
            First page
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!result.data?.next_cursor || result.loading}
            onClick={() => setCursor(result.data?.next_cursor ?? null)}
          >
            Next page
          </button>
        </div>
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* S15 · dashboard counts                                              */
/* ------------------------------------------------------------------ */

function DashboardDetail({
  scope,
  id,
  onDeletedClean,
}: {
  scope: Scope;
  id: string;
  onDeletedClean: () => void;
}) {
  const path = `${tenantPath(scope.tenant.id)}/dashboards/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const dashboard = result.data?.data;
  const retained = useRef<RecordData | undefined>(undefined);
  if (dashboard) retained.current = dashboard;
  const deleted =
    result.error instanceof ApiError && result.error.status === 404;
  const denied =
    result.error instanceof ApiError &&
    [401, 403].includes(result.error.status);
  if (denied) retained.current = undefined;
  const available = denied ? undefined : (dashboard ?? retained.current);
  const detailHref = `/tenants/${scope.tenant.id}/dashboards/${id}`;
  if (!available)
    return (
      <Page
        scope={scope}
        title={result.loading ? "Loading dashboard…" : "Dashboard unavailable"}
        crumbs={[
          {
            label: "Dashboards",
            href: `/tenants/${scope.tenant.id}/dashboards`,
          },
        ]}
      >
        {result.error instanceof ApiError && result.error.status === 404 ? (
          <div className="banner bn-warn">
            This dashboard no longer exists. It may have been deleted.{" "}
            <NavLink scope={scope} href={`${detailHref}/history`}>
              View retained history
            </NavLink>
          </div>
        ) : (
          <ErrorNotice error={result.error} />
        )}
      </Page>
    );
  return (
    <DashboardView
      scope={scope}
      dashboard={available}
      deleted={deleted}
      onDeletedClean={onDeletedClean}
      reload={result.reload}
      install={(row) => result.install({ data: row })}
    />
  );
}

function DashboardView({
  scope,
  dashboard,
  reload,
  install,
  deleted,
  onDeletedClean,
}: {
  scope: Scope;
  dashboard: RecordData;
  reload: () => void;
  install: (row: RecordData) => void;
  deleted: boolean;
  onDeletedClean: () => void;
}) {
  const model = useDashboard(scope, dashboard, reload);
  const leave = useLeave(scope);
  return (
    <DashboardWorkspace
      scope={scope}
      existing={dashboard}
      current={dashboard}
      deleted={deleted}
      onDeletedClean={onDeletedClean}
      model={model}
      reload={reload}
      onSaved={(row) => {
        if (row) {
          if (row.id !== dashboard.id)
            leave(`/tenants/${scope.tenant.id}/dashboards/${row.id}`);
          else {
            install(row);
            reload();
          }
        }
      }}
    />
  );
}
