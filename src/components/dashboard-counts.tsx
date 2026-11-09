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
import { TableTile } from "./dashboard-table-panel";

interface PanelLayout {
  id: string;
  title?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
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
export type Panel = CountPanel | HtmlPanel | ImagePanel | TablePanel;
export const isHtmlPanel = (panel: Panel): panel is HtmlPanel =>
  panel.type === "html";
export const isImagePanel = (panel: Panel): panel is ImagePanel =>
  panel.type === "image";
export const isTablePanel = (panel: Panel): panel is TablePanel =>
  panel.type === "table";
export const isCountPanel = (panel: Panel): panel is CountPanel =>
  (panel.type ?? "count") === "count";
export const countPanels = (panels: Panel[]) => panels.filter(isCountPanel);
/** The name of a panel without a counted preset to name it. */
export const contentPanelName = (panel: Panel) =>
  isHtmlPanel(panel)
    ? "HTML panel"
    : isImagePanel(panel)
      ? "Image panel"
      : isTablePanel(panel)
        ? "Alert table"
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
  count?: string;
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
};
const decimal = /^(0|[1-9]\d*)$/;
const panelsOf = (definition: RecordData) =>
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
}: {
  scope: Scope;
  panel: CountPanel;
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
}) {
  const threshold = thresholdFor(value, panel.thresholds);
  const tone = threshold?.color ?? "none";
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
      className={`pn pn-${tone} ${isStale ? "pn-stale" : ""} ${selected ? "pn-selected" : ""} ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={`${title} count`}
      data-layout-panel={panel.id}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
        ...layoutStyle,
      }}
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
      </span>
      {presetName && (panel.title || panel.h >= 3) && (
        <span className="sub">Preset: {presetName}</span>
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
      {panel.title && (
        <span className="pn-head">
          <span className="pn-title">{panel.title}</span>
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
      {layoutControls}
    </article>
  );
}

/** Count engine plus transient fullscreen state for one open dashboard. */
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
  return { ...counts, refresh, refreshed, fullscreen, setFullscreen, trigger };
}
export type DashboardModel = ReturnType<typeof useDashboard>;

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
  draftPanels,
  editing,
}: {
  scope: Scope;
  model: DashboardModel;
  draftPanels?: Panel[];
  editing?: {
    disabled: boolean;
    onChange: (panels: Panel[]) => void;
    options: (panel: Panel) => ReactNode;
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
      presetName ??
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
              (isCountPanel(panel)
                ? names.get(panel.preset_id)
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
