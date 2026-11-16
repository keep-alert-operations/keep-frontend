"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, Envelope, request, requestStatus } from "@/lib/api";
import { ErrorNotice } from "./ui";

export interface DirectoryPrincipal {
  /** Null for a directory match Keep has not saved yet (REV-73). */
  id: string | null;
  directory_source: string;
  object_id: string;
  display_name: string;
  kind: "user" | "team";
  eligible: boolean;
  deleted: boolean;
  selectable: boolean;
  verification: string;
  verified_at: string | null;
}

/** Initials for the reference's round avatar. */
export function initials(name: string) {
  const parts = name.split(/[ ._@-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** A pick being saved from the directory (tenant access 5, save on pick). */
type Save =
  | { state: "saving" }
  | { state: "pending" }
  | { state: "saved"; row: DirectoryPrincipal }
  | { state: "failed"; reason: string }
  | { state: "refused"; message: string };

/** Polls start this long after each answer, not on a fixed timer. */
const POLL_DELAY_MS = 3000;

const failureReasons: Record<string, string> = {
  directory_unavailable: "The company directory didn't answer.",
  directory_group_too_large: "It has too many members for Keep to save.",
  directory_verification_deadline:
    "Reading it from the directory took too long.",
  directory_busy: "The directory was busy.",
};

const rowKey = (principal: DirectoryPrincipal) =>
  `${principal.directory_source}:${principal.object_id}`;

function isPrincipal(value: unknown): value is DirectoryPrincipal {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as DirectoryPrincipal).object_id === "string" &&
    typeof (value as DirectoryPrincipal).display_name === "string"
  );
}

/**
 * Compact company-directory search: an input, an optional Search button and
 * a results list. Used inline (permissions add row, `floating`) and inside
 * popovers by other screens. With `resolve`, choosing a match Keep has not
 * saved saves it from the directory first (REV-73).
 */
export function DirectoryPicker({
  endpoint,
  resolve,
  onChoose,
  onDenied,
  disabled = false,
  label = "Search directory",
  placeholder = "Search by name · at least 2 characters",
  labelHidden = false,
  floating = false,
  searchOnType = false,
  showSearchButton = true,
  trailing,
  onQueryChange,
}: {
  endpoint: string;
  /** `POST`/`GET …/permission-principals/resolve` and the session's CSRF token. */
  resolve?: { endpoint: string; csrf?: string };
  onChoose: (principal: DirectoryPrincipal & { id: string }) => void;
  onDenied: () => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  /** Keep the label for assistive technology only. */
  labelHidden?: boolean;
  /** Show results as a dropdown under the input. */
  floating?: boolean;
  /** Search shortly after typing stops (Enter still searches at once). */
  searchOnType?: boolean;
  showSearchButton?: boolean;
  /** Controls placed after the input on the same row. */
  trailing?: React.ReactNode;
  onQueryChange?: (query: string) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<{
    endpoint: string;
    query: string;
    page?: Envelope<DirectoryPrincipal[]>;
    error?: unknown;
    loading: boolean;
  }>({ endpoint, query: "", loading: false });
  const [saves, setSaves] = useState<Record<string, Save>>({});
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<AbortController | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => () => pending.current?.abort(), [endpoint]);
  // Saves and their polls belong to this picker: leaving the page stops the
  // polls, and the Product API finishes a background save anyway.
  const live = useRef(true);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    live.current = true;
    const waiting = timers.current,
      inFlight = requests.current;
    return () => {
      live.current = false;
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    };
  }, []);
  const current = state.endpoint === endpoint ? state : undefined;
  const queryValid =
    Array.from(query).length >= 2 &&
    Array.from(query).length <= 100 &&
    !!query.trim();

  async function search(cursor?: string) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const searched = cursor ? (current?.query ?? query) : query;
    setOpen(true);
    setState({ endpoint, query: searched, loading: true });
    try {
      const params = new URLSearchParams({ q: searched, limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const page = await request<DirectoryPrincipal[]>(
        `${endpoint}?${params}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setState({ endpoint, query: searched, page, loading: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ endpoint, query: searched, error, loading: false });
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        onDenied();
    }
  }
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });
  const searchedQuery = current?.query;
  const chosen = useRef<string | null>(null);
  useEffect(() => {
    if (
      !searchOnType ||
      !queryValid ||
      disabled ||
      searchedQuery === query ||
      chosen.current === query
    )
      return;
    const timer = setTimeout(() => void searchRef.current(), 350);
    return () => clearTimeout(timer);
  }, [query, searchOnType, queryValid, disabled, searchedQuery]);
  useEffect(() => {
    if (!floating || !open) return;
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [floating, open]);
  const showResults =
    open && !!current && (current.loading || !!current.page || !!current.error);

  // Answers arrive after awaits; they act with the latest props.
  const latest = useRef({ onChoose, onDenied, floating, resolve });
  useEffect(() => {
    latest.current = { onChoose, onDenied, floating, resolve };
  });
  function choose(principal: DirectoryPrincipal) {
    if (!principal.id || !principal.selectable) return;
    if (latest.current.floating) {
      chosen.current = principal.display_name;
      setQuery(principal.display_name);
      setOpen(false);
    }
    latest.current.onChoose({ ...principal, id: principal.id });
  }
  function record(key: string, save: Save) {
    if (live.current) setSaves((all) => ({ ...all, [key]: save }));
  }
  function tracked() {
    const controller = new AbortController();
    requests.current.add(controller);
    return controller;
  }
  const subject = (principal: DirectoryPrincipal) =>
    principal.kind === "team" ? "group" : "user";
  /** Applies one resolve answer: 200 saved, 202 still saving. */
  function answered(
    principal: DirectoryPrincipal,
    status: number,
    data: unknown,
    picked: boolean,
  ) {
    const key = rowKey(principal);
    if (status === 202) {
      record(key, { state: "pending" });
      const timer = setTimeout(() => {
        timers.current.delete(key);
        void poll(principal);
      }, POLL_DELAY_MS);
      clearTimeout(timers.current.get(key));
      timers.current.set(key, timer);
      return;
    }
    if (!isPrincipal(data)) {
      record(key, { state: "failed", reason: "invalid_response" });
      setAnnouncement(`Couldn't add this ${subject(principal)}.`);
      return;
    }
    record(key, { state: "saved", row: data });
    // The pick that saved inline completes at once; a background save that
    // finished later only makes the row selectable.
    if (picked && data.selectable && data.id) choose(data);
    else
      setAnnouncement(
        data.selectable
          ? `${data.display_name} saved. Choose it to add.`
          : `${data.display_name} saved.`,
      );
  }
  function failed(
    principal: DirectoryPrincipal,
    error: unknown,
    polling: boolean,
  ) {
    const key = rowKey(principal);
    if (error instanceof ApiError && error.status === 422) {
      record(key, { state: "refused", message: error.message });
      setAnnouncement(error.message);
      return;
    }
    record(key, {
      state: "failed",
      reason: error instanceof ApiError ? error.code : "request_failed",
    });
    setAnnouncement(`Couldn't add this ${subject(principal)}.`);
    // A poll's 404 means no save is recorded; Try again starts a new one.
    if (
      error instanceof ApiError &&
      (error.status === 401 ||
        error.status === 403 ||
        (error.status === 404 && !polling))
    )
      latest.current.onDenied();
  }
  async function poll(principal: DirectoryPrincipal) {
    const target = latest.current.resolve;
    if (!target || !live.current) return;
    const controller = tracked();
    try {
      const params = new URLSearchParams({
        kind: principal.kind,
        username: principal.object_id,
      });
      const answer = await requestStatus(`${target.endpoint}?${params}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        answered(principal, answer.status, answer.envelope.data, false);
    } catch (error) {
      if (!controller.signal.aborted) failed(principal, error, true);
    } finally {
      requests.current.delete(controller);
    }
  }
  /** Saves a match Keep has not saved; `retry` repeats a recorded failure. */
  async function save(principal: DirectoryPrincipal, retry = false) {
    const target = latest.current.resolve;
    if (!target) return;
    const key = rowKey(principal);
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    record(key, { state: "saving" });
    setAnnouncement(`Saving ${principal.display_name} from the directory…`);
    const controller = tracked();
    try {
      const answer = await requestStatus(target.endpoint, {
        method: "POST",
        csrf: target.csrf,
        body: {
          kind: principal.kind,
          username: principal.object_id,
          ...(retry ? { retry: true } : {}),
        },
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        answered(principal, answer.status, answer.envelope.data, true);
    } catch (error) {
      if (!controller.signal.aborted) failed(principal, error, false);
    } finally {
      requests.current.delete(controller);
    }
  }

  return (
    <section
      ref={root}
      aria-label={label}
      className={`dirpick${floating ? " dirpick-floating" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && floating && showResults) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <label htmlFor={inputId} className={labelHidden ? "sr-only" : "lbl"}>
        {label}
      </label>
      <div className="dirpick-row">
        <input
          id={inputId}
          className="inp"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange?.(event.target.value);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (queryValid && !disabled) void search();
            }
          }}
        />
        {showSearchButton && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || !queryValid || current?.loading}
            onClick={() => void search()}
          >
            Search
          </button>
        )}
        {trailing}
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {showResults && current && (
        <div className="dirpick-results">
          <ErrorNotice error={current.error} />
          {current.loading && (
            <p className="dirpick-status" role="status">
              Searching directory…
            </p>
          )}
          {current.page && (
            <>
              <p className="dirpick-status" role="status">
                {current.page.meta?.cached
                  ? "Showing cached matches. This is not the complete company directory."
                  : "Matches from the configured company directory."}
                {current.page.meta?.directory_degraded
                  ? " Directory verification is degraded; accepted identity data remains available."
                  : ""}
              </p>
              {current.page.meta?.type_more === true && (
                <p className="dirpick-status" role="status">
                  Too many results — type more to narrow the search.
                </p>
              )}
              {!current.page.data.length && (
                <p className="dirpick-status">
                  No matches found. Try another name.
                </p>
              )}
              <ul className="dirpick-list">
                {current.page.data.map((listed) => {
                  const progress = saves[rowKey(listed)];
                  const principal =
                    progress?.state === "saved" ? progress.row : listed;
                  const choosable = principal.selectable && !!principal.id;
                  // Choosing a match Keep has not saved (or whose members it
                  // has not saved) saves it first.
                  const saveable =
                    !!resolve &&
                    !choosable &&
                    principal.eligible &&
                    !principal.deleted;
                  const saving =
                    progress?.state === "saving" ||
                    progress?.state === "pending";
                  const status = saving
                    ? "Saving from the directory…"
                    : progress?.state === "failed"
                      ? `Couldn't add this ${subject(principal)}. ${
                          failureReasons[progress.reason] ?? "Try again."
                        }`
                      : progress?.state === "refused"
                        ? progress.message
                        : principal.deleted
                          ? "Deleted identity"
                          : !principal.eligible
                            ? "Ineligible"
                            : !choosable
                              ? "Not saved in Keep yet"
                              : undefined;
                  return (
                    <li
                      key={rowKey(listed)}
                      className="dirpick-item"
                      aria-busy={saving || undefined}
                    >
                      <span className="adm-avatar" aria-hidden="true">
                        {initials(principal.display_name)}
                      </span>
                      <span className="dirpick-name">
                        <span>{principal.display_name}</span>
                        <span>
                          {principal.kind === "team" ? "Team" : "User"}
                          {status && ` · ${status}`}
                        </span>
                      </span>
                      {progress?.state === "failed" ? (
                        <button
                          type="button"
                          className="ibtn"
                          disabled={disabled}
                          onClick={() => void save(listed, true)}
                        >
                          Try again
                          <span className="sr-only">
                            {" "}
                            {principal.display_name}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ibtn"
                          disabled={
                            disabled ||
                            saving ||
                            progress?.state === "refused" ||
                            !(choosable || saveable)
                          }
                          onClick={() => {
                            if (choosable) choose(principal);
                            else if (saveable && !saving) void save(listed);
                          }}
                        >
                          Choose
                          <span className="sr-only">
                            {" "}
                            {principal.display_name}
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {current.page.next_cursor && (
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  disabled={disabled || current.loading}
                  onClick={() =>
                    void search(current.page?.next_cursor ?? undefined)
                  }
                >
                  Next matches
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

type Role = "view" | "edit" | "admin";
export interface ExplicitGrant {
  principal_id: string;
  display_name: string;
  kind: "user" | "team";
  role: Role;
  eligible: boolean;
  deleted: boolean;
}
