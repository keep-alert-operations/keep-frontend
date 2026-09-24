"use client";
import { useEffect, useState } from "react";
import { ApiError, message, tenantPath, timestamp } from "@/lib/api";
import { useCommand, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import { personLabel, useConfirm } from "./page";

interface Note {
  id: string;
  text: string | null;
  deleted?: boolean;
  created_at: string;
  actor_id: string;
  actor_display_name?: string | null;
  revision: string;
}
interface Draft {
  id?: string;
  text: string;
  /** Note text when the edit started, to show later changes for review. */
  original?: string;
  revision: string;
  deleting?: boolean;
}
export interface NotesSummary {
  count: number;
  more: boolean;
  texts: Map<string, string>;
}

/**
 * Incident notes for the detail page's right column: the Notes tab pane
 * (list, edit, delete, history, deleted notes, paging) and the note composer
 * that stays at the bottom of the column on every tab.
 */
export function IncidentNotes({
  scope,
  incidentId,
  active,
  reload,
  onDirty,
  onSummary,
}: {
  scope: Scope;
  incidentId: string;
  active: boolean;
  reload: () => void;
  onDirty: (dirty: boolean) => void;
  onSummary?: (summary: NotesSummary) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const path = `${tenantPath(scope.tenant.id)}/incidents/${incidentId}/notes`;
  const result = useResource<Note[]>(
    `${path}?limit=50&include_deleted=${includeDeleted}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
    scope.version,
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const revision = result.data?.meta?.revision;
  const editable = scope.tenant.role !== "view";
  const locked = command.busy || command.uncertain;
  const notes = result.data?.data;
  const unavailable =
    typeof revision !== "string" || result.loading || !!result.error;
  useEffect(() => {
    setConflict(
      command.error instanceof ApiError && command.error.status === 409,
    );
  }, [command.error]);
  useEffect(() => {
    onDirty(!!draft);
    return () => onDirty(false);
  }, [draft, onDirty]);
  useEffect(() => {
    if (!notes || cursor || !onSummary) return;
    const current = notes.filter((note) => !note.deleted);
    onSummary({
      count: current.length,
      more: Boolean(result.data?.next_cursor),
      texts: new Map(current.map((note) => [note.id, note.text ?? ""])),
    });
  }, [notes, cursor, onSummary, result.data?.next_cursor]);

  async function save(value: Draft) {
    if (!editable) return;
    const response = await command.execute(
      value.id ? `${path}/${value.id}` : path,
      { expected_revision: value.revision, text: value.text },
      value.deleting ? "DELETE" : value.id ? "PATCH" : "POST",
      value.deleting
        ? {
            "If-Match": `"${value.revision}"`,
            "Idempotency-Key": crypto.randomUUID(),
          }
        : undefined,
    );
    if (response) {
      setDraft(null);
      result.reload();
      reload();
    }
  }
  function discard() {
    setDraft(null);
    setConflict(false);
    result.reload();
  }
  const newDraft = draft && !draft.id ? draft : null;
  const tooLong = (text: string) => Array.from(text).length > 10000;

  const feedback = (
    <>
      {command.uncertain ? (
        <p className="banner bn-warn" role="status">
          The outcome is uncertain. Retry repeats the original command and
          values. Your draft remains in this tab.
        </p>
      ) : command.error ? (
        <p className="banner bn-err" role="alert">
          {message(command.error)}
        </p>
      ) : null}
      {conflict && (
        <p className="banner bn-warn">
          Your draft was preserved. Refresh notes to review current text, then
          discard this draft and open the note again before saving a new edit.
        </p>
      )}
      {draft && typeof revision === "string" && revision !== draft.revision && (
        <p className="help">
          A newer incident revision is available. Your draft still uses its
          original revision {draft.revision}.
        </p>
      )}
    </>
  );

  return (
    <>
      <div
        className="inc-pane"
        id="inc-pane-notes"
        role="tabpanel"
        aria-labelledby="inc-tab-notes"
        hidden={!active}
      >
        <div className="inc-notes-bar">
          <label className="plain">
            <input
              type="checkbox"
              checked={includeDeleted}
              disabled={!!draft}
              onChange={(event) => {
                setIncludeDeleted(event.target.checked);
                setCursor(null);
              }}
            />
            Show deleted notes
          </label>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-sm btn-g"
            disabled={command.busy}
            onClick={() => result.reload()}
          >
            Refresh notes
          </button>
        </div>
        <ErrorNotice error={result.error} />
        {result.loading && !result.data && <p role="status">Loading notes…</p>}
        {notes && !notes.length && (
          <p className="muted small">
            {includeDeleted ? "No notes found." : "No current notes."}
          </p>
        )}
        {editable && result.data && typeof revision !== "string" && (
          <p className="banner bn-warn">
            The notes revision is unavailable. Refresh before editing.
          </p>
        )}
        <div className="inc-notes">
          {notes?.map((note) => {
            const editing = draft?.id === note.id;
            return (
              <article
                className={`inc-note ${note.deleted ? "inc-note-deleted" : ""}`}
                key={note.id}
                aria-label="Incident note"
              >
                {editing && !draft.deleting ? (
                  <form
                    className="inc-note-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(draft);
                    }}
                  >
                    {!note.deleted && note.text !== draft.original && (
                      <div className="inc-note-current">
                        <span className="lbl">Current text</span>
                        <p className="inc-note-text">{note.text}</p>
                      </div>
                    )}
                    <textarea
                      className="inp"
                      aria-label="Edit incident note"
                      rows={4}
                      value={draft.text}
                      disabled={locked}
                      required
                      onChange={(event) =>
                        setDraft({ ...draft, text: event.target.value })
                      }
                    />
                    <span className="help">
                      {Array.from(draft.text).length} / 10,000 characters · base
                      incident revision {draft.revision}
                    </span>
                    {feedback}
                    <div className="inc-note-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-g"
                        disabled={locked}
                        onClick={discard}
                      >
                        Discard note draft
                      </button>
                      <button
                        className="btn btn-sm btn-p"
                        disabled={
                          command.busy ||
                          conflict ||
                          !draft.text.trim() ||
                          tooLong(draft.text)
                        }
                      >
                        {command.uncertain
                          ? "Retry original note command"
                          : "Save note"}
                      </button>
                    </div>
                  </form>
                ) : note.deleted ? (
                  <p className="inc-note-text muted">
                    Deleted note · current text hidden
                  </p>
                ) : (
                  <p className="inc-note-text">{note.text}</p>
                )}
                <div className="tl-m">
                  {timestamp(note.created_at)} ·{" "}
                  {personLabel(
                    scope,
                    note.actor_id,
                    note.actor_display_name,
                    "Unknown author",
                  )}{" "}
                  · revision {note.revision}
                </div>
                {editing && draft.deleting && (
                  <div className="inc-note-form">
                    {feedback}
                    <div className="inc-note-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-g"
                        disabled={locked}
                        onClick={discard}
                      >
                        Discard note draft
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-p"
                        disabled={command.busy}
                        onClick={() => void save(draft)}
                      >
                        {command.uncertain
                          ? "Retry original note command"
                          : "Retry note deletion"}
                      </button>
                    </div>
                  </div>
                )}
                {!editing && (
                  <div className="inc-note-actions">
                    <button
                      type="button"
                      className="ibtn"
                      onClick={() => setHistoryNote(note.id)}
                    >
                      View note history
                    </button>
                    {editable && !note.deleted && (
                      <>
                        <button
                          type="button"
                          className="ibtn"
                          disabled={!!draft || unavailable}
                          onClick={() =>
                            setDraft({
                              id: note.id,
                              text: note.text ?? "",
                              original: note.text ?? "",
                              revision: revision as string,
                            })
                          }
                        >
                          Edit note
                        </button>
                        <button
                          type="button"
                          className="ibtn inc-danger"
                          disabled={!!draft || unavailable}
                          onClick={async () => {
                            const value = {
                              id: note.id,
                              text: note.text ?? "",
                              revision: revision as string,
                              deleting: true,
                            };
                            if (
                              !(await confirm({
                                title: "Delete this incident note?",
                                body: (
                                  <p>
                                    It will disappear from current notes;
                                    retained revisions remain in history.
                                  </p>
                                ),
                                confirmLabel: "Delete note",
                                danger: true,
                              }))
                            )
                              return;
                            setDraft(value);
                            void save(value);
                          }}
                        >
                          Delete note
                        </button>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {(cursor || result.data?.next_cursor) && (
          <div className="inc-pager">
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!cursor || !!draft || result.loading}
              onClick={() => setCursor(null)}
            >
              First notes page
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!result.data?.next_cursor || !!draft || result.loading}
              onClick={() => setCursor(result.data?.next_cursor ?? null)}
            >
              Next notes page
            </button>
          </div>
        )}
        {historyNote && (
          <IncidentNoteHistory
            key={historyNote}
            scope={scope}
            path={`${path}/${historyNote}/history`}
            close={() => setHistoryNote(null)}
          />
        )}
      </div>
      {editable && (
        <form
          className="inc-composer"
          aria-label="Add an incident note"
          onSubmit={(event) => {
            event.preventDefault();
            if (newDraft) void save(newDraft);
          }}
        >
          {newDraft && feedback}
          <div className="inc-composer-row">
            <label className="sr-only" htmlFor="inc-note-new">
              New incident note
            </label>
            <textarea
              id="inc-note-new"
              className="inp"
              rows={2}
              placeholder="Add an incident note"
              value={newDraft?.text ?? ""}
              disabled={
                locked ||
                (!!draft && !newDraft) ||
                (!newDraft && (typeof revision !== "string" || !!result.error))
              }
              onChange={(event) => {
                const text = event.target.value;
                if (newDraft) {
                  if (!text && !conflict && !command.error) setDraft(null);
                  else setDraft({ ...newDraft, text });
                } else if (text && typeof revision === "string")
                  setDraft({ text, revision });
              }}
            />
            <div className="inc-composer-actions">
              {newDraft && (conflict || !!command.error) && (
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  disabled={locked}
                  onClick={discard}
                >
                  Discard note draft
                </button>
              )}
              <button
                className="btn btn-sm"
                disabled={
                  !newDraft ||
                  command.busy ||
                  conflict ||
                  !newDraft.text.trim() ||
                  tooLong(newDraft.text)
                }
              >
                {newDraft && command.uncertain
                  ? "Retry original note command"
                  : "Add note"}
              </button>
            </div>
          </div>
          {newDraft && Array.from(newDraft.text).length > 9000 && (
            <span className="help">
              {Array.from(newDraft.text).length} / 10,000 characters
            </span>
          )}
        </form>
      )}
      {confirmDialog}
    </>
  );
}

interface NoteRevision {
  note_id: string;
  revision: string;
  text: string;
  deleted: boolean;
  actor_id: string;
  actor_display_name: string | null;
  recorded_at: string;
}

function IncidentNoteHistory({
  scope,
  path,
  close,
}: {
  scope: Scope;
  path: string;
  close: () => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const history = useResource<NoteRevision[]>(
    `${path}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    scope.onDenied,
  );
  return (
    <section
      className="inc-history"
      aria-label="Incident note revision history"
    >
      <div className="inc-history-head">
        <h3>Note revision and deletion history</h3>
        <span className="grow" />
        <button type="button" className="ibtn" onClick={close}>
          Close note history
        </button>
      </div>
      <p className="help">
        Historical text, recorded author names and deletion records for this
        retained incident.
      </p>
      <ErrorNotice error={history.error} />
      {history.loading && !history.data && (
        <p role="status">Loading note history…</p>
      )}
      {history.data && !!history.error && (
        <p className="help">Previous history page · refresh unavailable</p>
      )}
      <div className="tl">
        {history.data?.data.map((revision) => (
          <article
            className="tl-i"
            key={revision.revision}
            aria-label={`Note revision ${revision.revision}`}
          >
            <i
              className={revision.deleted ? "tl-sev" : "tl-user"}
              aria-hidden="true"
            />
            <div>
              <div className="tl-t">
                <strong>
                  Revision {revision.revision} ·{" "}
                  {revision.deleted ? "Deletion record" : "Saved text"}
                </strong>
              </div>
              {revision.deleted && (
                <p className="help">
                  This deletion hid the current note. The last text is retained
                  below as history.
                </p>
              )}
              <p className="inc-note-text">{revision.text}</p>
              <div className="tl-m">
                {timestamp(revision.recorded_at)} ·{" "}
                {revision.actor_display_name ?? "Historical name unavailable"}
              </div>
            </div>
          </article>
        ))}
      </div>
      {history.data && !history.data.data.length && (
        <p className="muted small">No revisions in this page.</p>
      )}
      <div className="inc-pager">
        <button
          type="button"
          className="btn btn-sm btn-g"
          disabled={!cursor || history.loading}
          onClick={() => setCursor(null)}
        >
          First revision page
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={
            !history.data?.next_cursor || history.loading || !!history.error
          }
          onClick={() => setCursor(history.data?.next_cursor ?? null)}
        >
          Older revisions
        </button>
        <button
          type="button"
          className="btn btn-sm btn-g"
          disabled={history.loading}
          onClick={() => {
            setCursor(null);
            history.reload();
          }}
        >
          Refresh note history
        </button>
      </div>
    </section>
  );
}
