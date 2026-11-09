"use client";
import { DashboardWorkspace } from "./dashboard-workspace";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type RecordData,
  display,
  request,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useResource } from "@/lib/hooks";
import {
  columnsSummary,
  sortSentence,
  timezoneLabel,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { CelCode, PresetEditor } from "./definition-editor";
import { groupFieldLabel } from "./alert-groups";
import { ErrorNotice } from "./ui";
import { NavLink, Page } from "./page";

interface Revision {
  revision: string;
  recorded_at: string;
  definition_available: boolean;
  activity_available: boolean;
}
interface Activity {
  kind: string;
  command_id: string;
  actor_id: string;
  actor_label: string;
  actor_display_name?: string;
  before_revision: string | null;
  after_revision: string;
  changed_fields: string[] | null;
  recorded_at: string;
}
interface Detail {
  definition: Record<string, unknown>;
  before_definition: Record<string, unknown> | null;
  activity: Activity | null;
}
interface HistoryPanel {
  id?: string;
  /** Absent in revisions saved before REV-57, which hold only count panels. */
  type?: "count" | "html" | "image";
  preset_id?: string;
  title?: string | null;
  w?: number;
  h?: number;
  thresholds?: { lower_bound: string; color: string }[];
}
type Kind = "presets" | "dashboards";
function copyDefinition(definition: Record<string, unknown>, section: Kind) {
  return {
    ...definition,
    name: "",
    ...(section === "dashboards" && Array.isArray(definition.panels)
      ? {
          panels: definition.panels.map((panel) => ({
            ...panel,
            id: crypto.randomUUID(),
          })),
        }
      : {}),
  };
}
const FIELDS: Record<Kind, [string, string][]> = {
  presets: [
    ["name", "Name"],
    ["cel", "Filter"],
    ["columns", "Columns"],
    ["sort", "Sort"],
    ["group_by", "Grouping"],
    ["noisy", "Alarm"],
  ],
  dashboards: [
    ["name", "Name"],
    ["panels", "Panels"],
  ],
};
const CHANGED: Record<string, string> = {
  cel: "filter",
  group_by: "grouping",
  noisy: "alarm",
};
// Revisions saved before REV-44 have no group_by: they were not grouped.
// Revisions saved before REV-58 have no noisy flag: they were silent.
const fieldValue = (definition: Record<string, unknown>, field: string) =>
  field === "group_by"
    ? (definition[field] ?? null)
    : field === "noisy"
      ? definition[field] === true
      : definition[field];
function activityVerb(kind: string) {
  return /delet/i.test(kind)
    ? "Deleted"
    : /creat/i.test(kind)
      ? "Created"
      : /restor/i.test(kind)
        ? "Restored"
        : "Updated";
}
function changedFields(fields: string[] | null | undefined) {
  return fields?.length
    ? fields
        .map((field) => CHANGED[field] ?? field.replaceAll("_", " "))
        .join(", ")
    : "Not recorded";
}
function actorName(activity: Activity) {
  return display(
    activity.actor_display_name ?? activity.actor_label ?? activity.actor_id,
  );
}

/**
 * Activity summaries for the visible revision list. The list endpoint carries
 * no actor or changed fields, so each revision's retained detail is read with
 * a small concurrency limit.
 */
function useRevisionSummaries(
  base: string,
  revisions: string[],
  onDenied: () => void,
) {
  const [summaries, setSummaries] = useState<
    Record<string, Activity | null | "unavailable">
  >({});
  const known = useRef(summaries);
  known.current = summaries;
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const key = revisions.join(",");
  useEffect(() => {
    const queue = key
      ? key.split(",").filter((revision) => !(revision in known.current))
      : [];
    if (!queue.length) return;
    const controller = new AbortController();
    let next = 0;
    async function worker() {
      while (next < queue.length && !controller.signal.aborted) {
        const revision = queue[next++];
        try {
          const result = await request<Detail>(
            `${base}/history/${encodeURIComponent(revision)}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setSummaries((previous) => ({
            ...previous,
            [revision]: result.data?.activity ?? null,
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && [401, 403].includes(error.status))
            denied.current();
          setSummaries((previous) => ({
            ...previous,
            [revision]: "unavailable",
          }));
        }
      }
    }
    void Promise.all([worker(), worker(), worker()]);
    return () => controller.abort();
  }, [base, key]);
  return summaries;
}

export function ConfigurationHistory({
  scope,
  section,
  id,
}: {
  scope: Scope;
  section: Kind;
  id: string;
}) {
  const base = `${tenantPath(scope.tenant.id)}/${section}/${id}`;
  const [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [compare, setCompare] = useState<"current" | "before" | null>(null);
  const [draft, setDraft] = useState<{
    source: string;
    initial: Record<string, unknown>;
    existing?: RecordData;
  } | null>(null);
  const [saved, setSaved] = useState<RecordData>();
  // Keep the reviewed history page stable. Live current revisions advertise
  // newer history below; explicit refresh obtains a new history watermark.
  const history = useResource<Revision[]>(
    `${base}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
    0,
  );
  const detail = useResource<Detail>(
    selected ? `${base}/history/${encodeURIComponent(selected)}` : null,
    scope.onDenied,
    0,
  );
  const current = useResource<RecordData>(base, scope.onDenied, scope.version);
  const presetNames = useResource<RecordData[]>(
    section === "dashboards"
      ? `${tenantPath(scope.tenant.id)}/presets?limit=200`
      : null,
    scope.onDenied,
    scope.version,
  );
  const names = new Map<string, string>();
  if (Array.isArray(presetNames.data?.data))
    for (const row of presetNames.data.data)
      names.set(row.id, display(row.name));
  const currentDefinition = current.data?.data;
  const rows = Array.isArray(history.data?.data) ? history.data.data : [];
  const summaries = useRevisionSummaries(
    base,
    rows.map((row) => row.revision),
    scope.onDenied,
  );
  const firstRevision = rows[0]?.revision;
  const newerHistory =
    !cursor &&
    firstRevision &&
    currentDefinition &&
    /^\d+$/.test(firstRevision) &&
    /^\d+$/.test(currentDefinition.revision) &&
    BigInt(currentDefinition.revision) > BigInt(firstRevision);
  const deleted =
    current.error instanceof ApiError && current.error.status === 404;
  const retained = detail.data?.data;
  useEffect(() => {
    if (!selected && rows[0]) setSelected(rows[0].revision);
  }, [selected, rows]);
  const canEdit = scope.tenant.role !== "view";
  const singular = section === "presets" ? "preset" : "dashboard";
  const listHref = `/tenants/${scope.tenant.id}/${section}`;
  const detailHref = `${listHref}/${id}`;
  if (draft) {
    const Editor = section === "presets" ? PresetEditor : DashboardWorkspace;
    return (
      <Editor
        key={`${id}:${draft.source}:${draft.existing ? "reuse" : "copy"}`}
        scope={scope}
        existing={draft.existing}
        current={currentDefinition}
        initialDraft={draft.initial}
        onSaved={(row) => {
          setDraft(null);
          setSaved(row);
          history.reload();
          current.reload();
        }}
        onDiscard={() => setDraft(null)}
        context={
          <p className="banner bn-info" role="status">
            Draft from retained revision {draft.source}.{" "}
            {draft.existing
              ? `Opened against current revision ${draft.existing.revision}. No shared change is made until you save.`
              : "Choose a unique name. Saving creates a new shared identity; old links and references remain unchanged."}
            {draft.existing && deleted
              ? " The original definition is no longer active. Use Save as new to create another identity."
              : ""}
          </p>
        }
      />
    );
  }
  const effective =
    compare ??
    (currentDefinition && !current.error && !deleted ? "current" : "before");
  const left =
    effective === "current"
      ? current.error
        ? undefined
        : currentDefinition
      : (retained?.before_definition ?? undefined);
  const name = display(
    currentDefinition?.name ?? retained?.definition.name ?? "",
  );
  const title = name && name !== "—" ? `${name} history` : "History";
  const timezone = timezoneLabel().split(" ")[0];
  function renderValue(field: string, value: unknown) {
    if (field === "group_by") return groupFieldLabel(value);
    if (field === "noisy") return value === true ? "Noisy" : "Silent";
    if (value === undefined) return <span className="muted">Unavailable</span>;
    if (field === "cel")
      return (
        <span className="mono cmp-code">
          <CelCode source={String(value)} />
        </span>
      );
    if (field === "columns") return columnsSummary(value);
    if (field === "sort") return sortSentence(value);
    if (field === "panels") {
      const panels = Array.isArray(value) ? (value as HistoryPanel[]) : [];
      return panels.length ? (
        <ol className="cmp-panels">
          {panels.map((panel, index) => (
            <li key={panel.id ?? index}>
              <b>
                {panel.title ??
                  (panel.preset_id ? names.get(panel.preset_id) : undefined) ??
                  "Untitled panel"}
              </b>
              <span className="small muted">
                {" · "}
                {panel.type === "html"
                  ? "HTML panel"
                  : panel.type === "image"
                    ? "Image panel"
                    : panel.preset_id
                      ? `Preset: ${names.get(panel.preset_id) ?? panel.preset_id}`
                      : "No preset"}
                {` · ${panel.w ?? "?"} × ${panel.h ?? "?"}`}
                {panel.thresholds?.length
                  ? ` · ${panel.thresholds
                      .map(
                        (item) => `at least ${item.lower_bound} ${item.color}`,
                      )
                      .join(", ")}`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <span className="muted">No panels</span>
      );
    }
    return display(value);
  }
  return (
    <Page
      scope={scope}
      className="config-history"
      title={title}
      crumbs={[
        {
          label: section === "presets" ? "Presets" : "Dashboards",
          href: listHref,
        },
        ...(name && name !== "—"
          ? [{ label: name, href: deleted ? undefined : detailHref }]
          : []),
      ]}
      extra={
        <span className="page-subtitle">Retained revisions are read-only</span>
      }
      actions={
        <NavLink
          scope={scope}
          className="btn"
          href={deleted ? listHref : detailHref}
        >
          {deleted ? `Back to ${section}` : `Back to ${singular}`}
        </NavLink>
      }
    >
      {saved && (
        <p className="banner bn-ok" role="status">
          Saved shared definition {display(saved.name)}.
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => scope.navigate(`${listHref}/${saved.id}`)}
          >
            Open saved definition
          </button>
        </p>
      )}
      {deleted && (
        <p className="banner bn-warn">
          The original {singular} is no longer active. Retained history can be
          copied into a new draft; there is no undelete action.
        </p>
      )}
      {!deleted && <ErrorNotice error={current.error} />}
      <ErrorNotice error={history.error} />
      {newerHistory && (
        <p className="banner bn-info" role="status">
          A newer shared revision is available. Refresh history to review it.
        </p>
      )}
      <div className="hist">
        <section className="panel hist-list" aria-label="Revision list">
          <div className="panel-h">
            <h2>Revisions</h2>
            <span className="small muted">
              {rows.length}
              {history.data?.next_cursor ? "+" : ""}
            </span>
            <span style={{ flexGrow: 1 }} />
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={history.loading}
              onClick={() => {
                history.reload();
                current.reload();
                detail.reload();
              }}
            >
              Refresh history
            </button>
          </div>
          <div className="hist-scroll">
            <p className="sr-only" role="status">
              {history.loading
                ? "Loading revision history…"
                : "Revision history loaded."}
            </p>
            {history.loading && !history.data && (
              <p className="hist-empty">Loading revision history…</p>
            )}
            {history.data && !rows.length && (
              <p className="hist-empty">No retained revisions are available.</p>
            )}
            <ul aria-label="Retained revisions">
              {rows.map((revision) => {
                const summary = summaries[revision.revision];
                const isCurrent =
                  !deleted && currentDefinition?.revision === revision.revision;
                return (
                  <li key={revision.revision}>
                    <button
                      type="button"
                      className={`rev ${selected === revision.revision ? "rev-on" : ""}`}
                      aria-pressed={selected === revision.revision}
                      onClick={() => setSelected(revision.revision)}
                    >
                      <span className="rev-title">
                        <b>Revision {revision.revision}</b>
                        {isCurrent && (
                          <span className="chip b-dark">Current</span>
                        )}
                      </span>
                      <span className="small muted">
                        {summary && summary !== "unavailable"
                          ? `${activityVerb(summary.kind)} by ${actorName(summary)} · `
                          : ""}
                        <span className="mono">
                          {timestamp(revision.recorded_at)}
                        </span>
                      </span>
                      <span className="small">
                        {summary === undefined
                          ? revision.activity_available
                            ? "Loading change summary…"
                            : "Activity unavailable"
                          : summary === "unavailable"
                            ? "Details unavailable"
                            : summary === null
                              ? "Activity unavailable"
                              : `Changed: ${changedFields(summary.changed_fields)}`}
                        {!revision.definition_available &&
                          " · definition unavailable"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {(cursor || history.data?.next_cursor) && (
            <div className="hist-pager">
              <button
                type="button"
                className="btn btn-sm btn-g"
                disabled={!cursor}
                onClick={() => setCursor(null)}
              >
                First history page
              </button>
              <button
                type="button"
                className="btn btn-sm btn-g"
                disabled={!history.data?.next_cursor || history.loading}
                onClick={() => setCursor(history.data?.next_cursor ?? null)}
              >
                Next history page
              </button>
            </div>
          )}
        </section>
        <section className="panel hist-detail" aria-label="Revision detail">
          <ErrorNotice error={detail.error} />
          <p className="sr-only" role="status">
            {detail.loading && selected
              ? `Loading revision ${selected}…`
              : retained && detail.error
                ? "Previous successful revision detail · unavailable"
                : selected
                  ? `Retained revision ${selected}.`
                  : "Select a retained revision."}
          </p>
          {!selected && history.data && (
            <p className="hist-empty">Select a retained revision.</p>
          )}
          {retained && selected && !detail.error && (
            <section
              className="hist-compare"
              aria-label={`Revision ${selected} comparison`}
            >
              <div className="panel-h">
                <div className="hist-head">
                  <h2>Revision {selected}</h2>
                  {retained.activity ? (
                    <span className="small muted">
                      {activityVerb(retained.activity.kind)} by{" "}
                      {actorName(retained.activity)} ·{" "}
                      <span className="mono">
                        {timestamp(retained.activity.recorded_at)}
                      </span>{" "}
                      {timezone} · changed fields:{" "}
                      {changedFields(retained.activity.changed_fields)}
                    </span>
                  ) : (
                    <span className="small muted">
                      Activity metadata is unavailable for this retained
                      revision.
                    </span>
                  )}
                </div>
                <div style={{ flexGrow: 1 }} />
                <label className="hist-select small muted">
                  Compare with
                  <select
                    className="inp"
                    value={effective}
                    onChange={(event) =>
                      setCompare(event.target.value as "current" | "before")
                    }
                  >
                    <option
                      value="current"
                      disabled={!currentDefinition || Boolean(current.error)}
                    >
                      Current saved definition
                    </option>
                    <option value="before">Before this change</option>
                  </select>
                </label>
              </div>
              <div
                role="table"
                aria-label="Revision comparison"
                className="cmp-table"
              >
                <div role="row" className="cmp cmp-h">
                  <span role="columnheader">Field</span>
                  <span role="columnheader">
                    {effective === "current"
                      ? `Current · revision ${currentDefinition?.revision ?? "unavailable"}`
                      : `Before this change${
                          retained.activity?.before_revision
                            ? ` · revision ${retained.activity.before_revision}`
                            : ""
                        }`}
                  </span>
                  <span role="columnheader">
                    Selected · revision {selected}
                  </span>
                </div>
                {!left && (
                  <div role="row" className="cmp">
                    <span role="cell" />
                    <span role="cell" className="small muted">
                      The comparison definition is unavailable; it is not an
                      empty definition.
                    </span>
                    <span role="cell" />
                  </div>
                )}
                {FIELDS[section].map(([field, label]) => {
                  const differs =
                    left !== undefined &&
                    JSON.stringify(fieldValue(left, field)) !==
                      JSON.stringify(fieldValue(retained.definition, field));
                  return (
                    <div
                      role="row"
                      key={field}
                      className={`cmp ${differs ? "cmp-d" : ""}`}
                    >
                      <span role="cell" className="cmp-field">
                        <span className="lbl">{label}</span>
                        {differs && (
                          <span className="chip b-amber">Differs</span>
                        )}
                      </span>
                      <span role="cell">
                        {left
                          ? renderValue(field, fieldValue(left, field))
                          : null}
                      </span>
                      <span role="cell">
                        {renderValue(
                          field,
                          fieldValue(retained.definition, field),
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="hist-foot">
                <span className="help">
                  {canEdit
                    ? deleted
                      ? `This ${singular} was deleted. “Save as new draft…” copies this revision into a new ${singular}.`
                      : `“Use this revision” opens it as an unsaved draft of this ${singular}. Nothing changes until you save.`
                    : `You can compare revisions. Editing requires edit access in ${scope.tenant.name}.`}
                </span>
                <div style={{ flexGrow: 1 }} />
                {canEdit && (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(detail.error)}
                      onClick={() => {
                        setSaved(undefined);
                        setDraft({
                          source: selected,
                          initial: copyDefinition(retained.definition, section),
                        });
                      }}
                    >
                      Save as new draft…
                    </button>
                    {!deleted && (
                      <button
                        type="button"
                        className="btn btn-p"
                        disabled={
                          !currentDefinition ||
                          Boolean(current.error) ||
                          Boolean(detail.error)
                        }
                        onClick={() => {
                          if (currentDefinition) {
                            setSaved(undefined);
                            setDraft({
                              source: selected,
                              initial: retained.definition,
                              existing: currentDefinition,
                            });
                          }
                        }}
                      >
                        Use this revision
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
        </section>
      </div>
    </Page>
  );
}
