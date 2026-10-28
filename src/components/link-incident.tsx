"use client";
import { useEffect, useRef, useState } from "react";
import { display, message, RecordData, tenantPath } from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { Severity } from "./page";
import { IncidentStatus } from "./incident-list";

/**
 * Link one alert to an active incident from the alert itself (REV-48): the
 * alert page and the alert row menu. An alert another active incident owns is
 * moved there explicitly instead, since ordinary Link never steals an alert.
 */
export function LinkIncidentDialog({
  scope,
  alert,
  onDone,
  onClose,
}: {
  scope: Scope;
  alert: RecordData;
  onDone: () => void;
  onClose: () => void;
}) {
  const prefix = tenantPath(scope.tenant.id);
  const owner =
    typeof alert.active_incident_id === "string"
      ? alert.active_incident_id
      : null;
  const [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ id: string; revision: string }>();
  const params = new URLSearchParams({ view: "active", q: query, limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const incidents = useResource<RecordData[]>(
    `${prefix}/incidents?${params}`,
    scope.onDenied,
  );
  // A move carries the owning incident's revision as well.
  const source = useResource<RecordData>(
    owner ? `${prefix}/incidents/${owner}` : null,
    scope.onDenied,
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const locked = command.busy || command.uncertain;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector<HTMLElement>("#link-inc-q")?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [locked, onClose]);
  const text = display(alert.message ?? alert.application ?? alert.id);
  const ownerTitle = display(
    source.data?.data.title ??
      alert.active_incident_title ??
      "another incident",
  );
  const moving = owner !== null;
  async function submit() {
    if (!chosen) return;
    const result = moving
      ? await command.execute(`${prefix}/incidents/move-alerts`, {
          source_id: owner,
          destination_id: chosen.id,
          source_revision: source.data?.data.revision,
          destination_revision: chosen.revision,
          alert_ids: [alert.id],
        })
      : await command.execute(`${prefix}/incidents/${chosen.id}/alerts/link`, {
          expected_revision: chosen.revision,
          alert_ids: [alert.id],
        });
    if (result) {
      onDone();
      onClose();
    }
  }
  const rows = incidents.data?.data ?? [];
  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={dialog}
        className="dlg link-inc-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-inc-title"
        aria-describedby="link-inc-help"
      >
        <h2 id="link-inc-title">Link to incident</h2>
        <p id="link-inc-help">
          {moving ? (
            <>
              <b>{text}</b> is linked to <b>{ownerTitle}</b>. An alert belongs
              to one active incident, so choosing another moves it there.
            </>
          ) : (
            <>
              Choose an active incident for <b>{text}</b>. Linking does not
              change the alert&apos;s status, assignment or suppression.
            </>
          )}
        </p>
        <form
          className="inc-member-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q);
            setCursor(null);
          }}
        >
          <label className="sr-only" htmlFor="link-inc-q">
            Find active incidents
          </label>
          <input
            id="link-inc-q"
            className="inp grow"
            value={q}
            placeholder="Find active incidents"
            maxLength={256}
            onChange={(event) => setQ(event.target.value)}
          />
          <button className="btn btn-sm">Search</button>
        </form>
        <ErrorNotice error={incidents.error ?? source.error} />
        <div
          className="link-inc-list"
          role="radiogroup"
          aria-label="Active incidents"
        >
          {rows.map((row) => {
            const here = row.id === owner;
            const title = display(row.title);
            return (
              <label
                key={row.id}
                className={`link-inc-row ${chosen?.id === row.id ? "r-sel" : ""} ${here ? "link-inc-here" : ""}`}
              >
                <input
                  type="radio"
                  name="link-inc-choice"
                  value={row.id}
                  aria-label={title}
                  checked={chosen?.id === row.id}
                  disabled={here || locked}
                  onChange={() =>
                    setChosen({ id: row.id, revision: row.revision })
                  }
                />
                <Severity value={row.severity} plain />
                <span className="link-inc-title">{title}</span>
                {here ? (
                  <span className="chip chip-inc">Linked here</span>
                ) : (
                  <IncidentStatus value={row.status} />
                )}
              </label>
            );
          })}
          {incidents.loading && !incidents.data && (
            <p className="inc-table-state" role="status">
              Loading active incidents…
            </p>
          )}
          {incidents.data && !rows.length && (
            <p className="inc-table-state muted">
              {query ? "No active incidents match." : "No active incidents."}
            </p>
          )}
        </div>
        {(cursor || incidents.data?.next_cursor) && (
          <div className="inc-member-bar">
            <span className="grow" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!cursor}
              onClick={() => setCursor(null)}
            >
              First incidents
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!incidents.data?.next_cursor}
              onClick={() => setCursor(incidents.data?.next_cursor ?? null)}
            >
              Next incidents
            </button>
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
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-p"
            disabled={
              command.busy || !chosen || (moving && !source.data?.data.revision)
            }
            onClick={() => void submit()}
          >
            {command.uncertain
              ? "Retry original command"
              : moving
                ? "Move to incident"
                : "Link to incident"}
          </button>
        </div>
      </div>
    </div>
  );
}
