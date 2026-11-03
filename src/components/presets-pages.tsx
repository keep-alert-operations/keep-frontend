"use client";
import type { AlertCommandKind } from "./alert-table";
import type { DismissalValue } from "./dismiss-dialog";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ApiError, display, RecordData, request, tenantPath } from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import {
  DEFAULT_COLUMNS,
  DEFAULT_SORT,
  nextQuickSort,
  sortItems,
  sortSummary,
  usePresetPreview,
  type SortItem,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice, Menu } from "./ui";
import {
  NavLink,
  Page,
  personLabel,
  RelativeTime,
  SearchInput,
  useConfirm,
} from "./page";
import {
  AlertTable,
  BulkBar,
  composeCel,
  QuickViews,
  useQuickViewCounts,
  type QuickViewKey,
} from "./alert-table";
import { rememberAlertList } from "./alerts";
import {
  AlertGroups,
  GROUP_PAGE,
  GROUP_ROWS,
  GroupByControl,
  groupFieldLabel,
  isGroupField,
  tooManyGroups,
  useAlertGroups,
  type AlertGroup,
  type GroupField,
} from "./alert-groups";
import { CelCode, Dialog, PresetEditor } from "./definition-editor";
import { LinkIncidentDialog } from "./link-incident";
import { ConfigurationHistory } from "./configuration-history";
import { AlarmBanner, NoisyChip, useAlarm } from "./preset-alarm";

/** Routes this area's list, detail, editor and history screens. */
export function PresetPages(scope: Scope & { section: string; id?: string }) {
  const pathname = usePathname();
  const sub = pathname.split("/").filter(Boolean)[4];
  if (!scope.id) return <PresetList key={scope.tenant.id} scope={scope} />;
  if (scope.id === "new")
    return <NewPreset key={`${scope.tenant.id}:new`} scope={scope} />;
  if (sub === "history")
    return (
      <ConfigurationHistory
        key={`${scope.tenant.id}:presets:${scope.id}`}
        scope={scope}
        section="presets"
        id={scope.id}
      />
    );
  return (
    <PresetDetail
      key={`${scope.tenant.id}:${scope.id}`}
      scope={scope}
      id={scope.id}
      editing={sub === "edit"}
    />
  );
}

/**
 * Navigates after the render that cleared the workspace unsaved-changes guard,
 * so leaving a just-saved or discarded editor never prompts.
 */
export function useLeave(scope: Scope) {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    setTarget(null);
    scope.navigate(target);
  }, [target, scope]);
  return setTarget;
}

/**
 * Leaving an editor returns keyboard focus to the page's edit action. The flag
 * lives outside React because the route change may remount the page tree.
 */
export const returnFocus = { pending: false };
export function useReturnFocus(ready: boolean) {
  useEffect(() => {
    if (!ready || !returnFocus.pending) return;
    returnFocus.pending = false;
    document.querySelector<HTMLElement>("[data-edit-trigger]")?.focus();
  }, [ready]);
}

function searchParam(name: string) {
  return typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get(name);
}

function NewPreset({ scope }: { scope: Scope }) {
  const searchParams = useSearchParams();
  // App Router can render the destination before window.location is updated.
  // Capture its query once so later URL changes cannot replace an edited draft.
  const [initial] = useState(() => {
    const cel = searchParams.get("cel");
    const groupBy = searchParams.get("group_by");
    return cel || isGroupField(groupBy)
      ? {
          ...(cel ? { cel } : {}),
          ...(isGroupField(groupBy) ? { group_by: groupBy } : {}),
        }
      : undefined;
  });
  const leave = useLeave(scope);
  const list = `/tenants/${scope.tenant.id}/presets`;
  return (
    <PresetEditor
      scope={scope}
      initialDraft={initial}
      onSaved={(row) => leave(row?.id ? `${list}/${row.id}` : list)}
      onDiscard={() => leave(list)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Shared preset actions: delete confirmation and dashboard references */
/* ------------------------------------------------------------------ */

function usePresetDelete(scope: Scope, onDeleted: () => void) {
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [dialog, confirm] = useConfirm();
  async function remove(preset: RecordData) {
    if (
      !(await confirm({
        title: `Delete preset “${display(preset.name)}”?`,
        body: (
          <p>
            It is removed for everyone in {scope.tenant.name}. A preset that
            dashboard panels still use can’t be deleted. Retained history stays
            readable; there is no undelete.
          </p>
        ),
        confirmLabel: "Delete preset",
        danger: true,
      }))
    )
      return;
    const result = await command.execute(
      `${tenantPath(scope.tenant.id)}/presets/${preset.id}`,
      {},
      "DELETE",
      {
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": `"${preset.revision}"`,
      },
    );
    if (result) onDeleted();
  }
  return { dialog, remove, command };
}

function PresetReferences({
  scope,
  preset,
  onClose,
}: {
  scope: Scope;
  preset: RecordData;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/presets/${preset.id}/references?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  const grouped = new Map<string, { name: string; panels: number }>();
  for (const row of rows) {
    const id = String(row.dashboard_id ?? row.id);
    const name = display(row.dashboard_name ?? row.name);
    const panels =
      typeof row.panels === "string" && /^\d+$/.test(row.panels)
        ? Number(row.panels)
        : 1;
    const entry = grouped.get(id) ?? { name, panels: 0 };
    entry.panels += panels;
    grouped.set(id, entry);
  }
  const total = result.data?.meta?.total;
  return (
    <Dialog
      title={`Dashboards using “${display(preset.name)}”`}
      onClose={onClose}
      actions={
        <>
          {(cursor || result.data?.next_cursor) && (
            <>
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
                className="btn btn-sm btn-g"
                disabled={!result.data?.next_cursor || result.loading}
                onClick={() => setCursor(result.data?.next_cursor ?? null)}
              >
                Next page
              </button>
            </>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ErrorNotice error={result.error} />
      {result.loading && !result.data ? (
        <p role="status">Loading dashboard references…</p>
      ) : grouped.size ? (
        <>
          <p>
            {typeof total === "string" ? `${total} panel reference(s). ` : ""}
            Remove or replace these panels before deleting the preset.
          </p>
          <ul className="ref-list">
            {[...grouped].map(([id, entry]) => (
              <li key={id}>
                <NavLink
                  scope={scope}
                  className="lnk"
                  href={`/tenants/${scope.tenant.id}/dashboards/${id}`}
                >
                  {entry.name}
                </NavLink>
                <span className="small muted">
                  {entry.panels} panel{entry.panels === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        !result.error && <p>No current dashboard panels use this preset.</p>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* S04 · preset list                                                   */
/* ------------------------------------------------------------------ */

function useDebounced(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function PresetList({ scope }: { scope: Scope }) {
  const [state, setState] = useState<"active" | "deleted">("active");
  const [search, setSearch] = useState("");
  const filter = useDebounced(search.trim());
  const [cursor, setCursor] = useState<string | null>(null);
  const [references, setReferences] = useState<RecordData | null>(null);
  const base = `${tenantPath(scope.tenant.id)}/presets`;
  const params = new URLSearchParams({ limit: "50", state });
  if (filter) params.set("name", filter);
  if (cursor) params.set("cursor", cursor);
  const result = useResource<RecordData[]>(
    `${base}?${params}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  const countFor = (value: string) =>
    `${base}?${new URLSearchParams({ limit: "200", state: value, ...(filter ? { name: filter } : {}) })}`;
  const active = useResource<RecordData[]>(
    countFor("active"),
    scope.onDenied,
    scope.version,
  );
  const deleted = useResource<RecordData[]>(
    countFor("deleted"),
    scope.onDenied,
    scope.version,
  );
  const removal = usePresetDelete(scope, () => {
    result.reload();
    active.reload();
    deleted.reload();
  });
  useEffect(() => setCursor(null), [filter, state]);
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  const canEdit = scope.tenant.role !== "view";
  const tenantBase = `/tenants/${scope.tenant.id}/presets`;
  const countLabel = (value: typeof active) =>
    Array.isArray(value.data?.data)
      ? `${value.data.data.length}${value.data.next_cursor ? "+" : ""}`
      : "";
  return (
    <Page
      scope={scope}
      className="preset-list"
      title="Presets"
      crumbs={[{ label: "Presets" }]}
      extra={
        <span className="page-subtitle">
          Saved alert views shared with everyone in {scope.tenant.name}
        </span>
      }
      actions={
        canEdit && (
          <NavLink
            scope={scope}
            className="btn btn-p"
            href={`${tenantBase}/new`}
          >
            New preset
          </NavLink>
        )
      }
    >
      {removal.dialog}
      <div className="list-bar">
        <div className="seg" role="group" aria-label="Show">
          {(
            [
              ["active", "Active", active],
              ["deleted", "Deleted", deleted],
            ] as const
          ).map(([value, label, counted]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state === value}
              className={state === value ? "on" : undefined}
              onClick={() => setState(value)}
            >
              {label} <b>{countLabel(counted)}</b>
            </button>
          ))}
        </div>
        <div style={{ flexGrow: 1 }} />
        <SearchInput
          id="preset-search"
          label="Search presets by name"
          value={search}
          maxLength={128}
          width={280}
          onChange={setSearch}
        />
      </div>
      <ErrorNotice error={result.error} />
      {(removal.command.error || removal.command.uncertain) && (
        <div className="pe-feedback">
          <CommandFeedback command={removal.command} />
        </div>
      )}
      <div className="panel table-panel grow">
        <div role="table" aria-label="Presets" className="table-body">
          <div role="row" className="row head pl-row">
            <span role="columnheader">Name ↑</span>
            <span role="columnheader">Sort</span>
            <span role="columnheader">
              {state === "deleted" ? "Deleted by" : "Last editor"}
            </span>
            <span role="columnheader">
              {state === "deleted" ? "Deleted" : "Last modified"}
            </span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {rows.map((row) => {
            const isDeleted = state === "deleted" || Boolean(row.deleted_at);
            const href = `${tenantBase}/${row.id}${isDeleted ? "/history" : ""}`;
            return (
              <div
                role="row"
                className="row pl-row pl-item alert-link-row"
                key={row.id}
              >
                <span role="cell" className="pl-name">
                  <span className="pl-name-row">
                    <NavLink
                      scope={scope}
                      className="lnk alert-row-link"
                      href={href}
                    >
                      {display(row.name)}
                    </NavLink>
                    {row.noisy === true && !isDeleted && <NoisyChip />}
                  </span>
                  <span className="sub">
                    {typeof row.cel === "string"
                      ? row.cel
                      : isDeleted
                        ? "Deleted · retained history"
                        : ""}
                  </span>
                </span>
                <span role="cell" className="cell small">
                  {row.sort ? sortSummary(row.sort) : "—"}
                </span>
                <span role="cell" className="cell">
                  {isDeleted
                    ? personLabel(
                        scope,
                        row.deleted_by ?? row.updated_by,
                        row.deleted_by_display_name ??
                          row.updated_by_display_name,
                        "—",
                      )
                    : personLabel(
                        scope,
                        row.updated_by,
                        row.updated_by_display_name,
                        "—",
                      )}
                </span>
                <span role="cell" className="cell small">
                  <RelativeTime
                    value={
                      isDeleted
                        ? (row.deleted_at ?? row.recorded_at)
                        : row.updated_at
                    }
                  />
                </span>
                <span role="cell" className="acts">
                  {!isDeleted && canEdit && (
                    <NavLink
                      scope={scope}
                      className="ibtn"
                      href={`${tenantBase}/${row.id}/edit`}
                      aria-label={`Edit ${display(row.name)}`}
                    >
                      Edit
                    </NavLink>
                  )}
                  <NavLink
                    scope={scope}
                    className="ibtn"
                    href={`${tenantBase}/${row.id}/history`}
                    aria-label={`History of ${display(row.name)}`}
                  >
                    History
                  </NavLink>
                  {!isDeleted && (
                    <Menu
                      label={`More actions for ${display(row.name)}`}
                      className="ibtn"
                      content="⋯"
                    >
                      {(close) => (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            onClick={() => {
                              close();
                              setReferences(row);
                            }}
                          >
                            Dashboard references
                          </button>
                          {canEdit && (
                            <button
                              type="button"
                              role="menuitem"
                              className="menu-item menu-danger"
                              disabled={removal.command.busy}
                              onClick={() => {
                                close();
                                void removal.remove(row);
                              }}
                            >
                              Delete preset
                            </button>
                          )}
                        </>
                      )}
                    </Menu>
                  )}
                </span>
              </div>
            );
          })}
          {!rows.length && result.data && (
            <div className="list-empty">
              <h2>
                {filter
                  ? `No presets match “${filter}”`
                  : state === "deleted"
                    ? "No deleted presets"
                    : "No presets yet"}
              </h2>
              <p>
                {state === "deleted"
                  ? "Deleted presets keep their retained history here."
                  : canEdit
                    ? "Create a preset to save a filter, columns and sort order for everyone in this tenant."
                    : "Presets created by editors appear here."}
              </p>
            </div>
          )}
          {result.loading && !result.data && (
            <p className="list-empty" role="status">
              Loading presets…
            </p>
          )}
        </div>
        {(cursor || result.data?.next_cursor) && (
          <div className="table-footer-bar">
            <span>
              {rows.length} presets on this page
              {result.loading ? " · updating…" : ""}
            </span>
            <div style={{ flexGrow: 1 }} />
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
      </div>
      {references && (
        <PresetReferences
          scope={scope}
          preset={references}
          onClose={() => setReferences(null)}
        />
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* S05 · preset results and S06 · editing                              */
/* ------------------------------------------------------------------ */

function PresetDetail({
  scope,
  id,
  editing,
}: {
  scope: Scope;
  id: string;
  editing: boolean;
}) {
  const path = `${tenantPath(scope.tenant.id)}/presets/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const preset = result.data?.data;
  const [base, setBase] = useState<RecordData | null>(null);
  const leave = useLeave(scope);
  const detailHref = `/tenants/${scope.tenant.id}/presets/${id}`;
  useEffect(() => {
    if (editing && !base && preset) setBase(preset);
    if (!editing && base) setBase(null);
  }, [editing, base, preset]);
  if (editing && base)
    return (
      <PresetEditor
        key={`${id}:${base.revision}`}
        scope={scope}
        existing={base}
        current={preset}
        onSaved={(row) => {
          result.reload();
          returnFocus.pending = !row?.id || row.id === id;
          leave(
            row?.id && row.id !== id
              ? `/tenants/${scope.tenant.id}/presets/${row.id}`
              : detailHref,
          );
        }}
        onDiscard={() => {
          returnFocus.pending = true;
          leave(detailHref);
        }}
      />
    );
  if (!preset)
    return (
      <Page
        scope={scope}
        title={result.loading ? "Loading preset…" : "Preset unavailable"}
        crumbs={[
          { label: "Presets", href: `/tenants/${scope.tenant.id}/presets` },
        ]}
      >
        {result.error instanceof ApiError && result.error.status === 404 ? (
          <div className="banner bn-warn">
            This preset no longer exists. It may have been deleted.{" "}
            <NavLink
              scope={scope}
              className="lnk-inline"
              href={`${detailHref}/history`}
            >
              View retained history
            </NavLink>
          </div>
        ) : (
          <ErrorNotice error={result.error} />
        )}
        {result.loading && (
          <p className="sr-only" role="status">
            Loading preset…
          </p>
        )}
      </Page>
    );
  return (
    <PresetResults
      scope={scope}
      preset={preset}
      reload={result.reload}
      stale={Boolean(result.error)}
    />
  );
}

function PresetSwitcher({ scope, current }: { scope: Scope; current: string }) {
  return (
    <Menu
      label="Switch preset"
      className="btn btn-g btn-sm ps-switch"
      align="left"
      content={
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      }
    >
      {(close) => (
        <PresetSwitchList scope={scope} current={current} close={close} />
      )}
    </Menu>
  );
}
function PresetSwitchList({
  scope,
  current,
  close,
}: {
  scope: Scope;
  current: string;
  close: () => void;
}) {
  const [search, setSearch] = useState("");
  const filter = useDebounced(search.trim(), 200);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/presets?${new URLSearchParams({ limit: "200", ...(filter ? { name: filter } : {}) })}`,
    scope.onDenied,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return (
    <div className="ps-switch-list">
      <input
        className="inp"
        aria-label="Find a preset"
        placeholder="Find a preset"
        value={search}
        maxLength={128}
        onChange={(event) => setSearch(event.target.value)}
      />
      <ErrorNotice error={result.error} />
      <div className="ps-switch-items">
        {rows.map((row) => (
          <NavLink
            key={row.id}
            scope={scope}
            role="menuitem"
            className={`menu-item ${row.id === current ? "menu-on" : ""}`}
            aria-current={row.id === current ? "page" : undefined}
            href={`/tenants/${scope.tenant.id}/presets/${row.id}`}
            onClick={close}
          >
            {display(row.name)}
          </NavLink>
        ))}
        {!rows.length && result.data && (
          <span className="help menu-note">No presets match.</span>
        )}
        {result.loading && !result.data && (
          <span className="help menu-note">Loading presets…</span>
        )}
      </div>
    </div>
  );
}

function PresetResults({
  scope,
  preset,
  reload,
  stale,
}: {
  scope: Scope;
  preset: RecordData;
  reload: () => void;
  stale: boolean;
}) {
  const [quick, setQuick] = useState<QuickViewKey>("all"),
    [suppressed, setSuppressed] = useState(false),
    [search, setSearch] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [pageNumber, setPageNumber] = useState(1),
    [refresh, setRefresh] = useState(0),
    [selection, setSelection] = useState<Map<string, string>>(new Map()),
    [references, setReferences] = useState(false);
  const [quickSort, setQuickSort] = useState<SortItem | null>(null);
  const [linking, setLinking] = useState<RecordData>();
  const [fromDashboard] = useState(() => searchParam("from") === "dashboard");
  useReturnFocus(true);
  const q = useDebounced(search.trim());
  const tenantId = scope.tenant.id,
    csrf = scope.session.csrf_token;
  const listHref = `/tenants/${tenantId}/presets`;
  const detailHref = `${listHref}/${preset.id}`;
  const sort = sortItems(preset.sort).length
    ? sortItems(preset.sort)
    : DEFAULT_SORT;
  const effectiveSort = quickSort ? [quickSort] : sort;
  const columns =
    Array.isArray(preset.columns) && preset.columns.length
      ? (preset.columns as unknown[]).map(String)
      : DEFAULT_COLUMNS;
  const cel = typeof preset.cel === "string" ? preset.cel : "true";
  const savedGroupBy = isGroupField(preset.group_by) ? preset.group_by : null;
  // A toolbar change of grouping is temporary, like the sort override (REV-44).
  const [groupOverride, setGroupOverride] = useState<GroupField | null>();
  const groupBy = groupOverride !== undefined ? groupOverride : savedGroupBy;
  const canEdit = scope.tenant.role !== "view";
  const command = useCommand(csrf, scope.onDenied);
  const removal = usePresetDelete(scope, () => scope.navigate(listHref));
  useEffect(() => {
    setCursor(null);
    setPageNumber(1);
    setSelection(new Map());
  }, [quick, suppressed, q, preset.id, preset.revision, groupBy]);
  useEffect(() => {
    setQuickSort(null);
    setGroupOverride(undefined);
  }, [preset.id, preset.revision]);
  const savedView = quick === "all" && !quickSort;
  const groupRequest =
    savedView && groupOverride === undefined
      ? { preset_id: preset.id, expected_revision: preset.revision }
      : {
          cel: composeCel(cel, quick, scope.session.principal.id),
          sort: effectiveSort,
          columns,
          group_by: groupBy,
        };
  const grouped = useAlertGroups({
    scope,
    field: groupBy,
    path: groupBy ? `${tenantPath(tenantId)}/presets/preview/groups` : null,
    body: groupBy
      ? {
          ...groupRequest,
          q,
          include_suppressed: suppressed,
          group_limit: GROUP_PAGE,
          rows_per_group: GROUP_ROWS,
        }
      : null,
    version: `${scope.version}:${refresh}`,
    rows: (group: AlertGroup, next: string) =>
      request<RecordData[]>(`${tenantPath(tenantId)}/presets/preview`, {
        method: "POST",
        csrf,
        body: {
          ...groupRequest,
          q,
          include_suppressed: suppressed,
          limit: GROUP_ROWS,
          cursor: next,
          ...(group.key === null
            ? { group_empty: true }
            : { group_key: group.key }),
        },
        signal: AbortSignal.timeout(15000),
      }),
  });
  const tooMany = groupBy !== null && tooManyGroups(grouped.first.error);
  const showGroups = groupBy !== null && !tooMany;
  // Saved "All" uses the saved preview (observed revision); quick views are
  // transient candidates built from the saved definition.
  const body =
    quick === "all" && !quickSort
      ? {
          preset_id: preset.id,
          expected_revision: preset.revision,
          q,
          include_suppressed: suppressed,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        }
      : {
          cel: composeCel(cel, quick, scope.session.principal.id),
          sort: effectiveSort,
          columns,
          q,
          include_suppressed: suppressed,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        };
  const viewVersion = cursor ? 0 : scope.version;
  const page = usePresetPreview(
    tenantId,
    csrf,
    scope.onDenied,
    showGroups ? null : body,
    `${viewVersion}:${refresh}`,
  );
  const changed = [page.error, grouped.first.error].some(
    (error) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "preset_changed",
  );
  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (changed && reloadedFor.current !== preset.revision) {
      // Reload the definition; retry once in case it is already current.
      reloadedFor.current = preset.revision;
      reload();
      setRefresh((value) => value + 1);
    }
  }, [changed, preset.revision, reload]);
  const counts = useQuickViewCounts(
    scope,
    cel,
    suppressed,
    q,
    JSON.stringify([
      preset.id,
      preset.revision,
      (showGroups ? grouped.meta : page.result?.meta)?.evaluated_at,
    ]),
  );
  const expandedGroups = grouped.groups.some(
    (group) => !grouped.isCollapsed(group),
  );
  async function rowCommand(
    row: RecordData,
    kind: AlertCommandKind,
    value: string | DismissalValue | null,
  ) {
    const done = Boolean(
      await command.execute(
        `${tenantPath(tenantId)}/alerts/${row.id}/commands`,
        {
          expected_revision: row.revision,
          kind,
          value,
        },
      ),
    );
    if (done) {
      setRefresh((value) => value + 1);
      if (showGroups) grouped.first.reload();
    }
    return done;
  }
  const rows = page.result?.data ?? [];
  const currentResult = page.resultKey === JSON.stringify(body);
  const meta = page.result?.meta;
  const total =
    typeof meta?.total === "string" && /^\d+$/.test(meta.total)
      ? BigInt(meta.total).toLocaleString()
      : undefined;
  // Noisy presets (REV-58) sound while the view's exact total is above zero.
  // A loading or failed total keeps the last answer instead of counting as zero.
  const noisy = preset.noisy === true;
  const viewMeta = showGroups ? grouped.meta : meta;
  const [alarmTotal, setAlarmTotal] = useState<string>();
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setAlarmTotal(undefined);
    setMuted(false);
  }, [preset.id]);
  useEffect(() => {
    const value = viewMeta?.total;
    if (typeof value === "string" && /^\d+$/.test(value)) setAlarmTotal(value);
  }, [viewMeta]);
  const hasAlerts = alarmTotal !== undefined && !/^0+$/.test(alarmTotal);
  const alarm = useAlarm(noisy && hasAlerts && !muted);
  return (
    <Page
      scope={scope}
      className="preset-view"
      title={display(preset.name)}
      crumbs={[{ label: "Presets", href: listHref }]}
      extra={
        <>
          {noisy && (
            <NoisyChip
              ringing={alarm === "playing"}
              quiet={alarmTotal !== undefined && !hasAlerts}
            />
          )}
          <PresetSwitcher scope={scope} current={preset.id} />
        </>
      }
      actions={
        <>
          {canEdit && (
            <NavLink
              data-edit-trigger
              scope={scope}
              className="btn"
              href={`${detailHref}/edit`}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />
              </svg>
              Edit preset
            </NavLink>
          )}
          <NavLink scope={scope} className="btn" href={`${detailHref}/history`}>
            History
          </NavLink>
          <Menu
            label="More preset actions"
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
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    setReferences(true);
                  }}
                >
                  Dashboard references
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    setRefresh((value) => value + 1);
                  }}
                >
                  Refresh results
                </button>
                {canEdit && (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item menu-danger"
                    disabled={removal.command.busy}
                    onClick={() => {
                      close();
                      void removal.remove(preset);
                    }}
                  >
                    Delete preset
                  </button>
                )}
              </>
            )}
          </Menu>
        </>
      }
    >
      {removal.dialog}
      {changed && (
        <p className="banner bn-info" role="status">
          This preset changed while you were viewing it. Loading the current
          saved definition…
        </p>
      )}
      {stale && (
        <p className="banner bn-warn" role="status">
          Showing the last loaded definition · refreshing it failed.
        </p>
      )}
      {(removal.command.error || removal.command.uncertain) && (
        <div className="pe-feedback">
          <CommandFeedback command={removal.command} />
          {removal.command.error instanceof ApiError &&
            removal.command.error.code === "preset_in_use" && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setReferences(true)}
              >
                View dashboard references
              </button>
            )}
        </div>
      )}
      {noisy && hasAlerts && (
        <AlarmBanner
          state={alarm}
          muted={muted}
          total={BigInt(alarmTotal!).toLocaleString()}
          onMute={setMuted}
        />
      )}
      <div className="ps-bar">
        {canEdit ? (
          <NavLink
            scope={scope}
            className="ps-filter"
            href={`${detailHref}/edit`}
            aria-label="Edit filter expression"
            title={cel}
          >
            <FilterSummary cel={cel} sort={sort} groupBy={savedGroupBy} />
          </NavLink>
        ) : (
          <div className="ps-filter ps-filter-static" title={cel}>
            <FilterSummary cel={cel} sort={sort} groupBy={savedGroupBy} />
          </div>
        )}
        <SearchInput
          id="preset-results-search"
          label="Search text in results"
          placeholder="Search text"
          value={search}
          maxLength={256}
          onChange={setSearch}
        />
      </div>
      <QuickViews
        value={quick}
        onChange={setQuick}
        counts={counts.counts}
        hidden={counts.hidden}
        includeSuppressed={suppressed}
        onIncludeSuppressed={setSuppressed}
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
              saved={savedGroupBy}
              onChange={(value) =>
                setGroupOverride(value === savedGroupBy ? undefined : value)
              }
            />
            {groupOverride !== undefined && (
              <button
                type="button"
                className="btn btn-sm btn-g"
                title="Back to the saved grouping"
                onClick={() => setGroupOverride(undefined)}
              >
                Reset
              </button>
            )}
          </>
        }
      />
      {grouped.stale && showGroups && (
        <div className="banner bn-info" role="status">
          <span>
            <b>New results available.</b> Alerts changed since these groups were
            loaded. They stay as they were so rows don&apos;t move while you
            work.
          </span>
          <div className="grow" />
          <button type="button" className="btn btn-sm" onClick={grouped.reset}>
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
      {showGroups
        ? !changed && (
            <ErrorNotice error={grouped.error ?? grouped.first.error} />
          )
        : page.error !== undefined &&
          !changed && <ErrorNotice error={page.error} />}
      <ErrorNotice error={command.error} />
      {showGroups && grouped.groups.length > 0 && (
        <AlertGroups
          scope={scope}
          field={groupBy}
          state={grouped}
          columns={columns}
          sort={effectiveSort}
          onSort={(field) => {
            setQuickSort((current) => nextQuickSort(current, field));
            setSelection(new Map());
          }}
          selection={selection}
          onSelectionChange={setSelection}
          onRowCommand={rowCommand}
          command={command}
          onLinkIncident={setLinking}
          busy={command.busy}
          evaluated
          footnote={
            fromDashboard && (
              <span>· opened current results; count may have changed</span>
            )
          }
          onRemember={(ids, current) =>
            rememberAlertList(tenantId, {
              label: display(preset.name),
              href: detailHref,
              ids,
              current,
            })
          }
        />
      )}
      {showGroups && grouped.groups.length === 0 && (
        <div className="panel table-panel grow">
          <div className="ps-empty">
            {grouped.first.error ? null : !grouped.settled ? (
              <p role="status">Loading matching alerts…</p>
            ) : (
              <>
                <h2>No matching alerts</h2>
                <p>
                  {q
                    ? `Nothing in this preset matches “${q}”.`
                    : quick !== "all"
                      ? "Nothing in this quick view right now."
                      : "No current alerts match this preset."}
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {!showGroups && (
        <div className="panel table-panel grow">
          {rows.length ? (
            <div
              className={`ps-table ${page.loading ? "is-stale" : ""}`}
              aria-busy={page.loading}
              onClickCapture={(event) => {
                const link = (event.target as Element).closest?.("a[href]");
                const match = link
                  ?.getAttribute("href")
                  ?.match(/\/alerts\/([^/?#]+)$/);
                if (match)
                  rememberAlertList(tenantId, {
                    label: display(preset.name),
                    href: detailHref,
                    ids: rows.map((row) => row.id),
                    current: decodeURIComponent(match[1]),
                  });
              }}
            >
              <AlertTable
                scope={scope}
                rows={rows}
                columns={columns}
                sort={effectiveSort}
                onSort={(field) => {
                  setQuickSort((current) => nextQuickSort(current, field));
                  setCursor(null);
                  setPageNumber(1);
                  setSelection(new Map());
                }}
                selection={selection}
                onSelectionChange={setSelection}
                onRowCommand={rowCommand}
                command={command}
                onLinkIncident={setLinking}
                busy={command.busy}
              />
            </div>
          ) : (
            <div className="ps-empty">
              {page.loading && !currentResult ? (
                <p role="status">Loading matching alerts…</p>
              ) : page.result && currentResult ? (
                <>
                  <h2>No matching alerts</h2>
                  <p>
                    {q
                      ? `Nothing in this preset matches “${q}”.`
                      : quick !== "all"
                        ? "Nothing in this quick view right now."
                        : "No current alerts match this preset."}
                  </p>
                </>
              ) : null}
            </div>
          )}
          <div className="table-footer-bar">
            <span className="ps-foot-text">
              <b>
                {total !== undefined
                  ? `${total} matching alerts`
                  : "Matching alerts unavailable"}
              </b>
              {typeof meta?.evaluated_at === "string" && (
                <>
                  {" "}
                  · evaluated <RelativeTime value={meta.evaluated_at} />
                </>
              )}
              {cursor ? ` · page ${pageNumber}` : ""}
              {page.loading && page.result ? " · updating…" : ""}
              {meta?.updating ? " · index catching up" : ""}
              {fromDashboard
                ? " · opened current results; count may have changed"
                : ""}
            </span>
            <div style={{ flexGrow: 1 }} />
            {(cursor || page.result?.next_cursor) && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  disabled={!cursor}
                  aria-label="First results page"
                  onClick={() => {
                    setCursor(null);
                    setPageNumber(1);
                    setSelection(new Map());
                  }}
                >
                  First page
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page.loading || !page.result?.next_cursor}
                  aria-label="Next results page"
                  onClick={() => {
                    setCursor(page.result?.next_cursor ?? null);
                    setPageNumber((value) => value + 1);
                    setSelection(new Map());
                  }}
                >
                  Next page
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <BulkBar
        scope={scope}
        selection={selection}
        onDone={() => {
          setSelection(new Map());
          setRefresh((value) => value + 1);
          if (showGroups) grouped.first.reload();
        }}
        onClear={() => setSelection(new Map())}
      />
      {references && (
        <PresetReferences
          scope={scope}
          preset={preset}
          onClose={() => setReferences(false)}
        />
      )}
      {linking && (
        <LinkIncidentDialog
          scope={scope}
          alert={linking}
          onDone={() => {
            setRefresh((value) => value + 1);
            if (showGroups) grouped.first.reload();
          }}
          onClose={() => setLinking(undefined)}
        />
      )}
    </Page>
  );
}

function FilterSummary({
  cel,
  sort,
  groupBy,
}: {
  cel: string;
  sort: unknown;
  groupBy?: GroupField | null;
}) {
  return (
    <>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted)"
        strokeWidth="2"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />
      </svg>
      <span className="mono ps-cel">
        <CelCode source={cel.replace(/\s+/g, " ")} />
      </span>
      <span className="ps-sorted">
        {groupBy
          ? `Grouped by ${groupFieldLabel(groupBy).toLowerCase()} · sorted by `
          : "Sorted by "}
        {sortSummary(sort).toLowerCase()}
      </span>
    </>
  );
}
