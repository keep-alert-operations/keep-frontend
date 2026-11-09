"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ApiError } from "@/lib/api";
import { thresholdColorCss } from "@/lib/threshold-colors";
import {
  defaultTitle,
  fetchTicketCounts,
  filterLine,
  queryKey,
  unavailable,
  type TicketQuery,
  type TicketResult,
} from "@/lib/ticket-counts";
import type { Scope } from "./workspace";
import { PanelLinkButton } from "./dashboard-panel-link";
import {
  isServiceNowPanel,
  thresholdFor,
  type Panel,
  type ServiceNowPanel,
} from "./dashboard-counts";

/** How often the board asks for fresh ticket counts (REV-65 acceptance 6). */
export const TICKET_REFRESH_MS = 60_000;

/** The last count this page showed for a query, kept while the service is down. */
export interface Remembered {
  /** A canonical decimal string, as on the wire. */
  count: string;
  at: string;
}
export interface TicketEntry {
  result?: TicketResult;
  remembered?: Remembered;
}
export type TicketCounts = Map<string, TicketEntry>;

export const queryOf = (panel: ServiceNowPanel): TicketQuery => ({
  team: panel.team,
  ticket_state: panel.ticket_state,
  detection: panel.detection,
});

/**
 * Ticket counts for every ServiceNow panel in `panels`, saved or still a draft.
 * Identical queries are asked once, in one batched request per dashboard, on
 * load, about every minute, on `refreshKey` changes (Refresh counts) and when
 * the tab becomes visible again. Paused dashboards skip the automatic refreshes.
 * The batch is separate from alert count batches.
 */
export function useTicketCounts(
  scope: Scope,
  panels: Panel[],
  refreshKey?: unknown,
  paused = false,
): TicketCounts {
  const queries = useMemo(() => {
    const seen = new Map<string, TicketQuery>();
    for (const panel of panels)
      if (isServiceNowPanel(panel) && panel.team.trim()) {
        const query = queryOf(panel);
        seen.set(queryKey(query), query);
      }
    return [...seen.values()];
  }, [panels]);
  const signature = JSON.stringify(queries.map(queryKey));
  const tenant = scope.tenant.id,
    csrf = scope.session.csrf_token;
  const [entries, setEntries] = useState<TicketCounts>(() => new Map());
  const memory = useRef(new Map<string, Remembered>());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const denied = useRef(scope.onDenied);
  denied.current = scope.onDenied;
  const asked = useRef(queries);
  asked.current = queries;
  useEffect(() => {
    const current = asked.current;
    if (!current.length) return;
    const controller = new AbortController();
    let busy = false,
      again = false;
    async function load() {
      if (controller.signal.aborted) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      let results: TicketResult[];
      try {
        results = await fetchTicketCounts(
          tenant,
          csrf,
          current,
          controller.signal,
        );
      } catch (failure) {
        if (controller.signal.aborted) return;
        // A lost session or access goes through the app's sign-in handling.
        if (
          failure instanceof ApiError &&
          [401, 403].includes(failure.status)
        ) {
          denied.current();
          return;
        }
        // A failed request shows each panel as unavailable, keeping its last count.
        results = current.map(unavailable);
      } finally {
        busy = false;
      }
      if (controller.signal.aborted) return;
      const next: TicketCounts = new Map();
      current.forEach((query, index) => {
        const key = queryKey(query);
        const result = results[index];
        if (result.status === "count" && result.count !== null)
          memory.current.set(key, {
            count: result.count,
            at: result.checked_at ?? new Date().toISOString(),
          });
        next.set(key, { result, remembered: memory.current.get(key) });
      });
      setEntries(next);
      if (again) {
        again = false;
        void load();
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!pausedRef.current && document.visibilityState === "visible")
        void load();
    }, TICKET_REFRESH_MS);
    function visibility() {
      if (document.visibilityState === "visible" && !pausedRef.current)
        void load();
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [signature, tenant, csrf, refreshKey]);
  return entries;
}

/** A checked decimal count string, grouped for reading; counts may exceed 2^53. */
const formatCount = (value: string) => BigInt(value).toLocaleString();
const minutesSince = (value: string) =>
  Math.max(1, Math.floor((Date.now() - Date.parse(value)) / 60000));

/**
 * One ServiceNow panel (REV-65): the title, the "Team · State · Detection" line
 * and the team's count, centered, with the top bar colored by the highest
 * threshold reached. Tickets are only counted, never changed; like every panel it
 * may carry a panel link (REV-66).
 */
export function ServiceNowTile({
  panel,
  title: shownTitle,
  entry,
  placeholder,
  layoutControls,
  layoutActive,
  layoutStyle,
}: {
  panel: ServiceNowPanel;
  /** Overrides the panel's own title, as the panel dialog's preview does. */
  title?: string;
  entry?: TicketEntry;
  /** Shown instead of a count, as the dialog does before a team is chosen. */
  placeholder?: string;
  layoutControls?: ReactNode;
  layoutActive?: boolean;
  layoutStyle?: CSSProperties;
}) {
  const title = shownTitle ?? (panel.title?.trim() || defaultTitle(panel.team));
  const result = entry?.result;
  let value: string | undefined;
  let dim = false;
  let footer: ReactNode = null;
  let message: { head: string; body?: string; tone: "warn" | "quiet" } | null =
    null;
  let label: string;
  if (placeholder) {
    message = { head: placeholder, tone: "quiet" };
    label = title;
  } else if (!result) {
    label = `${title}, loading`;
  } else if (result.status === "count" && result.count !== null) {
    value = result.count;
    label = `${title}: ${formatCount(result.count)}`;
  } else if (result.status === "not_found") {
    message = {
      head: "Team not found",
      body: `ServiceNow has no team called "${panel.team}".`,
      tone: "warn",
    };
    label = `${title}: team not found`;
  } else if (result.status === "no_count") {
    message = {
      head: "No count",
      body: "The ticket count service answered without a count for this team.",
      tone: "quiet",
    };
    label = `${title}: no count`;
  } else if (result.status === "not_configured") {
    message = {
      head: "ServiceNow isn't connected",
      body: "An admin sets up the ticket count service.",
      tone: "quiet",
    };
    label = `${title}: ServiceNow not connected`;
  } else {
    const last = result.last_count ?? entry?.remembered?.count ?? null;
    const at =
      result.last_counted_at ??
      (result.last_count === null ? entry?.remembered?.at : undefined);
    if (last !== null) {
      value = last;
      dim = true;
      label = `${title}: last count ${formatCount(last)}, out of date`;
      const note = at
        ? `Last count ${minutesSince(at)} min ago. Retrying.`
        : "Couldn't get a new count. Retrying.";
      footer = (
        <span className="pn-sn-foot" title={note}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
          </svg>
          <span className="pn-sn-note">{note}</span>
        </span>
      );
    } else {
      message = {
        head: "Couldn't get the count",
        body: "The ticket count service isn't answering. Retrying about every minute.",
        tone: "quiet",
      };
      label = `${title}: couldn't get the count`;
    }
  }
  // A greyed, out-of-date count never takes a threshold color.
  const tone =
    value !== undefined && !dim
      ? thresholdFor(value, panel.thresholds)?.color
      : undefined;
  const shown = value === undefined ? undefined : formatCount(value);
  return (
    <article
      className={`pn pn-sn ${tone ? "pn-toned" : "pn-none"} ${layoutControls ? "de-tile" : ""} ${layoutActive ? "de-tile-active" : ""}`}
      aria-label={label}
      aria-busy={!result && !placeholder ? true : undefined}
      data-layout-panel={panel.id}
      data-threshold-color={tone}
      data-ticket-state={
        placeholder ? "placeholder" : (result?.status ?? "loading")
      }
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
        <span className="pn-title">{title}</span>
        <span style={{ flexGrow: 1 }} />
        <PanelLinkButton link={panel.link} inactive={layoutActive} />
      </span>
      <span className="sub">{filterLine(queryOf(panel))}</span>
      {shown !== undefined ? (
        <span className="pn-value">
          <b
            className={dim ? "pn-none-value" : undefined}
            style={{ "--pn-chars": shown.length } as CSSProperties}
          >
            {shown}
          </b>
        </span>
      ) : message ? (
        // The box fits the space under the title; text that doesn't fit is
        // clamped, and the full text stays in its title.
        <div className="pn-sn-area">
          <div
            className={`pn-sn-msg pn-sn-${message.tone}`}
            title={[message.head, message.body].filter(Boolean).join(" ")}
          >
            <strong>{message.head}</strong>
            {message.body && <span>{message.body}</span>}
          </div>
        </div>
      ) : (
        <>
          <div className="pn-sn-wait">
            <span className="pn-sn-skel" />
          </div>
          <span role="status" className="pn-sn-status">
            Getting the count…
          </span>
        </>
      )}
      {footer}
      {layoutControls}
    </article>
  );
}
