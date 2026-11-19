"use client";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ApiError,
  display,
  request,
  tenantPath,
  timestamp,
  type RecordData,
} from "@/lib/api";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { NavLink, RelativeTime } from "./page";
import { DashboardLayout } from "./dashboard-layout";
import { compactPanels } from "@/lib/dashboard-layout";
import { sanitizePanelHtml } from "@/lib/panel-html";
import { thresholdColorCss } from "@/lib/threshold-colors";
import { TableTile } from "./dashboard-table-panel";
import {
  defaultTitle,
  queryKey,
  type Detection,
  type TicketState,
} from "@/lib/ticket-counts";
import {
  queryOf,
  ServiceNowTile,
  useTicketCounts,
} from "./dashboard-servicenow-panel";
import { PanelLinkButton } from "./dashboard-panel-link";
import { GrafanaTile, useGrafanaStatus } from "./dashboard-grafana-panel";
import type { PanelLink } from "@/lib/panel-link";
import {
  defaultIncidentTitle,
  statusLine,
  type IncidentStatus,
} from "@/lib/incident-counts";
import { DashboardAlarmStatus, PanelBell, useAlarm } from "./preset-alarm";

interface PanelLayout {
  id: string;
  title?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A button that opens this address in a new tab (REV-66). */
  link?: PanelLink | null;
}
/** A preset count panel; a panel without `type` is one (REV-57). */
export interface CountPanel extends PanelLayout {
  type?: "count";
  preset_id: string;
  thresholds?: { lower_bound: string; color: string }[];
}
/** A panel showing sanitized HTML; it references no preset (REV-57). */
export interface HtmlPanel extends PanelLayout {
  type: "html";
  html: string;
}
/** A panel showing an uploaded image or an https image address (REV-62). */
export interface ImagePanel extends PanelLayout {
  type: "image";
  image_id?: string | null;
  url?: string | null;
  fit?: "contain" | "cover";
  alt?: string | null;
}
/** A panel listing its preset's latest alerts, newest first (REV-63). */
export interface TablePanel extends PanelLayout {
  type: "table";
  preset_id: string;
  rows: number;
}
/** A panel counting a team's ServiceNow incidents through the API (REV-65). */
export interface ServiceNowPanel extends PanelLayout {
  type: "servicenow";
  team: string;
  ticket_state: TicketState;
  detection: Detection;
  thresholds?: { lower_bound: string; color: string }[];
}
/** One live panel framed from an allowed Grafana (REV-68). */
export interface GrafanaPanel extends PanelLayout {
  type: "grafana";
  url: string;
}
/** A panel counting the incidents its preset's alerts are in (REV-69). */
export interface IncidentCountPanel extends PanelLayout {
  type: "incident_count";
  preset_id: string;
  incident_status: IncidentStatus;
  thresholds?: { lower_bound: string; color: string }[];
}
export type Panel =
  | CountPanel
  | HtmlPanel
  | ImagePanel
  | TablePanel
  | ServiceNowPanel
  | GrafanaPanel
  | IncidentCountPanel;
export const isHtmlPanel = (panel: Panel): panel is HtmlPanel =>
  panel.type === "html";
export const isImagePanel = (panel: Panel): panel is ImagePanel =>
  panel.type === "image";
export const isTablePanel = (panel: Panel): panel is TablePanel =>
  panel.type === "table";
export const isServiceNowPanel = (panel: Panel): panel is ServiceNowPanel =>
  panel.type === "servicenow";
export const isGrafanaPanel = (panel: Panel): panel is GrafanaPanel =>
  panel.type === "grafana";
export const isCountPanel = (panel: Panel): panel is CountPanel =>
  (panel.type ?? "count") === "count";
export const isIncidentCountPanel = (
  panel: Panel,
): panel is IncidentCountPanel => panel.type === "incident_count";
/** Panels the dashboard's count batch counts: alert and incident counts (REV-69). */
export type CountedPanel = CountPanel | IncidentCountPanel;
export const isCountedPanel = (panel: Panel): panel is CountedPanel =>
  isCountPanel(panel) || isIncidentCountPanel(panel);
export const countPanels = (panels: Panel[]) => panels.filter(isCountedPanel);
/** A counted panel's title when it has none, from its preset's name. */
export const countedTitle = (panel: CountedPanel, presetName?: string) =>
  presetName === undefined
    ? undefined
    : isIncidentCountPanel(panel)
      ? defaultIncidentTitle(presetName)
      : presetName;
/** The name of a panel without a counted preset to name it. */
export const contentPanelName = (panel: Panel) =>
  isHtmlPanel(panel)
    ? "HTML panel"
    : isImagePanel(panel)
      ? "Image panel"
      : isTablePanel(panel)
        ? "Alert table"
        : isServiceNowPanel(panel)
          ? defaultTitle(panel.team)
          : isGrafanaPanel(panel)
            ? "Grafana panel"
            : "";
/** Where an image panel's picture loads from: the tenant's upload or the link. */
export const imageSource = (tenantId: string, panel: ImagePanel) =>
  panel.image_id
    ? `${tenantPath(tenantId)}/dashboard-images/${panel.image_id}`
    : (panel.url ?? "");
interface PanelCount {
  panel_id: string;
  preset_id: string;
  preset_name?: string;
  /** The preset's saved alarm flag, read with the counted revision (REV-78). */
  preset_noisy?: boolean;
  count?: string;
  /** Incident count panels: matching alerts and those in a counted incident (REV-69). */
  alerts?: string;
  linked_alerts?: string;
  error?: unknown;
}
interface Batch {
  observation_id: string;
  dashboard_revision: string;
  evaluated_at: string;
  preset_revisions: Record<string, string>;
  relative?: boolean;
  updating: boolean;
  updating_suppression: boolean;
  panels: PanelCount[];
  [key: string]: unknown;
}
type Reason = "live" | "clock" | "manual" | "resume" | "definition" | "pause";
type State = {
  key: string;
  definition: RecordData;
  batch?: Batch;
  loading: boolean;
  updating?: boolean;
  error?: unknown;
  announcement?: string;
  /** The dashboard was deleted or is no longer readable; it stays silent (REV-78). */
  gone?: boolean;
};
const decimal = /^(0|[1-9]\d*)$/;
export const panelsOf = (definition: RecordData) =>
  Array.isArray(definition.panels) ? (definition.panels as Panel[]) : [];

function checkedBatch(value: Batch, definition: RecordData): Batch {
  const panels = countPanels(panelsOf(definition));
  if (
    !value ||
    value.dashboard_revision !== definition.revision ||
    typeof value.observation_id !== "string" ||
    typeof value.evaluated_at !== "string" ||
    !Number.isFinite(Date.parse(value.evaluated_at)) ||
    (value.relative !== undefined && typeof value.relative !== "boolean") ||
    !Array.isArray(value.panels) ||
    value.panels.length !== panels.length ||
    new Set(value.panels.map((panel) => panel?.panel_id)).size !==
      panels.length ||
    !value.panels.every((panel) => {
      const expected = panels.find((item) => item.id === panel?.panel_id);
      return (
        expected &&
        expected.preset_id === panel.preset_id &&
        (panel.error !== undefined ||
          (typeof panel.count === "string" && decimal.test(panel.count)))
      );
    })
  )
    throw new ApiError(
      502,
      "invalid_response",
      "The count batch does not match its dashboard context.",
    );
  return value;
}

export function useCounts(
  scope: Scope,
  dashboard: RecordData,
  onDefinitionChanged: () => void,
) {
  const key = JSON.stringify([
    scope.tenant.id,
    scope.tenant.revision,
    scope.tenant.role,
    scope.session.principal.id,
    scope.session.csrf_token,
    dashboard.id,
  ]);
  const latest = useRef({ scope, dashboard, onDefinitionChanged });
  latest.current = { scope, dashboard, onDefinitionChanged };
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [state, setState] = useState<State>({
    key,
    definition: dashboard,
    loading: true,
  });
  const enqueue = useRef<(reason: Reason) => void>(() => {});
  const currentDefinition = useRef(dashboard);
  const context = useRef(key);
  context.current = key;
  useEffect(() => {
    let stopped = false,
      busy = false,
      pending: Reason | undefined;
    let relative = false,
      blocked = false,
      lastAnnounced = 0;
    let active: AbortController | undefined;
    currentDefinition.current = latest.current.dashboard;
    setState({ key, definition: currentDefinition.current, loading: false });
    function valid(controller: AbortController) {
      return !stopped && !controller.signal.aborted && context.current === key;
    }
    function queue(reason: Reason) {
      if (stopped) return;
      if (reason === "pause") {
        pending = "resume";
        active?.abort();
        return;
      }
      if (reason === "clock" && (!relative || blocked)) return;
      if (
        document.visibilityState !== "visible" ||
        (pausedRef.current && reason !== "manual")
      ) {
        pending = reason;
        return;
      }
      if (busy) {
        if (!pending || reason !== "clock") pending = reason;
        return;
      }
      pending = undefined;
      void run(reason);
    }
    async function run(reason: Reason) {
      busy = true;
      const controller = new AbortController();
      active = controller;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 25000);
      setState((old) => ({
        ...old,
        key,
        definition: currentDefinition.current,
        loading: true,
        error: undefined,
        updating: false,
      }));
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const definition = currentDefinition.current;
          const { scope: current } = latest.current;
          if (!countPanels(panelsOf(definition)).length) {
            // Only count panels are counted, so there is nothing to request.
            relative = false;
            setState({ key, definition, loading: false });
            return;
          }
          try {
            const response = await request<Batch>(
              `${tenantPath(current.tenant.id)}/dashboards/${definition.id}/counts`,
              {
                method: "POST",
                body: { expected_revision: definition.revision },
                csrf: current.session.csrf_token,
                signal: controller.signal,
              },
            );
            if (!valid(controller)) return;
            const batch = checkedBatch(response.data, definition);
            if (currentDefinition.current.revision !== definition.revision) {
              pending = "definition";
              return;
            }
            relative = batch.relative === true;
            blocked = false;
            const announce =
              reason === "manual" || Date.now() - lastAnnounced >= 30000;
            if (announce) lastAnnounced = Date.now();
            setState((old) => ({
              key,
              definition,
              batch,
              loading: false,
              announcement: announce
                ? `Dashboard updated at ${timestamp(batch.evaluated_at)}.`
                : old.announcement,
            }));
            return;
          } catch (failure) {
            if (!valid(controller)) throw failure;
            if (
              !(failure instanceof ApiError) ||
              failure.status !== 409 ||
              attempt === 1
            )
              throw failure;
            const fresh = await request<RecordData>(
              `${tenantPath(current.tenant.id)}/dashboards/${definition.id}`,
              { signal: controller.signal },
            );
            if (!valid(controller)) return;
            if (
              !fresh.data ||
              fresh.data.id !== definition.id ||
              typeof fresh.data.revision !== "string" ||
              !decimal.test(fresh.data.revision) ||
              !Array.isArray(fresh.data.panels)
            )
              throw new ApiError(
                502,
                "invalid_response",
                "The refreshed dashboard definition is unavailable.",
              );
            if (
              BigInt(fresh.data.revision) >=
              BigInt(currentDefinition.current.revision)
            )
              currentDefinition.current = fresh.data;
            setState((old) => ({
              ...old,
              definition: currentDefinition.current,
            }));
            latest.current.onDefinitionChanged();
          }
        }
      } catch (failure) {
        if (
          stopped ||
          context.current !== key ||
          (controller.signal.aborted && !timedOut)
        )
          return;
        const denied =
          failure instanceof ApiError && [401, 403].includes(failure.status);
        const absent = failure instanceof ApiError && failure.status === 404;
        blocked = failure instanceof ApiError && failure.status === 409;
        if (blocked) pending = undefined;
        if (denied) latest.current.scope.onDenied();
        if (absent) latest.current.onDefinitionChanged();
        setState((old) => ({
          ...old,
          batch: denied || absent ? undefined : old.batch,
          gone: denied || absent || old.gone,
          loading: false,
          updating: blocked,
          error: blocked
            ? undefined
            : timedOut
              ? new Error(
                  "Count refresh timed out. Refresh explicitly to try again.",
                )
              : failure,
        }));
      } finally {
        clearTimeout(timeout);
        if (active === controller) active = undefined;
        busy = false;
        if (!stopped && context.current === key) {
          setState((old) => ({ ...old, loading: false }));
          if (
            pending &&
            (!pausedRef.current || pending === "manual") &&
            document.visibilityState === "visible"
          ) {
            const next = pending;
            pending = undefined;
            queue(next);
          }
        }
      }
    }
    enqueue.current = queue;
    function visibility() {
      if (document.visibilityState === "visible") queue("resume");
      else {
        pending = "resume";
        active?.abort();
      }
    }
    document.addEventListener("visibilitychange", visibility);
    const clock = setInterval(() => queue("clock"), 1000);
    queue("definition");
    return () => {
      stopped = true;
      active?.abort();
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
      enqueue.current = () => {};
    };
  }, [key]);
  useEffect(() => {
    if (
      currentDefinition.current.revision !== dashboard.revision &&
      BigInt(dashboard.revision) > BigInt(currentDefinition.current.revision)
    ) {
      currentDefinition.current = dashboard;
      enqueue.current("definition");
    }
  }, [dashboard]);
  const lastVersion = useRef(scope.version);
  useEffect(() => {
    if (lastVersion.current !== scope.version) {
      lastVersion.current = scope.version;
      enqueue.current("live");
    }
  }, [scope.version]);
  function pause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    enqueue.current(pausedRef.current ? "pause" : "resume");
  }
  return {
    state:
      state.key === key
        ? state
        : ({ key, definition: dashboard, loading: true } as State),
    paused,
    pause,
    refresh: () => enqueue.current("manual"),
  };
}

/** Highest threshold whose exact lower bound the count reaches. */
export function thresholdFor(
  value: string | undefined,
  thresholds: { lower_bound: string; color: string }[] | undefined,
) {
  return typeof value === "string" && decimal.test(value)
    ? [...(thresholds ?? [])]
        .reverse()
        .find(
          (item) =>
            decimal.test(item.lower_bound) &&
            BigInt(value) >= BigInt(item.lower_bound),
        )
    : undefined;
}

/**
 * One reference count panel (S15). The panel title is a link stretched over
 * the whole card so the entire panel opens its preset.
 */
export function CountTile({
  scope,
  panel,
  title,
  presetName,
  value,
  unavailable,
  stale,
  paused,
  capturedAt,
  href,
  onSelect,
  selected,
  placeholder,
  layoutControls,
  layoutActive,
  layoutStyle,
  bell,
}: {
  scope: Scope;
  panel: CountedPanel;
  title: string;
  presetName?: string;
  value?: string;
  unavailable?: string;
  stale?: boolean;
  paused?: boolean;
  capturedAt?: string;
  href?: string;
  onSelect?: () => void;
  selected?: boolean;
  placeholder?: string;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
  /** A noisy panel's alarm bell, at the end of the title row (REV-78). */
  bell?: ReactNode;
}) {
  const threshold = thresholdFor(value, panel.thresholds);
  const tone = threshold?.color;
  const isStale = Boolean(stale && value !== undefined);
  const shown =
    value !== undefined && decimal.test(value)
      ? BigInt(value).toLocaleString()
      : "—";
  // A fresh, live count needs no caption; only exceptional states explain it.
  const status =
    unavailable !== undefined ? (
      unavailable
    ) : placeholder ? (
      placeholder
    ) : value === undefined ? (
      "Count unavailable"
    ) : isStale ? (
      <>
        Previous observation · stale
        {capturedAt && (
          <>
            {" "}
            · captured <RelativeTime value={capturedAt} />
          </>
        )}
      </>
    ) : paused ? (
      "Captured observation · paused"
    ) : null;
  return (
    <article
      className={`pn ${tone ? "pn-toned" : "pn-none"} ${isStale ? "pn-stale" : ""} ${selected ? "pn-selected" : ""} ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={`${title} count`}
      data-panel-type={
        isIncidentCountPanel(panel) ? "incident_count" : undefined
      }
      data-layout-panel={panel.id}
      data-threshold-color={tone}
      style={
        {
          gridColumn: `${panel.x + 1} / span ${panel.w}`,
          gridRow: `${panel.y + 1} / span ${panel.h}`,
          ...(tone ? { "--pn-tone": thresholdColorCss(tone) } : {}),
          ...layoutStyle,
        } as CSSProperties
      }
    >
      <span className="pn-head">
        {href ? (
          <NavLink scope={scope} href={href} className="pn-title pn-link">
            {title}
          </NavLink>
        ) : onSelect ? (
          <button
            type="button"
            className="pn-title pn-link"
            aria-pressed={selected}
            onClick={onSelect}
          >
            {title}
          </button>
        ) : (
          <span className="pn-title">{title}</span>
        )}
        <span style={{ flexGrow: 1 }} />
        {isStale && <span className="chip b-dash">Stale</span>}
        <PanelLinkButton link={panel.link} inactive={layoutActive} />
        {bell}
      </span>
      {isIncidentCountPanel(panel) ? (
        // An incident count always says what it counts (REV-69).
        <span className="sub">
          {presetName ? `${presetName} · ` : ""}
          {statusLine(panel.incident_status)}
        </span>
      ) : (
        presetName &&
        (panel.title || panel.h >= 3) && (
          <span className="sub">Preset: {presetName}</span>
        )
      )}
      {/* The number is centered in the space left and scales with the panel. */}
      <span className="pn-value">
        <b
          className={value === undefined ? "pn-none-value" : undefined}
          style={{ "--pn-chars": shown.length } as CSSProperties}
        >
          {shown}
        </b>
      </span>
      {status !== null && (
        <span className={`small ${isStale ? "ack-n" : "muted"}`}>{status}</span>
      )}
      {layoutControls}
    </article>
  );
}

/** One HTML panel: its title, if any, above the sanitized content. */
export function HtmlTile({
  panel,
  layoutControls,
  layoutActive,
  layoutStyle,
}: {
  panel: HtmlPanel;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
}) {
  const [html, setHtml] = useState("");
  // DOMPurify needs the browser DOM, so the content renders after mounting.
  useEffect(() => setHtml(sanitizePanelHtml(panel.html)), [panel.html]);
  return (
    <article
      className={`pn pn-html ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={panel.title ?? "HTML panel"}
      data-layout-panel={panel.id}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
        ...layoutStyle,
      }}
    >
      {/* Without a title, a slim row holds only the link button (REV-66). */}
      {(panel.title || panel.link) && (
        <span className="pn-head">
          {panel.title && <span className="pn-title">{panel.title}</span>}
          <span style={{ flexGrow: 1 }} />
          <PanelLinkButton link={panel.link} inactive={layoutActive} />
        </span>
      )}
      <div
        className="pn-html-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {layoutControls}
    </article>
  );
}

/**
 * The picture of an image panel with its loading and unavailable states (REV-62).
 * `src` may be a local preview; links load with no referrer.
 */
export function PanelImage({
  src,
  link,
  fit,
  alt,
  emptyText,
  onStatus,
}: {
  src: string;
  link?: string | null;
  fit?: "contain" | "cover";
  alt: string;
  /** Shown when there is no source yet, instead of "Image unavailable". */
  emptyText?: string;
  onStatus?: (status: "loading" | "ready" | "failed") => void;
}) {
  const [state, setState] = useState<{
    src: string;
    status: "loading" | "ready" | "failed";
  }>({ src, status: "loading" });
  const status = state.src === src ? state.status : "loading";
  const reported = useRef(onStatus);
  reported.current = onStatus;
  useEffect(() => reported.current?.(status), [status]);
  return (
    <div className="pn-img-box" data-image-state={status}>
      {src && status !== "failed" && (
        // eslint-disable-next-line @next/next/no-img-element -- tenant uploads and arbitrary links
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          decoding="async"
          draggable={false}
          style={{ objectFit: fit ?? "contain" }}
          onLoad={() => setState({ src, status: "ready" })}
          onError={() => setState({ src, status: "failed" })}
        />
      )}
      {status === "loading" && src && (
        <span className="pn-img-state">Loading image…</span>
      )}
      {!src && emptyText && <span className="pn-img-state">{emptyText}</span>}
      {(status === "failed" || (!src && !emptyText)) && (
        <span className="pn-img-state pn-img-failed">
          <b>Image unavailable</b>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer">
              Open link
            </a>
          )}
        </span>
      )}
    </div>
  );
}

/** One image panel: its title, if any, above the picture; without one the picture fills it. */
export function ImageTile({
  tenantId,
  panel,
  src,
  emptyText,
  onStatus,
  layoutControls,
  layoutActive,
  layoutStyle,
}: {
  tenantId: string;
  panel: ImagePanel;
  /** A local preview to show instead of the stored source. */
  src?: string;
  emptyText?: string;
  onStatus?: (status: "loading" | "ready" | "failed") => void;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
}) {
  // Drafts hold "" for a cleared title or description; treat it as none.
  const title = panel.title?.trim() || null;
  const label = title ?? "Image panel";
  return (
    <article
      className={`pn pn-img ${title ? "" : "pn-img-bare"} ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={label}
      data-layout-panel={panel.id}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
        ...layoutStyle,
      }}
    >
      {title && (
        <span className="pn-head">
          <span className="pn-title">{title}</span>
          <span style={{ flexGrow: 1 }} />
          <PanelLinkButton link={panel.link} inactive={layoutActive} />
        </span>
      )}
      <PanelImage
        src={src ?? imageSource(tenantId, panel)}
        link={panel.image_id ? undefined : panel.url}
        fit={panel.fit}
        alt={panel.alt?.trim() || label}
        emptyText={emptyText}
        onStatus={onStatus}
      />
      {/* Without a title the button floats over the image (REV-66). */}
      {!title && (
        <PanelLinkButton link={panel.link} floating inactive={layoutActive} />
      )}
      {layoutControls}
    </article>
  );
}

/** What an alert table panel last knew about its preset's alarm (REV-78). */
export interface TableAlarmReport {
  noisy: boolean;
  alerts: boolean;
  total?: string;
}
/**
 * A dashboard view's alarm memory (REV-78): the panels muted in this tab and the
 * table panels' last reports, keyed by panel and preset. It lives with the view,
 * not the tiles, because fullscreen remounts every tile.
 */
interface AlarmMemory {
  dashboard: string;
  muted: ReadonlySet<string>;
  tables: ReadonlyMap<string, TableAlarmReport>;
}
/**
 * Mutes last for the browser tab (REV-78): leaving a dashboard and coming back,
 * for example through a panel's link, keeps them, and a reload starts unmuted.
 * Keyed by tenant and dashboard; nothing is sent or stored.
 */
const tabMutes = new Map<string, ReadonlySet<string>>();
const alarmMemory = (dashboard: string): AlarmMemory => ({
  dashboard,
  muted: tabMutes.get(dashboard) ?? new Set(),
  tables: new Map(),
});
export const tableAlarmKey = (panel: TablePanel) =>
  `${panel.id}\n${panel.preset_id}`;

/** Count engine plus transient fullscreen and alarm state for one open dashboard. */
export function useDashboard(
  scope: Scope,
  dashboard: RecordData,
  onDefinitionChanged: () => void,
) {
  const counts = useCounts(scope, dashboard, onDefinitionChanged);
  const [fullscreen, setFullscreen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Table panels read their own rows; Refresh counts reloads them too (REV-63).
  const [refreshed, setRefreshed] = useState(0);
  const refresh = () => {
    counts.refresh();
    setRefreshed((value) => value + 1);
  };
  // Mutes are per tab and per dashboard: nothing is sent or stored (REV-78).
  const id = `${scope.tenant.id}:${String(dashboard.id)}`;
  const [stored, setStored] = useState(() => alarmMemory(id));
  const memory = useMemo(
    () => (stored.dashboard === id ? stored : alarmMemory(id)),
    [stored, id],
  );
  useEffect(() => {
    tabMutes.set(memory.dashboard, memory.muted);
  }, [memory]);
  const alarm = useMemo(() => {
    const update = (change: (memory: AlarmMemory) => AlarmMemory) =>
      setStored((old) => change(old.dashboard === id ? old : alarmMemory(id)));
    return {
      memory,
      setMuted(panelIds: string[], muted: boolean) {
        update((old) => {
          const next = new Set(muted ? [...old.muted, ...panelIds] : []);
          if (!muted)
            for (const panelId of old.muted)
              if (!panelIds.includes(panelId)) next.add(panelId);
          return { ...old, muted: next };
        });
      },
      report(key: string, report: TableAlarmReport | null) {
        update((old) => {
          const before = old.tables.get(key);
          if (
            report === null
              ? before === undefined
              : before?.noisy === report.noisy &&
                before.alerts === report.alerts &&
                before.total === report.total
          )
            return old;
          const tables = new Map(old.tables);
          if (report === null) tables.delete(key);
          else tables.set(key, report);
          return { ...old, tables };
        });
      },
      /** Forget table reports for panels no longer on screen. */
      prune(keys: ReadonlySet<string>) {
        update((old) => {
          if ([...old.tables.keys()].every((key) => keys.has(key))) return old;
          return {
            ...old,
            tables: new Map([...old.tables].filter(([key]) => keys.has(key))),
          };
        });
      },
    };
  }, [memory, id]);
  return {
    ...counts,
    refresh,
    refreshed,
    fullscreen,
    setFullscreen,
    trigger,
    alarm,
  };
}
export type DashboardModel = ReturnType<typeof useDashboard>;

/** One noisy panel on screen and whether it has alerts (REV-78). */
interface AlarmEntry {
  id: string;
  alerts: boolean;
  count?: string;
}
const NO_MUTES: ReadonlySet<string> = new Set();

/**
 * The one alarm of a dashboard view (REV-78). `panels` are the panels on screen,
 * an unsaved draft included, so a panel deleted or pointed at another preset in a
 * draft stops its part at once. Alert count panels use the last count batch,
 * matched by panel and preset, so a loading or failed count keeps its last state;
 * table panels use their last report. Muted panels stay muted when their alerts
 * drop to zero and return. Call it once per view: it owns the audio element.
 */
export function useDashboardAlarm(
  model: DashboardModel | undefined,
  panels: Panel[],
  silenced = false,
) {
  const state = model?.state;
  const gone = silenced || !model || state?.gone === true;
  const batch = gone ? undefined : state?.batch;
  const memory = model?.alarm.memory;
  const entries: AlarmEntry[] = [];
  for (const panel of gone ? [] : panels) {
    if (isCountPanel(panel)) {
      const observation = batch?.panels.find(
        (item) =>
          item.panel_id === panel.id && item.preset_id === panel.preset_id,
      );
      if (observation?.preset_noisy !== true) continue;
      const count =
        observation.error === undefined &&
        typeof observation.count === "string" &&
        decimal.test(observation.count)
          ? observation.count
          : undefined;
      entries.push({
        id: panel.id,
        alerts: count !== undefined && BigInt(count) > BigInt(0),
        count,
      });
    } else if (isTablePanel(panel)) {
      const report = memory?.tables.get(tableAlarmKey(panel));
      if (report?.noisy)
        entries.push({
          id: panel.id,
          alerts: report.alerts,
          count: report.total,
        });
    }
  }
  const muted = memory?.muted ?? NO_MUTES;
  const sounding = entries.filter(
    (entry) => entry.alerts && !muted.has(entry.id),
  ).length;
  const sound = useAlarm(sounding > 0);
  const tableKeys = panels
    .filter(isTablePanel)
    .map(tableAlarmKey)
    .sort()
    .join("\t");
  const latest = useRef(model?.alarm);
  latest.current = model?.alarm;
  useEffect(() => {
    latest.current?.prune(new Set(tableKeys ? tableKeys.split("\t") : []));
  }, [tableKeys]);
  const ids = entries.map((entry) => entry.id);
  return {
    summary: entries.length
      ? {
          sound,
          sounding,
          mutedWithAlerts: entries.filter(
            (entry) => entry.alerts && muted.has(entry.id),
          ).length,
          anyMuted: entries.some((entry) => muted.has(entry.id)),
        }
      : undefined,
    /** The bell of a noisy panel on screen, or nothing for any other panel. */
    bell(panel: Panel, label: string) {
      const entry = entries.find((item) => item.id === panel.id);
      if (!entry || !model) return undefined;
      const isMuted = muted.has(entry.id);
      return (
        <PanelBell
          state={isMuted ? "muted" : entry.alerts ? "sounding" : "quiet"}
          label={label}
          count={entry.count}
          onToggle={() => model.alarm.setMuted([entry.id], !isMuted)}
        />
      );
    },
    muteAll: () => model?.alarm.setMuted(ids, true),
    unmuteAll: () => model?.alarm.setMuted(ids, false),
    report: (panel: TablePanel, report: TableAlarmReport | null) =>
      model?.alarm.report(tableAlarmKey(panel), report),
  };
}
export type DashboardAlarm = ReturnType<typeof useDashboardAlarm>;

function statusWord(scope: Scope, model: DashboardModel) {
  const { state, paused } = model;
  if (paused) return "Paused";
  if (state.error) return "Unavailable";
  if (state.batch?.updating_suppression) return "Updating suppression";
  if (
    state.loading ||
    state.updating ||
    state.batch?.updating ||
    scope.searchUpdating
  )
    return "Updating";
  return scope.liveStatus === "Live hints connected"
    ? "Live"
    : (scope.liveStatus ?? "Connecting");
}

/**
 * Reference S15 body: the 12-column panel grid and fullscreen modal.
 * Page-level actions drive `model`.
 */
export function DashboardBoard({
  scope,
  model,
  alarm,
  draftPanels,
  editing,
}: {
  scope: Scope;
  model: DashboardModel;
  /** The view's one alarm, from `useDashboardAlarm` over the same panels (REV-78). */
  alarm?: DashboardAlarm;
  draftPanels?: Panel[];
  editing?: {
    disabled: boolean;
    onChange: (panels: Panel[]) => void;
    options: (panel: Panel) => ReactNode;
    /** Opens Edit panel, as a blocked Grafana panel offers (REV-68). */
    edit?: (panelId: string) => void;
  };
}) {
  const { state, paused, refresh, fullscreen, setFullscreen, trigger } = model;
  const dialog = useRef<HTMLDialogElement>(null);
  const wasFullscreen = useRef(false);
  const titleId = useId();
  useEffect(() => {
    if (fullscreen) {
      dialog.current?.showModal();
      dialog.current
        ?.querySelector<HTMLButtonElement>("[data-exit-fullscreen]")
        ?.focus();
    } else {
      dialog.current?.close();
      if (wasFullscreen.current) trigger.current?.focus();
    }
    wasFullscreen.current = fullscreen;
  }, [fullscreen, trigger]);
  const definition = state.definition;
  const batch =
    state.batch?.dashboard_revision === definition.revision
      ? state.batch
      : undefined;
  const stale = !!state.error || state.updating;
  const names = new Map<string, string>();
  for (const item of batch?.panels ?? [])
    if (item.preset_name) names.set(item.preset_id, item.preset_name);
  const savedPanels = useMemo(
    () => compactPanels(panelsOf(definition)),
    [definition],
  );
  const panels = draftPanels ?? savedPanels;
  // ServiceNow panels, drafts included, get their counts in their own batch (REV-65).
  const tickets = useTicketCounts(scope, panels, model.refreshed, paused);
  // Grafana panels are framed, never counted; the allowed Grafana is read once
  // per dashboard view (REV-68).
  const grafana = useGrafanaStatus(scope, panels.some(isGrafanaPanel));
  const editable = editing && !fullscreen;
  function renderPanel(
    panel: Panel,
    controls?: ReactNode,
    active?: boolean,
    style?: CSSProperties,
  ) {
    const layoutControls = editable ? (
      <>
        {controls}
        {editing.options(panel)}
      </>
    ) : undefined;
    if (isHtmlPanel(panel))
      return (
        <HtmlTile
          key={panel.id}
          panel={panel}
          layoutControls={layoutControls}
          layoutActive={active}
          layoutStyle={style}
        />
      );
    if (isImagePanel(panel))
      return (
        <ImageTile
          key={panel.id}
          tenantId={scope.tenant.id}
          panel={panel}
          layoutControls={layoutControls}
          layoutActive={active}
          layoutStyle={style}
        />
      );
    if (isGrafanaPanel(panel)) {
      const edit = editable ? editing.edit : undefined;
      return (
        <GrafanaTile
          key={panel.id}
          panel={panel}
          status={grafana}
          onEdit={edit ? () => edit(panel.id) : undefined}
          layoutControls={layoutControls}
          layoutActive={active}
          layoutStyle={style}
        />
      );
    }
    if (isServiceNowPanel(panel))
      return (
        <ServiceNowTile
          key={panel.id}
          panel={panel}
          entry={tickets.get(queryKey(queryOf(panel)))}
          layoutControls={layoutControls}
          layoutActive={active}
          layoutStyle={style}
        />
      );
    if (isTablePanel(panel))
      return (
        <TableTile
          key={panel.id}
          scope={scope}
          panel={panel}
          refreshKey={model.refreshed}
          paused={paused}
          layoutControls={layoutControls}
          layoutActive={active}
          layoutStyle={style}
          bell={alarm && ((label) => alarm.bell(panel, label))}
          onAlarm={alarm && ((report) => alarm.report(panel, report))}
        />
      );
    const observation = batch?.panels.find(
      (item) =>
        item.panel_id === panel.id && item.preset_id === panel.preset_id,
    );
    const failed = observation?.error !== undefined;
    const value = failed ? undefined : observation?.count;
    const code =
      failed &&
      observation?.error &&
      typeof observation.error === "object" &&
      "code" in observation.error
        ? String((observation.error as { code: unknown }).code)
        : "";
    const presetName = observation?.preset_name;
    const title =
      panel.title ??
      countedTitle(panel, presetName) ??
      (code === "preset_unavailable" ? "Preset unavailable" : "Open preset");
    return (
      <CountTile
        key={panel.id}
        scope={scope}
        panel={panel}
        title={title}
        presetName={presetName}
        value={value}
        unavailable={
          failed
            ? code === "preset_unavailable"
              ? "Unavailable · the preset was deleted"
              : code === "incident_count_too_large"
                ? "Too many incidents to count"
                : "Unavailable"
            : undefined
        }
        placeholder={
          draftPanels && !observation
            ? "Save the dashboard to count this panel"
            : undefined
        }
        stale={stale}
        paused={paused}
        capturedAt={batch?.evaluated_at}
        href={`/tenants/${scope.tenant.id}/presets/${panel.preset_id}?from=dashboard`}
        layoutControls={layoutControls}
        layoutActive={active}
        layoutStyle={style}
        bell={alarm?.bell(panel, title)}
      />
    );
  }
  const word = statusWord(scope, model);
  const updateDetail = paused
    ? "Updates are paused. Showing the captured observation."
    : state.updating
      ? "The dashboard changed while refreshing. Refresh counts or wait for the next update."
      : batch?.updating_suppression
        ? "Suppression updates are still being applied."
        : batch?.updating || scope.searchUpdating
          ? "Search is catching up with the latest changes. Showing the captured counts."
          : state.loading
            ? "Refreshing counts. Showing the last captured observation until ready."
            : undefined;
  const content = (
    <>
      <span className="sr-only" data-dashboard-status>
        <span title={updateDetail}>{word}</span>
      </span>
      <p role="status" className="sr-only">
        {state.announcement}
      </p>
      <ErrorNotice error={state.error} />
      {batch?.relative === undefined && batch && (
        <p className="banner bn-warn">
          Relative-time refresh metadata is unavailable. Refresh counts
          explicitly.
        </p>
      )}
      {panels.length ? (
        editable ? (
          <DashboardLayout
            panels={panels}
            disabled={editing.disabled}
            label={(panel) =>
              panel.title ??
              (isCountedPanel(panel)
                ? countedTitle(panel, names.get(panel.preset_id))
                : contentPanelName(panel)) ??
              "Panel"
            }
            onChange={editing.onChange}
            onSelect={() => {}}
            renderPanel={renderPanel}
          />
        ) : (
          <div className="pg" aria-busy={state.loading}>
            {panels.map((panel) => renderPanel(panel))}
          </div>
        )
      ) : (
        <div className="panel db-empty">
          <h2>This dashboard has no panels</h2>
          <p>
            {editing
              ? "Create a panel to count or list a saved preset's alerts, or show your own notes or images."
              : "Panels created by editors appear here."}
          </p>
        </div>
      )}
    </>
  );
  return (
    <>
      {!fullscreen && content}
      <dialog
        ref={dialog}
        className="db-fullscreen"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          setFullscreen(false);
        }}
        onClose={() => setFullscreen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], summary, [tabindex="0"]',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        {fullscreen ? (
          <div className="db-fullscreen-body">
            <div className="db-fullscreen-bar">
              <h2 id={titleId}>{display(definition.name)}</h2>
              {alarm?.summary && (
                <DashboardAlarmStatus
                  summary={alarm.summary}
                  onMuteAll={alarm.muteAll}
                  onUnmuteAll={alarm.unmuteAll}
                />
              )}
              <span style={{ flexGrow: 1 }} />
              <button type="button" className="btn" onClick={refresh}>
                Refresh counts
              </button>
              <button
                type="button"
                className="btn"
                data-exit-fullscreen
                onClick={() => setFullscreen(false)}
              >
                Exit fullscreen
              </button>
            </div>
            {content}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
