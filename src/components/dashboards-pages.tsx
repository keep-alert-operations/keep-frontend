"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ApiError,
  display,
  RecordData,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice } from "./ui";
import { NavLink, Page, personLabel, SearchInput, useConfirm } from "./page";
import { DashboardEditor, Menu } from "./definition-editor";
import { ConfigurationHistory } from "./configuration-history";
import { DashboardBoard, useDashboard, type Panel } from "./dashboard-counts";
import { returnFocus, useLeave, useReturnFocus } from "./presets-pages";

/** Routes this area's list, detail, editor and history screens. */
export function DashboardPages(
  scope: Scope & { section: string; id?: string },
) {
  const pathname = usePathname();
  const sub = pathname.split("/").filter(Boolean)[4];
  if (!scope.id) return <DashboardList key={scope.tenant.id} scope={scope} />;
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
      editing={sub === "edit"}
    />
  );
}

function NewDashboard({ scope }: { scope: Scope }) {
  const leave = useLeave(scope);
  const list = `/tenants/${scope.tenant.id}/dashboards`;
  return (
    <DashboardEditor
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
        const thresholds = panel.thresholds ?? [];
        return thresholds.length
          ? thresholds[thresholds.length - 1].color
          : "none";
      })
    : Array.from({ length: Math.min(6, countValue ?? 0) }, () => "none");
  while (tones.length < 6) tones.push("empty");
  return { tones, count: countValue };
}

function DashboardList({ scope }: { scope: Scope }) {
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
                  {tones.map((tone, index) => (
                    <span key={index} className={`mn-${tone}`} />
                  ))}
                </span>
                <span className="small muted">
                  {isDeleted ? "Deleted · " : ""}Revision{" "}
                  {display(row.revision)}
                  {editor
                    ? ` · ${isDeleted ? "by" : "updated by"} ${editor}`
                    : ""}
                  {" · "}
                  <span className="mono">
                    {timestamp(
                      isDeleted
                        ? (row.deleted_at ?? row.recorded_at)
                        : row.updated_at,
                    )}
                  </span>
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
  editing,
}: {
  scope: Scope;
  id: string;
  editing: boolean;
}) {
  const path = `${tenantPath(scope.tenant.id)}/dashboards/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const dashboard = result.data?.data;
  const [base, setBase] = useState<RecordData | null>(null);
  const leave = useLeave(scope);
  const detailHref = `/tenants/${scope.tenant.id}/dashboards/${id}`;
  useEffect(() => {
    if (editing && !base && dashboard) setBase(dashboard);
    if (!editing && base) setBase(null);
  }, [editing, base, dashboard]);
  if (editing && base)
    return (
      <DashboardEditor
        key={`${id}:${base.revision}`}
        scope={scope}
        existing={base}
        current={dashboard}
        onSaved={(row) => {
          result.reload();
          returnFocus.pending = !row?.id || row.id === id;
          leave(
            row?.id && row.id !== id
              ? `/tenants/${scope.tenant.id}/dashboards/${row.id}`
              : detailHref,
          );
        }}
        onDiscard={() => {
          returnFocus.pending = true;
          leave(detailHref);
        }}
      />
    );
  if (!dashboard)
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
    <DashboardView scope={scope} dashboard={dashboard} reload={result.reload} />
  );
}

function DashboardView({
  scope,
  dashboard,
  reload,
}: {
  scope: Scope;
  dashboard: RecordData;
  reload: () => void;
}) {
  const model = useDashboard(scope, dashboard, reload);
  useReturnFocus(true);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [dialog, confirm] = useConfirm();
  const definition = model.state.definition;
  const canEdit = scope.tenant.role !== "view";
  const list = `/tenants/${scope.tenant.id}/dashboards`;
  const href = `${list}/${dashboard.id}`;
  const panels = Array.isArray(definition.panels)
    ? definition.panels.length
    : 0;
  async function remove() {
    if (
      !(await confirm({
        title: `Delete dashboard “${display(definition.name)}”?`,
        body: (
          <p>
            It is removed for everyone in {scope.tenant.name}. Its presets and
            alerts are kept. Retained history stays readable; there is no
            undelete.
          </p>
        ),
        confirmLabel: "Delete dashboard",
        danger: true,
      }))
    )
      return;
    const result = await command.execute(
      `${tenantPath(scope.tenant.id)}/dashboards/${definition.id}`,
      {},
      "DELETE",
      {
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": `"${definition.revision}"`,
      },
    );
    if (result) scope.navigate(list);
  }
  return (
    <Page
      scope={scope}
      className="dashboard-view"
      title={display(definition.name)}
      crumbs={[{ label: "Dashboards", href: list }]}
      extra={
        <span className="page-subtitle">
          Shared · revision {definition.revision} · {panels} panel
          {panels === 1 ? "" : "s"}
        </span>
      }
      actions={
        <>
          <button type="button" className="btn" onClick={model.pause}>
            {model.paused ? "Resume updates" : "Pause updates"}
          </button>
          <button type="button" className="btn" onClick={model.refresh}>
            Refresh counts
          </button>
          <button
            ref={model.trigger}
            type="button"
            className="btn"
            onClick={() => model.setFullscreen(true)}
          >
            Fullscreen
          </button>
          {canEdit && (
            <NavLink
              data-edit-trigger
              scope={scope}
              className="btn"
              href={`${href}/edit`}
            >
              Edit dashboard
            </NavLink>
          )}
          <Menu
            label="More dashboard actions"
            className="btn"
            style={{ padding: "0 10px" }}
            content={
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
            }
          >
            {(close) => (
              <>
                <NavLink
                  scope={scope}
                  role="menuitem"
                  className="menu-item"
                  href={`${href}/history`}
                  onClick={close}
                >
                  History
                </NavLink>
                {canEdit && (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item menu-danger"
                    disabled={command.busy}
                    onClick={() => {
                      close();
                      void remove();
                    }}
                  >
                    Delete dashboard
                  </button>
                )}
              </>
            )}
          </Menu>
        </>
      }
    >
      {dialog}
      {(command.error || command.uncertain) && (
        <div className="pe-feedback">
          <CommandFeedback command={command} />
        </div>
      )}
      <DashboardBoard scope={scope} model={model} />
    </Page>
  );
}
