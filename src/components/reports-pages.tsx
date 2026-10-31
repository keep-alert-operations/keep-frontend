"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Envelope, message, tenantPath, timestamp } from "@/lib/api";
import type { components } from "@/lib/generated";
import { useResource } from "@/lib/hooks";
import { timezoneLabel } from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { Icon } from "./icons";
import { NavLink, Page, RelativeTime, personLabel } from "./page";

type Report = components["schemas"]["IncidentReport"];
type Summary = components["schemas"]["ReportSummary"];
type Groups = Report["breakdowns"];
type GroupRow = Omit<Groups["severity"][number], "severity">;
type PeriodKey = "24h" | "7d" | "30d" | "90d" | "custom";
type View = "severity" | "origin" | "rule" | "assignee";

const PERIODS: [PeriodKey, string][] = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["custom", "Custom"],
];
const DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
const VIEWS: [View, string][] = [
  ["severity", "Severity"],
  ["origin", "Origin"],
  ["rule", "Correlation rule"],
  ["assignee", "Assignee"],
];
const DAY = 86_400_000;

/** Definitions shown in the ⓘ popovers and the page foot (incident operations 20). */
const DEFINE = {
  opened:
    "Incident cycles that started in the period: new incidents plus reopenings, counted at the time the cycle opened.",
  resolved:
    "Incident cycles whose resolution time falls in the period, whatever the cause.",
  response:
    "For cycles opened in the period: the time from the cycle opening to its first assignment or its first move to Investigating, whichever came first. An assignee kept from before a reopening does not count. Shows the median; cycles with no response yet are left out.",
  resolve:
    "For cycles resolved in the period: the time from the cycle opening to its resolution, whatever the cause. Shows the median and the 90th percentile.",
  reopen:
    "Of the cycles resolved in the period, the share that were reopened before the period ended.",
  chart:
    "Incident cycles opened and resolved in each hour, day or week of the period, in your time zone.",
  cause:
    "How the cycles resolved in the period ended. Manual: someone set Resolved. All alerts resolved: the last linked alert resolved. Inactivity: 30 days without activity; automatic inactivity resolution is not running, so this stays at zero.",
  breakdown:
    "Severity is fixed when an incident is created. Origin is manual or correlation rule. Correlation rule is the rule that created the incident; a deleted rule keeps its last name while its history is kept. Assignee is the assignee when the cycle resolved, or now if it is still open. Each name opens the Incidents list for incidents created in this period with that value, so its counts can differ.",
} as const;

/** Local calendar date of an instant, as YYYY-MM-DD. */
function localDay(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
function midnight(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}
function addDays(day: string, days: number) {
  const start = midnight(day);
  return localDay(
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + days),
  );
}
const isMidnight = (value: Date) =>
  value.getHours() === 0 &&
  value.getMinutes() === 0 &&
  value.getSeconds() === 0;

/** The requested instants: rolling 24 hours, or calendar days including today. */
function bounds(
  period: PeriodKey,
  custom: { from: string; to: string },
  anchor: Date,
) {
  if (period === "24h")
    return { from: new Date(anchor.getTime() - DAY), to: anchor };
  const today = localDay(anchor);
  if (period !== "custom")
    return { from: midnight(addDays(today, 1 - DAYS[period])), to: anchor };
  return {
    from: midnight(custom.from),
    to: custom.to >= today ? anchor : midnight(addDays(custom.to, 1)),
  };
}

// Fixed English labels ("30 Sep"), independent of the browser's CLDR month style.
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (value: Date) =>
  `${value.getDate()} ${MONTHS[value.getMonth()]}`;
const weekdayLabel = (value: Date) =>
  `${WEEKDAYS[value.getDay()]} ${dayLabel(value)}`;
const timeLabel = (value: Date) =>
  `${pad(value.getHours())}:${pad(value.getMinutes())}`;
function rangeLabel(from: Date, to: Date, year = true) {
  if (!isMidnight(from) && to.getTime() - from.getTime() <= DAY + 3_600_000)
    return `${dayLabel(from)}, ${timeLabel(from)} – ${dayLabel(to)}, ${timeLabel(to)}`;
  const last = isMidnight(to) ? new Date(to.getTime() - 1) : to;
  return `${dayLabel(from)} – ${dayLabel(last)}${year ? ` ${last.getFullYear()}` : ""}`;
}
function exactRange(from: string, to: string) {
  return `${timestamp(from)} – ${timestamp(to)} ${timezoneLabel()}`;
}

const int = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);
const counted = (value: string | null | undefined) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString();

/** Whole seconds as "45 s", "9 min", "3 h 12 min" or "1 d 6 h". */
function duration(seconds: number | null) {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
  }
  let days = Math.floor(minutes / 1440),
    hours = Math.round((minutes % 1440) / 60);
  if (hours === 24) [days, hours] = [days + 1, 0];
  return `${days} d${hours ? ` ${hours} h` : ""}`;
}
function share(part: number, whole: number) {
  return whole ? (part / whole) * 100 : null;
}
function percent(value: number | null) {
  if (value === null) return "—";
  return `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** Change against the previous period; only time and reopen rate have a better direction. */
function change(
  current: number | null,
  previous: number | null,
  kind: "count" | "time" | "points",
  lowerIsBetter: boolean,
) {
  if (current === null || previous === null) return null;
  let direction: number, text: string;
  if (kind === "points") {
    const points = current - previous;
    direction = Math.abs(points) < 0.05 ? 0 : Math.sign(points);
    text = direction
      ? `${direction > 0 ? "↑" : "↓"} ${Math.abs(points).toFixed(1)} pts from ${percent(previous)}`
      : `No change from ${percent(previous)}`;
  } else {
    direction = Math.sign(current - previous);
    const before =
      kind === "time" ? duration(previous) : previous.toLocaleString();
    text = !direction
      ? `No change from ${before}`
      : !previous
        ? "↑ from 0"
        : `${direction > 0 ? "↑" : "↓"} ${Math.round((Math.abs(current - previous) / previous) * 100)}% from ${before}`;
  }
  const tone =
    !lowerIsBetter || !direction ? "flat" : direction < 0 ? "good" : "bad";
  return { text, tone };
}

/** ⓘ button with a definition popover; Escape or a click elsewhere closes it. */
function Definition({
  label,
  text,
  end,
}: {
  label: string;
  text: string;
  end?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span className="rp-def" ref={box}>
      <button
        type="button"
        className="rp-info"
        aria-label={`How ${label} is measured`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`rp-pop${end ? " rp-pop-end" : ""}`}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function Figure({
  label,
  define,
  value,
  sub,
  delta,
  state,
}: {
  label: string;
  define: string;
  value: string;
  sub: string;
  delta?: { text: string; tone: string } | null;
  state: "loading" | "ready" | "unavailable";
}) {
  return (
    <div className="rp-fig">
      <div className="rp-fig-l">
        <span>{label}</span>
        <Definition label={label.toLowerCase()} text={define} />
      </div>
      {state === "loading" ? (
        <>
          <span className="rp-skel rp-skel-v" />
          <span className="rp-skel rp-skel-s" />
        </>
      ) : state === "unavailable" ? (
        <>
          <span className="rp-fig-v rp-na">—</span>
          <span className="rp-fig-s">Unavailable for now</span>
        </>
      ) : (
        <>
          <span className="rp-fig-v">{value}</span>
          <span className="rp-fig-s" title={sub}>
            {sub}
          </span>
          {delta && (
            <span className={`rp-delta rp-${delta.tone}`}>{delta.text}</span>
          )}
        </>
      )}
    </div>
  );
}

interface Stat {
  label: string;
  define: string;
  value: string;
  sub: string;
  delta: { text: string; tone: string } | null;
  unavailable?: boolean;
}

function figures(summary?: Summary, previous?: Summary | null): Stat[] {
  const opened = int(summary?.opened) ?? 0;
  const resolved = int(summary?.resolved) ?? 0;
  const reopened = int(summary?.reopened) ?? 0;
  const before = previous ?? null;
  const rate = share(reopened, resolved);
  const response = summary?.first_response ?? null;
  const resolve = summary?.time_to_resolve ?? null;
  return [
    {
      label: "Opened",
      define: DEFINE.opened,
      value: opened.toLocaleString(),
      sub: opened
        ? `${counted(summary?.opened_new)} new · ${counted(summary?.opened_reopened)} reopened`
        : "None in this period",
      delta: before && change(opened, int(before.opened), "count", false),
    },
    {
      label: "Resolved",
      define: DEFINE.resolved,
      value: resolved.toLocaleString(),
      sub: resolved
        ? `${counted(summary?.resolved_by_cause.manual)} manual · ${counted(summary?.resolved_by_cause.alerts_resolved)} when alerts resolved`
        : "None in this period",
      delta: before && change(resolved, int(before.resolved), "count", false),
    },
    {
      label: "Time to first response",
      define: DEFINE.response,
      value: duration(int(response?.median_seconds)),
      sub:
        response && int(response.responded)
          ? `Median · 90th percentile ${duration(int(response.p90_seconds))}`
          : "No responses in this period",
      delta:
        before &&
        change(
          int(response?.median_seconds),
          int(before.first_response?.median_seconds),
          "time",
          true,
        ),
      unavailable: !response,
    },
    {
      label: "Time to resolve",
      define: DEFINE.resolve,
      value: duration(int(resolve?.median_seconds)),
      sub: resolve
        ? `Median · 90th percentile ${duration(int(resolve.p90_seconds))}`
        : "No resolutions in this period",
      delta:
        before &&
        change(
          int(resolve?.median_seconds),
          int(before.time_to_resolve?.median_seconds),
          "time",
          true,
        ),
    },
    {
      label: "Reopen rate",
      define: DEFINE.reopen,
      value: percent(rate),
      sub: resolved
        ? `${reopened.toLocaleString()} of ${resolved.toLocaleString()} resolutions`
        : "No resolutions in this period",
      delta:
        before &&
        change(
          rate,
          share(int(before.reopened) ?? 0, int(before.resolved) ?? 0),
          "points",
          true,
        ),
    },
  ];
}

function nice(value: number) {
  const steps = [
    2, 4, 6, 8, 10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 300, 400, 500,
    600, 800, 1000,
  ];
  return steps.find((step) => step >= value) ?? Math.ceil(value / 1000) * 1000;
}

function binLabels(report: Report) {
  const unit = report.period.bin;
  const count = report.series.length;
  return report.series.map((bin, index) => {
    const start = new Date(bin.start);
    const next = new Date(start.getTime() + 3_600_000);
    const label =
      unit === "hour"
        ? index % 6 === 0
          ? timeLabel(start)
          : ""
        : unit === "day"
          ? count <= 10 || index % 7 === 0
            ? dayLabel(start)
            : ""
          : index % 3 === 0
            ? dayLabel(start)
            : "";
    const when =
      unit === "hour"
        ? `${dayLabel(start)}, ${timeLabel(start)}–${timeLabel(next)}`
        : unit === "week"
          ? `Week of ${dayLabel(start)}`
          : `${weekdayLabel(start)}${localDay(start) === localDay(new Date()) ? ", so far" : ""}`;
    const edge =
      index < count * 0.15
        ? " rp-tip-start"
        : index > count * 0.82
          ? " rp-tip-end"
          : "";
    return { ...bin, label, when, edge };
  });
}

function Chart({ report, asTable }: { report: Report; asTable: boolean }) {
  const bins = binLabels(report);
  const top = nice(
    Math.max(
      1,
      ...bins.map((bin) => Math.max(Number(bin.opened), Number(bin.resolved))),
    ),
  );
  if (asTable)
    return (
      <div
        className="rp-ctab"
        role="table"
        aria-label="Opened and resolved incident cycles"
      >
        <div role="row" className="rp-ct-row rp-ct-head">
          <span role="columnheader">
            {report.period.bin === "hour"
              ? "Hour"
              : report.period.bin === "week"
                ? "Week"
                : "Day"}
          </span>
          <span role="columnheader">Opened</span>
          <span role="columnheader">Resolved</span>
        </div>
        {bins.map((bin) => (
          <div role="row" className="rp-ct-row" key={bin.start}>
            <span role="cell">{bin.when}</span>
            <span role="cell">{counted(bin.opened)}</span>
            <span role="cell">{counted(bin.resolved)}</span>
          </div>
        ))}
      </div>
    );
  return (
    <div
      className="rp-chart"
      role="img"
      aria-label={`Bar chart of incident cycles opened and resolved per ${report.period.bin}: ${counted(report.summary.opened)} opened and ${counted(report.summary.resolved)} resolved in total. View as table lists the values.`}
    >
      {[0, 50, 100].map((position) => (
        <div
          className="rp-tick"
          key={position}
          style={{ bottom: `${position}%` }}
        >
          <span>{((top * position) / 100).toLocaleString()}</span>
        </div>
      ))}
      <div className="rp-plot">
        {bins.map((bin) => (
          <div className="rp-col" key={bin.start}>
            <span
              className="rp-bar"
              style={{ height: `${(Number(bin.opened) / top) * 100}%` }}
            />
            <span
              className="rp-bar rp-bar2"
              style={{ height: `${(Number(bin.resolved) / top) * 100}%` }}
            />
            {bin.label && <span className="rp-xl">{bin.label}</span>}
            <span className={`rp-tip${bin.edge}`}>
              <b>{bin.when}</b>
              <span>
                Opened {counted(bin.opened)} · Resolved {counted(bin.resolved)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CauseList({ summary }: { summary: Summary }) {
  const resolved = Number(summary.resolved);
  const causes: [string, string, string?][] = [
    ["Manual", summary.resolved_by_cause.manual],
    ["All alerts resolved", summary.resolved_by_cause.alerts_resolved],
    [
      "Inactivity",
      summary.resolved_by_cause.inactivity,
      "Automatic inactivity resolution is off",
    ],
  ];
  const most = Math.max(1, ...causes.map(([, value]) => Number(value)));
  return (
    <div role="list">
      {causes.map(([name, value, note]) => (
        <div role="listitem" className="rp-bl" key={name}>
          <span className="rp-bl-n">
            {name}
            {note && <small>{note}</small>}
          </span>
          <span className="rp-bl-t" aria-hidden="true">
            <span
              className="rp-bl-f"
              style={{ width: `${(Number(value) / most) * 100}%` }}
            />
          </span>
          <span className="rp-bl-v">{counted(value)}</span>
          <span className="rp-bl-p">
            {percent(share(Number(value), resolved))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Created-time bounds for the Incidents list, which filters in whole UTC minutes. */
function minute(value: string, ceil: boolean) {
  const time = Date.parse(value);
  const rounded = (ceil ? Math.ceil : Math.floor)(time / 60_000) * 60_000;
  return new Date(rounded).toISOString().slice(0, 16);
}

interface Row {
  key: string;
  name: React.ReactNode;
  title: string;
  filter?: Record<string, string>;
  tag?: string;
  muted?: boolean;
  figures: GroupRow;
}

function groupRows(scope: Scope, groups: Groups, view: View): Row[] | null {
  if (view === "severity")
    return groups.severity.map((row) => ({
      key: row.severity,
      name: (
        <span className={`sev sev-${row.severity}`}>
          {row.severity[0].toUpperCase() + row.severity.slice(1)}
        </span>
      ),
      title: `severity ${row.severity}`,
      filter: { severity: row.severity },
      figures: row,
    }));
  if (view === "origin")
    return groups.origin.map((row) => ({
      key: row.origin,
      name: row.origin === "correlation" ? "Correlation rule" : "Manual",
      title:
        row.origin === "correlation"
          ? "created by a correlation rule"
          : "created manually",
      filter: { origin: row.origin },
      figures: row,
    }));
  if (view === "rule")
    return groups.rule.rows.map((row) => ({
      key: row.rule_id,
      name: row.name ?? "Deleted rule",
      title: `rule ${row.name ?? "Deleted rule"}`,
      filter: { rule_id: row.rule_id },
      tag: row.deleted && row.name ? "Deleted" : undefined,
      figures: row,
    }));
  if (!groups.assignee) return null;
  return groups.assignee.rows.map((row) => ({
    key: row.assignee_id ?? "unassigned",
    name: personLabel(scope, row.assignee_id, row.display_name, "Unassigned"),
    title: row.assignee_id
      ? `assignee ${row.display_name ?? row.assignee_id}`
      : "no assignee",
    filter: { assignee: row.assignee_id ?? "unassigned" },
    muted: !row.assignee_id,
    figures: row,
  }));
}

function Breakdown({
  scope,
  report,
  view,
  onView,
}: {
  scope: Scope;
  report: Report;
  view: View;
  onView: (view: View) => void;
}) {
  const groups = report.breakdowns;
  const rows = groupRows(scope, groups, view);
  const label = VIEWS.find(([key]) => key === view)![1];
  const opened = rows
    ? Math.max(1, ...rows.map((row) => Number(row.figures.opened)))
    : 1;
  const other =
    view === "rule"
      ? groups.rule.other
      : view === "assignee"
        ? groups.assignee?.other
        : null;
  const manual = groups.origin.find((row) => row.origin === "manual");
  const href = (filter: Record<string, string>) =>
    `/tenants/${scope.tenant.id}/incidents?${new URLSearchParams({
      view: "all",
      created_from: minute(report.period.covered_from, false),
      created_to: minute(report.period.covered_to, true),
      ...filter,
    })}`;
  return (
    <section className="panel rp-panel" aria-label="Breakdown">
      <div className="panel-h rp-panel-h">
        <h2>Breakdown</h2>
        <Definition label="the breakdown" text={DEFINE.breakdown} />
        <div className="grow" />
        <div className="seg rp-seg" role="group" aria-label="Break down by">
          {VIEWS.map(([key, text]) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => onView(key)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      <div className="rp-tablebox">
        <div
          className="rp-rows"
          role="table"
          aria-label={`Incidents by ${label.toLowerCase()}`}
        >
          <div role="row" className="rp-row rp-head">
            <span role="columnheader">{label}</span>
            <span role="columnheader" className="rp-num">
              Opened
            </span>
            <span role="columnheader" className="rp-num">
              Resolved
            </span>
            <span role="columnheader" className="rp-num">
              First response
            </span>
            <span role="columnheader" className="rp-num">
              Time to resolve
            </span>
            <span role="columnheader" className="rp-num">
              Reopened
            </span>
          </div>
          {rows === null ? (
            <div className="rp-empty-row" role="row">
              <span role="cell">
                Assignment history could not be read in time, so this breakdown
                is unavailable for now.
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div className="rp-empty-row" role="row">
              <span role="cell">No incidents in this period.</span>
            </div>
          ) : (
            rows.map((row) => (
              <div role="row" className="rp-row" key={row.key}>
                <span role="cell" className="rp-cell">
                  <NavLink
                    scope={scope}
                    href={href(row.filter!)}
                    className={`rp-lnk${row.muted ? " rp-muted" : ""}`}
                    title={`Open Incidents created in this period with ${row.title}. Counts there can differ: the list filters by creation and current assignee.`}
                  >
                    {row.name}
                  </NavLink>
                  {row.tag && <span className="rp-tag">{row.tag}</span>}
                </span>
                <span role="cell" className="rp-num">
                  <span className="rp-mini" aria-hidden="true">
                    <span
                      style={{
                        width: `${(Number(row.figures.opened) / opened) * 100}%`,
                      }}
                    />
                  </span>
                  {counted(row.figures.opened)}
                </span>
                <span role="cell" className="rp-num">
                  {counted(row.figures.resolved)}
                </span>
                <span role="cell" className="rp-num">
                  {duration(int(row.figures.first_response_median_seconds))}
                </span>
                <span role="cell" className="rp-num">
                  {duration(int(row.figures.time_to_resolve_median_seconds))}
                </span>
                <span role="cell" className="rp-num">
                  {counted(row.figures.reopened)}
                </span>
              </div>
            ))
          )}
          {other && (
            <div role="row" className="rp-row rp-other">
              <span role="cell">
                Other ({counted(other.groups)}{" "}
                {view === "rule" ? "rules" : "people"})
              </span>
              <span role="cell" className="rp-num">
                {counted(other.opened)}
              </span>
              <span role="cell" className="rp-num">
                {counted(other.resolved)}
              </span>
              <span role="cell" className="rp-num">
                —
              </span>
              <span role="cell" className="rp-num">
                —
              </span>
              <span role="cell" className="rp-num">
                {counted(other.reopened)}
              </span>
            </div>
          )}
        </div>
      </div>
      {view === "rule" && manual && Number(manual.opened) > 0 && (
        <div className="foot rp-foot">
          {counted(manual.opened)} manual incidents have no rule and are not
          listed.
        </div>
      )}
      {view === "assignee" && rows && rows.length > 0 && (
        <div className="foot rp-foot">
          Assignee when the cycle resolved, or now for cycles still open.
        </div>
      )}
    </section>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="rp-skel-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span
          key={index}
          className="rp-skel"
          style={{ width: `${90 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

/** Routes the Reports section; the incident report is its only report for now (REV-53). */
export function ReportPages(scope: Scope & { section: string; id?: string }) {
  return <IncidentReport key={scope.tenant.id} scope={scope} />;
}

function IncidentReport({ scope }: { scope: Scope }) {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [custom, setCustom] = useState(() => {
    const today = localDay(new Date());
    return { from: addDays(today, -29), to: today };
  });
  const [draft, setDraft] = useState(custom);
  const [picking, setPicking] = useState(false);
  const [compare, setCompare] = useState(true);
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<View>("severity");
  const [asTable, setAsTable] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { from, to } = bounds(period, custom, anchor);
  const selection = `${period}:${custom.from}:${custom.to}:${compare}`;
  const path = `${tenantPath(scope.tenant.id)}/reports/incidents?${new URLSearchParams(
    {
      from: from.toISOString(),
      to: to.toISOString(),
      time_zone: zone,
      compare: String(compare),
    },
  )}`;
  // No live version: a period report reloads only when asked (REV-53).
  const result = useResource<Report>(path, scope.onDenied);
  const last = useRef<{ selection: string; data: Envelope<Report> } | null>(
    null,
  );
  if (result.data) last.current = { selection, data: result.data };
  // A refresh of the same choices keeps the previous figures; a new choice waits for its own.
  const shown =
    result.data ??
    (last.current?.selection === selection ? last.current.data : undefined);
  const report = shown?.data;
  const refreshing = !!shown && result.loading;
  const loading = !shown && result.loading;
  const computed = (shown?.meta as { computed_at?: string } | undefined)
    ?.computed_at;
  const today = localDay(new Date());
  const horizon = (() => {
    const edge = new Date(Date.now() - 90 * DAY);
    const day = localDay(edge);
    return isMidnight(edge) ? day : addDays(day, 1);
  })();
  const draftInvalid = !draft.from || !draft.to || draft.from > draft.to;

  useEffect(() => {
    if (!picking) return;
    popover.current?.querySelector("input")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [picking]);

  const choose = (key: PeriodKey) => {
    if (key === "custom") {
      setDraft(custom);
      setPicking(true);
      return;
    }
    setPicking(false);
    setPeriod(key);
    setAnchor(new Date());
  };
  // A new "to" instant re-reads up to now; the same instant reloads the same request.
  const reload = () => {
    const next = new Date();
    if (next.getTime() === anchor.getTime()) result.reload();
    else setAnchor(next);
  };

  const coverage =
    report && report.period.covered_from !== report.period.requested_from
      ? {
          covered:
            report.period.covered_from === report.period.covered_to
              ? null
              : rangeLabel(
                  new Date(report.period.covered_from),
                  new Date(report.period.covered_to),
                ),
          requested: rangeLabel(
            new Date(report.period.requested_from),
            new Date(report.period.requested_to),
          ),
        }
      : null;
  const empty =
    report &&
    !Number(report.summary.opened) &&
    !Number(report.summary.resolved);
  const stats = figures(report?.summary, report?.previous_summary);

  return (
    <Page scope={scope} title="Reports" crumbs={[{ label: "Reports" }]}>
      <div className="rp">
        <div className="rp-filters">
          <div className="rp-period">
            <div className="seg rp-seg" role="group" aria-label="Period">
              {PERIODS.map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={period === key}
                  aria-expanded={key === "custom" ? picking : undefined}
                  onClick={() => choose(key)}
                >
                  {text}
                </button>
              ))}
            </div>
            {picking && (
              <div
                className="rp-custom"
                role="dialog"
                aria-label="Custom period"
                ref={popover}
              >
                <div className="rp-custom-row">
                  <label>
                    From
                    <input
                      type="date"
                      className="inp"
                      value={draft.from}
                      min={addDays(today, -365)}
                      max={today}
                      onChange={(event) =>
                        setDraft({ ...draft, from: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      className="inp"
                      value={draft.to}
                      min={addDays(today, -365)}
                      max={today}
                      onChange={(event) =>
                        setDraft({ ...draft, to: event.target.value })
                      }
                    />
                  </label>
                </div>
                {draftInvalid ? (
                  <p className="rp-custom-err" role="alert">
                    Choose a From date on or before the To date.
                  </p>
                ) : (
                  draft.from < horizon && (
                    <p className="rp-custom-note">
                      Incident history is kept for 90 days after resolution, so
                      this report starts on {dayLabel(midnight(horizon))}.
                    </p>
                  )
                )}
                <div className="rp-custom-f">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setPicking(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-p"
                    disabled={draftInvalid}
                    onClick={() => {
                      setCustom(draft);
                      setPeriod("custom");
                      setPicking(false);
                      setAnchor(new Date());
                    }}
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
          <span
            className="rp-range"
            title={exactRange(from.toISOString(), to.toISOString())}
          >
            {rangeLabel(from, to)}
          </span>
          <label className="rp-check">
            <input
              type="checkbox"
              checked={compare}
              onChange={() => setCompare(!compare)}
            />
            Compare with previous period
          </label>
          {compare && report && (
            <span
              className="rp-range-sub"
              title={
                report.previous
                  ? exactRange(report.previous.from, report.previous.to)
                  : "History is kept for 90 days after resolution."
              }
            >
              {report.previous
                ? `vs ${rangeLabel(new Date(report.previous.from), new Date(report.previous.to), false)}`
                : "No comparison: the previous period is past retention"}
            </span>
          )}
          {/* The stamp and Refresh wrap together, kept to the right. */}
          <div className="rp-meta">
            <span className="rp-stamp" aria-live="polite">
              {loading ? (
                "Computing…"
              ) : refreshing ? (
                "Refreshing…"
              ) : computed ? (
                <>
                  Computed <RelativeTime value={computed} />
                </>
              ) : null}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={result.loading}
              onClick={reload}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </button>
          </div>
        </div>

        {coverage && (
          <div className="rp-note" role="status">
            <Icon name="clock" size={16} />
            <span>
              {coverage.covered ? (
                <>
                  This report covers <b>{coverage.covered}</b>, not the full{" "}
                  {coverage.requested} you chose.
                </>
              ) : (
                <>Nothing in {coverage.requested} is still retained.</>
              )}{" "}
              Incidents are kept for 90 days after they resolve, so older
              history may be incomplete and is left out.
            </span>
          </div>
        )}
        {report && report.unavailable.length > 0 && (
          <div className="rp-note rp-warn" role="status">
            <Icon name="alerts" size={16} />
            <span>
              Assignment history could not be read in time, so time to first
              response and the assignee breakdown are missing. Everything else
              is complete.
            </span>
            <button type="button" className="btn btn-sm" onClick={reload}>
              Retry
            </button>
          </div>
        )}

        {!shown && !result.loading && result.error ? (
          <section className="panel rp-error" role="alert">
            <Icon name="alerts" size={20} />
            <div>
              <b>Reports couldn&apos;t be computed</b>
              <span>
                Your period and choices are kept, so you can try again in a
                moment.
              </span>
              <span className="rp-req">{message(result.error)}</span>
            </div>
            <button type="button" className="btn" onClick={reload}>
              Retry
            </button>
          </section>
        ) : (
          <>
            <section className="panel rp-strip" aria-label="Incident summary">
              {stats.map((stat) => (
                <Figure
                  key={stat.label}
                  label={stat.label}
                  define={stat.define}
                  value={stat.value}
                  sub={stat.sub}
                  delta={compare ? stat.delta : null}
                  state={
                    !report
                      ? "loading"
                      : stat.unavailable
                        ? "unavailable"
                        : "ready"
                  }
                />
              ))}
            </section>
            <div className="rp-grid">
              <section
                className="panel rp-panel"
                aria-label="Opened and resolved"
              >
                <div className="panel-h rp-panel-h">
                  <h2>
                    Opened and resolved,{" "}
                    {report?.period.bin === "hour"
                      ? "per hour"
                      : report?.period.bin === "week"
                        ? "per week"
                        : "per day"}
                  </h2>
                  <Definition label="this chart" text={DEFINE.chart} />
                  <div className="grow" />
                  {report && !empty && (
                    <div className="rp-legend">
                      <span>
                        <i className="rp-sw" aria-hidden="true" />
                        Opened <b>{counted(report.summary.opened)}</b>
                      </span>
                      <span>
                        <i className="rp-sw rp-sw2" aria-hidden="true" />
                        Resolved <b>{counted(report.summary.resolved)}</b>
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-g"
                    aria-pressed={asTable}
                    disabled={!report || !!empty}
                    onClick={() => setAsTable(!asTable)}
                  >
                    {asTable ? "View as chart" : "View as table"}
                  </button>
                </div>
                <div className="panel-b">
                  {!report ? (
                    <span className="rp-skel rp-skel-chart" />
                  ) : empty ? (
                    <div className="rp-empty">
                      <b>No incidents opened or resolved</b>
                      <span>Nothing happened in this period.</span>
                      {period === "24h" && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => choose("7d")}
                        >
                          Show last 7 days
                        </button>
                      )}
                    </div>
                  ) : (
                    <Chart report={report} asTable={asTable} />
                  )}
                </div>
              </section>
              <section className="panel rp-panel" aria-label="Resolution cause">
                <div className="panel-h rp-panel-h">
                  <h2>Resolution cause</h2>
                  <Definition
                    label="resolution cause"
                    text={DEFINE.cause}
                    end
                  />
                </div>
                <div className="panel-b">
                  {!report ? (
                    <Skeleton rows={3} />
                  ) : Number(report.summary.resolved) ? (
                    <CauseList summary={report.summary} />
                  ) : (
                    <p className="rp-empty-row">
                      No incidents resolved in this period.
                    </p>
                  )}
                </div>
              </section>
            </div>
            {report ? (
              <Breakdown
                scope={scope}
                report={report}
                view={view}
                onView={setView}
              />
            ) : (
              <section className="panel rp-panel" aria-label="Breakdown">
                <div className="panel-h rp-panel-h">
                  <h2>Breakdown</h2>
                </div>
                <div className="panel-b">
                  <Skeleton rows={4} />
                </div>
              </section>
            )}
            <details className="rp-defs">
              <summary>How these figures are measured</summary>
              <dl>
                <dt>Opened</dt>
                <dd>{DEFINE.opened}</dd>
                <dt>Resolved</dt>
                <dd>{DEFINE.resolved}</dd>
                <dt>Time to first response</dt>
                <dd>{DEFINE.response}</dd>
                <dt>Time to resolve</dt>
                <dd>{DEFINE.resolve}</dd>
                <dt>Reopen rate</dt>
                <dd>{DEFINE.reopen}</dd>
                <dt>Resolution cause</dt>
                <dd>{DEFINE.cause}</dd>
                <dt>Breakdown</dt>
                <dd>{DEFINE.breakdown}</dd>
              </dl>
              <p>
                Figures come from this tenant&apos;s recorded history and are
                computed when you open or refresh the report. Incidents are kept
                for 90 days after they resolve, so a report reaches back at most
                90 days. Times are in your time zone, {timezoneLabel()}.
              </p>
            </details>
          </>
        )}
      </div>
    </Page>
  );
}
