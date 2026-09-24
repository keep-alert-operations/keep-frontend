"use client";
import { useEffect, useState } from "react";
import { ApiError, display, message, tenantPath, timestamp } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { Page, Severity } from "./page";

/* ------------------------------------------------------------------------
 * Small shared pieces for the correlation-rule and maintenance screens.
 * --------------------------------------------------------------------- */

export function InfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
export function WarnIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
    </svg>
  );
}

/** Reference banner (.banner .bn-*) with its leading icon. */
export function Banner({
  tone,
  children,
  role,
  id,
  className,
}: {
  tone: "info" | "warn" | "err" | "ok";
  children: React.ReactNode;
  role?: string;
  id?: string;
  className?: string;
}) {
  return (
    <div
      id={id}
      role={role}
      className={`banner bn-${tone} banner-top ${className ?? ""}`}
    >
      {tone === "info" || tone === "ok" ? <InfoIcon /> : <WarnIcon />}
      <div className="banner-text">{children}</div>
    </div>
  );
}

export function ErrorBanner({ error, id }: { error?: unknown; id?: string }) {
  return error ? (
    <Banner tone="err" role="alert" id={id}>
      {message(error)}
    </Banner>
  ) : null;
}

/** Save/command outcome: error, uncertain outcome and progress. */
export function CommandBanner({
  command,
}: {
  command: { error?: unknown; uncertain: boolean; busy: boolean };
}) {
  return (
    <>
      <ErrorBanner error={command.error} />
      {command.uncertain && (
        <Banner tone="warn" role="status">
          The outcome is uncertain. Retry repeats the original command and
          values. Your draft remains in this tab.
        </Banner>
      )}
      {command.busy && (
        <span className="sr-only" role="status">
          Saving…
        </span>
      )}
    </>
  );
}

/** Human-readable messages from an arbitrary diagnostics payload. */
export function diagnosticMessages(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(diagnosticMessages);
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.message === "string")
      return [
        `${item.message}${typeof item.label === "string" ? ` (${item.label})` : ""}`,
      ];
    if (typeof item.msg === "string") return [item.msg];
    return Object.values(item).flatMap(diagnosticMessages);
  }
  return [display(value)];
}

/* Read-only CEL with the reference token colours (.k .s .o .n). */
const CEL_TOKEN =
  /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\balert\.[A-Za-z_]\w*|\b[a-z_]\w*(?=\s*(?:==|!=|<=|>=|<|>|\bin\b)))|(&&|\|\||==|!=|<=|>=|[<>!]|\bin\b)|(\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g;
function highlightCel(line: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(CEL_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(line.slice(last, index));
    parts.push(
      <span
        key={index}
        className={match[1] ? "s" : match[2] ? "k" : match[3] ? "o" : "n"}
      >
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}
export function CelCode({
  value,
  label,
  gutter = true,
}: {
  value: unknown;
  label?: string;
  gutter?: boolean;
}) {
  const lines = (typeof value === "string" ? value : display(value)).split(
    "\n",
  );
  const body = lines.map((line, index) => (
    <span key={index}>
      {highlightCel(line)}
      {index < lines.length - 1 ? "\n" : ""}
    </span>
  ));
  if (!gutter) return <span className="cel-code">{body}</span>;
  return (
    <div className="code cel-code" role="group" aria-label={label}>
      <div className="ln" aria-hidden="true">
        {lines.map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <pre>{body}</pre>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO instant → DD-MM-YYYY HH:mm:ss in UTC. */
export function utcStamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "—";
  const d = new Date(value);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** Wall-clock local "YYYY-MM-DDTHH:mm[:ss]" → DD-MM-YYYY HH:mm:ss. */
export function localStamp(value: unknown) {
  const match =
    typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return "—";
  return `${match[3]}-${match[2]}-${match[1]} ${match[4]}:${match[5]}:${match[6] ?? "00"}`;
}
export function offsetLabel(seconds: number, prefix = "UTC") {
  const absolute = Math.abs(seconds);
  return `${prefix}${seconds < 0 ? "−" : "+"}${pad(Math.floor(absolute / 3600))}:${pad(Math.floor((absolute % 3600) / 60))}${absolute % 60 ? `:${pad(absolute % 60)}` : ""}`;
}
/** Browser timezone label, e.g. "Asia/Jerusalem (UTC+03:00)". */
export function browserZoneLabel(at = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${zone} (${offsetLabel(-at.getTimezoneOffset() * 60)})`;
}
/** Human duration between two instants, e.g. "4 hours", "1 day 2 hours". */
export function durationLabel(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  const part = (n: number, unit: string) =>
    n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "";
  return (
    [part(days, "day"), part(hours, "hour"), part(rest, "minute")]
      .filter(Boolean)
      .join(" ") || "under a minute"
  );
}
export function titleCase(value: unknown) {
  const text = typeof value === "string" ? value.replaceAll("_", " ") : "";
  return text ? text[0].toUpperCase() + text.slice(1) : "—";
}

/* ------------------------------------------------------------------------
 * Retained history (rules and maintenance), styled like the preset history.
 * --------------------------------------------------------------------- */

type Kind = "maintenance" | "correlation-rules";
type Revision = {
  revision: string;
  recorded_at: string;
  [key: string]: unknown;
};

function activityOf(row: Revision | undefined) {
  const activity =
    row?.activity && typeof row.activity === "object"
      ? (row.activity as Record<string, unknown>)
      : undefined;
  return {
    action: activity?.action ?? activity?.kind ?? row?.action,
    actor:
      activity?.actor_label ??
      activity?.actor_display_name ??
      row?.actor_label ??
      row?.actor_display_name,
    changed: Array.isArray(activity?.changed_fields)
      ? (activity.changed_fields as unknown[]).map(String)
      : Array.isArray(row?.changed_fields)
        ? (row.changed_fields as unknown[]).map(String)
        : [],
  };
}
function definitionOf(record: Revision | undefined) {
  const value = record?.definition ?? record?.snapshot;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

interface Field {
  label: string;
  value: (definition: Record<string, unknown>) => unknown;
  render: (definition: Record<string, unknown>) => React.ReactNode;
  mono?: boolean;
}
const text = (key: string) => (d: Record<string, unknown>) =>
  d[key] === undefined || d[key] === "" ? "—" : display(d[key]);
const ruleFields: Field[] = [
  { label: "Name", value: (d) => d.name, render: text("name") },
  {
    label: "Description",
    value: (d) => d.description,
    render: text("description"),
  },
  {
    label: "Severity",
    value: (d) => d.severity,
    render: (d) => (d.severity ? <Severity value={d.severity} /> : "—"),
  },
  {
    label: "Window",
    value: (d) => d.window_minutes,
    render: (d) =>
      d.window_minutes === undefined ? "—" : `${display(d.window_minutes)} min`,
  },
  {
    label: "Grouped by",
    value: (d) => d.group_by,
    mono: true,
    render: (d) =>
      Array.isArray(d.group_by)
        ? d.group_by.length
          ? d.group_by.join(", ")
          : "Singleton group"
        : "—",
  },
  {
    label: "Conditions",
    value: (d) => d.conditions,
    render: (d) =>
      Array.isArray(d.conditions) ? (
        <span className="th-conds">
          {(
            d.conditions as { id?: string; label?: string; cel?: string }[]
          ).map((condition, index) => (
            <span key={condition.id ?? index} className="th-cond">
              <b>{display(condition.label)}</b>
              <span className="mono">
                <CelCode value={condition.cel} gutter={false} />
              </span>
            </span>
          ))}
        </span>
      ) : (
        "—"
      ),
  },
  {
    label: "State",
    value: (d) => d.enabled,
    render: (d) =>
      typeof d.enabled === "boolean"
        ? d.enabled
          ? "Enabled"
          : "Disabled"
        : "—",
  },
];
const endpointText = (d: Record<string, unknown>, which: "start" | "end") => {
  const shown = d[`${which}_display`] as { local?: string } | undefined;
  return shown?.local
    ? localStamp(shown.local)
    : d[`${which}_at`]
      ? `${utcStamp(d[`${which}_at`])} UTC`
      : "—";
};
const maintenanceFields: Field[] = [
  { label: "Name", value: (d) => d.name, render: text("name") },
  { label: "Reason", value: (d) => d.reason, render: text("reason") },
  {
    label: "Which alerts",
    value: (d) => d.cel,
    mono: true,
    render: (d) =>
      d.cel === undefined ? "—" : <CelCode value={d.cel} gutter={false} />,
  },
  { label: "Timezone", value: (d) => d.timezone, render: text("timezone") },
  {
    label: "Starts",
    value: (d) => d.start_at ?? d.start_display,
    mono: true,
    render: (d) => endpointText(d, "start"),
  },
  {
    label: "Ends",
    value: (d) => d.end_at ?? d.end_display,
    mono: true,
    render: (d) => endpointText(d, "end"),
  },
  {
    label: "Enabled",
    value: (d) => d.enabled,
    render: (d) =>
      typeof d.enabled === "boolean"
        ? d.enabled
          ? "Enabled"
          : "Disabled"
        : "—",
  },
];

export function TemporalHistory({
  scope,
  section,
  id,
}: {
  scope: Scope;
  section: Kind;
  id: string;
}) {
  const base = `${tenantPath(scope.tenant.id)}/${section}/${id}`;
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [head, setHead] = useState<Revision | null>(null);
  const [compare, setCompare] = useState<"latest" | "previous">("latest");
  const history = useResource<Revision[]>(
    `${base}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
    0,
  );
  const rows =
    Array.isArray(history.data?.data) &&
    history.data.data.every(
      (row) =>
        row &&
        typeof row.revision === "string" &&
        /^[1-9]\d*$/.test(row.revision),
    )
      ? history.data.data
      : undefined;
  useEffect(() => {
    if (!history.loading && !history.error && selected === null && rows?.length)
      setSelected(rows[0].revision);
    if (!history.loading && !history.error && cursor === null && rows?.length)
      setHead(rows[0]);
  }, [history.loading, history.error, rows, selected, cursor]);
  const detail = useResource<Revision>(
    selected ? `${base}/history/${encodeURIComponent(selected)}` : null,
    scope.onDenied,
    0,
  );
  const record =
    selected && detail.data?.data?.revision === selected
      ? detail.data.data
      : undefined;
  const otherRevision =
    selected && head
      ? compare === "latest"
        ? head.revision !== selected
          ? head.revision
          : null
        : BigInt(selected) > BigInt(1)
          ? String(BigInt(selected) - BigInt(1))
          : null
      : null;
  const other = useResource<Revision>(
    otherRevision && record
      ? `${base}/history/${encodeURIComponent(otherRevision)}`
      : null,
    scope.onDenied,
    0,
  );
  const otherRecord =
    otherRevision && other.data?.data?.revision === otherRevision
      ? other.data.data
      : undefined;
  const headDetail = useResource<Revision>(
    head ? `${base}/history/${encodeURIComponent(head.revision)}` : null,
    scope.onDenied,
    0,
  );
  const headDefinition = definitionOf(
    headDetail.data?.data?.revision === head?.revision
      ? headDetail.data?.data
      : undefined,
  );
  const definition = definitionOf(record);
  const comparison = definitionOf(otherRecord);
  const isRule = section === "correlation-rules";
  const noun = isRule ? "rule" : "window";
  const listLabel = isRule ? "Correlation rules" : "Maintenance";
  const listHref = `/tenants/${scope.tenant.id}/${section}`;
  const detailHref = `${listHref}/${id}`;
  const name =
    typeof headDefinition?.name === "string" ? headDefinition.name : undefined;
  const deleted =
    activityOf(head ?? undefined).action === "deleted" ||
    Boolean(headDefinition?.deleted_at) ||
    headDefinition?.phase === "deleted";
  const unavailable =
    history.error instanceof ApiError && history.error.status === 404;
  const fields = isRule ? ruleFields : maintenanceFields;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selectedRow = rows?.find((row) => row.revision === selected);
  const selectedActivity = activityOf(record ?? selectedRow);
  function restart() {
    setSelected(null);
    if (cursor) setCursor(null);
    else history.reload();
  }
  return (
    <Page
      scope={scope}
      title={
        name ? `${name} history` : `${isRule ? "Rule" : "Maintenance"} history`
      }
      crumbs={[
        { label: listLabel, href: listHref },
        ...(name && !deleted ? [{ label: name, href: detailHref }] : []),
        ...(name && deleted ? [{ label: name }] : []),
      ]}
      extra={
        <span className="page-subtitle">Retained revisions are read-only</span>
      }
      actions={
        <button
          type="button"
          className="btn"
          onClick={() => scope.navigate(deleted ? listHref : detailHref)}
        >
          {deleted ? `Back to ${listLabel.toLowerCase()}` : `Back to ${noun}`}
        </button>
      }
    >
      <ErrorBanner error={history.error} />
      {history.data && !rows && (
        <ErrorBanner
          error={
            new Error("The history response does not match its API contract.")
          }
        />
      )}
      {unavailable && (
        <Banner tone="warn">
          Retained history is unavailable. It may have expired or your access
          may have changed.
        </Banner>
      )}
      <section
        className="th-grid grow"
        aria-label={`${isRule ? "Correlation rule" : "Maintenance"} retained history`}
      >
        <section className="panel th-list">
          <div className="panel-h">
            <h2>Revisions</h2>
            <span className="small muted">
              {rows
                ? `${rows.length}${history.data?.next_cursor ? "+" : ""}`
                : ""}
            </span>
            <span className="grow-x" />
            <button
              type="button"
              className="ibtn"
              disabled={history.loading}
              onClick={restart}
              aria-label="Refresh history"
              title="Refresh history"
            >
              Refresh
            </button>
          </div>
          <div
            className="th-scroll"
            aria-label="Retained revisions"
            role="list"
          >
            {history.loading && !rows && (
              <p className="th-empty" role="status">
                Loading retained history…
              </p>
            )}
            {rows && !history.error && !rows.length && (
              <p className="th-empty">No retained revisions.</p>
            )}
            {rows &&
              !history.error &&
              rows.map((row) => {
                const activity = activityOf(row);
                return (
                  <div role="listitem" key={row.revision}>
                    <button
                      type="button"
                      className={`rev ${selected === row.revision ? "rev-on" : ""}`}
                      aria-pressed={selected === row.revision}
                      aria-current={
                        selected === row.revision ? "true" : undefined
                      }
                      onClick={() => setSelected(row.revision)}
                    >
                      <span className="rev-top">
                        <b>Revision {row.revision}</b>
                        {head?.revision === row.revision && (
                          <span className="chip b-dark">Latest</span>
                        )}
                      </span>
                      <span className="small muted">
                        {activity.action
                          ? titleCase(activity.action)
                          : "Recorded"}
                        {activity.actor ? ` by ${display(activity.actor)}` : ""}
                        {" · "}
                        <span className="mono">
                          {timestamp(row.recorded_at)}
                        </span>
                      </span>
                      {activity.changed.length > 0 && (
                        <span className="small">
                          Changed: {activity.changed.join(", ")}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
          </div>
          <div className="th-foot">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!cursor || history.loading}
              onClick={() => {
                setSelected(null);
                setCursor(null);
              }}
            >
              First history page
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={
                !history.data?.next_cursor || history.loading || !!history.error
              }
              onClick={() => {
                setSelected(null);
                setCursor(history.data?.next_cursor ?? null);
              }}
            >
              Next history page
            </button>
          </div>
        </section>
        <section
          className="panel th-detail"
          aria-label={
            selected ? `Revision ${selected} detail` : "Revision detail"
          }
        >
          <div className="panel-h">
            <div className="th-head">
              <h2>{selected ? `Revision ${selected}` : "Revision"}</h2>
              {selected && (
                <span className="small muted">
                  {record || selectedRow ? (
                    <>
                      {selectedActivity.action
                        ? titleCase(selectedActivity.action)
                        : "Recorded"}
                      {selectedActivity.actor
                        ? ` by ${display(selectedActivity.actor)}`
                        : ""}
                      {" · "}
                      <span className="mono">
                        {timestamp((record ?? selectedRow)?.recorded_at)}
                      </span>{" "}
                      {zone}
                      {selectedActivity.changed.length
                        ? ` · changed fields: ${selectedActivity.changed.join(", ")}`
                        : ""}
                    </>
                  ) : null}
                </span>
              )}
            </div>
            <span className="grow-x" />
            {record && (
              <label className="small muted th-compare">
                Compare with
                <select
                  className="inp"
                  value={compare}
                  onChange={(event) =>
                    setCompare(event.target.value as "latest" | "previous")
                  }
                >
                  <option value="latest">Latest retained revision</option>
                  <option value="previous">Before this change</option>
                </select>
              </label>
            )}
          </div>
          <div className="th-body">
            {selected && !history.error && (
              <>
                <ErrorBanner error={detail.error} />
                {detail.loading && !record && (
                  <p className="th-empty" role="status">
                    Loading revision {selected}…
                  </p>
                )}
              </>
            )}
            {record && !detail.error && isRule && record.activity === null && (
              <p className="help th-note">
                Activity metadata is unavailable for this retained revision.
              </p>
            )}
            {record && !detail.error && !definition && (
              <p className="th-empty">
                The retained definition is unavailable.
              </p>
            )}
            {record && !detail.error && definition && (
              <div role="table" aria-label="Revision comparison">
                <div role="row" className="cmp cmp-head">
                  <span role="columnheader">Field</span>
                  {otherRevision && (
                    <span role="columnheader">
                      {compare === "latest" ? "Latest" : "Before"} · revision{" "}
                      {otherRevision}
                    </span>
                  )}
                  <span role="columnheader">
                    {otherRevision ? "Selected · " : ""}revision {selected}
                    {!otherRevision && head?.revision === selected
                      ? " (latest)"
                      : ""}
                  </span>
                </div>
                {fields.map((field) => {
                  const differs =
                    Boolean(comparison) &&
                    JSON.stringify(field.value(comparison!)) !==
                      JSON.stringify(field.value(definition));
                  return (
                    <div
                      role="row"
                      key={field.label}
                      className={`cmp ${otherRevision ? "" : "cmp-one"} ${differs ? "cmp-d" : ""}`}
                    >
                      <span role="cell" className="cmp-label">
                        <span className="lbl">{field.label}</span>
                        {differs && (
                          <span className="chip b-amber">Differs</span>
                        )}
                      </span>
                      {otherRevision && (
                        <span
                          role="cell"
                          className={field.mono ? "mono cmp-mono" : undefined}
                        >
                          {comparison
                            ? field.render(comparison)
                            : other.loading
                              ? "Loading…"
                              : "Unavailable"}
                        </span>
                      )}
                      <span
                        role="cell"
                        className={field.mono ? "mono cmp-mono" : undefined}
                      >
                        {field.render(definition)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="th-foot">
            <span className="help">
              Read-only retained evidence. Historical definitions do not restore
              a deleted {noun} or change current{" "}
              {isRule ? "correlation evidence" : "suppression coverage"}.
            </span>
          </div>
        </section>
      </section>
    </Page>
  );
}
