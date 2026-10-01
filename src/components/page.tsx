"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { alertStatus } from "@/lib/alert-status";
import type { Scope } from "./workspace";
import { Icon } from "./icons";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Reference page frame: tenant breadcrumb, role chip, title row, live status
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
  const live = scope.liveStatus === "Live hints connected";
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
            className="live-pill"
            role="status"
            data-live={live}
            data-updating={scope.searchUpdating}
            title={
              scope.searchUpdating
                ? "Search is catching up with the latest changes. Counts may be slightly behind."
                : scope.liveStatus
            }
          >
            <i aria-hidden="true" />
            {live
              ? scope.searchUpdating
                ? "Updating"
                : "Live"
              : (scope.liveStatus ?? "Connecting")}
            {!live && scope.refresh && (
              <button
                type="button"
                aria-label="Refresh now"
                title="Refresh now"
                onClick={scope.refresh}
              >
                <Icon name="refresh" size={13} />
              </button>
            )}
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

/** Reference severity mark with its text label. */
export function Severity({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : "";
  const label = text ? text[0].toUpperCase() + text.slice(1) : "—";
  return (
    <span className={`sev sev-${text}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

/** Visible alert status: Firing, Acknowledged, or Resolved. */
export function AlertStatus({
  value,
  assigneeId,
}: {
  value: unknown;
  assigneeId?: unknown;
}) {
  const text = alertStatus(value, assigneeId);
  return (
    <span className={`st st-${text}`}>
      <i aria-hidden="true" />
      {text ? text[0].toUpperCase() + text.slice(1) : "—"}
    </span>
  );
}

/** Time split into the reference's two-line time/date cell. */
export function TimeCell({ value }: { value: string }) {
  const [date, time] = value.split(" ");
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
        {time ?? "—"}
      </span>
      <span className="mono" style={{ fontSize: 11, color: "var(--subtle)" }}>
        {date}
      </span>
    </span>
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
