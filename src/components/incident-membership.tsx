"use client";
import { useEffect, useRef, useState } from "react";
import { display, message, RecordData, tenantPath } from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { AlertStatus, Severity, useConfirm } from "./page";

/**
 * Link, unlink or move alerts for an active incident, shown as a dialog over
 * the incident page. Selections keep the incident revision they started from.
 */
export function IncidentMembership({
  scope,
  incident,
  initialMode = "link",
  reload,
  onDirty,
  onClose,
}: {
  scope: Scope;
  incident: RecordData;
  initialMode?: string;
  reload: () => void;
  onDirty: (dirty: boolean) => void;
  onClose?: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [includeSuppressed, setSuppressed] = useState(false);
  const [ids, setIds] = useState<Set<string>>(new Set()),
    [explicit, setExplicit] = useState("");
  const [baseRevision, setBaseRevision] = useState(incident.revision),
    [destination, setDestination] = useState<{
      id: string;
      revision: string;
    }>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const prefix = tenantPath(scope.tenant.id);
  const queryString = new URLSearchParams({
    q: query,
    cel: "true",
    include_suppressed: String(includeSuppressed),
    limit: "50",
  });
  if (cursor) queryString.set("cursor", cursor);
  const sourcePath =
    mode === "link"
      ? `${prefix}/alerts?${queryString}`
      : `${prefix}/incidents/${incident.id}/alerts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
  const candidates = useResource<RecordData[]>(sourcePath, scope.onDenied);
  const destinations = useResource<RecordData[]>(
    mode === "move" ? `${prefix}/incidents?view=active&limit=200` : null,
    scope.onDenied,
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const dirty = ids.size > 0 || !!explicit;
  const locked = command.busy || command.uncertain;
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    opener.current = document.activeElement;
    (
      dialog.current?.querySelector<HTMLElement>("#inc-member-q") ??
      dialog.current?.querySelector<HTMLElement>("select")
    )?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  async function close() {
    if (locked) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard alert selection?",
        body: <p>The selected alerts are not linked, unlinked or moved.</p>,
        confirmLabel: "Discard selection",
      }))
    )
      return;
    onDirty(false);
    onClose?.();
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmDialog) void close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  if (scope.tenant.role === "view" || incident.status === "resolved")
    return null;
  const rows = (candidates.data?.data ?? []).map((row): RecordData => ({
    ...row,
    id: String(row.alert_id ?? row.id ?? row.reference_id ?? ""),
  }));
  function reset() {
    setIds(new Set());
    setExplicit("");
    setCursor(null);
    setBaseRevision(incident.revision);
    setDestination(undefined);
  }
  function toggle(id: string) {
    setIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  }
  async function submit() {
    const selected = explicit.trim()
      ? explicit.split(/[\s,]+/).filter(Boolean)
      : Array.from(ids);
    const body =
      mode === "move"
        ? {
            source_id: incident.id,
            destination_id: destination?.id,
            source_revision: baseRevision,
            destination_revision: destination?.revision,
            alert_ids: selected,
          }
        : { expected_revision: baseRevision, alert_ids: selected };
    const path =
      mode === "move"
        ? `${prefix}/incidents/move-alerts`
        : `${prefix}/incidents/${incident.id}/alerts/${mode}`;
    if (await command.execute(path, body)) {
      reset();
      candidates.reload();
      reload();
    }
  }
  const heading =
    mode === "link"
      ? "Link alerts"
      : mode === "move"
        ? "Move alerts to another incident"
        : "Unlink alerts";
  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <div
        ref={dialog}
        className="dlg inc-member-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inc-member-title"
      >
        <div className="inc-member-head">
          <h2 id="inc-member-title">{heading}</h2>
          <span className="grow" />
          <label className="inc-inline-field small muted">
            Operation
            <select
              className="inp"
              value={mode}
              disabled={dirty || locked}
              onChange={(e) => {
                reset();
                setMode(e.target.value);
              }}
            >
              <option value="link">Link alerts</option>
              <option value="unlink">Unlink alerts</option>
              <option value="move">Move to another incident</option>
            </select>
          </label>
        </div>
        <p className="help">
          Linking does not change alert lifecycle or suppression. An alert can
          belong to only one active incident. Source base revision{" "}
          {baseRevision}.
        </p>
        {incident.revision !== baseRevision && (
          <p className="banner bn-warn">
            The incident changed to revision {incident.revision}. Your selection
            still uses revision {baseRevision}; review before submitting.
          </p>
        )}
        {mode === "link" && (
          <form
            className="inc-member-search"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q);
              setCursor(null);
            }}
          >
            <label className="sr-only" htmlFor="inc-member-q">
              Find alerts
            </label>
            <input
              id="inc-member-q"
              className="inp grow"
              value={q}
              placeholder="Find alerts by text or CEL"
              onChange={(e) => setQ(e.target.value)}
              maxLength={256}
            />
            <label className="plain">
              <input
                type="checkbox"
                checked={includeSuppressed}
                onChange={(e) => {
                  setSuppressed(e.target.checked);
                  setCursor(null);
                }}
              />
              Include suppressed
            </label>
            <button className="btn btn-sm">Search alerts</button>
          </form>
        )}
        <ErrorNotice error={candidates.error} />
        <div
          className="inc-member-list"
          role="table"
          aria-label={mode === "link" ? "Candidate alerts" : "Linked alerts"}
        >
          <div role="row" className="row head g-im">
            <span role="columnheader">
              <span className="sr-only">Select</span>
            </span>
            <span role="columnheader">Severity</span>
            <span role="columnheader">Alert</span>
            <span role="columnheader">Status</span>
          </div>
          {rows.map((row) => {
            const text = row.message ? display(row.message) : row.id;
            return (
              <div
                role="row"
                key={row.id}
                className={`row g-im ${ids.has(row.id) ? "r-sel" : ""}`}
              >
                <span role="cell">
                  <input
                    type="checkbox"
                    aria-label={`Select ${text}`}
                    checked={ids.has(row.id)}
                    disabled={locked || !!explicit.trim()}
                    onChange={() => toggle(row.id)}
                  />
                </span>
                <span role="cell">
                  {row.severity ? <Severity value={row.severity} /> : "—"}
                </span>
                <span role="cell" className="inc-title-cell">
                  <span className="alert-title">
                    <span className="cell inc-member-msg">{text}</span>
                    {row.suppressed === true && (
                      <span className="chip chip-supp">Suppressed</span>
                    )}
                    {mode === "link" &&
                      typeof row.active_incident_id === "string" && (
                        <span className="chip chip-inc">
                          {row.active_incident_id === incident.id
                            ? "Linked here"
                            : "Other incident"}
                        </span>
                      )}
                  </span>
                  <span className="sub">
                    {[row.application, row.component, row.node_name]
                      .filter((part) => typeof part === "string" && part)
                      .join(" · ")}
                  </span>
                </span>
                <span role="cell">
                  {row.status ? <AlertStatus value={row.status} /> : "—"}
                </span>
              </div>
            );
          })}
          {candidates.loading && !candidates.data && (
            <p className="inc-table-state" role="status">
              Loading candidate alerts…
            </p>
          )}
          {candidates.data && !rows.length && (
            <p className="inc-table-state muted">No alerts to show.</p>
          )}
        </div>
        <div className="inc-member-bar">
          <span className="small">
            <b>{ids.size}</b> selected
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={command.busy || command.uncertain}
            onClick={reset}
          >
            Clear selection and reload revision
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!cursor}
            onClick={() => setCursor(null)}
          >
            First candidates
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!candidates.data?.next_cursor}
            onClick={() => setCursor(candidates.data?.next_cursor ?? null)}
          >
            Next candidates
          </button>
        </div>
        <details className="inc-member-ids">
          <summary>Enter known alert IDs</summary>
          <div className="f">
            <label className="lbl" htmlFor="inc-member-ids">
              Alert IDs, separated by spaces or newlines
            </label>
            <textarea
              id="inc-member-ids"
              className="inp mono"
              rows={3}
              value={explicit}
              onChange={(e) => setExplicit(e.target.value)}
              spellCheck={false}
            />
            <span className="help">
              When supplied, these exact IDs replace the checkbox selection. At
              most 100; all must belong to this tenant.
            </span>
          </div>
        </details>
        {mode === "move" && (
          <div className="f">
            <ErrorNotice error={destinations.error} />
            <label className="lbl" htmlFor="inc-member-destination">
              Destination active incident
            </label>
            <select
              id="inc-member-destination"
              className="inp"
              value={destination?.id ?? ""}
              onChange={(e) => {
                const target = destinations.data?.data.find(
                  (item) => item.id === e.target.value,
                );
                setDestination(
                  target
                    ? { id: target.id, revision: target.revision }
                    : undefined,
                );
              }}
            >
              <option value="">Select destination</option>
              {destinations.data?.data
                .filter(
                  (item) =>
                    item.id !== incident.id && item.status !== "resolved",
                )
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {display(item.title)} · revision {item.revision}
                  </option>
                ))}
            </select>
            {destination && (
              <span className="help">
                Destination base revision {destination.revision}
              </span>
            )}
          </div>
        )}
        {command.uncertain ? (
          <p className="banner bn-warn" role="status">
            The outcome is uncertain. Retry repeats the original command and
            values.
          </p>
        ) : command.error ? (
          <p className="banner bn-err" role="alert">
            {message(command.error)}
          </p>
        ) : null}
        <div className="dlg-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            onClick={() => void close()}
          >
            Close
          </button>
          <button
            type="button"
            className="btn btn-sm btn-p"
            disabled={
              command.busy || !dirty || (mode === "move" && !destination)
            }
            onClick={() => void submit()}
          >
            {command.uncertain
              ? "Retry original command"
              : mode === "move"
                ? "Move selected alerts"
                : mode === "unlink"
                  ? "Unlink selected alerts"
                  : "Link selected alerts"}
          </button>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
