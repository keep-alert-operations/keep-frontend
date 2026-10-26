"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { alertStatus } from "@/lib/alert-status";
import { timestamp } from "@/lib/api";
import { timezoneLabel } from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { Icon } from "./icons";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Reference page frame: tenant breadcrumb, role chip, title row, update notice
 * and page actions, then the optional administration tabs and a full-height
 * body. Status banners supplied by the workspace are shown above the body.
 */
export function Page({
  scope,
  title,
  crumbs,
  extra,
  actions,
  role,
  className,
  children,
}: {
  scope: Scope;
  title: React.ReactNode;
  crumbs?: Crumb[];
  extra?: React.ReactNode;
  actions?: React.ReactNode;
  role?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  // Healthy delivery and the brief connect/reconcile steps show nothing; only
  // lost live delivery or lagging search earns a notice (REV-43).
  const degraded =
    scope.liveStatus !== undefined &&
    !["Live hints connected", "Connecting", "Reconciling"].includes(
      scope.liveStatus,
    );
  const roleLabel =
    role ??
    `${scope.tenant.role === "view" ? "View" : scope.tenant.role === "admin" ? "Admin" : "Edit"} access`;
  return (
    <div className={`page ${className ?? ""}`}>
      <header className="page-header">
        <div className="page-header-text">
          <nav className="page-crumbs" aria-label="Breadcrumb">
            <label className="sr-only" htmlFor="tenant-select">
              Tenant
            </label>
            <select
              id="tenant-select"
              aria-label="Tenant"
              value={scope.tenant.id}
              onChange={(event) =>
                scope.navigate(`/tenants/${event.target.value}/alerts`)
              }
            >
              {scope.session.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
            {(crumbs ?? []).map((crumb, index) => (
              <span
                key={`${crumb.label}:${index}`}
                style={{ display: "contents" }}
              >
                <span aria-hidden="true">/</span>
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey)
                        return;
                      event.preventDefault();
                      scope.navigate(crumb.href!);
                    }}
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </span>
            ))}
            <span className="role-chip">{roleLabel}</span>
          </nav>
          <div className="page-title">
            <h1>{title}</h1>
            {extra}
          </div>
        </div>
        <div className="page-actions">
          <span
            className="update-note"
            role="status"
            data-live-status={scope.liveStatus}
          >
            {degraded ? (
              <>
                <i aria-hidden="true" />
                <span>
                  {scope.liveStatus === "Updates unavailable"
                    ? "Updates unavailable"
                    : "Live updates degraded · reconnecting"}
                </span>
                {scope.refresh && (
                  <button
                    type="button"
                    className="btn btn-sm btn-g"
                    onClick={scope.refresh}
                  >
                    <Icon name="refresh" size={13} />
                    Refresh
                  </button>
                )}
              </>
            ) : scope.searchUpdating ? (
              <span
                className="update-note-wait"
                title="Search is catching up with the latest changes. Counts may be slightly behind."
              >
                <i aria-hidden="true" />
                Catching up · counts may lag
              </span>
            ) : null}
          </span>
          {actions}
        </div>
      </header>
      {scope.subnav && <div className="page-subnav">{scope.subnav}</div>}
      <div className="page-body">
        {scope.banners}
        {children}
      </div>
    </div>
  );
}

/** Link-styled navigation that keeps the unsaved-changes guard. */
export function NavLink({
  scope,
  href,
  className,
  children,
  onClick,
  ...rest
}: {
  scope: Scope;
  href: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      {...rest}
      href={href}
      className={className}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        scope.navigate(href);
        onClick?.(event);
      }}
    >
      {children}
    </a>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Styled confirmation dialog (reference "System states" board). Returns the
 * dialog element to render and an async confirm function.
 */
export function useConfirm(): [
  React.ReactNode,
  (options: ConfirmOptions) => Promise<boolean>,
] {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (value: boolean) => void }) | null
  >(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = useCallback(
    (value: boolean) => {
      pending?.resolve(value);
      setPending(null);
    },
    [pending],
  );
  return [
    pending ? (
      <ConfirmDialog key="confirm" options={pending} onClose={close} />
    ) : null,
    confirm,
  ];
}

function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: (value: boolean) => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(false);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [onClose]);
  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose(false);
      }}
    >
      <div
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={options.body ? "confirm-body" : undefined}
      >
        <h2 id="confirm-title">{options.title}</h2>
        {options.body && <div id="confirm-body">{options.body}</div>}
        <div className="dlg-actions">
          <button
            ref={cancel}
            type="button"
            className="btn btn-sm"
            onClick={() => onClose(false)}
          >
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${options.danger ? "btn-danger-solid" : "btn-p"}`}
            onClick={() => onClose(true)}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Severity text in its color, with the reference shape mark unless `plain`
 * (Feed and preset rows show color alone).
 */
export function Severity({
  value,
  plain,
}: {
  value: unknown;
  plain?: boolean;
}) {
  const text = typeof value === "string" ? value : "";
  const label = text ? text[0].toUpperCase() + text.slice(1) : "—";
  return (
    <span className={`sev sev-${text}`}>
      {!plain && <i aria-hidden="true" />}
      {label}
    </span>
  );
}

/** Visible alert status: Firing, Acknowledged, or Resolved. */
export function AlertStatus({
  value,
  assigneeId,
  plain,
}: {
  value: unknown;
  assigneeId?: unknown;
  plain?: boolean;
}) {
  const text = alertStatus(value, assigneeId);
  return (
    <span className={`st st-${text}`}>
      {!plain && <i aria-hidden="true" />}
      {text ? text[0].toUpperCase() + text.slice(1) : "—"}
    </span>
  );
}

// One shared clock for every relative time on the page: it ticks every five
// seconds while visible, and catches up at once when the tab returns.
const clock = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  stop: undefined as (() => void) | undefined,
};
function tick() {
  if (document.visibilityState !== "visible") return;
  clock.now = Date.now();
  clock.listeners.forEach((listener) => listener());
}
function subscribeClock(listener: () => void) {
  clock.listeners.add(listener);
  if (!clock.stop) {
    clock.now = Date.now();
    const timer = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    clock.stop = () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }
  return () => {
    clock.listeners.delete(listener);
    if (!clock.listeners.size) {
      clock.stop?.();
      clock.stop = undefined;
    }
  };
}
const readClock = () => clock.now;

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const relativeUnits: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [30, "day"],
  [12, "month"],
];

/** "30 seconds ago", "2 hours ago", "3 days ago"; under five seconds "just now". */
export function relativeTime(value: string, now: number) {
  let amount = (now - Date.parse(value)) / 1000;
  if (amount < 5) return "just now";
  for (const [size, unit] of relativeUnits) {
    if (amount < size) return relativeFormat.format(-Math.floor(amount), unit);
    amount /= size;
  }
  return relativeFormat.format(-Math.floor(amount), "year");
}

/**
 * Time relative to now (REV-43). The exact time, in the selected date format
 * with the browser timezone label, stays available as the tooltip.
 */
export function RelativeTime({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const now = useSyncExternalStore(subscribeClock, readClock, readClock);
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return <span className={className}>—</span>;
  return (
    <time
      className={className}
      dateTime={new Date(value).toISOString()}
      title={`${timestamp(value)} ${timezoneLabel()}`}
    >
      {relativeTime(value, now)}
    </time>
  );
}

export function SearchInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  width = 220,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number;
  maxLength?: number;
}) {
  return (
    <div
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted)"
        strokeWidth="2"
        aria-hidden="true"
        style={{ position: "absolute", left: 11 }}
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </svg>
      <input
        id={id}
        className="inp"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.target.value)}
        style={{ width, paddingLeft: 32 }}
      />
    </div>
  );
}

/**
 * Principal label from an id and its enriched display name; the signed-in
 * user reads "name (you)" as in the reference.
 */
export function personLabel(
  scope: Scope,
  id: unknown,
  name: unknown,
  fallback = "Unassigned",
) {
  if (typeof id !== "string" || !id) return fallback;
  const label = typeof name === "string" && name ? name : id;
  return id === scope.session.principal.id ? `${label} (you)` : label;
}
