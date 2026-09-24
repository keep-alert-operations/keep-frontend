"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, Envelope, request } from "@/lib/api";
import { ErrorNotice } from "./ui";

export interface DirectoryPrincipal {
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

/**
 * Compact company-directory search: an input, an optional Search button and
 * a results list. Used inline (permissions add row, `floating`) and inside
 * popovers by other screens.
 */
export function DirectoryPicker({
  endpoint,
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
  const pending = useRef<AbortController | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => () => pending.current?.abort(), [endpoint]);
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
              {!current.page.data.length && (
                <p className="dirpick-status">
                  No verified or pending matches found. Try another name or
                  search again after directory verification.
                </p>
              )}
              <ul className="dirpick-list">
                {current.page.data.map((principal) => (
                  <li
                    key={`${principal.directory_source}:${principal.object_id}`}
                    className="dirpick-item"
                  >
                    <span className="adm-avatar" aria-hidden="true">
                      {initials(principal.display_name)}
                    </span>
                    <span className="dirpick-name">
                      <span>{principal.display_name}</span>
                      <span>
                        {principal.kind === "team" ? "Team" : "User"}
                        {!principal.selectable &&
                          ` · ${
                            principal.deleted
                              ? "Deleted identity"
                              : !principal.eligible
                                ? "Ineligible"
                                : "Verification pending"
                          }`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="ibtn"
                      disabled={
                        disabled || !principal.selectable || !principal.id
                      }
                      onClick={() => {
                        if (!principal.id || !principal.selectable) return;
                        if (floating) {
                          chosen.current = principal.display_name;
                          setQuery(principal.display_name);
                          setOpen(false);
                        }
                        onChoose({ ...principal, id: principal.id });
                      }}
                    >
                      Choose
                      <span className="sr-only"> {principal.display_name}</span>
                    </button>
                  </li>
                ))}
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
