"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  message,
  RecordData,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { AlertStatus, NavLink, Page, Severity, personLabel } from "./page";
import { rememberAlertList } from "./alerts";
import { DirectoryPicker } from "./directory-picker";
import { IncidentList, INCIDENT_STATUS } from "./incident-list";
import { IncidentMembership } from "./incident-membership";
import { IncidentNotes, type NotesSummary } from "./incident-notes";

/** Routes the incident list, creation form and incident detail. */
export function IncidentPages(scope: Scope & { section: string; id?: string }) {
  if (!scope.id) return <IncidentList key={scope.tenant.id} scope={scope} />;
  if (scope.id === "new")
    return <IncidentCreate key={`${scope.tenant.id}:new`} scope={scope} />;
  return (
    <IncidentDetail
      key={`${scope.tenant.id}:${scope.id}`}
      scope={scope}
      id={scope.id}
    />
  );
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
/** Describes recorded inactivity resolutions only; the sweep is deferred (REV-34). */
const INACTIVITY_DAYS = 30;

function cap(value: unknown) {
  return typeof value === "string" && value
    ? value[0].toUpperCase() + value.slice(1)
    : "—";
}
function str(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
function num(value: unknown) {
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : undefined;
}
/** Principal label that also accepts rows carrying only a display name. */
function who(
  scope: Scope,
  id: unknown,
  name: unknown,
  fallback = "Unassigned",
) {
  if (typeof id === "string" && id) return personLabel(scope, id, name);
  return str(name) ?? fallback;
}
function initials(label: string) {
  const parts = label
    .replace(/\(you\)$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[1][0] : "")
  ).toUpperCase();
}
function groupText(group: unknown): string | undefined {
  if (!group || typeof group !== "object") return str(group);
  const entries = Array.isArray(group)
    ? group.filter((item): item is [string, unknown] => Array.isArray(item))
    : Object.entries(group);
  return entries.length
    ? entries
        .map(
          ([key, value]) =>
            `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
        .join(", ")
    : undefined;
}
function alertKey(row: RecordData) {
  return String(row.alert_id ?? row.id ?? row.reference_id ?? "");
}

/* ------------------------------------------------------------------ create */

function IncidentCreate({ scope }: { scope: Scope }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("");
  const [dirty, setDirty] = useState(false);
  const [created, setCreated] = useState<string>();
  const [missingSeverity, setMissingSeverity] = useState(false);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const listHref = `/tenants/${scope.tenant.id}/incidents`;
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
  useEffect(() => {
    if (created && !dirty) scope.navigate(created);
  }, [created, dirty, listHref, scope.navigate]);
  const locked = command.busy || command.uncertain;
  async function save() {
    if (!severity) {
      setMissingSeverity(true);
      return;
    }
    const result = await command.execute<RecordData>(
      `${tenantPath(scope.tenant.id)}/incidents`,
      { title, description, severity, alert_ids: [] },
      "POST",
    );
    if (result) {
      setDirty(false);
      scope.setDirty(false);
      setCreated(result.data?.id ? `${listHref}/${result.data.id}` : listHref);
    }
  }
  const editable = scope.tenant.role !== "view";
  return (
    <Page
      scope={scope}
      title="New incident"
      crumbs={[{ label: "Incidents", href: listHref }]}
      actions={
        editable ? (
          <>
            <NavLink scope={scope} className="btn btn-g" href={listHref}>
              Discard
            </NavLink>
            <button
              type="submit"
              form="incident-create"
              className="btn btn-p"
              disabled={command.busy}
            >
              {command.uncertain ? "Retry create incident" : "Create incident"}
            </button>
          </>
        ) : undefined
      }
    >
      {!editable ? (
        <p className="banner bn-warn">
          Creating incidents requires edit access to this tenant.
        </p>
      ) : (
        <div className="inc-edit-grid">
          <section className="panel inc-edit-main">
            <form
              id="incident-create"
              className="inc-form"
              onChange={() => setDirty(true)}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="f">
                <label className="lbl" htmlFor="incident-title">
                  Title
                </label>
                <input
                  id="incident-title"
                  className="inp"
                  value={title}
                  required
                  maxLength={200}
                  disabled={locked}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="f">
                <label className="lbl" htmlFor="incident-description">
                  Description <span className="inc-optional">(optional)</span>
                </label>
                <textarea
                  id="incident-description"
                  className="inp"
                  rows={5}
                  value={description}
                  maxLength={10000}
                  disabled={locked}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div className="f">
                <span className="lbl" id="incident-severity-label">
                  Severity
                </span>
                <div
                  className="seg"
                  role="radiogroup"
                  aria-labelledby="incident-severity-label"
                  aria-describedby="incident-severity-help"
                >
                  {SEVERITIES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={severity === value}
                      className={severity === value ? "on" : undefined}
                      disabled={locked}
                      onClick={() => {
                        setSeverity(value);
                        setDirty(true);
                        setMissingSeverity(false);
                      }}
                    >
                      <Severity value={value} />
                    </button>
                  ))}
                </div>
                <span className="help" id="incident-severity-help">
                  Severity cannot change after the incident is created.
                </span>
                {missingSeverity && (
                  <span className="inc-field-error" role="alert">
                    Choose a severity.
                  </span>
                )}
              </div>
              <div className="banner bn-info">
                The incident opens with status Open and no assignee. Link
                alerts, assign it and add notes from its page after creation.
              </div>
              <IncidentFeedback command={command} />
            </form>
          </section>
          <aside className="panel inc-edit-aside">
            <div className="panel-h">
              <h2>How incidents work</h2>
            </div>
            <ul className="inc-facts">
              <li>Status and assignment are independent.</li>
              <li>An alert can belong to only one active incident.</li>
              <li>
                Incidents stay active until someone resolves them or all their
                linked alerts resolve; nothing removes an incident
                automatically.
              </li>
            </ul>
          </aside>
        </div>
      )}
    </Page>
  );
}

/* ---------------------------------------------------------- command status */

function IncidentFeedback({
  command,
  retry,
}: {
  command: { error?: unknown; uncertain: boolean; busy: boolean };
  retry?: () => void;
}) {
  if (!command.error && !command.uncertain) return null;
  return command.uncertain ? (
    <div className="banner bn-warn" role="status">
      <span>
        The outcome is uncertain. Retry repeats the original command and values.
      </span>
      {retry && (
        <button
          type="button"
          className="btn btn-sm"
          disabled={command.busy}
          onClick={retry}
        >
          Retry original command
        </button>
      )}
    </div>
  ) : (
    <div className="banner bn-err" role="alert">
      {message(command.error)}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

type Tab = "activity" | "notes" | "cycles";

function IncidentDetail({ scope, id }: { scope: Scope; id: string }) {
  const prefix = tenantPath(scope.tenant.id);
  const path = `${prefix}/incidents/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const incident = result.data?.data;
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [memberDirty, setMemberDirty] = useState(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("activity");
  const [membership, setMembership] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const [notes, setNotes] = useState<NotesSummary>();
  const [linkedCursor, setLinkedCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [cycleCursor, setCycleCursor] = useState<string | null>(null);
  const page = (cursor: string | null) =>
    `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const linked = useResource<RecordData[]>(
    `${path}/alerts${page(linkedCursor)}`,
    scope.onDenied,
    linkedCursor ? 0 : scope.version,
  );
  const activity = useResource<RecordData[]>(
    `${path}/activity${page(activityCursor)}`,
    scope.onDenied,
    activityCursor ? 0 : scope.version,
  );
  const cycles = useResource<RecordData[]>(
    `${path}/cycles${page(cycleCursor)}`,
    scope.onDenied,
    cycleCursor ? 0 : scope.version,
  );
  const activityRows = Array.isArray(activity.data?.data)
    ? activity.data.data
    : [];
  const origin = activityRows.find((row) =>
    ["correlation-created", "correlation-added"].includes(String(row.kind)),
  )?.evidence as Record<string, unknown> | undefined;
  const ruleId =
    str(incident?.origin_rule_id) ??
    str(incident?.rule_id) ??
    str(origin?.rule_id);
  const recordedName = str(incident?.origin_rule_name);
  const rule = useResource<RecordData>(
    ruleId && !recordedName ? `${prefix}/correlation-rules/${ruleId}` : null,
    scope.onDenied,
  );
  const ruleName = recordedName ?? str(rule.data?.data?.name);
  const group = groupText(origin?.group);
  const dirty = memberDirty || noteDirty || editDirty;
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
  const reloadAll = useCallback(() => {
    result.reload();
    linked.reload();
    activity.reload();
    cycles.reload();
  }, [result.reload, linked.reload, activity.reload, cycles.reload]);
  async function action(suffix: string, body: Record<string, unknown>) {
    if (
      incident &&
      (await command.execute(`${path}/${suffix}`, {
        expected_revision: incident.revision,
        ...body,
      }))
    ) {
      setPicker(false);
      reloadAll();
    }
  }
  async function retry() {
    if (await command.execute(path, {})) reloadAll();
  }
  const listHref = `/tenants/${scope.tenant.id}/incidents`;
  const crumbs = [{ label: "Incidents", href: listHref }];
  if (!incident)
    return (
      <Page scope={scope} title="Incident" crumbs={crumbs}>
        <ErrorNotice error={result.error} />
        {result.loading && <p role="status">Loading incident…</p>}
      </Page>
    );

  const editable = scope.tenant.role !== "view";
  const resolved = incident.status === "resolved";
  const title = str(incident.title) ?? incident.id;
  const locked = command.busy || command.uncertain;
  const assigneeLabel = who(
    scope,
    incident.assignee_id,
    incident.assignee_display_name,
  );
  const assigned = Boolean(
    incident.assignee_id ?? incident.assignee_display_name,
  );
  const mine = incident.assignee_id === scope.session.principal.id;

  const linkedRows = Array.isArray(linked.data?.data) ? linked.data.data : [];
  const linkedComplete =
    !linkedCursor && !linked.data?.next_cursor && Boolean(linked.data);
  const total =
    num(incident.total_linked) ??
    num(incident.alert_count) ??
    (linkedComplete ? String(linkedRows.length) : undefined);
  const suppressed =
    num(incident.suppressed) ??
    (linkedComplete
      ? String(linkedRows.filter((row) => row.suppressed === true).length)
      : undefined);
  const unavailable =
    num(incident.unavailable) ??
    (linkedComplete
      ? String(linkedRows.filter((row) => !row.message && !row.id).length)
      : undefined);
  const alertNames = new Map(
    linkedRows.map((row) => [
      alertKey(row),
      str(row.name) ?? str(row.message) ?? alertKey(row),
    ]),
  );

  const cycleRows = Array.isArray(cycles.data?.data) ? cycles.data.data : [];
  const cyclesComplete =
    !cycleCursor && !cycles.data?.next_cursor && Boolean(cycles.data);
  const currentIndex = cycleRows.findIndex(
    (row) => row.id === incident.cycle_id,
  );
  const current = currentIndex >= 0 ? cycleRows[currentIndex] : undefined;
  const cycleNumber =
    num(current?.cycle_number) ??
    (current && cyclesComplete
      ? String(cycleRows.length - currentIndex)
      : undefined);
  const cycleCount =
    cycles.data && !cycleCursor
      ? `${cycleRows.length}${cycles.data.next_cursor ? "+" : ""}`
      : undefined;
  const lastActivity = incident.last_activity ?? incident.updated_at;
  const resolvedAt = incident.resolved_at ?? current?.resolved_at;
  const cause = str(current?.cause);

  const correlation = incident.origin === "correlation";
  const originChip = correlation ? (
    ruleId ? (
      <NavLink
        scope={scope}
        className="chip b-violet"
        href={`/tenants/${scope.tenant.id}/correlation-rules/${ruleId}`}
        title={group ? `Group ${group}` : undefined}
      >
        Created by correlation rule{ruleName ? ` ${ruleName}` : ""}
      </NavLink>
    ) : (
      <span className="chip b-violet">Created by correlation</span>
    )
  ) : incident.origin === "manual" ? (
    <span className="chip b-neutral">Manual</span>
  ) : null;

  const context: Describe = {
    scope,
    incident,
    alertNames,
    noteTexts: notes?.texts ?? new Map(),
    ruleName,
    group,
  };

  return (
    <Page
      scope={scope}
      title={title}
      crumbs={crumbs}
      extra={
        <>
          <span className="inc-head-sev">
            <Severity value={incident.severity} />
          </span>
          {originChip}
        </>
      }
      actions={
        editable ? (
          <button
            type="button"
            className="btn"
            disabled={memberDirty || noteDirty}
            onClick={() => setEditing(true)}
          >
            Edit title and description
          </button>
        ) : undefined
      }
    >
      <ErrorNotice error={result.error} />
      <div className="inc-detail">
        <div className="inc-main">
          <section
            className="panel inc-control"
            aria-label="Incident status and assignment"
            aria-busy={command.busy}
          >
            <div className="f">
              <span className="lbl" id="incident-status-label">
                Status
              </span>
              <div
                className="seg"
                role="group"
                aria-labelledby="incident-status-label"
              >
                {(["open", "investigating", "resolved"] as const).map(
                  (status) => (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={incident.status === status}
                      className={incident.status === status ? "on" : undefined}
                      disabled={!editable || locked}
                      onClick={() => {
                        if (incident.status !== status)
                          void action("status", { status });
                      }}
                    >
                      {INCIDENT_STATUS[status]}
                    </button>
                  ),
                )}
              </div>
            </div>
            <div className="f inc-assign">
              <span className="lbl">Assignee</span>
              <div className="inc-assign-row">
                <span className={`inc-person ${assigned ? "" : "ack-n"}`}>
                  <span aria-hidden="true" className="inc-avatar">
                    {assigned ? initials(assigneeLabel) : "–"}
                  </span>
                  {assigneeLabel}
                </span>
                {editable && (
                  <button
                    type="button"
                    className="btn"
                    aria-expanded={picker}
                    aria-controls="incident-assignment-options"
                    disabled={locked}
                    onClick={() => setPicker((value) => !value)}
                  >
                    Assign…
                  </button>
                )}
              </div>
              {picker && editable && (
                <Popover onClose={() => setPicker(false)}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={locked || mine}
                    onClick={() => {
                      setPicker(false);
                      void action("assignment", {
                        assignee_id: scope.session.principal.id,
                      });
                    }}
                  >
                    Assign to me
                  </button>
                  {assigned && (
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={locked}
                      onClick={() => {
                        setPicker(false);
                        void action("assignment", { assignee_id: null });
                      }}
                    >
                      Unassign
                    </button>
                  )}
                  <DirectoryPicker
                    key={scope.tenant.id}
                    label="Assign incident to a user"
                    endpoint={`${prefix}/assignees`}
                    onDenied={scope.onDenied}
                    disabled={locked}
                    onChoose={(principal) => {
                      setPicker(false);
                      void action("assignment", { assignee_id: principal.id });
                    }}
                  />
                </Popover>
              )}
            </div>
            <div className="inc-times">
              {resolved ? (
                <span className="small muted">
                  Resolved{" "}
                  <span className="mono inc-strong">
                    {timestamp(resolvedAt)}
                  </span>
                  {cause === "inactivity"
                    ? ` · after ${INACTIVITY_DAYS} days without activity`
                    : cause === "manual"
                      ? " · manually"
                      : cause === "alerts_resolved"
                        ? " · when all linked alerts resolved"
                        : ""}
                </span>
              ) : (
                <span className="small muted">
                  Last activity{" "}
                  <span className="mono inc-strong">
                    {timestamp(lastActivity)}
                  </span>
                </span>
              )}
              <span className="small muted">
                Opened{" "}
                <span className="mono">
                  {timestamp(current?.opened_at ?? incident.created_at)}
                </span>
                {cycleNumber ? ` · cycle ${cycleNumber}` : ""}
              </span>
            </div>
            <div className="inc-control-feedback">
              <IncidentFeedback command={command} retry={() => void retry()} />
            </div>
          </section>
          <section className="panel inc-desc" aria-labelledby="inc-desc-label">
            <span className="lbl" id="inc-desc-label">
              Description
            </span>
            <p className={str(incident.description) ? undefined : "muted"}>
              {str(incident.description) ?? "No description."}
            </p>
          </section>
          <section
            className="panel inc-linked"
            aria-labelledby="inc-linked-title"
          >
            <div className="panel-h">
              <h2 id="inc-linked-title">Linked alerts</h2>
              <span className="small muted">
                {[
                  total !== undefined ? `${total} total` : undefined,
                  suppressed !== undefined
                    ? `${suppressed} suppressed`
                    : undefined,
                  unavailable !== undefined
                    ? `${unavailable} unavailable`
                    : undefined,
                  incident.maintenance_updating === true
                    ? "suppression updating"
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="grow" />
              {editable && !resolved && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setMembership("link")}
                  >
                    Link alerts…
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-g"
                    onClick={() => setMembership("unlink")}
                  >
                    Unlink or move…
                  </button>
                </>
              )}
              {editable && resolved && (
                <span className="small muted">
                  Reopen the incident to change its links.
                </span>
              )}
            </div>
            <LinkedAlerts
              scope={scope}
              rows={linkedRows}
              label={title}
              href={`${listHref}/${id}`}
            />
            <ErrorNotice error={linked.error} />
            {linked.loading && !linked.data && (
              <p className="inc-table-state" role="status">
                Loading linked alerts…
              </p>
            )}
            {linked.data && !linkedRows.length && (
              <p className="inc-table-state muted">
                No alerts are linked to this incident.
              </p>
            )}
            {(linkedCursor || linked.data?.next_cursor) && (
              <div className="table-footer-bar">
                <span className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!linkedCursor}
                  onClick={() => setLinkedCursor(null)}
                >
                  First linked alerts
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!linked.data?.next_cursor || linked.loading}
                  onClick={() =>
                    setLinkedCursor(linked.data?.next_cursor ?? null)
                  }
                >
                  Next linked alerts
                </button>
              </div>
            )}
          </section>
        </div>
        <aside className="panel inc-aside">
          <div
            className="tabbar inc-tabs"
            role="tablist"
            aria-label="Incident records"
          >
            {(
              [
                ["activity", "Activity", undefined],
                [
                  "notes",
                  "Notes",
                  notes ? `${notes.count}${notes.more ? "+" : ""}` : undefined,
                ],
                ["cycles", "Cycles", cycleCount],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`inc-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`inc-pane-${key}`}
                className={`tab ${tab === key ? "tab-on" : ""}`}
                onClick={() => setTab(key)}
              >
                {label}
                {count !== undefined && <b>{count}</b>}
              </button>
            ))}
          </div>
          <div
            className="inc-pane"
            id="inc-pane-activity"
            role="tabpanel"
            aria-labelledby="inc-tab-activity"
            hidden={tab !== "activity"}
          >
            <ErrorNotice error={activity.error} />
            {activity.loading && !activity.data && (
              <p role="status">Loading activity…</p>
            )}
            {activity.data && !activityRows.length && (
              <p className="muted small">No activity recorded.</p>
            )}
            <div className="tl">
              {activityRows.map((row, index) => {
                const line = describe(row, context);
                return (
                  <div className="tl-i" key={row.id ?? index}>
                    <i className={line.dot} aria-hidden="true" />
                    <div>
                      <div className="tl-t">
                        <b>{line.what}</b> {line.detail}
                      </div>
                      <div className="tl-m">
                        {timestamp(row.recorded_at ?? row.created_at)} ·{" "}
                        {line.who}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <Pager
              label="activity"
              cursor={activityCursor}
              next={activity.data?.next_cursor}
              loading={activity.loading}
              onPage={setActivityCursor}
            />
          </div>
          <div
            className="inc-pane"
            id="inc-pane-cycles"
            role="tabpanel"
            aria-labelledby="inc-tab-cycles"
            hidden={tab !== "cycles"}
          >
            <ErrorNotice error={cycles.error} />
            {cycles.loading && !cycles.data && (
              <p role="status">Loading cycles…</p>
            )}
            <div className="tl">
              {cycleRows.map((row, index) => {
                const number =
                  num(row.cycle_number) ??
                  (cyclesComplete ? String(cycleRows.length - index) : "");
                return (
                  <div className="tl-i" key={row.id ?? index}>
                    <i
                      className={row.resolved_at ? "tl-src" : "tl-user"}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="tl-t">
                        <b>Cycle {number}</b>{" "}
                        {row.resolved_at
                          ? `resolved ${str(row.cause) === "inactivity" ? `after ${INACTIVITY_DAYS} days without activity` : str(row.cause) === "manual" ? "manually" : str(row.cause) === "alerts_resolved" ? "when all linked alerts resolved" : ""}`.trim() +
                            "."
                          : row.id === incident.cycle_id
                            ? "is the current cycle."
                            : ""}
                      </div>
                      <div className="tl-m">
                        Opened {timestamp(row.opened_at)}
                        {row.investigating_at
                          ? ` · investigating ${timestamp(row.investigating_at)}`
                          : ""}
                        {row.resolved_at
                          ? ` · resolved ${timestamp(row.resolved_at)}`
                          : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <Pager
              label="cycles"
              cursor={cycleCursor}
              next={cycles.data?.next_cursor}
              loading={cycles.loading}
              onPage={setCycleCursor}
            />
          </div>
          <IncidentNotes
            key={scope.tenant.role}
            scope={scope}
            incidentId={id}
            active={tab === "notes"}
            reload={reloadAll}
            onDirty={setNoteDirty}
            onSummary={setNotes}
          />
        </aside>
      </div>
      {membership && editable && !resolved && (
        <IncidentMembership
          scope={scope}
          incident={incident}
          initialMode={membership}
          reload={reloadAll}
          onDirty={setMemberDirty}
          onClose={() => setMembership(null)}
        />
      )}
      {editing && editable && (
        <ContentDialog
          scope={scope}
          path={path}
          incident={incident}
          onDirty={setEditDirty}
          onClose={(saved) => {
            setEditing(false);
            setEditDirty(false);
            if (saved) reloadAll();
          }}
        />
      )}
    </Page>
  );
}

function Pager({
  label,
  cursor,
  next,
  loading,
  onPage,
}: {
  label: string;
  cursor: string | null;
  next?: string | null;
  loading: boolean;
  onPage: (cursor: string | null) => void;
}) {
  if (!cursor && !next) return null;
  return (
    <div className="inc-pager">
      <button
        type="button"
        className="btn btn-sm btn-g"
        disabled={!cursor || loading}
        onClick={() => onPage(null)}
      >
        Newest {label}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!next || loading}
        onClick={() => onPage(next ?? null)}
      >
        Older {label}
      </button>
    </div>
  );
}

function alertAvailable(row: RecordData) {
  return Boolean(row.message ?? row.id ?? row.alert_id);
}

function LinkedAlerts({
  scope,
  rows,
  label,
  href,
}: {
  scope: Scope;
  rows: RecordData[];
  label: string;
  href: string;
}) {
  return (
    <div role="table" aria-label="Linked alerts" className="table-body">
      <div role="row" className="row head g-ia">
        <span role="columnheader">Severity</span>
        <span role="columnheader">Alert</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Last received</span>
        <span role="columnheader">Assignee</span>
      </div>
      {rows.map((row) => {
        const key = alertKey(row);
        const available = alertAvailable(row);
        const text =
          str(row.name) ?? str(row.message) ?? "Unavailable alert reference";
        const assignee = who(scope, row.assignee_id, row.assignee_display_name);
        return (
          <div
            role="row"
            key={key}
            className={`row g-ia inc-arow alert-link-row ${row.status === "resolved" ? "r-res" : ""}`}
          >
            <span role="cell">
              {available ? <Severity value={row.severity} /> : "—"}
            </span>
            <span role="cell" className="inc-title-cell">
              <span className="alert-title">
                {available ? (
                  <NavLink
                    scope={scope}
                    className="msg alert-row-link"
                    href={`/tenants/${scope.tenant.id}/alerts/${key}`}
                    onClickCapture={() =>
                      rememberAlertList(scope.tenant.id, {
                        label,
                        href,
                        ids: rows.filter(alertAvailable).map(alertKey),
                        current: key,
                      })
                    }
                  >
                    {text}
                  </NavLink>
                ) : (
                  <span className="msg muted">{text}</span>
                )}
                {row.suppressed === true && (
                  <span className="chip chip-supp">Suppressed</span>
                )}
              </span>
              <span className="sub">
                {available
                  ? [row.application, row.component, row.node_name]
                      .filter((part) => typeof part === "string" && part)
                      .join(" · ")
                  : key}
              </span>
            </span>
            <span role="cell">
              {available ? (
                <AlertStatus value={row.status} assigneeId={row.assignee_id} />
              ) : (
                <span className="small muted">Unknown</span>
              )}
            </span>
            <span role="cell" className="cell mono small">
              {timestamp(row.timestamp ?? row.last_received_at)}
            </span>
            <span
              role="cell"
              className={`cell small ${row.assignee_id || row.assignee_display_name ? "" : "ack-n"}`}
            >
              {available ? assignee : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Small anchored surface that closes on Escape or an outside click. */
function Popover({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    const click = (event: MouseEvent) => {
      // The anchoring field (with its toggle button) keeps the popover open.
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) close.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", click);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", click);
    };
  }, []);
  return (
    <div
      id="incident-assignment-options"
      className="panel inc-popover"
      ref={ref}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------- content edit */

function ContentDialog({
  scope,
  path,
  incident,
  onDirty,
  onClose,
}: {
  scope: Scope;
  path: string;
  incident: RecordData;
  onDirty: (dirty: boolean) => void;
  onClose: (saved: boolean) => void;
}) {
  const [base] = useState(incident.revision);
  const [title, setTitle] = useState(String(incident.title ?? ""));
  const [description, setDescription] = useState(
    String(incident.description ?? ""),
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const dirty =
    title !== String(incident.title ?? "") ||
    description !== String(incident.description ?? "");
  const conflict =
    command.error instanceof ApiError && command.error.status === 409;
  const locked = command.busy || command.uncertain;
  const first = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    opener.current = document.activeElement;
    first.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose(false);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [locked, onClose]);
  async function save() {
    const result = await command.execute(
      path,
      { title, description, expected_revision: base },
      "PATCH",
    );
    if (result) onClose(true);
  }
  return (
    <div className="dlg-backdrop">
      <form
        className="dlg inc-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inc-edit-title"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id="inc-edit-title">Edit title and description</h2>
        <div className="f">
          <label className="lbl" htmlFor="inc-edit-name">
            Title
          </label>
          <input
            id="inc-edit-name"
            ref={first}
            className="inp"
            value={title}
            required
            maxLength={200}
            disabled={locked}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="f">
          <label className="lbl" htmlFor="inc-edit-description">
            Description <span className="inc-optional">(optional)</span>
          </label>
          <textarea
            id="inc-edit-description"
            className="inp"
            rows={6}
            value={description}
            maxLength={10000}
            disabled={locked}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="help">
            Severity and origin cannot change. Editing base revision {base}.
          </span>
        </div>
        {incident.revision !== base && (
          <p className="banner bn-warn">
            A newer revision {String(incident.revision)} is available. Cancel to
            review it; saving uses revision {base}.
          </p>
        )}
        {conflict && (
          <p className="banner bn-warn">
            Your draft was preserved. The incident changed since you opened this
            editor; cancel and reopen it to edit the current revision.
          </p>
        )}
        <IncidentFeedback command={command} />
        <div className="dlg-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            onClick={() => onClose(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-sm btn-p"
            disabled={
              command.busy || conflict || (!dirty && !command.uncertain)
            }
          >
            {command.uncertain ? "Retry original command" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------- activity */

/** Labels for activity kinds recorded without structured evidence. */
const LABELS: Record<string, string> = {
  status_changed: "Status changed",
  assignment_changed: "Assigned",
  note_added: "Note added",
  alert_linked: "Alert linked:",
  alert_unlinked: "Alert unlinked:",
};

interface Describe {
  scope: Scope;
  incident: RecordData;
  alertNames: Map<string, string>;
  noteTexts: Map<string, string>;
  ruleName?: string;
  group?: string;
}

/** Human sentence for one incident activity record. */
function describe(
  row: RecordData,
  context: Describe,
): { what: string; detail: string; dot: string; who: string } {
  const { scope, incident, alertNames, noteTexts, ruleName } = context;
  const kind = String(row.kind ?? "");
  const evidence =
    row.evidence && typeof row.evidence === "object"
      ? (row.evidence as Record<string, unknown>)
      : undefined;
  const ruleLabel = `Correlation rule${ruleName ? ` ${ruleName}` : ""}`;
  const system = !row.actor_id && !row.actor_display_name && !row.actor_label;
  const correlationKind = kind.startsWith("correlation-");
  const actor =
    str(row.actor_display_name) ??
    str(row.actor_label) ??
    (system
      ? correlationKind
        ? ruleLabel
        : "System"
      : personLabel(scope, row.actor_id, undefined, "System"));
  const ruleActor = correlationKind || /^Correlation rule/i.test(actor);
  const alerts = (ids: unknown) => {
    if (!Array.isArray(ids)) return "";
    const names = ids.map((id) => alertNames.get(String(id)));
    return names.every(Boolean)
      ? names.join(", ")
      : `${ids.length} alert${ids.length === 1 ? "" : "s"}`;
  };
  const plural = (ids: unknown) => Array.isArray(ids) && ids.length !== 1;
  let what = "";
  let detail = "";
  let dot = ruleActor ? "tl-inc" : system ? "tl-src" : "tl-user";
  switch (kind) {
    case "created":
    case "incident_created":
    case "correlation-created":
      what = "Incident created";
      detail =
        kind === "correlation-created"
          ? `by correlation rule${ruleName ? ` ${ruleName}` : ""}${context.group ? ` for ${context.group}` : ""} with severity ${cap(incident.severity)}.`
          : `with severity ${cap(evidence?.severity ?? incident.severity)}.`;
      if (kind === "created" && Array.isArray(evidence?.alert_ids)) {
        if (evidence.alert_ids.length)
          detail = `with severity ${cap(evidence?.severity ?? incident.severity)} and ${evidence.alert_ids.length} linked alert${evidence.alert_ids.length === 1 ? "" : "s"}.`;
      }
      dot = "tl-src";
      break;
    case "correlation-added":
      what = plural(evidence?.attachments) ? "Alerts linked:" : "Alert linked:";
      detail = `${alerts(evidence?.attachments) || "matching alerts"}.`;
      break;
    case "status":
      what = "Status changed";
      detail = `to ${INCIDENT_STATUS[String(evidence?.status)] ?? cap(evidence?.status)}.`;
      break;
    case "assignment":
      if (evidence?.assignee_id) {
        what = "Assigned";
        detail = `to ${
          evidence.assignee_id === incident.assignee_id
            ? who(scope, incident.assignee_id, incident.assignee_display_name)
            : personLabel(scope, evidence.assignee_id, undefined)
        }.`;
      } else {
        what = "Unassigned.";
      }
      break;
    case "content":
      what = "Title and description edited.";
      detail = str(evidence?.title) ? `Title “${evidence?.title}”.` : "";
      break;
    case "link":
    case "unlink":
      what = `${plural(evidence?.alert_ids) ? "Alerts" : "Alert"} ${kind === "link" ? "linked" : "unlinked"}:`;
      detail = `${alerts(evidence?.alert_ids)}.`;
      break;
    case "move":
      what = `${plural(evidence?.alert_ids) ? "Alerts" : "Alert"} moved`;
      detail =
        evidence?.destination_id === incident.id
          ? `in from another incident: ${alerts(evidence?.alert_ids)}.`
          : `to another incident: ${alerts(evidence?.alert_ids)}.`;
      break;
    case "note-created":
    case "note-edited":
    case "note-deleted": {
      what =
        kind === "note-created"
          ? "Note added."
          : kind === "note-edited"
            ? "Note edited."
            : "Note deleted.";
      const text = noteTexts.get(String(evidence?.note_id));
      detail = text && kind !== "note-deleted" ? `“${text}”` : "";
      break;
    }
    case "eligibility_lost":
      what = "Assignee cleared";
      detail = "after the user lost edit eligibility.";
      dot = "tl-src";
      break;
    case "inactivity":
      what = "Resolved automatically";
      detail = `after ${INACTIVITY_DAYS} days without activity.`;
      dot = "tl-src";
      break;
    case "alerts-resolved":
      what = "Resolved automatically";
      detail = "when all linked alerts resolved.";
      dot = "tl-src";
      break;
    case "linked-alert-status":
      what = "Linked alert";
      detail = `${alertNames.get(String(evidence?.alert_id)) ?? "status"} changed from ${cap(evidence?.before)} to ${cap(evidence?.after)}.`;
      dot = "tl-src";
      break;
    default: {
      // Records without structured evidence carry a recorded description;
      // drop its words that restate the label.
      let label = LABELS[kind] ?? cap(kind.replaceAll(/[_-]+/g, " "));
      const stems = label
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .split(" ")
        .map((word) => word.slice(0, 5));
      const parts = (str(row.description) ?? "").split(" ");
      while (
        parts.length &&
        stems.includes(
          parts[0]
            .toLowerCase()
            .replace(/[^a-z]/g, "")
            .slice(0, 5),
        )
      )
        parts.shift();
      let rest = parts.join(" ");
      const counted = /^(\d+) alerts?:\s*/.exec(rest);
      if (counted) {
        rest = rest.slice(counted[0].length);
        if (counted[1] !== "1") label = label.replace(/^Alert /, "Alerts ");
      }
      const arrow = rest.split(/\s*→\s*/);
      if (arrow.length === 2)
        rest = `from ${cap(arrow[0].trim())} to ${cap(arrow[1].trim())}`;
      what = label;
      detail = rest ? `${rest.replace(/\.$/, "")}.` : "";
    }
  }
  return { what, detail, dot, who: actor };
}
