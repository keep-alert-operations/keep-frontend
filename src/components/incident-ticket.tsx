"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, message, RecordData } from "@/lib/api";
import { useCommand } from "@/lib/hooks";
import {
  checkTicketInput,
  checkTicketNumber,
  newIncidentFormUrl,
  ticketDescriptionSuffix,
  ticketLabel,
  TICKET_NUMBER_HELP,
  TICKET_TITLE_MAX,
  type TicketCheck,
} from "@/lib/incident-ticket";
import type { Scope } from "./workspace";
import { personLabel } from "./page";

/*
 * ServiceNow tickets on incidents (REV-70; incident operations 15): the Link
 * and Create dialogs. Keep stores only the link and optional number; it never
 * reads, creates or changes tickets.
 */

export function TicketIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v2M14 11v2M14 16v2" />
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function LinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" />
    </svg>
  );
}

/** The ticket pill: the number in mono, or "ServiceNow ticket". */
export function TicketPill({
  number,
  href,
}: {
  number: string | null;
  href?: string;
}) {
  const content = (
    <>
      <span className="inc-ticket-ic" aria-hidden="true">
        <TicketIcon size={13} />
      </span>
      <span className={number ? "mono" : undefined}>{ticketLabel(number)}</span>
      <ExternalIcon size={12} />
    </>
  );
  return href ? (
    <a
      className="inc-ticket-pill"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Opens in ServiceNow in a new tab"
    >
      {content}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <span className="inc-ticket-pill">{content}</span>
  );
}

/* ------------------------------------------------------------ the entry */

interface Entry {
  check: TicketCheck;
  numberOk: boolean;
  /** Number to save: from the input, the link, or the optional field. */
  number: string | null;
  ready: boolean;
}

function entry(value: string, extra: string, base: URL): Entry {
  const check = checkTicketInput(value, base);
  const field = checkTicketNumber(extra);
  const asked = check.kind === "ok" && !check.number;
  const numberOk = !asked || field.ok;
  const number =
    check.kind === "ok"
      ? (check.number ?? (asked && field.ok ? field.number : null))
      : null;
  return { check, numberOk, number, ready: check.kind === "ok" && numberOk };
}

/** "Ticket link or number" with live checks, number field and preview. */
function TicketEntry({
  id,
  base,
  value,
  extra,
  disabled,
  inputRef,
  onValue,
  onExtra,
  preview = true,
}: {
  id: string;
  base: URL;
  value: string;
  extra: string;
  disabled: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onValue: (value: string) => void;
  onExtra: (value: string) => void;
  preview?: boolean;
}) {
  const state = entry(value, extra, base);
  const { check } = state;
  const asked = check.kind === "ok" && !check.number;
  const messageId = `${id}-msg`;
  return (
    <>
      <div className="f inc-ticket-field">
        <label className="lbl" htmlFor={id}>
          Ticket link or number
        </label>
        <input
          id={id}
          ref={inputRef}
          className={`inp mono ${check.kind === "error" ? "inc-ticket-bad" : ""}`}
          value={value}
          placeholder={`${base.origin}/… or INC0041235`}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={check.kind === "error"}
          aria-describedby={messageId}
          onChange={(event) => onValue(event.target.value)}
        />
        <div id={messageId}>
          {check.kind === "error" && (
            <p className="inc-ticket-err" role="alert">
              {check.message}
            </p>
          )}
          {check.kind === "empty" && (
            <p className="help inc-ticket-help">
              Copy the address from the ticket in ServiceNow, or type its
              number. Only links to {base.host} can be saved.
            </p>
          )}
          {check.kind === "ok" && (
            <p className="inc-ticket-ok" role="status">
              {check.fromNumber
                ? `Keep will link ${check.number} at ${base.host}.`
                : check.number
                  ? `ServiceNow link for ${check.number}.`
                  : `ServiceNow link at ${base.host}.`}
            </p>
          )}
        </div>
      </div>
      {asked && (
        <div className="f inc-ticket-field">
          <label className="lbl" htmlFor={`${id}-number`}>
            Ticket number <span className="inc-optional">(optional)</span>
          </label>
          <input
            id={`${id}-number`}
            className={`inp mono inc-ticket-number ${state.numberOk ? "" : "inc-ticket-bad"}`}
            value={extra}
            placeholder="INC0041235"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={!state.numberOk}
            aria-describedby={`${id}-number-help`}
            onChange={(event) => onExtra(event.target.value)}
          />
          <p className="help inc-ticket-help" id={`${id}-number-help`}>
            That link doesn&apos;t include the number. Add it so people can
            recognise the ticket without opening it.
          </p>
          {!state.numberOk && (
            <p className="inc-ticket-err" role="alert">
              {TICKET_NUMBER_HELP}
            </p>
          )}
        </div>
      )}
      {preview && check.kind === "ok" && (
        <div className="f inc-ticket-field">
          <span className="lbl">On the incident</span>
          <div className="inc-ticket-preview">
            <TicketPill number={state.number} />
            <span className="help">
              Opens the ticket in ServiceNow in a new tab. Shown in Activity as
              &quot;ServiceNow ticket linked&quot;.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------- shared dialog parts */

function CloseButton({
  onClose,
  disabled,
}: {
  onClose: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-g btn-sm inc-ticket-close"
      aria-label="Close"
      disabled={disabled}
      onClick={onClose}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

/** Escape closes; focus moves in on open and back to the opener on close. */
function useDialogFocus(
  first: React.RefObject<HTMLElement | null>,
  locked: boolean,
  onClose: () => void,
) {
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    first.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
    // Runs once per dialog.
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [locked, onClose]);
}

const isStale = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 409 &&
  error.code === "revision_conflict";

function TicketFeedback({
  command,
  base,
}: {
  command: { error?: unknown; uncertain: boolean };
  base: URL;
}) {
  if (command.uncertain)
    return (
      <div className="banner bn-warn" role="status">
        The outcome is uncertain. Retry repeats the original command and values.
      </div>
    );
  const error = command.error;
  if (!error || isStale(error)) return null;
  const text =
    error instanceof ApiError && error.code === "ticket_url_invalid"
      ? `Keep didn't accept this link. Only links to ${base.host} can be saved. (${error.code})`
      : error instanceof ApiError && error.code === "servicenow_not_configured"
        ? `ServiceNow is no longer set up in Keep, so tickets can't be linked. Unlinking still works. (${error.code})`
        : message(error);
  return (
    <div className="banner bn-err" role="alert">
      {text}
    </div>
  );
}

/**
 * Saves the ticket against the revision the dialog opened with, so a live
 * refresh never lets it overwrite someone else's change unseen. A stale
 * revision keeps the entry, reloads the incident, reports who changed it and
 * only then adopts the new revision for the next save.
 */
function useTicketSave({
  scope,
  path,
  incident,
  reload,
}: {
  scope: Scope;
  path: string;
  incident: RecordData;
  reload: () => void;
}) {
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [stale, setStale] = useState(false);
  const [baseRevision, setBaseRevision] = useState(incident.revision);
  const [opened] = useState(() => ({
    url: incident.ticket_url ?? null,
    number: incident.ticket_number ?? null,
  }));
  async function save(url: string, number: string | null) {
    const result = await command.execute(`${path}/ticket`, {
      expected_revision: baseRevision,
      url,
      number,
    });
    return Boolean(result);
  }
  useEffect(() => {
    if (isStale(command.error)) {
      setStale(true);
      reload();
    }
  }, [command.error, reload]);
  // The conflict notice describes the reloaded incident; a retry saves over it.
  useEffect(() => {
    if (stale) setBaseRevision(incident.revision);
  }, [stale, incident.revision]);
  const ticketChanged =
    (incident.ticket_url ?? null) !== opened.url ||
    (incident.ticket_number ?? null) !== opened.number;
  const linkedNow = typeof incident.ticket_url === "string";
  const by = personLabel(
    scope,
    incident.ticket_linked_by,
    incident.ticket_linked_by_display_name,
    "Someone",
  );
  const notice = !stale ? null : ticketChanged && linkedNow ? (
    <>
      {by} linked{" "}
      <span className={incident.ticket_number ? "mono" : undefined}>
        {ticketLabel(incident.ticket_number)}
      </span>{" "}
      to this incident while this was open. Your entry is kept. Link again to
      replace it, or cancel to keep theirs.
    </>
  ) : ticketChanged ? (
    <>
      Someone unlinked the ticket while this was open. Your entry is kept. Link
      again to save it.
    </>
  ) : (
    <>
      Someone else changed this incident while this was open. Your entry is
      kept. Link again to save it.
    </>
  );
  return { command, save, stale, notice };
}

function StaleNotice({ children }: { children: ReactNode }) {
  return children ? (
    <div className="banner bn-warn" role="alert">
      {children}
    </div>
  ) : null;
}

/* ------------------------------------------------------------ link dialog */

/** Link existing ticket / Link a different ticket. */
export function TicketLinkDialog({
  scope,
  path,
  incident,
  base,
  replacing,
  reload,
  onDirty,
  onClose,
}: {
  scope: Scope;
  path: string;
  incident: RecordData;
  base: URL;
  replacing: boolean;
  reload: () => void;
  onDirty: (dirty: boolean) => void;
  onClose: (saved: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [extra, setExtra] = useState("");
  const { command, save, stale, notice } = useTicketSave({
    scope,
    path,
    incident,
    reload,
  });
  const [openedLabel] = useState(() =>
    replacing ? ticketLabel(incident.ticket_number) : null,
  );
  // After a conflict the note names the ticket a retry would replace now.
  const replaced = !stale
    ? openedLabel
    : typeof incident.ticket_url === "string"
      ? ticketLabel(incident.ticket_number)
      : null;
  const state = entry(value, extra, base);
  const locked = command.busy || command.uncertain;
  const first = useRef<HTMLInputElement>(null);
  const dirty = Boolean(value.trim() || extra.trim());
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useDialogFocus(first, locked, () => onClose(false));
  async function submit() {
    // After an uncertain outcome the command repeats its original body.
    if (command.uncertain) {
      if (await save("", null)) onClose(true);
      return;
    }
    if (!state.ready || state.check.kind !== "ok") return;
    if (await save(state.check.url, state.number)) onClose(true);
  }
  const title = replacing ? "Link a different ticket" : "Link existing ticket";
  return (
    <div className="dlg-backdrop">
      <form
        className="dlg inc-dlg inc-ticket-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inc-ticket-link-title"
        aria-describedby="inc-ticket-link-sub"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="inc-ticket-head">
          <div className="inc-ticket-titles">
            <h2 id="inc-ticket-link-title">{title}</h2>
            <span className="help inc-ticket-sub" id="inc-ticket-link-sub">
              {String(incident.title ?? incident.id)} · ServiceNow at{" "}
              <span className="mono">{base.host}</span>
            </span>
          </div>
          <CloseButton onClose={() => onClose(false)} disabled={locked} />
        </div>
        {replaced && (
          <div className="banner bn-info">
            <span>
              This replaces{" "}
              <span className={incident.ticket_number ? "mono" : undefined}>
                {replaced}
              </span>
              . Nothing changes in ServiceNow.
            </span>
          </div>
        )}
        <StaleNotice>{notice}</StaleNotice>
        <TicketEntry
          id="inc-ticket-link-input"
          base={base}
          value={value}
          extra={extra}
          disabled={locked}
          inputRef={first}
          onValue={setValue}
          onExtra={setExtra}
        />
        <TicketFeedback command={command} base={base} />
        <div className="inc-ticket-foot">
          <span className="help inc-ticket-foot-note">
            Keep saves the link only. It doesn&apos;t read or change the ticket.
          </span>
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
            disabled={command.busy || (!state.ready && !command.uncertain)}
          >
            {command.uncertain
              ? "Retry original command"
              : stale
                ? "Link and replace"
                : replacing
                  ? "Replace ticket"
                  : "Link ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------- create dialog */

const STEPS = [
  ["fill", "Fill in the ticket"],
  ["link", "Link it back"],
] as const;

/** Create in ServiceNow: open the prefilled form, then link the ticket back. */
export function TicketCreateDialog({
  scope,
  path,
  incident,
  base,
  severity,
  reload,
  onDirty,
  onClose,
}: {
  scope: Scope;
  path: string;
  incident: RecordData;
  base: URL;
  /** Severity as shown to people, e.g. "Critical". */
  severity: string;
  reload: () => void;
  onDirty: (dirty: boolean) => void;
  onClose: (saved: boolean) => void;
}) {
  const [prefill] = useState(() => {
    const incidentUrl = `${window.location.origin}/tenants/${encodeURIComponent(scope.tenant.id)}/incidents/${encodeURIComponent(incident.id)}`;
    const suffix = ticketDescriptionSuffix(severity, incidentUrl);
    const description =
      typeof incident.description === "string" ? incident.description : "";
    // Without an incident description the severity line starts the text.
    const kept = description.trim() ? suffix : suffix.replace(/^\n\n/, "");
    return {
      title: Array.from(String(incident.title ?? ""))
        .slice(0, TICKET_TITLE_MAX)
        .join(""),
      description: `${description.trimEnd()}${kept}`,
      suffix: kept,
    };
  });
  const [step, setStep] = useState<"fill" | "link">("fill");
  const [title, setTitle] = useState(prefill.title);
  const [description, setDescription] = useState(prefill.description);
  const [value, setValue] = useState("");
  const [extra, setExtra] = useState("");
  const { command, save, stale, notice } = useTicketSave({
    scope,
    path,
    incident,
    reload,
  });
  const state = entry(value, extra, base);
  const locked = command.busy || command.uncertain;
  const titleRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const dirty = Boolean(value.trim() || extra.trim());
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useDialogFocus(titleRef, locked, () => onClose(false));
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!moved) return;
    (step === "fill" ? titleRef : linkRef).current?.focus();
  }, [step, moved]);
  const titleLength = Array.from(title).length;
  function openForm() {
    const url = newIncidentFormUrl(base, title, description, prefill.suffix);
    window.open(url, "_blank", "noopener,noreferrer");
  }
  async function submit() {
    if (step === "fill") {
      if (!title.trim()) return;
      openForm();
      setMoved(true);
      setStep("link");
      return;
    }
    // After an uncertain outcome the command repeats its original body.
    if (command.uncertain) {
      if (await save("", null)) onClose(true);
      return;
    }
    if (!state.ready || state.check.kind !== "ok") return;
    if (await save(state.check.url, state.number)) onClose(true);
  }
  return (
    <div className="dlg-backdrop">
      <form
        className="dlg inc-dlg inc-ticket-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inc-ticket-create-title"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="inc-ticket-head">
          <div className="inc-ticket-titles">
            <h2 id="inc-ticket-create-title">Create in ServiceNow</h2>
            <ol className="inc-ticket-steps" aria-label="Steps">
              {STEPS.map(([key, label], index) => (
                <li
                  key={key}
                  className={
                    step === key
                      ? "on"
                      : step === "link" && key === "fill"
                        ? "done"
                        : undefined
                  }
                  aria-current={step === key ? "step" : undefined}
                >
                  <b aria-hidden="true">{index + 1}</b>
                  <span className="sr-only">Step {index + 1}: </span>
                  {label}
                </li>
              ))}
            </ol>
          </div>
          <CloseButton onClose={() => onClose(false)} disabled={locked} />
        </div>
        {step === "fill" ? (
          <>
            <div className="f inc-ticket-field">
              <div className="inc-ticket-label-row">
                <label className="lbl" htmlFor="inc-ticket-create-name">
                  Ticket Title
                </label>
                <span
                  className="inc-ticket-count"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {titleLength} / {TICKET_TITLE_MAX}
                </span>
              </div>
              <input
                id="inc-ticket-create-name"
                ref={titleRef}
                className="inp"
                value={title}
                required
                maxLength={TICKET_TITLE_MAX}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="f inc-ticket-field">
              <label className="lbl" htmlFor="inc-ticket-create-description">
                Description
              </label>
              <textarea
                id="inc-ticket-create-description"
                className="inp inc-ticket-ta"
                rows={7}
                value={description}
                aria-describedby="inc-ticket-create-description-help"
                onChange={(event) => setDescription(event.target.value)}
              />
              <p
                className="help inc-ticket-help"
                id="inc-ticket-create-description-help"
              >
                Filled in from the incident. The link back to Keep lets
                ServiceNow users find this incident.
              </p>
            </div>
            <div className="banner bn-info">
              <ExternalIcon size={16} />
              <span>
                ServiceNow&apos;s new incident form opens in a new tab with
                these filled in. Set the remaining fields and submit it there.
                Keep doesn&apos;t create the ticket itself.
              </span>
            </div>
            <div className="inc-ticket-foot">
              <span className="grow" />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onClose(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-sm btn-p"
                disabled={!title.trim()}
              >
                Open ServiceNow form
                <ExternalIcon size={13} />
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="inc-ticket-lead">
              The form opened in a new tab. After you submit it, copy the new
              ticket&apos;s link or number from ServiceNow and paste it here.
            </p>
            <StaleNotice>{notice}</StaleNotice>
            <TicketEntry
              id="inc-ticket-create-input"
              base={base}
              value={value}
              extra={extra}
              disabled={locked}
              inputRef={linkRef}
              onValue={setValue}
              onExtra={setExtra}
              preview={false}
            />
            <p className="help inc-ticket-help">
              Didn&apos;t open?{" "}
              <button
                type="button"
                className="inc-ticket-textbtn"
                onClick={openForm}
              >
                Open the form again
              </button>
              . Your browser may have blocked the new tab.
            </p>
            <TicketFeedback command={command} base={base} />
            <div className="inc-ticket-foot">
              <button
                type="button"
                className="btn btn-sm btn-g"
                disabled={locked}
                onClick={() => {
                  setMoved(true);
                  setStep("fill");
                }}
              >
                Back
              </button>
              <span className="grow" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={locked}
                onClick={() => onClose(false)}
              >
                Link later
              </button>
              <button
                type="submit"
                className="btn btn-sm btn-p"
                disabled={command.busy || (!state.ready && !command.uncertain)}
              >
                {command.uncertain
                  ? "Retry original command"
                  : stale
                    ? "Link and replace"
                    : "Link ticket"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
