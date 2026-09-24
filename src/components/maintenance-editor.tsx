"use client";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type RecordData,
  request,
  tenantPath,
  display,
  timestamp,
} from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { CelEditor } from "./cel-editor";
import { Page, useConfirm } from "./page";
import {
  Banner,
  CommandBanner,
  ErrorBanner,
  durationLabel,
  localStamp,
  offsetLabel,
  utcStamp,
} from "./temporal-history";

export interface Endpoint {
  local: string;
  utc: string;
  timezone: string;
  offset_seconds: number;
  occurrence?: string | null;
  tzdata_version: string;
  rules_changed?: boolean;
  original_local?: string;
  original_timezone?: string;
  original_offset_seconds?: number;
  original_tzdata_version?: string;
}
interface Diagnostic {
  code: string;
  message: string;
  fields?: unknown;
}
interface Validation {
  valid: boolean;
  schedule?: { start: Endpoint; end: Endpoint };
  start_display?: Endpoint;
  end_display?: Endpoint;
  diagnostics?: Diagnostic[];
}
const seconds = (value: string) =>
  value.length === 16 ? value + ":00" : value;

/** One schedule endpoint as local time, offset and authoritative UTC. */
export function EndpointLine({
  label,
  value,
  region,
}: {
  label: string;
  value?: Endpoint;
  region: string;
}) {
  if (!value) return null;
  return (
    <section
      aria-label={region}
      className="mw-ep"
      title={`tzdata ${value.tzdata_version}`}
    >
      <b>{label}</b> {localStamp(value.local)} {value.timezone} (
      {offsetLabel(value.offset_seconds)}
      {value.occurrence ? `, ${value.occurrence} occurrence` : ""}) ={" "}
      <span className="mono">{utcStamp(value.utc)}</span> UTC
    </section>
  );
}
/** Timezone-rule change notice for a stored endpoint. */
export function RulesChanged({ value }: { value?: Endpoint }) {
  if (!value?.rules_changed) return null;
  return (
    <Banner tone="warn">
      Timezone rules changed; execution time is unchanged. Originally{" "}
      {localStamp(value.original_local)} {value.original_timezone}
      {typeof value.original_offset_seconds === "number"
        ? ` (${offsetLabel(value.original_offset_seconds)})`
        : ""}{" "}
      · tzdata {value.original_tzdata_version}.
    </Banner>
  );
}
function Candidates({ fields }: { fields?: unknown }) {
  const candidates = Array.isArray(fields)
    ? fields.flatMap((field) =>
        field && typeof field === "object" && Array.isArray(field.candidates)
          ? field.candidates
          : [],
      )
    : [];
  return candidates.length ? (
    <ol className="mw-cands">
      {candidates.map((candidate, index) => (
        <li key={index}>
          {index === 0 ? "First" : "Second"} occurrence:{" "}
          {utcStamp(String(candidate.utc))} UTC ·{" "}
          {offsetLabel(Number(candidate.offset_seconds))}
        </li>
      ))}
    </ol>
  ) : null;
}
function hasAmbiguity(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Diagnostic).code === "ambiguous_local_time",
    )
  );
}

export function MaintenanceEditor({
  scope,
  window: stored,
  current,
  onSaved,
}: {
  scope: Scope;
  window?: RecordData;
  current?: RecordData;
  /** Called with the saved window, or without arguments on discard. */
  onSaved?: (saved?: RecordData) => void;
}) {
  const base = `${tenantPath(scope.tenant.id)}/maintenance`;
  const listHref = `/tenants/${scope.tenant.id}/maintenance`;
  const zones = useResource<{ id: string; offset_seconds: number }[]>(
    `${tenantPath(scope.tenant.id)}/timezones`,
    scope.onDenied,
  );
  const [kind, setKind] = useState(stored ? "metadata" : "create"),
    [name, setName] = useState(String(stored?.name ?? "")),
    [reason, setReason] = useState(String(stored?.reason ?? "")),
    [zone, setZone] = useState(String(stored?.timezone ?? "")),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [cel, setCel] = useState(String(stored?.cel ?? "")),
    [startChoice, setStartChoice] = useState(""),
    [endChoice, setEndChoice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    key: string;
    busy: boolean;
    value?: Validation;
    error?: unknown;
  }>();
  const pending = useRef<AbortController | null>(null);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmDialog, confirm] = useConfirm();
  const phase = current?.phase ?? stored?.phase;
  const locked =
    Boolean(stored?.started_lock || current?.started_lock) ||
    ["active", "ended", "deleted"].includes(String(phase));
  const ended = ["ended", "deleted"].includes(String(phase));
  const canEdit =
    scope.tenant.role !== "view" && !stored?.deleted_at && !current?.deleted_at;
  const zoneKnown =
    zones.data?.data.some((item) => item.id === zone) ||
    Boolean(stored && stored.timezone === zone);
  // New windows default to the browser timezone when the server supports it.
  useEffect(() => {
    if (stored || zone || !Array.isArray(zones.data?.data)) return;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zones.data.data.some((item) => item.id === browser)) setZone(browser);
  }, [stored, zone, zones.data]);
  function payload(): Record<string, unknown> {
    if (!stored)
      return {
        name,
        reason,
        cel,
        timezone: zone,
        start_local: seconds(start),
        end_local: seconds(end),
        ...(startChoice ? { start_occurrence: startChoice } : {}),
        ...(endChoice ? { end_occurrence: endChoice } : {}),
      };
    const common = { kind, expected_revision: stored.revision };
    if (kind === "metadata") return { ...common, name, reason };
    if (kind === "timezone") return { ...common, timezone: zone };
    return {
      ...common,
      timezone: zone,
      ...(!locked && cel !== stored.cel ? { cel } : {}),
      ...(!locked && start
        ? {
            start_local: seconds(start),
            ...(startChoice ? { start_occurrence: startChoice } : {}),
          }
        : {}),
      ...(!ended && end
        ? {
            end_local: seconds(end),
            ...(endChoice ? { end_occurrence: endChoice } : {}),
          }
        : {}),
    };
  }
  const body = payload(),
    key = JSON.stringify(body),
    latest = useRef(key);
  latest.current = key;
  const activeValidation = validation?.key === key ? validation : undefined;
  const hasScheduleChange =
    kind !== "schedule" ||
    (!locked && (Boolean(start) || cel !== stored?.cel)) ||
    (!ended && Boolean(end));
  const unsaved = dirty && !leaving;
  useDirtyWarning(unsaved);
  useEffect(() => {
    scope.setDirty(unsaved);
    return () => scope.setDirty(false);
  }, [unsaved, scope.setDirty]);
  useEffect(() => {
    if (leaving) scope.navigate(leaving);
  }, [leaving, scope.navigate]);
  useEffect(() => {
    setValidation((previous) => (previous?.busy ? undefined : previous));
    return () => pending.current?.abort();
  }, [key]);
  async function validate() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const captured = key;
    setValidation({ key: captured, busy: true });
    try {
      const result = await request<Validation>(
        stored ? `${base}/${stored.id}/validate` : `${base}/validate`,
        {
          method: "POST",
          body: stored ? { ...body, command_id: crypto.randomUUID() } : body,
          csrf: scope.session.csrf_token,
          signal: controller.signal,
        },
      );
      if (typeof result.data?.valid !== "boolean")
        throw new Error("The schedule validation response is unavailable.");
      if (!controller.signal.aborted && latest.current === captured)
        setValidation({ key: captured, busy: false, value: result.data });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        scope.onDenied();
      if (latest.current === captured)
        setValidation({ key: captured, busy: false, error });
    }
  }
  async function save() {
    if (!canEdit) return;
    const result = await command.execute<RecordData>(
      stored ? `${base}/${stored.id}` : base,
      body,
      stored ? "PATCH" : "POST",
    );
    if (result) {
      setDirty(false);
      scope.setDirty(false);
      if (onSaved) onSaved(result.data);
      else
        setLeaving(
          result.data && typeof result.data.id === "string"
            ? `${listHref}/${result.data.id}`
            : listHref,
        );
    }
  }
  async function discard() {
    if (
      dirty &&
      !(await confirm({
        title: "Discard maintenance changes?",
        body: <p>Your unsaved changes to this window will be lost.</p>,
        confirmLabel: "Discard changes",
        danger: true,
      }))
    )
      return;
    setDirty(false);
    scope.setDirty(false);
    if (onSaved) onSaved();
    else setLeaving(listHref);
  }
  function touch() {
    setDirty(true);
  }
  const startDisplay = (current?.start_display ?? stored?.start_display) as
    Endpoint | undefined;
  const endDisplay = (current?.end_display ?? stored?.end_display) as
    Endpoint | undefined;
  const validated = activeValidation?.value;
  const validStart = validated?.start_display ?? validated?.schedule?.start;
  const validEnd = validated?.end_display ?? validated?.schedule?.end;
  const scheduleKind = kind === "create" || kind === "schedule";
  const showOccurrence =
    scheduleKind &&
    (Boolean(startChoice || endChoice) ||
      hasAmbiguity(validated?.diagnostics) ||
      (command.error instanceof ApiError &&
        command.error.code === "ambiguous_local_time"));
  const naive =
    !stored && start && end
      ? durationLabel(Date.parse(`${end}Z`) - Date.parse(`${start}Z`))
      : null;
  const newer =
    stored && current && current.revision !== stored.revision
      ? current.revision
      : null;
  const zoneOptions = zones.data?.data ?? [];
  return (
    <Page
      scope={scope}
      title={stored ? `Edit ${display(stored.name)}` : "New maintenance window"}
      crumbs={[
        { label: "Maintenance", href: listHref },
        ...(stored
          ? [{ label: display(stored.name), href: `${listHref}/${stored.id}` }]
          : []),
      ]}
      extra={
        unsaved ? <span className="chip b-amber">Unsaved changes</span> : null
      }
      actions={
        <>
          <button
            type="button"
            className="btn btn-g"
            disabled={command.busy}
            onClick={() => void discard()}
          >
            Discard
          </button>
          {canEdit && (
            <button
              type={command.uncertain ? "button" : "submit"}
              form="maintenance-form"
              onClick={command.uncertain ? () => void save() : undefined}
              className="btn btn-p"
              disabled={
                command.busy ||
                (!command.uncertain &&
                  (!hasScheduleChange || (kind !== "metadata" && !zoneKnown)))
              }
            >
              {command.uncertain
                ? "Retry original command"
                : stored
                  ? "Save maintenance change"
                  : "Create window"}
            </button>
          )}
        </>
      }
    >
      {confirmDialog}
      <CommandBanner command={command} />
      {command.error instanceof ApiError && (
        <Candidates fields={command.error.fields} />
      )}
      {newer && (
        <Banner tone="warn" role="status">
          Editing base revision {stored?.revision}. A newer shared revision{" "}
          {newer} is available; saving will conflict. Discard to review it.
        </Banner>
      )}
      {!canEdit && (
        <Banner tone="info">
          Current access permits validation only; saving is unavailable.
        </Banner>
      )}
      <div className="mw-grid grow">
        <section className="panel mw-form-panel">
          <form
            id="maintenance-form"
            className="mw-form"
            onChange={touch}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {stored && (
              <div className="mw-kind">
                <div className="f">
                  <label className="lbl" htmlFor="mw-kind">
                    Change
                  </label>
                  <select
                    id="mw-kind"
                    className="inp"
                    value={kind}
                    onChange={(event) => {
                      // Choosing a change kind is not itself a draft change.
                      event.stopPropagation();
                      setKind(event.target.value);
                    }}
                  >
                    <option value="metadata">Name and reason</option>
                    <option value="timezone">Display timezone only</option>
                    <option value="schedule" disabled={ended}>
                      Schedule or condition
                    </option>
                  </select>
                </div>
                <span className="help">
                  Each save applies one kind of change to revision{" "}
                  {stored.revision}.
                  {ended ? " Ended windows cannot be rescheduled." : ""}
                </span>
              </div>
            )}
            {(!stored || kind === "metadata") && (
              <>
                <div className="f">
                  <label className="lbl" htmlFor="mw-name">
                    Name
                  </label>
                  <input
                    id="mw-name"
                    className="inp"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    required
                  />
                </div>
                <div className="f">
                  <label className="lbl" htmlFor="mw-reason">
                    Reason <span className="mw-opt">(optional)</span>
                  </label>
                  <textarea
                    id="mw-reason"
                    className="inp"
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={10000}
                  />
                </div>
              </>
            )}
            {kind !== "metadata" && (
              <div
                className={kind === "timezone" ? "mw-row mw-row-tz" : "mw-row"}
              >
                <div className="f">
                  <label className="lbl" htmlFor="mw-zone">
                    Timezone
                  </label>
                  <select
                    id="mw-zone"
                    className="inp"
                    value={zone}
                    required
                    onChange={(event) => {
                      setZone(event.target.value);
                      setStartChoice("");
                      setEndChoice("");
                    }}
                  >
                    <option value="">Select a supported timezone</option>
                    {zone && !zoneOptions.some((item) => item.id === zone) && (
                      <option value={zone}>{zone} · stored timezone</option>
                    )}
                    {zoneOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} · {offsetLabel(item.offset_seconds, "")}
                      </option>
                    ))}
                  </select>
                  <span className="help">
                    {zones.loading
                      ? "Loading supported timezones…"
                      : stored
                        ? `Currently ${display(stored.timezone)} · tzdata ${display(zones.data?.meta?.tzdata_version)}`
                        : `Defaults to your browser timezone · tzdata ${display(zones.data?.meta?.tzdata_version)}`}
                  </span>
                </div>
                {scheduleKind && (
                  <>
                    <div className="f">
                      <label className="lbl" htmlFor="mw-start">
                        {stored ? (
                          <>
                            Changed start
                            <span className="sr-only"> local time</span>
                          </>
                        ) : (
                          "Starts"
                        )}
                      </label>
                      <input
                        id="mw-start"
                        className="inp mono"
                        type="datetime-local"
                        step={1}
                        value={start}
                        required={!stored}
                        disabled={locked}
                        onChange={(event) => {
                          setStart(event.target.value);
                          setStartChoice("");
                        }}
                      />
                      {stored && (
                        <span className="help">
                          {locked
                            ? "Locked: the window has started"
                            : `Now ${localStamp(startDisplay?.local)} · blank keeps it`}
                        </span>
                      )}
                    </div>
                    <div className="f">
                      <label className="lbl" htmlFor="mw-end">
                        {stored ? (
                          <>
                            Changed end
                            <span className="sr-only"> local time</span>
                          </>
                        ) : (
                          "Ends"
                        )}
                      </label>
                      <input
                        id="mw-end"
                        className="inp mono"
                        type="datetime-local"
                        step={1}
                        value={end}
                        required={!stored}
                        disabled={ended}
                        onChange={(event) => {
                          setEnd(event.target.value);
                          setEndChoice("");
                        }}
                      />
                      {stored && (
                        <span className="help">
                          {ended
                            ? "Ended windows cannot be extended"
                            : `Now ${localStamp(endDisplay?.local)} · blank keeps it`}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {zones.error ? (
              <div className="mw-inline">
                <ErrorBanner error={zones.error} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={zones.reload}
                >
                  Refresh timezones
                </button>
              </div>
            ) : null}
            {showOccurrence && (
              <div className="mw-row mw-row-occ">
                <div className="f">
                  <label className="lbl" htmlFor="mw-start-occ">
                    Start repeated local time
                  </label>
                  <select
                    id="mw-start-occ"
                    className="inp"
                    value={startChoice}
                    disabled={locked || !start}
                    onChange={(event) => setStartChoice(event.target.value)}
                  >
                    <option value="">Not selected</option>
                    <option value="first">
                      First occurrence (earlier UTC)
                    </option>
                    <option value="second">
                      Second occurrence (later UTC)
                    </option>
                  </select>
                </div>
                <div className="f">
                  <label className="lbl" htmlFor="mw-end-occ">
                    End repeated local time
                  </label>
                  <select
                    id="mw-end-occ"
                    className="inp"
                    value={endChoice}
                    disabled={ended || !end}
                    onChange={(event) => setEndChoice(event.target.value)}
                  >
                    <option value="">Not selected</option>
                    <option value="first">
                      First occurrence (earlier UTC)
                    </option>
                    <option value="second">
                      Second occurrence (later UTC)
                    </option>
                  </select>
                </div>
              </div>
            )}
            {kind !== "metadata" && (
              <Banner tone="info" className="mw-sched">
                <div className="mw-sched-row">
                  <span>
                    {validated?.valid && validStart && validEnd ? (
                      <>
                        {kind === "timezone" ? (
                          <>
                            Displays as {localStamp(validStart.local)} →{" "}
                            {localStamp(validEnd.local)} {validStart.timezone}.
                            The UTC start and end are unchanged.
                          </>
                        ) : (
                          <>
                            Runs{" "}
                            {durationLabel(
                              Date.parse(validEnd.utc) -
                                Date.parse(validStart.utc),
                            ) ?? "—"}{" "}
                            · stored as {utcStamp(validStart.utc)} →{" "}
                            {utcStamp(validEnd.utc)} UTC.
                          </>
                        )}
                      </>
                    ) : kind === "timezone" ? (
                      "Changing the display timezone preserves the UTC start and end. Validate to review the server rendering."
                    ) : stored ? (
                      <>
                        Currently runs{" "}
                        {durationLabel(
                          Date.parse(String(stored.end_at)) -
                            Date.parse(String(stored.start_at)),
                        ) ?? "—"}{" "}
                        · stored as {utcStamp(stored.start_at)} →{" "}
                        {utcStamp(stored.end_at)} UTC. Only changed endpoints
                        are rescheduled.
                      </>
                    ) : naive ? (
                      <>Runs {naive} · validate to see the stored UTC times.</>
                    ) : (
                      "Choose a timezone, start and end, then validate to see the stored UTC times."
                    )}{" "}
                    {scheduleKind &&
                      "If a local time happens twice because of a clock change, you will be asked which occurrence you mean."}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={
                      activeValidation?.busy || !hasScheduleChange || !zoneKnown
                    }
                    onClick={() => void validate()}
                  >
                    {activeValidation?.busy
                      ? "Validating…"
                      : "Validate schedule"}
                  </button>
                </div>
                {validated?.valid && (
                  <div className="mw-eps">
                    <EndpointLine
                      label="Start"
                      value={validStart}
                      region="Validated start schedule evidence"
                    />
                    <EndpointLine
                      label="End"
                      value={validEnd}
                      region="Validated end schedule evidence"
                    />
                  </div>
                )}
                {activeValidation?.busy && (
                  <span className="sr-only" role="status">
                    Validating against server time and timezone rules…
                  </span>
                )}
              </Banner>
            )}
            <ErrorBanner error={activeValidation?.error} />
            {validated && (
              <div role="status" className="mw-valid">
                {validated.valid ? (
                  <span className="small">
                    <span className="chip chip-ok">Valid</span> Saving rechecks
                    the current phase, permissions and capacity.
                  </span>
                ) : (
                  <Banner tone="err">
                    <b>The schedule is invalid.</b> Your draft is preserved.
                    {validated.diagnostics?.map((diagnostic, index) => (
                      <div key={index}>
                        {diagnostic.message} ({diagnostic.code})
                        <Candidates fields={diagnostic.fields} />
                      </div>
                    ))}
                  </Banner>
                )}
              </div>
            )}
            {validation?.value && !activeValidation && kind !== "metadata" && (
              <span className="help">
                Draft changed. Validate the current schedule again.
              </span>
            )}
            {scheduleKind && (
              <div className="f mw-cel">
                <div className="mw-cel-h" aria-hidden="true">
                  <span className="lbl">Which alerts (CEL)</span>
                  <span className="help">
                    {locked
                      ? "Locked because this window has started"
                      : "Ctrl+Space completes"}
                  </span>
                </div>
                <CelEditor
                  scope={scope}
                  context="rule"
                  label={stored ? "CEL" : "CEL expression"}
                  value={cel}
                  minimal
                  rows={2}
                  disabled={locked}
                  onChange={(source) => {
                    setCel(source);
                    setDirty(true);
                  }}
                />
                <span className="help">
                  Alerts already firing when the window starts are not
                  suppressed. Existing matches are never backfilled.
                </span>
              </div>
            )}
            {kind !== "metadata" && (
              <>
                <RulesChanged value={startDisplay} />
                <RulesChanged value={endDisplay} />
              </>
            )}
            {!stored ? (
              <Banner tone="warn">
                Once the window starts, its start time and condition are locked.
                You can still extend or shorten the end, rename it, or change
                the display timezone.
              </Banner>
            ) : kind === "schedule" && (locked || ended) ? (
              <Banner tone="warn">
                {ended
                  ? "This window has ended. Its schedule and condition can no longer change."
                  : "Start and condition are locked because this window has started. You can still extend or shorten the end."}
              </Banner>
            ) : null}
          </form>
        </section>
        <aside className="mw-side">
          {stored ? (
            <MaintenanceAlertTest
              scope={scope}
              savedWindow={current ?? stored}
            />
          ) : (
            <MaintenanceAlertTest scope={scope} definition={body} />
          )}
        </aside>
      </div>
    </Page>
  );
}

type TestResult = {
  matches: boolean;
  covers_selected_time: boolean;
  firing: boolean;
  explanation: string;
  qualification_proven: false;
  enabled?: boolean;
  meta?: Record<string, unknown>;
};
function YesNo({ value, tone }: { value: boolean; tone: string }) {
  return value ? (
    <span className={`chip ${tone}`}>Yes</span>
  ) : (
    <span className="chip b-neutral">No</span>
  );
}

export function MaintenanceAlertTest({
  scope,
  definition,
  savedWindow,
}: {
  scope: Scope;
  definition?: Record<string, unknown>;
  savedWindow?: RecordData;
}) {
  const [alert, setAlert] = useState(""),
    [result, setResult] = useState<TestResult>(),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null),
    key = JSON.stringify([
      definition,
      savedWindow?.id,
      savedWindow?.revision,
      alert,
      scope.tenant.id,
      scope.tenant.revision,
      scope.tenant.role,
      scope.session.principal.id,
      scope.session.csrf_token,
    ]);
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    pending.current?.abort();
    setResult(undefined);
    setError(undefined);
    setBusy(false);
    return () => pending.current?.abort();
  }, [key]);
  const valid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      alert,
    );
  async function testAlert() {
    if (!valid) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const response = await request<Omit<TestResult, "meta">>(
        `${tenantPath(scope.tenant.id)}/maintenance${savedWindow ? `/${savedWindow.id}` : ""}/test`,
        {
          method: "POST",
          body: savedWindow
            ? { expected_revision: savedWindow.revision, alert_id: alert }
            : { ...definition, alert_id: alert },
          csrf: scope.session.csrf_token,
          signal: controller.signal,
        },
      );
      const value = response.data;
      if (
        !value ||
        typeof value.matches !== "boolean" ||
        typeof value.covers_selected_time !== "boolean" ||
        typeof value.firing !== "boolean" ||
        typeof value.explanation !== "string" ||
        value.qualification_proven !== false
      )
        throw new Error(
          "The maintenance test response does not match its API contract.",
        );
      if (!controller.signal.aborted && latest.current === key)
        setResult({ ...value, meta: response.meta });
    } catch (failure) {
      if (!controller.signal.aborted && latest.current === key) {
        setError(failure);
        if (failure instanceof ApiError && [401, 403].includes(failure.status))
          scope.onDenied();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="panel mw-test"
      aria-label="Maintenance current alert test"
    >
      <div className="panel-h">
        <h2>Test a current alert</h2>
      </div>
      <div className="mw-test-body">
        <div className="rt-input">
          <label className="sr-only" htmlFor="mw-test-alert">
            Test against retained alert ID
          </label>
          <input
            id="mw-test-alert"
            className="inp"
            value={alert}
            placeholder="Alert ID (UUID)"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              event.stopPropagation();
              setAlert(event.target.value.trim());
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void testAlert();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !valid}
            onClick={() => void testAlert()}
          >
            {busy ? "Testing…" : "Test"}
          </button>
        </div>
        <ErrorBanner error={error} />
        {busy && (
          <span className="sr-only" role="status">
            Testing current alert…
          </span>
        )}
        {result && (
          <div role="status" className="mw-test-result">
            <dl className="mw-yes">
              <div className="fld">
                <dt>Condition matches</dt>
                <dd>
                  <YesNo value={result.matches} tone="b-green" />
                </dd>
              </div>
              <div className="fld">
                <dt>Time is covered</dt>
                <dd>
                  <YesNo value={result.covers_selected_time} tone="b-green" />
                </dd>
              </div>
              <div className="fld">
                <dt>Currently firing</dt>
                <dd>
                  <YesNo value={result.firing} tone="b-dark" />
                </dd>
              </div>
            </dl>
            <p className="help mw-p">{result.explanation}</p>
            {typeof result.enabled === "boolean" && (
              <p className="help mw-p">
                Saved window intent: {result.enabled ? "Enabled" : "Disabled"}.
                Schedule coverage alone does not establish suppression.
              </p>
            )}
            {typeof result.meta?.as_of === "string" && (
              <span className="small muted">
                As of{" "}
                <span className="mono">{timestamp(result.meta.as_of)}</span>
                {result.meta.alert_revision !== undefined
                  ? ` · alert revision ${String(result.meta.alert_revision)}`
                  : ""}
                {result.meta.revision !== undefined
                  ? ` · window revision ${String(result.meta.revision)}`
                  : ""}
              </span>
            )}
          </div>
        )}
        <p className="help mw-p">
          A current match does not mean the alert will be suppressed: only
          alerts that start firing or newly match during the window are.
          Existing matches are not backfilled.
        </p>
      </div>
    </section>
  );
}
