"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  count,
  display,
  request,
  tenantPath,
  timestamp,
  type RecordData,
} from "@/lib/api";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { NavLink } from "./page";

export interface Panel {
  id: string;
  preset_id: string;
  title?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  thresholds?: { lower_bound: string; color: string }[];
}
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
  const panels = panelsOf(definition);
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

const COLOR_NAMES: Record<string, string> = {
  red: "Red",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
};

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
}: {
  scope: Scope;
  panel: Panel;
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
}) {
  const threshold = thresholdFor(value, panel.thresholds);
  const tone = threshold?.color ?? "none";
  const isStale = Boolean(stale && value !== undefined);
  const size = panel.h >= 3 ? "fs-l" : "fs-m";
  return (
    <article
      className={`pn pn-${tone} ${isStale ? "pn-stale" : ""} ${selected ? "pn-selected" : ""}`}
      aria-label={`${title} count`}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
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
        {isStale ? (
          <span className="chip b-dash">Stale</span>
        ) : threshold ? (
          <span className={`chip b-${threshold.color}`}>
            At least {count(threshold.lower_bound)} ·{" "}
            {COLOR_NAMES[threshold.color] ?? threshold.color}
          </span>
        ) : null}
      </span>
      {presetName && (panel.title || panel.h >= 3) && (
        <span className="sub">Preset: {presetName}</span>
      )}
      <span style={{ flexGrow: 1 }} />
      <b className={`${size} ${value === undefined ? "pn-none-value" : ""}`}>
        {value !== undefined && decimal.test(value)
          ? BigInt(value).toLocaleString()
          : "—"}
      </b>
      <span className={`small ${isStale ? "ack-n" : "muted"}`}>
        {placeholder
          ? placeholder
          : unavailable !== undefined
            ? unavailable
            : value === undefined
              ? "Count unavailable"
              : isStale
                ? `Previous observation · stale${capturedAt ? ` · captured ${timestamp(capturedAt)}` : ""}`
                : paused
                  ? "Captured observation · paused"
                  : "Exact logical alerts"}
      </span>
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
  return { ...counts, fullscreen, setFullscreen, trigger };
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

function Provenance({
  batch,
  names,
}: {
  batch: Batch;
  names: Map<string, string>;
}) {
  const known = new Set([
    "observation_id",
    "dashboard_revision",
    "evaluated_at",
    "preset_revisions",
    "relative",
    "updating",
    "updating_suppression",
    "panels",
  ]);
  const extra = Object.entries(batch).filter(
    ([key, value]) =>
      !known.has(key) &&
      (typeof value === "string" || typeof value === "number"),
  );
  return (
    <section className="panel db-provenance" aria-label="Count provenance">
      <dl>
        <div className="fld">
          <dt>Captured at</dt>
          <dd className="mono">
            {timestamp(batch.evaluated_at)}{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </dd>
        </div>
        <div className="fld">
          <dt>Dashboard revision</dt>
          <dd>{batch.dashboard_revision}</dd>
        </div>
        <div className="fld">
          <dt>Observation</dt>
          <dd className="mono">{batch.observation_id}</dd>
        </div>
        <div className="fld">
          <dt>Relative time</dt>
          <dd>
            {batch.relative === undefined
              ? "Unknown"
              : batch.relative
                ? "Refreshes each second"
                : "Static query"}
          </dd>
        </div>
        <div className="fld">
          <dt>Index state</dt>
          <dd>
            {batch.updating || batch.updating_suppression
              ? "Updating"
              : "Caught up"}
          </dd>
        </div>
        {extra.map(([key, value]) => (
          <div className="fld" key={key}>
            <dt>{key.replaceAll("_", " ")}</dt>
            <dd className="mono">{display(value)}</dd>
          </div>
        ))}
        <div className="fld db-prov-presets">
          <dt>Preset revisions counted</dt>
          <dd>
            {Object.entries(batch.preset_revisions ?? {}).length
              ? Object.entries(batch.preset_revisions)
                  .map(
                    ([id, revision]) =>
                      `${names.get(id) ?? id} · revision ${revision}`,
                  )
                  .join("; ")
              : "None"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Reference S15 body: status line with count provenance, the 12-column panel
 * grid and the fullscreen modal. Page-level actions drive `model`.
 */
export function DashboardBoard({
  scope,
  model,
}: {
  scope: Scope;
  model: DashboardModel;
}) {
  const { state, paused, pause, refresh, fullscreen, setFullscreen, trigger } =
    model;
  const [provenance, setProvenance] = useState(false);
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
  const panels = panelsOf(definition);
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
      <div className="db-status">
        <span className="db-status-text">
          <b>
            {scope.tenant.name} ·{" "}
            <span className="db-status-word" title={updateDetail}>
              {word}
            </span>
          </b>
          {batch ? (
            <>
              {" "}
              · captured at{" "}
              <span className="mono">{timestamp(batch.evaluated_at)}</span>{" "}
              {Intl.DateTimeFormat().resolvedOptions().timeZone} · dashboard
              revision {batch.dashboard_revision}
            </>
          ) : state.loading ? (
            " · counting…"
          ) : null}
        </span>
        {panels.length > 0 && (
          <span className="db-status-hint">
            <span aria-hidden="true">·</span>
            <span>Click a panel to open its preset</span>
          </span>
        )}
        {batch && (
          <button
            type="button"
            className="btn btn-sm btn-g"
            aria-expanded={provenance}
            onClick={() => setProvenance((value) => !value)}
          >
            Count provenance
          </button>
        )}
      </div>
      <p role="status" className="sr-only">
        {state.announcement}
      </p>
      {provenance && batch && <Provenance batch={batch} names={names} />}
      <ErrorNotice error={state.error} />
      {batch?.relative === undefined && batch && (
        <p className="banner bn-warn">
          Relative-time refresh metadata is unavailable. Refresh counts
          explicitly.
        </p>
      )}
      {panels.length ? (
        <div className="pg" aria-busy={state.loading}>
          {panels.map((panel) => {
            const observation = batch?.panels.find(
              (item) => item.panel_id === panel.id,
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
              (code === "preset_unavailable"
                ? "Preset unavailable"
                : "Open preset");
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
                stale={stale}
                paused={paused}
                capturedAt={batch?.evaluated_at}
                href={`/tenants/${scope.tenant.id}/presets/${panel.preset_id}?from=dashboard`}
              />
            );
          })}
        </div>
      ) : (
        <div className="panel db-empty">
          <h2>This dashboard has no panels</h2>
          <p>Edit the dashboard to add panels that count saved presets.</p>
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
              <button type="button" className="btn" onClick={pause}>
                {paused ? "Resume updates" : "Pause updates"}
              </button>
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
