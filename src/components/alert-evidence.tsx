"use client";
import { display, type RecordData } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { useState } from "react";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { personLabel, RelativeTime } from "./page";

function value(item: unknown) {
  if (item === null || item === undefined || item === "") return "—";
  return typeof item === "string" ? item : JSON.stringify(item);
}

/** One source event in the S03 "Source events" timeline, details on demand. */
export function SourceEvent({
  path,
  event,
  scope,
}: {
  path: string;
  event: RecordData;
  scope: Scope;
}) {
  const [opened, setOpened] = useState(false);
  const result = useResource<RecordData>(
    opened ? `${path}/source-events/${encodeURIComponent(event.id)}` : null,
    scope.onDenied,
    scope.version,
  );
  const data = result.data?.data;
  const payload =
    data && data.payload && typeof data.payload === "object"
      ? Object.entries(data.payload as Record<string, unknown>)
      : [];
  return (
    <li className="tl-i">
      <i className="tl-src" aria-hidden="true" />
      <article aria-label="Source event">
        <div className="tl-t">
          <b>Source event received.</b> Admission order{" "}
          <span className="mono">{display(event.admission_order)}</span> ·{" "}
          {event.time_defaulted
            ? "creation time defaulted at admission."
            : "creation time supplied by sender."}
        </div>
        <div className="tl-m">
          <RelativeTime value={event.received_at} />
        </div>
        <button
          type="button"
          className="cel-link ev-toggle"
          aria-expanded={opened}
          onClick={() => setOpened(!opened)}
        >
          {opened ? "Close source details" : "View source details"}
        </button>
        {opened && (
          <section aria-label="Source event details" className="ev-box">
            <ErrorNotice error={result.error} />
            {result.loading && !result.data && (
              <p role="status" className="help">
                Loading source event…
              </p>
            )}
            {data && (
              <>
                {result.error && (
                  <p role="status" className="help">
                    Previously loaded source data; refresh failed.
                  </p>
                )}
                <span className="lbl">Received JSON</span>
                <pre className="ev-json">
                  {typeof data.raw_json === "string"
                    ? data.raw_json
                    : "Original JSON unavailable."}
                </pre>
                <span className="lbl">Validated source fields</span>
                {payload.length ? (
                  <dl className="ev-fields">
                    {payload.map(([key, item]) => (
                      <div className="fld" key={key}>
                        <dt>{key.replaceAll("_", " ")}</dt>
                        <dd title={value(item)}>{value(item)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="help">No validated fields.</p>
                )}
                <span className="help">
                  Occurrence {display(data.occurrence_id)} · Adapter{" "}
                  {display(data.adapter_version)}
                </span>
              </>
            )}
          </section>
        )}
      </article>
    </li>
  );
}

/** Retained revisions of one alert note, paged newest first. */
export function AlertNoteHistory({
  path,
  noteId,
  scope,
}: {
  path: string;
  noteId: string;
  scope: Scope;
}) {
  const [opened, setOpened] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useResource<RecordData[]>(
    opened
      ? `${path}/notes/${encodeURIComponent(noteId)}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : null,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  return (
    <>
      <button
        type="button"
        className="cel-link"
        aria-expanded={opened}
        onClick={() => setOpened(!opened)}
      >
        {opened ? "Close note history" : "View note history"}
      </button>
      {opened && (
        <section aria-label="Alert note history" className="ev-box ev-history">
          <ErrorNotice error={result.error} />
          {result.loading && !result.data && (
            <p role="status" className="help">
              Loading note history…
            </p>
          )}
          {result.data && (
            <>
              {result.error && (
                <p role="status" className="help">
                  Previously loaded revisions; refresh failed.
                </p>
              )}
              {result.data.data.map((row) => (
                <article
                  key={String(row.revision)}
                  aria-label="Note revision"
                  className="ev-rev"
                >
                  <span className="small muted">
                    Revision {display(row.revision)} ·{" "}
                    {row.deleted ? "Deleted" : "Saved"} ·{" "}
                    <RelativeTime value={row.recorded_at} /> ·{" "}
                    {personLabel(
                      scope,
                      row.actor_id,
                      row.actor_display_name,
                      "—",
                    )}
                  </span>
                  <span className="ev-text">{display(row.text)}</span>
                </article>
              ))}
              {!result.data.data.length && (
                <p className="help">No retained revisions.</p>
              )}
            </>
          )}
          <div className="ev-pager">
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!cursor}
              onClick={() => setCursor(null)}
            >
              Newest revisions
            </button>
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={result.loading || !result.data?.next_cursor}
              onClick={() => setCursor(result.data?.next_cursor ?? null)}
            >
              Older revisions
            </button>
          </div>
        </section>
      )}
    </>
  );
}
