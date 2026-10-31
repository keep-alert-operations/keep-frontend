"use client";
import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { alertTitle, RecordData } from "@/lib/api";
import { components } from "@/lib/generated";
import { CommandFeedback } from "./ui";

export type DismissalValue = components["schemas"]["DismissalValue"];

const MINUTE = 60_000;
const MAX_MS = 30 * 24 * 60 * MINUTE;
const PRESETS: [number, string][] = [
  [15 * 60, "15 min"],
  [30 * 60, "30 min"],
  [60 * 60, "1 hour"],
  [2 * 3600, "2 hours"],
  [4 * 3600, "4 hours"],
  [8 * 3600, "8 hours"],
  [86400, "1 day"],
  [7 * 86400, "1 week"],
];
const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNITS;

/** The stored end of a still-running dismissal, or null (REV-49). */
export function dismissedUntil(alert: RecordData): Date | null {
  const raw =
    typeof alert.dismissed_until === "string"
      ? alert.dismissed_until
      : (alert.dismissal as { until?: unknown } | null | undefined)?.until;
  if (typeof raw !== "string") return null;
  const until = new Date(raw);
  return Number.isNaN(until.getTime()) || until.getTime() <= Date.now()
    ? null
    : until;
}

export function formatUntil(value: Date, now = new Date()) {
  const time = value.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (value.toDateString() === now.toDateString()) return time;
  return `${value.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

export function formatUntilFull(value: Date) {
  return value.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 2 hours 30 min" for a time ahead of now. */
export function relative(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60)
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60),
      rest = minutes % 60;
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}${rest ? ` ${rest} min` : ""}`;
  }
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return `in ${days} ${days === 1 ? "day" : "days"}${hours ? ` ${hours} h` : ""}`;
}

function zone() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-",
    abs = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function localParts(value: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
}

function nextMorning(days: number) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  value.setHours(9, 0, 0, 0);
  return value;
}

function nextMonday() {
  const today = new Date().getDay();
  return nextMorning((8 - today) % 7 || 7);
}

/**
 * Dismiss one firing alert for a duration or until a time (REV-49). The server
 * measures durations from its own clock; the summary here is only a preview.
 */
export function DismissDialog({
  alert,
  command,
  onClose,
  onSubmit,
}: {
  alert: RecordData;
  command: { error?: unknown; uncertain: boolean; busy: boolean };
  onClose: () => void;
  onSubmit: (value: DismissalValue) => Promise<boolean>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const current = dismissedUntil(alert);
  const [mode, setMode] = useState<"duration" | "until">(
    current ? "until" : "duration",
  );
  const [preset, setPreset] = useState<number | "custom">(3600);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<Unit>("minutes");
  const initial = localParts(current ?? nextMorning(1));
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [reason, setReason] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (element && !element.open) element.showModal();
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(tick);
      if (element?.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  let end: number | undefined, error: string | undefined;
  let value: DismissalValue | undefined;
  // An empty Custom field is not an error yet; it only waits for a number.
  const awaiting = mode === "duration" && preset === "custom" && !amount.trim();
  if (awaiting) {
    // Nothing to validate or submit until a number is entered.
  } else if (mode === "duration") {
    const seconds =
      preset === "custom"
        ? /^[1-9][0-9]*$/.test(amount.trim())
          ? Number(amount.trim()) * UNITS[unit]
          : NaN
        : preset;
    if (!Number.isFinite(seconds))
      error = "Enter a whole number greater than zero.";
    else if (seconds * 1000 > MAX_MS)
      error = "A dismissal can last up to 30 days.";
    else {
      end = now + seconds * 1000;
      value = { duration_seconds: seconds };
    }
  } else {
    const at = new Date(`${date}T${time}`);
    if (!date || !time || Number.isNaN(at.getTime()))
      error = "Choose a date and a time.";
    else if (at.getTime() <= now)
      error = `Choose a time after now (${formatUntilFull(new Date(now))}).`;
    else if (at.getTime() - now > MAX_MS)
      error = "A dismissal can last up to 30 days.";
    else {
      end = at.getTime();
      value = { until: at.toISOString() };
    }
  }
  const editing = current !== null;
  const returnsAs = alert.assignee_id ? "Acknowledged" : "Firing";
  const customActive = mode === "duration" && preset === "custom";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value || command.busy) return;
    const text = reason.trim();
    if (await onSubmit(text ? { ...value, reason: text } : value)) onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="dlg dismiss-dialog"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <div className="dismiss-head">
        <div className="dismiss-title">
          <h2 id={`${id}-heading`}>
            {editing ? "Change dismissal" : "Dismiss alert"}
          </h2>
          <span className="dismiss-alert">{alertTitle(alert)}</span>
        </div>
        <button
          type="button"
          className="btn btn-g btn-sm dismiss-close"
          aria-label="Close"
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
      </div>
      <form className="dismiss-form" onSubmit={submit} noValidate>
        <fieldset className="dismiss-seg">
          <legend className="sr-only">How long</legend>
          {(
            [
              ["duration", "For a duration"],
              ["until", "Until a date"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className={mode === key ? "on" : undefined}>
              <input
                type="radio"
                name={`${id}-mode`}
                className="sr-only"
                checked={mode === key}
                onChange={() => setMode(key)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {/* Both modes share one grid cell, so switching never resizes the dialog. */}
        <div className="dismiss-modes">
          <fieldset
            className={
              mode === "duration"
                ? "dismiss-group"
                : "dismiss-group dismiss-hidden"
            }
            inert={mode !== "duration"}
          >
            <legend className="lbl">Dismiss for</legend>
            <div className="dismiss-pills">
              {PRESETS.map(([seconds, label]) => (
                <label
                  key={seconds}
                  className={preset === seconds ? "pill on" : "pill"}
                >
                  <input
                    type="radio"
                    name={`${id}-preset`}
                    className="sr-only"
                    checked={preset === seconds}
                    onChange={() => setPreset(seconds)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div
              className={
                customActive
                  ? error
                    ? "dismiss-custom err"
                    : "dismiss-custom on"
                  : "dismiss-custom"
              }
            >
              <label className="dismiss-custom-l" htmlFor={`${id}-amount`}>
                Custom
              </label>
              <input
                id={`${id}-amount`}
                className="dismiss-custom-n"
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="Enter a number"
                value={amount}
                aria-invalid={customActive && Boolean(error)}
                onFocus={() => setPreset("custom")}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setPreset("custom");
                }}
              />
              <label className="sr-only" htmlFor={`${id}-unit`}>
                Unit
              </label>
              <select
                id={`${id}-unit`}
                className="dismiss-custom-u"
                value={unit}
                onFocus={() => setPreset("custom")}
                onChange={(event) => {
                  setUnit(event.target.value as Unit);
                  setPreset("custom");
                }}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </fieldset>
          <fieldset
            className={
              mode === "until"
                ? "dismiss-group"
                : "dismiss-group dismiss-hidden"
            }
            inert={mode !== "until"}
          >
            <legend className="lbl">Dismiss until</legend>
            <div className="dismiss-when">
              <label className="sr-only" htmlFor={`${id}-date`}>
                Date
              </label>
              <input
                id={`${id}-date`}
                className="inp"
                type="date"
                value={date}
                aria-invalid={mode === "until" && Boolean(error)}
                onChange={(event) => setDate(event.target.value)}
              />
              <label className="sr-only" htmlFor={`${id}-time`}>
                Time
              </label>
              <input
                id={`${id}-time`}
                className="inp"
                type="time"
                value={time}
                aria-invalid={mode === "until" && Boolean(error)}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
            <div className="dismiss-quick">
              {(
                [
                  ["Tomorrow 09:00", nextMorning(1)],
                  ["Monday 09:00", nextMonday()],
                ] as const
              ).map(([label, at]) => (
                <button
                  key={label}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const parts = localParts(at);
                    setDate(parts.date);
                    setTime(parts.time);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="help">Times are in your time zone, {zone()}.</span>
          </fieldset>
        </div>
        <label className="f">
          <span className="lbl">
            Reason{" "}
            <span className="dismiss-optional">
              (optional, added as a note)
            </span>
          </span>
          <textarea
            className="inp dismiss-reason"
            maxLength={10000}
            placeholder="Why is it safe to set aside for now?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {/* A hidden full-length summary holds the space for every message. */}
        <div className="dismiss-status">
          <div className="dismiss-summary dismiss-hidden" aria-hidden="true">
            <ClockIcon />
            <div>
              <span>
                Suppressed until <b>Wed, Oct 28, 12:00 PM</b> (in 23 hours 59
                min), so it is hidden from the feed. It then returns as{" "}
                <b>Acknowledged</b>.
              </span>
              <span className="dismiss-note">
                If the alert resolves and fires again, the dismissal ends early.
                Assignment, incident links and notes stay as they are.
              </span>
            </div>
          </div>
          {command.error || command.uncertain ? (
            <div className="dismiss-feedback">
              <CommandFeedback command={{ ...command, busy: false }} />
            </div>
          ) : end !== undefined ? (
            <div className="dismiss-summary" role="status">
              <ClockIcon />
              <div>
                <span>
                  Suppressed until <b>{formatUntilFull(new Date(end))}</b> (
                  {relative(end - now)}), so it is hidden from the feed. It then
                  returns as <b>{returnsAs}</b>.
                </span>
                <span className="dismiss-note">
                  If the alert resolves and fires again, the dismissal ends
                  early. Assignment, incident links and notes stay as they are.
                </span>
              </div>
            </div>
          ) : error ? (
            <div className="dismiss-summary err" role="alert">
              <ClockIcon />
              <span>{error}</span>
            </div>
          ) : (
            <div className="dismiss-summary idle" role="status">
              <ClockIcon />
              <span>
                Enter how many minutes, hours or days to dismiss it for.
              </span>
            </div>
          )}
        </div>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-p"
            disabled={!value || command.busy}
          >
            {editing ? "Update dismissal" : "Dismiss"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function ClockIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** The Suppressed indicator, naming a running dismissal's end. */
export function SuppressedChip({ alert }: { alert: RecordData }) {
  if (alert.suppressed !== true) return null;
  const until = dismissedUntil(alert);
  return (
    <span
      className="chip chip-supp"
      title={until ? `Dismissed until ${formatUntilFull(until)}` : undefined}
    >
      {until ? `Suppressed · until ${formatUntil(until)}` : "Suppressed"}
    </span>
  );
}
