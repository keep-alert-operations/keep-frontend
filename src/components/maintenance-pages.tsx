"use client";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ApiError,
  display,
  type RecordData,
  request,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { NavLink, Page, Severity, useConfirm } from "./page";
import {
  type Endpoint,
  EndpointLine,
  MaintenanceAlertTest,
  MaintenanceEditor,
  RulesChanged,
} from "./maintenance-editor";
import {
  Banner,
  CommandBanner,
  ErrorBanner,
  CelCode,
  TemporalHistory,
  browserZoneLabel,
  durationLabel,
  localStamp,
  titleCase,
  utcStamp,
} from "./temporal-history";

type MaintenanceScope = Scope & { section: string; id?: string };

/** Routes the maintenance list, window detail/editor, creation and history. */
export function MaintenancePages(scope: MaintenanceScope) {
  const pathname = usePathname();
  if (scope.id && pathname.endsWith("/history"))
    return (
      <TemporalHistory
        key={`${scope.tenant.id}:maintenance:${scope.id}`}
        scope={scope}
        section="maintenance"
        id={scope.id}
      />
    );
  if (scope.id === "new")
    return <MaintenanceEditor key={`${scope.tenant.id}:new`} scope={scope} />;
  if (scope.id)
    return (
      <MaintenanceDetail
        key={`${scope.tenant.id}:${scope.id}`}
        scope={scope}
        id={scope.id}
      />
    );
  return <MaintenanceList key={scope.tenant.id} scope={scope} />;
}

export function PhasePill({ phase }: { phase: unknown }) {
  const value = String(phase ?? "");
  return (
    <span className={`ph ph-${value || "unknown"}`}>{titleCase(value)}</span>
  );
}
export function ProcessingChip({ value }: { value: unknown }) {
  const text = String(value ?? "");
  const tone =
    text === "healthy" ? "b-green" : text === "blocked" ? "b-red" : "b-amber";
  return text ? (
    <span className={`chip ${tone}`}>{titleCase(text)}</span>
  ) : (
    <span className="small muted">—</span>
  );
}
function EnabledChip({ enabled }: { enabled: unknown }) {
  return enabled ? (
    <span className="chip b-dark">Enabled</span>
  ) : (
    <span className="chip b-neutral">Disabled</span>
  );
}
function shown(row: RecordData, which: "start" | "end") {
  const display = row[`${which}_display`] as Endpoint | undefined;
  return display?.local
    ? localStamp(display.local)
    : timestamp(row[`${which}_at`]);
}
function relative(ms: number) {
  const minutes = Math.round(Math.abs(ms) / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
function effect(row: RecordData, now: number, suppressed?: string) {
  const start = Date.parse(String(row.start_at)),
    end = Date.parse(String(row.end_at));
  const phase = String(row.phase ?? "");
  if (row.deleted_at || phase === "deleted") return "Suppression released";
  if (phase === "ended" || (!phase && end <= now))
    return Number.isFinite(end) && end <= now
      ? `Ended ${relative(now - end)} ago`
      : "Ended";
  if (!row.enabled) return "Will not suppress";
  if (phase === "active" || (!phase && start <= now))
    return suppressed !== undefined && /^\d+$/.test(suppressed)
      ? `${BigInt(suppressed).toLocaleString()} alert${suppressed === "1" ? "" : "s"} suppressed`
      : "Suppressing new matches";
  return Number.isFinite(start) && start > now
    ? `Starts in ${relative(start - now)}`
    : "Starting";
}

/** Current suppression counts for the (few) active enabled windows shown. */
function useSuppressedCounts(scope: Scope, ids: string[]) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void Promise.all(
      key.split(",").map((id) =>
        request<RecordData>(
          `${tenantPath(scope.tenant.id)}/maintenance/${id}`,
          {
            signal: controller.signal,
          },
        )
          .then((result) => [id, result.data?.current_causes_count] as const)
          .catch(() => [id, undefined] as const),
      ),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setCounts(
        Object.fromEntries(
          entries.filter(
            (entry): entry is readonly [string, string] =>
              typeof entry[1] === "string",
          ),
        ),
      );
    });
    return () => controller.abort();
  }, [key, scope.tenant.id, scope.version]);
  return counts;
}

/* ------------------------------------------------------------------ S12 */

const PHASES = [
  ["current", "Current and upcoming"],
  ["ended", "Ended"],
  ["all", "All"],
  ["deleted", "Deleted history"],
] as const;
const SORTS = [
  ["start", "Start time"],
  ["end", "End time"],
  ["name", "Name"],
  ["updated_at", "Last updated"],
] as const;

function MaintenanceList({ scope }: { scope: Scope }) {
  const [phase, setPhase] = useState<string>("current");
  const [sort, setSort] = useState<string>("start");
  const [search, setSearch] = useState(""),
    [name, setName] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const timer = setTimeout(() => {
      setName(search.trim());
      setCursors([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    limit: "50",
    phase,
    sort,
    direction: sort === "updated_at" ? "desc" : "asc",
  });
  if (name) params.set("name", name);
  if (cursor) params.set("cursor", cursor);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/maintenance?${params}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : null;
  const now = Date.now();
  const activeIds = (rows ?? [])
    .filter((row) => row.enabled && !row.deleted_at && row.phase === "active")
    .slice(0, 10)
    .map((row) => row.id);
  const counts = useSuppressedCounts(scope, activeIds);
  const base = `/tenants/${scope.tenant.id}/maintenance`;
  const canEdit = scope.tenant.role !== "view";
  const arrow = (key: string) =>
    sort === key ? (sort === "updated_at" ? " ↓" : " ↑") : "";
  return (
    <Page
      scope={scope}
      title="Maintenance"
      crumbs={[{ label: "Maintenance" }]}
      extra={
        <span className="page-subtitle">
          One-time windows that suppress newly matching alerts
        </span>
      }
      actions={
        canEdit && (
          <button
            type="button"
            className="btn btn-p"
            onClick={() => scope.navigate(`${base}/new`)}
          >
            New window
          </button>
        )
      }
    >
      <div className="rl-toolbar">
        <div className="seg" role="group" aria-label="Records">
          {PHASES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={phase === value}
              className={phase === value ? "on" : undefined}
              onClick={() => {
                setPhase(value);
                setCursors([]);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="maintenance-search">
          Search by name
        </label>
        <input
          id="maintenance-search"
          className="inp mw-search"
          placeholder="Search by name"
          value={search}
          maxLength={128}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="grow-x" />
        <label className="small muted mw-sort">
          Sort
          <select
            className="inp"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setCursors([]);
            }}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(phase === "current" || phase === "all") && (
        <MaintenanceTimeline scope={scope} />
      )}
      <ErrorBanner error={result.error} />
      <section className="panel table-panel grow">
        <div
          role="table"
          aria-label="Maintenance windows"
          className="table-body"
        >
          <div role="row" className="row head g-mw">
            <span role="columnheader">Window{arrow("name")}</span>
            <span role="columnheader">Phase</span>
            <span role="columnheader">Enabled</span>
            <span role="columnheader">Starts{arrow("start")}</span>
            <span role="columnheader">Ends{arrow("end")}</span>
            <span role="columnheader">Effect</span>
            <span role="columnheader">Processing</span>
          </div>
          {rows?.map((row) => {
            const deleted = phase === "deleted" || Boolean(row.deleted_at);
            return (
              <div role="row" className="row g-mw rl-row" key={row.id}>
                <span role="cell" className="rl-name">
                  <NavLink
                    scope={scope}
                    href={`${base}/${row.id}${deleted ? "/history" : ""}`}
                    className="lnk"
                  >
                    {display(row.name)}
                  </NavLink>
                  {row.reason ? (
                    <span className="cell small muted">
                      {display(row.reason)}
                    </span>
                  ) : null}
                </span>
                <span role="cell">
                  <PhasePill phase={deleted ? "deleted" : row.phase} />
                </span>
                <span role="cell" className="small">
                  {row.enabled ? "Enabled" : "Disabled"}
                </span>
                <span role="cell" className="mono small">
                  {shown(row, "start")}
                </span>
                <span role="cell" className="mono small">
                  {shown(row, "end")}
                </span>
                <span role="cell" className="cell small">
                  {effect(row, now, counts[row.id])}
                </span>
                <span role="cell">
                  {deleted ? (
                    <span className="small muted">—</span>
                  ) : (
                    <ProcessingChip value={row.processing_health} />
                  )}
                </span>
              </div>
            );
          })}
          {rows && !rows.length && (
            <div className="rl-empty">
              <b>
                {name
                  ? "No windows match this search"
                  : phase === "deleted"
                    ? "No deleted windows with retained history"
                    : phase === "ended"
                      ? "No ended windows"
                      : "No maintenance windows"}
              </b>
              <span className="small muted">
                {canEdit && phase === "current" && !name
                  ? "Create a one-time window to suppress newly matching alerts during planned work."
                  : "Change the view or search to see other windows."}
              </span>
            </div>
          )}
          {result.loading && !rows && (
            <div className="rl-empty" role="status">
              <span className="small muted">Loading maintenance windows…</span>
            </div>
          )}
        </div>
        {(cursors.length > 0 || result.data?.next_cursor) && (
          <div className="table-footer-bar">
            <span className="grow-x" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!cursors.length || result.loading}
              onClick={() => setCursors([])}
            >
              First page
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!result.data?.next_cursor || result.loading}
              onClick={() =>
                setCursors((previous) => [
                  ...previous,
                  result.data!.next_cursor!,
                ])
              }
            >
              Next page
            </button>
          </div>
        )}
        {result.data && Boolean(result.error) && rows && (
          <div className="table-footer-bar">
            <span className="small muted" role="status">
              Showing previous results · refresh unavailable
            </span>
          </div>
        )}
      </section>
    </Page>
  );
}

function MaintenanceTimeline({ scope }: { scope: Scope }) {
  const origin = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }, []);
  const days = useMemo(
    () =>
      Array.from({ length: 10 }, (_, index) => {
        const day = new Date(origin);
        day.setDate(day.getDate() + index);
        return day;
      }),
    [origin],
  );
  const finish = new Date(origin);
  finish.setDate(finish.getDate() + 10);
  const span = finish.getTime() - origin;
  const params = new URLSearchParams({
    phase: "current",
    sort: "start",
    direction: "asc",
    limit: "100",
    overlap_start: new Date(origin).toISOString(),
    overlap_end: finish.toISOString(),
  });
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/maintenance?${params}`,
    scope.onDenied,
    scope.version,
  );
  const now = Date.now();
  const bars = useMemo(() => {
    const rows = Array.isArray(result.data?.data) ? result.data.data : [];
    const lanes: number[] = [0, 0];
    return rows
      .map((row) => ({
        row,
        start: Date.parse(String(row.start_at)),
        end: Date.parse(String(row.end_at)),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.start) &&
          Number.isFinite(item.end) &&
          item.end > origin &&
          item.start < origin + span &&
          !item.row.deleted_at,
      )
      .sort((a, b) => a.start - b.start)
      .map((item) => {
        const left = Math.max(0, (item.start - origin) / span) * 100;
        const right = Math.min(1, (item.end - origin) / span) * 100;
        const width = Math.min(Math.max(right - left, 7), 100 - left);
        const extent = left + width;
        let lane = lanes.findIndex((edge) => edge <= left);
        if (lane < 0) lane = lanes[0] <= lanes[1] ? 0 : 1;
        lanes[lane] = extent + 0.5;
        const phase = !item.row.enabled
          ? "disabled"
          : ["active", "scheduled", "ended"].includes(String(item.row.phase))
            ? String(item.row.phase)
            : item.start <= now && item.end > now
              ? "active"
              : item.end <= now
                ? "ended"
                : "scheduled";
        return { ...item, left, width, lane, phase };
      });
  }, [result.data, origin, span, now]);
  const nowLeft = ((now - origin) / span) * 100;
  const base = `/tenants/${scope.tenant.id}/maintenance`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <section className="panel mw-tl" aria-label="Next 10 days">
      <div className="mw-tl-h">
        <span className="lbl">Next 10 days</span>
        <span className="help">{browserZoneLabel()}</span>
        {result.error ? (
          <span className="help">· Timeline unavailable</span>
        ) : null}
      </div>
      <div className="mw-tl-body">
        <div className="mw-tl-grid" aria-hidden="true">
          {days.map((day) => (
            <span key={day.getTime()} />
          ))}
        </div>
        {nowLeft >= 0 && nowLeft <= 100 && (
          <span
            className="mw-tl-now"
            aria-hidden="true"
            style={{ left: `${nowLeft}%` }}
          />
        )}
        {bars.map((bar) => (
          <NavLink
            key={bar.row.id}
            scope={scope}
            href={`${base}/${bar.row.id}`}
            className={`tlbar tl-${bar.phase}`}
            tabIndex={-1}
            aria-hidden="true"
            title={`${display(bar.row.name)} · ${timestamp(bar.row.start_at)} → ${timestamp(bar.row.end_at)}`}
            style={{
              left: `${bar.left}%`,
              width: `${bar.width}%`,
              top: bar.lane ? 38 : 8,
            }}
          >
            {display(bar.row.name)}
            {bar.phase === "disabled" ? " (disabled)" : ""}
          </NavLink>
        ))}
        <div className="mw-tl-days" aria-hidden="true">
          {days.map((day) => (
            <span key={day.getTime()}>
              {pad(day.getDate())}-{pad(day.getMonth() + 1)}
            </span>
          ))}
        </div>
      </div>
      {result.data && !result.error && bars.length === 0 && (
        <span className="help">No windows in the next 10 days.</span>
      )}
    </section>
  );
}

/* --------------------------------------------- Window detail (S13 style) */

function MaintenanceDetail({ scope, id }: { scope: Scope; id: string }) {
  const path = `${tenantPath(scope.tenant.id)}/maintenance/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const [editing, setEditing] = useState<RecordData | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmDialog, confirm] = useConfirm();
  const w = result.data?.data;
  const listHref = `/tenants/${scope.tenant.id}/maintenance`;
  useEffect(() => {
    if (leaving) scope.navigate(leaving);
  }, [leaving, scope.navigate]);
  if (editing)
    return (
      <MaintenanceEditor
        scope={scope}
        window={editing}
        current={w}
        onSaved={() => {
          setEditing(null);
          result.reload();
        }}
      />
    );
  const canEdit = scope.tenant.role !== "view";
  async function action(suffix: string) {
    if (
      w &&
      (await command.execute(`${path}/${suffix}`, {
        expected_revision: w.revision,
      }))
    )
      result.reload();
  }
  async function remove() {
    if (!w) return;
    const ok = await confirm({
      title: `Delete maintenance window “${display(w.name)}”?`,
      body: (
        <p>
          Its active suppression will be released. Retained history stays
          available for review. This cannot be undone.
        </p>
      ),
      confirmLabel: "Delete window",
      danger: true,
    });
    if (!ok) return;
    const headers = {
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": `"${w.revision}"`,
    };
    if (await command.execute(path, {}, "DELETE", headers))
      setLeaving(listHref);
  }
  if (!w) {
    const missing =
      result.error instanceof ApiError && result.error.status === 404;
    return (
      <Page
        scope={scope}
        title={missing ? "Window unavailable" : "Maintenance window"}
        crumbs={[{ label: "Maintenance", href: listHref }]}
      >
        {result.loading && !result.error && (
          <p className="small muted" role="status">
            Loading maintenance window…
          </p>
        )}
        {missing ? (
          <Banner tone="warn" role="alert">
            This window was deleted or is not visible to you.{" "}
            <NavLink
              scope={scope}
              href={`${listHref}/${id}/history`}
              className="inline-link"
            >
              View retained history
            </NavLink>
          </Banner>
        ) : (
          <ErrorBanner error={result.error} />
        )}
      </Page>
    );
  }
  const start = w.start_display as Endpoint | undefined,
    end = w.end_display as Endpoint | undefined;
  const phase = String(w.phase ?? "");
  const locked = Boolean(w.started_lock) || ["active", "ended"].includes(phase);
  const runs = durationLabel(
    Date.parse(String(w.end_at)) - Date.parse(String(w.start_at)),
  );
  return (
    <Page
      scope={scope}
      title={display(w.name)}
      crumbs={[{ label: "Maintenance", href: listHref }]}
      extra={
        <>
          <PhasePill phase={phase} />
          <EnabledChip enabled={w.enabled} />
          <ProcessingChip value={w.processing_health} />
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => scope.navigate(`${listHref}/${w.id}/history`)}
          >
            History
          </button>
          {canEdit && (
            <button
              type="button"
              className="btn"
              disabled={
                command.busy ||
                command.uncertain ||
                (phase === "ended" && !w.enabled)
              }
              onClick={() => void action(w.enabled ? "disable" : "enable")}
            >
              {w.enabled ? "Disable" : "Enable"}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-d"
              disabled={command.busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-p"
              aria-label="Edit shared definition"
              onClick={() => setEditing(w)}
            >
              Edit
            </button>
          )}
        </>
      }
    >
      {confirmDialog}
      <CommandBanner command={command} />
      {result.error && !result.loading ? (
        <Banner tone="warn" role="status">
          Showing the last loaded revision · refresh failed.
        </Banner>
      ) : null}
      {w.processing_health === "blocked" && (
        <Banner tone="err">
          Suppression processing for this window is blocked. Existing causes are
          kept until processing is repaired.
        </Banner>
      )}
      {w.processing_health === "updating" && (
        <Banner tone="warn">
          Updating suppression. Alert states may take a moment to reflect this
          window.
        </Banner>
      )}
      <div className="mw-grid grow">
        <section className="panel mw-form-panel" aria-label="Window definition">
          <div className="panel-h">
            <h2>Definition</h2>
            <span className="grow-x" />
            <span className="small muted">
              Revision {w.revision} · shared with everyone in{" "}
              {scope.tenant.name}
            </span>
          </div>
          <div className="mw-form">
            <dl className="mw-read">
              <div className="fld">
                <dt>Reason</dt>
                <dd className="mw-wrap">
                  {w.reason ? display(w.reason) : "—"}
                </dd>
              </div>
              <div className="mw-row">
                <div className="fld">
                  <dt>Timezone</dt>
                  <dd>{display(w.timezone)}</dd>
                </div>
                <div className="fld">
                  <dt>Starts</dt>
                  <dd className="mono">{localStamp(start?.local)}</dd>
                </div>
                <div className="fld">
                  <dt>Ends</dt>
                  <dd className="mono">{localStamp(end?.local)}</dd>
                </div>
              </div>
            </dl>
            <Banner tone="info">
              {runs ? `Runs ${runs} · ` : ""}stored as {utcStamp(w.start_at)} →{" "}
              {utcStamp(w.end_at)} UTC.
              <div className="mw-eps">
                <EndpointLine
                  label="Start"
                  value={start}
                  region="Current start schedule evidence"
                />
                <EndpointLine
                  label="End"
                  value={end}
                  region="Current end schedule evidence"
                />
              </div>
            </Banner>
            <RulesChanged value={start} />
            <RulesChanged value={end} />
            <div className="f">
              <span className="lbl">Which alerts (CEL)</span>
              <CelCode value={w.cel} label="Which alerts (CEL)" />
              <span className="help">
                Alerts already firing when the window starts are not suppressed.
                Existing matches are never backfilled.
              </span>
            </div>
            <Banner tone="warn">
              {phase === "ended"
                ? "This window has ended. You can still rename it or change its display timezone."
                : locked
                  ? "This window has started, so its start time and condition are locked. You can still extend or shorten the end, rename it, or change the display timezone."
                  : "Once the window starts, its start time and condition are locked. You can still extend or shorten the end, rename it, or change the display timezone."}
            </Banner>
            <span className="help">
              {w.enabled
                ? "Enabled: qualifying arrivals and transitions during the window gain suppression."
                : "Disabled: this window does not suppress alerts while disabled."}{" "}
              Last changed{" "}
              {w.updated_by_display_name
                ? `by ${display(w.updated_by_display_name)} `
                : ""}
              <span className="mono">{timestamp(w.updated_at)}</span>.
            </span>
          </div>
        </section>
        <aside className="mw-side">
          <MaintenanceAlertTest scope={scope} savedWindow={w} />
          <SuppressedAlerts scope={scope} window={w} />
        </aside>
      </div>
    </Page>
  );
}

function SuppressedAlerts({
  scope,
  window: w,
}: {
  scope: Scope;
  window: RecordData;
}) {
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/maintenance/${w.id}/alerts?limit=20`,
    scope.onDenied,
    scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  const total =
    typeof w.current_causes_count === "string" ? w.current_causes_count : null;
  if (!rows.length) return null;
  return (
    <section
      className="panel rl-small"
      aria-label="Alerts suppressed by this window"
    >
      <span className="lbl">
        Alerts suppressed by this window
        {total ? <span className="mw-count"> {total}</span> : null}
      </span>
      <div className="mw-alerts">
        {rows.map((row) => {
          const alertId = String(row.alert_id ?? row.id);
          return (
            <div className="mw-alert" key={alertId}>
              {row.severity ? <Severity value={row.severity} /> : null}
              {row.unavailable ? (
                <span className="small muted">Alert no longer retained</span>
              ) : (
                <NavLink
                  scope={scope}
                  href={`/tenants/${scope.tenant.id}/alerts/${alertId}`}
                  className={`lnk mw-alert-link ${row.status === "resolved" ? "mw-res" : ""}`}
                >
                  {display(row.message)}
                  {row.status === "resolved" ? " · resolved" : ""}
                </NavLink>
              )}
            </div>
          );
        })}
      </div>
      {result.data?.next_cursor && (
        <span className="help">Showing the first {rows.length} alerts.</span>
      )}
    </section>
  );
}
