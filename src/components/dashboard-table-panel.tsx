"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  alertTitle,
  ApiError,
  display,
  request,
  tenantPath,
  type RecordData,
} from "@/lib/api";
import { currentAlertColumns, fieldLabel } from "@/lib/preset-choices";
import { AlertField } from "./alert-table";
import { SuppressedChip } from "./dismiss-dialog";
import { NavLink } from "./page";
import type { Scope } from "./workspace";
import type { TablePanel } from "./dashboard-counts";
import { PanelLinkButton } from "./dashboard-panel-link";

/** What a table panel shows: its preset's latest alerts (REV-63). */
interface Latest {
  key: string;
  preset?: RecordData;
  rows?: RecordData[];
  columns?: string[];
  total?: string;
  loading: boolean;
  error?: unknown;
}

const decimal = /^(0|[1-9]\d*)$/;

/**
 * Reads the preset's latest `rows` alerts through the saved preset preview, newest
 * first, so the server applies the preset's current saved query and revision. A
 * preset edited between the two reads is read again once.
 */
export function useLatestAlerts(
  scope: Scope,
  presetId: string,
  rows: number,
  refreshKey: string,
) {
  const tenant = scope.tenant.id,
    csrf = scope.session.csrf_token;
  const key = JSON.stringify([tenant, presetId, rows]);
  const [state, setState] = useState<Latest>({ key, loading: true });
  const onDenied = useRef(scope.onDenied);
  onDenied.current = scope.onDenied;
  useEffect(() => {
    if (!presetId) return;
    const controller = new AbortController();
    const signal = controller.signal;
    // Keep the rows on screen while a refresh runs; a new preset or size starts over.
    setState((old) =>
      old.key === key ? { ...old, loading: true } : { key, loading: true },
    );
    (async () => {
      for (let attempt = 0; ; attempt++) {
        const preset = await request<RecordData>(
          `${tenantPath(tenant)}/presets/${presetId}`,
          { signal },
        );
        try {
          const page = await request<RecordData[]>(
            `${tenantPath(tenant)}/presets/preview`,
            {
              method: "POST",
              csrf,
              signal,
              body: {
                preset_id: presetId,
                expected_revision: preset.data.revision,
                newest_first: true,
                limit: rows,
              },
            },
          );
          const applied = page.meta?.applied as
            { definition?: { columns?: unknown } } | undefined;
          const saved = applied?.definition?.columns ?? preset.data.columns;
          const total = page.meta?.total;
          return {
            preset: preset.data,
            rows: Array.isArray(page.data) ? page.data : [],
            columns: Array.isArray(saved) ? saved.map(String) : undefined,
            total:
              typeof total === "string" || typeof total === "number"
                ? String(total)
                : undefined,
          };
        } catch (failure) {
          if (
            attempt === 0 &&
            failure instanceof ApiError &&
            failure.status === 409 &&
            failure.code === "preset_changed"
          )
            continue;
          throw failure;
        }
      }
    })().then(
      (result) => {
        if (!signal.aborted) setState({ key, loading: false, ...result });
      },
      (failure) => {
        if (signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status))
          onDenied.current();
        setState((old) => ({
          ...(old.key === key ? old : { key }),
          loading: false,
          error: failure,
        }));
      },
    );
    return () => controller.abort();
  }, [key, tenant, presetId, rows, csrf, refreshKey]);
  return state.key === key ? state : ({ key, loading: true } as Latest);
}

/** Column widths for fitting; the Alert column takes the rest of the row. */
const WIDTHS: Record<string, number> = {
  severity: 84,
  display_status: 116,
  timestamp: 108,
  last_received_at: 108,
  time_created: 108,
  first_received_at: 108,
  opened_at: 108,
  resolved_at: 108,
  assignee_id: 140,
  active_incident_id: 170,
};
const ALERT_MIN = 180,
  GAP = 12,
  INSET = 24;

/**
 * The preset's saved columns that fit `width`, in their saved order. Alert is
 * always kept (added first when the preset lacks it); other columns drop from
 * the right once one no longer fits.
 */
export function fittedColumns(saved: string[], width: number, kind?: string) {
  const columns = currentAlertColumns(saved, kind);
  const ordered = columns.includes("message")
    ? columns
    : ["message", ...columns];
  let used = INSET + ALERT_MIN;
  let full = false;
  return ordered.filter((field) => {
    if (field === "message") return true;
    if (full) return false;
    const next = used + GAP + (WIDTHS[field] ?? 120);
    if (next > width) {
      full = true;
      return false;
    }
    used = next;
    return true;
  });
}
const track = (field: string) =>
  field === "message"
    ? `minmax(${ALERT_MIN}px, 1fr)`
    : `${WIDTHS[field] ?? 120}px`;

/** The panel's body width, followed as the panel is resized. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function count(value: string | undefined) {
  return value !== undefined && decimal.test(value)
    ? BigInt(value).toLocaleString()
    : undefined;
}

/**
 * One alert table panel (REV-63): the latest alerts of its preset, newest first,
 * in the preset's saved columns. Rows open their alert; the title and footer open
 * the preset. It has no thresholds, so its top bar stays neutral.
 */
export function TableTile({
  scope,
  panel,
  title: shownTitle,
  refreshKey,
  paused,
  layoutControls,
  layoutActive,
  layoutStyle,
}: {
  scope: Scope;
  panel: TablePanel;
  /** Overrides the panel's own title, as the panel dialog's preview does. */
  title?: string;
  refreshKey?: unknown;
  paused?: boolean;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
}) {
  // Live updates refresh the rows unless the dashboard is paused.
  const [live, setLive] = useState(scope.version);
  useEffect(() => {
    if (!paused) setLive(scope.version);
  }, [paused, scope.version]);
  const latest = useLatestAlerts(
    scope,
    panel.preset_id,
    panel.rows,
    `${String(live)}:${String(refreshKey ?? "")}`,
  );
  const [body, width] = useWidth();
  const presetName =
    latest.preset && typeof latest.preset.name === "string"
      ? display(latest.preset.name)
      : undefined;
  const absent =
    latest.error instanceof ApiError && latest.error.status === 404;
  const title =
    shownTitle ??
    panel.title ??
    presetName ??
    (absent ? "Preset unavailable" : "Alert table");
  const presetHref = `/tenants/${scope.tenant.id}/presets/${panel.preset_id}?from=dashboard`;
  const columns = fittedColumns(
    latest.columns ?? ["severity", "message", "timestamp"],
    width || 600,
    scope.tenant.kind,
  );
  const grid = { gridTemplateColumns: columns.map(track).join(" ") };
  const rows = latest.rows;
  const total = count(latest.total);
  const shown = rows?.length ?? 0;
  let content: ReactNode;
  if (rows === undefined) {
    content = (
      <p className="small muted pnt-state" role="status">
        {latest.error
          ? absent
            ? "Unavailable · the preset was deleted"
            : "Alerts unavailable. Refresh to try again."
          : "Loading alerts…"}
      </p>
    );
  } else if (!rows.length) {
    content = (
      <div className="pnt-empty">
        <b>No alerts match this preset</b>
        <span>New alerts appear here as they arrive.</span>
      </div>
    );
  } else {
    content = (
      <div
        className="pnt"
        role="table"
        aria-label={`Latest alerts in ${title}`}
        aria-busy={latest.loading}
      >
        <div role="row" className="row head" style={grid}>
          {columns.map((field) => (
            <span role="columnheader" key={field}>
              {field === "message"
                ? "Alert"
                : field === "timestamp"
                  ? `${fieldLabel(field)} ↓`
                  : fieldLabel(field)}
            </span>
          ))}
        </div>
        {rows.map((row) => {
          const name = alertTitle(row);
          return (
            <div
              role="row"
              key={row.id}
              className={`row arow ${row.status === "resolved" ? "r-res" : ""}`}
              style={grid}
            >
              {columns.map((field) => (
                <span
                  role="cell"
                  key={field}
                  className={field === "message" ? "pnt-alert" : "cell"}
                >
                  {field === "message" ? (
                    <>
                      <NavLink
                        scope={scope}
                        className="msg"
                        href={`/tenants/${scope.tenant.id}/alerts/${row.id}`}
                        title={name}
                      >
                        {name}
                      </NavLink>
                      <SuppressedChip alert={row} />
                    </>
                  ) : (
                    <AlertField field={field} row={row} scope={scope} />
                  )}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <article
      className={`pn pn-table ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={title}
      data-layout-panel={panel.id}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
        ...layoutStyle,
      }}
    >
      <span className="pn-head">
        <NavLink scope={scope} href={presetHref} className="pn-title pn-link">
          {title}
        </NavLink>
        <span style={{ flexGrow: 1 }} />
        <span className="pnt-meta">
          Latest {panel.rows.toLocaleString()} · newest first
        </span>
        <PanelLinkButton link={panel.link} inactive={layoutActive} />
      </span>
      {/* The preset line only adds something under a custom title, and needs room. */}
      {presetName && title !== presetName && panel.h >= 4 && (
        <span className="sub">Preset: {presetName}</span>
      )}
      <div className="pnt-body" ref={body}>
        {content}
      </div>
      {rows !== undefined && rows.length > 0 && (
        <div className="pnt-foot">
          <span>
            {total !== undefined
              ? `Showing ${shown.toLocaleString()} of ${total} matching alerts`
              : `Showing ${shown.toLocaleString()} alerts`}
          </span>
          <span style={{ flexGrow: 1 }} />
          <NavLink scope={scope} href={presetHref}>
            Open preset
          </NavLink>
        </div>
      )}
      {layoutControls}
    </article>
  );
}
