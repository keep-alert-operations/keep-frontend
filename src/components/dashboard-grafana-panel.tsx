"use client";
import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useResource } from "@/lib/hooks";
import {
  checkGrafanaAddress,
  framedSrc,
  grafanaStatusPath,
  type GrafanaCheck,
  type GrafanaPanelStatus,
} from "@/lib/grafana-panel";
import type { Scope } from "./workspace";
import { PanelLinkButton } from "./dashboard-panel-link";
import type { GrafanaPanel } from "./dashboard-counts";

export const GRAFANA_STATUS_FAILED =
  "Keep couldn't check which Grafana is allowed. Reload the page to try again.";
/** The tenant's Grafana panel status, or "failed" when it couldn't be read. */
export type GrafanaStatus = GrafanaPanelStatus | "failed" | undefined;

const checkedStatus = (value: unknown): GrafanaPanelStatus | undefined => {
  const item = value as Partial<GrafanaPanelStatus> | undefined;
  if (
    !item ||
    typeof item.enabled !== "boolean" ||
    !Array.isArray(item.origins) ||
    !item.origins.every(
      (entry) =>
        entry &&
        typeof entry.origin === "string" &&
        typeof entry.path_prefix === "string",
    )
  )
    return undefined;
  return { enabled: item.enabled, origins: item.origins };
};

/**
 * Which Grafana addresses this tenant's panels may frame, read once per view while
 * `wanted`. A response that doesn't match the contract counts as a failure.
 */
export function useGrafanaStatus(scope: Scope, wanted: boolean): GrafanaStatus {
  const resource = useResource<GrafanaPanelStatus>(
    wanted ? grafanaStatusPath(scope.tenant.id) : null,
    scope.onDenied,
  );
  if (resource.data) return checkedStatus(resource.data.data) ?? "failed";
  return resource.error ? "failed" : undefined;
}

function subscribeTheme(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
/** The viewer's Keep theme, following the theme switch while the page is open. */
export function useKeepTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeTheme,
    () =>
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    () => "light",
  );
}

const lock = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const chart = (path: string) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);
export const GRAFANA_ICON_PATH = "M4 4h16v16H4zM4 15l4.5-4.5 3.5 3 3.5-5L20 13";

/** The loading placeholder: the panel keeps its size, so the board doesn't move. */
function Loading() {
  return (
    <div className="pn-gf-msg pn-gf-loading" aria-busy="true">
      <span className="pn-gf-skel" style={{ width: "46%", height: 12 }} />
      <span className="pn-gf-skel" style={{ flex: "1 1 auto" }} />
      <span className="pn-gf-skel" style={{ width: "60%", height: 10 }} />
      <span role="status" className="pn-gf-status">
        Loading from Grafana…
      </span>
    </div>
  );
}

/**
 * One Grafana panel (REV-68): Grafana's own panel in a sandboxed frame, checked
 * against the allowed Grafana on every render before the frame exists. The frame
 * uses the viewer's Keep theme, refreshes on Grafana's schedule and is covered
 * while panels are moved or resized. Untitled panels give the frame the whole card.
 */
export function GrafanaTile({
  panel,
  status,
  check: given,
  preview,
  emptyText,
  onEdit,
  layoutControls,
  layoutActive,
  layoutStyle,
}: {
  panel: GrafanaPanel;
  status: GrafanaStatus;
  /** The dialog's check of what was typed, instead of checking `panel.url`. */
  check?: GrafanaCheck;
  /** In the panel dialog every problem shows as blocked. */
  preview?: boolean;
  emptyText?: string;
  /** Opens Edit panel; given to editors only. */
  onEdit?: () => void;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
}) {
  const theme = useKeepTheme();
  const [loaded, setLoaded] = useState<string>();
  const title = panel.title?.trim() || null;
  const failed = status === "failed";
  // Until the status arrives (and while rendering on the server) nothing is framed.
  const check: GrafanaCheck = given
    ? given
    : failed || status === undefined
      ? { state: "pending", snippet: false }
      : checkGrafanaAddress(panel.url ?? "", status);
  const src = check.state === "ok" ? framedSrc(check.url, theme) : undefined;
  const off =
    !preview &&
    check.state === "problem" &&
    status !== "failed" &&
    status !== undefined &&
    (!status.enabled || !status.origins.length);
  const state =
    failed && !given
      ? "blocked"
      : check.state === "ok"
        ? loaded === src
          ? "ready"
          : "loading"
        : check.state === "pending"
          ? "loading"
          : check.state === "empty"
            ? "empty"
            : off
              ? "off"
              : "blocked";
  const reason =
    check.state === "problem"
      ? check.problem
      : failed
        ? GRAFANA_STATUS_FAILED
        : "";
  const label = title ?? "Grafana panel";
  return (
    <article
      className={`pn pn-gf ${title ? "" : "pn-gf-bare"} ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={
        state === "blocked"
          ? `${label}, blocked`
          : state === "off"
            ? `${label}, Grafana panels are turned off`
            : label
      }
      aria-busy={state === "loading" || undefined}
      data-layout-panel={panel.id}
      data-grafana-state={state}
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
      <div className="pn-gf-box">
        {src && (
          // Grafana's origin, never Keep's (the check refuses Keep's own
          // pages); no top navigation, and no referrer leaves Keep.
          <iframe
            key={src}
            src={src}
            title={label}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
            onLoad={() => setLoaded(src)}
          />
        )}
        {state === "loading" && <Loading />}
        {state === "empty" && (
          <div className="pn-gf-msg pn-gf-quiet">
            {chart(GRAFANA_ICON_PATH)}
            <span>{emptyText}</span>
          </div>
        )}
        {state === "blocked" && (
          <div className="pn-gf-msg pn-gf-blocked">
            {lock}
            <strong>Grafana panel blocked</strong>
            <span className="pn-gf-reason">{reason}</span>
            {onEdit && (
              <button type="button" className="btn btn-sm" onClick={onEdit}>
                Edit panel
              </button>
            )}
          </div>
        )}
        {state === "off" && (
          <div className="pn-gf-msg pn-gf-quiet">
            {chart("M4 4h16v16H4zM4 4l16 16")}
            <strong>Grafana panels are turned off</strong>
            <span>
              An admin allows Grafana addresses in deployment configuration.
            </span>
          </div>
        )}
        {src && (
          // Shown only while a panel is moved or resized, so a frame can't
          // swallow the drag.
          <div className="pn-gf-cover" aria-hidden="true">
            <span>Paused while you move it</span>
          </div>
        )}
      </div>
      {!title && (
        <PanelLinkButton link={panel.link} floating inactive={layoutActive} />
      )}
      {layoutControls}
    </article>
  );
}
