"use client";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError, request, tenantPath } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { ErrorNotice } from "./ui";
import type { Scope } from "./workspace";

type Context = "feed" | "rule" | "correlation";
interface Profile {
  profile: string;
  context: Context;
  cost_model: string;
  fields: { name: string; type: string; nullable: boolean; values: string[] }[];
  operators: string[];
  functions: {
    name: string;
    signature: string;
    description: string;
    insert_text: string;
  }[];
  limits: {
    source_bytes: number;
    ast_nodes: number;
    depth: number;
    list_members: number;
    compile_timeout_ms: number;
  };
}
interface Validation {
  valid: boolean;
  profile: string;
  context: Context;
  position_encoding: "unicode_codepoints";
  diagnostics: {
    code: string;
    message: string;
    position: number | null;
    line: number | null;
    column: number | null;
  }[];
  ast_nodes: number | null;
  rule_cost_upper_bound: string | null;
  relative: boolean | null;
}
interface Choice {
  label: string;
  text: string;
  detail: string;
  kind: string;
}

function currentToken(value: string, caret: number) {
  let quote = "",
    escaped = false;
  for (const character of value.slice(0, caret)) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
  }
  if (quote) return null;
  const token =
    /[A-Za-z_][A-Za-z0-9_.]*$/.exec(value.slice(0, caret))?.[0] ?? "";
  return { text: token, start: caret - token.length };
}

/* Display-only syntax colouring (mock .k fields, .s strings, .o operators,
 * .n numbers). The textarea above it stays the source of truth. */
const TOKEN =
  /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\balert\.[A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[<>!?:+\-*/%]|\bin\b)|(\b(?:\d+(?:\.\d+)?|true|false|null)\b)|((?<![.\w])[A-Za-z_]\w*(?![\w(]))/g;
function highlight(line: string, fields: Set<string>) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(line.slice(last, index));
    if (match[5] && !fields.has(match[5])) {
      parts.push(match[5]);
      last = index + match[0].length;
      continue;
    }
    const className = match[1]
      ? "s"
      : match[2] || match[5]
        ? "k"
        : match[3]
          ? "o"
          : "n";
    parts.push(
      <span key={index} className={className}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function FunnelIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />
    </svg>
  );
}

/**
 * CEL source editor. `compact` renders the single-line S02 filter bar; the
 * default renders the S06/S11/S13 code box with a line-number gutter, a
 * validity chip row and a collapsed reference of supported fields.
 *
 * Optional presentation props (all backward compatible):
 * - `status`: caller text shown after the validity chip (e.g. "12 matching").
 * - `statusAction`: caller control on the right of the chip row.
 * - `hint`: replaces the keyboard hint next to the label.
 * - `fieldChips`: shows an "Insert field" row of published fields.
 */
export function CelEditor({
  scope,
  value,
  onChange,
  context = "feed",
  label = "CEL expression",
  rows = 5,
  disabled = false,
  onRun,
  compact = false,
  status,
  statusAction,
  hint,
  fieldChips = false,
  minimal = false,
}: {
  scope: Scope;
  value: string;
  onChange: (value: string) => void;
  context?: Context;
  label?: string;
  rows?: number;
  disabled?: boolean;
  onRun?: () => void;
  compact?: boolean;
  status?: ReactNode;
  statusAction?: ReactNode;
  hint?: string;
  fieldChips?: boolean;
  /**
   * Reference condition/window style: no Validate button or reference line;
   * the caller validates the whole definition. Status shows once available.
   */
  minimal?: boolean;
}) {
  const id = useId(),
    area = useRef<HTMLTextAreaElement>(null),
    root = useRef<HTMLElement>(null);
  const base = `${tenantPath(scope.tenant.id)}/cel`;
  const profile = useResource<Profile>(
    `${base}/profile?context=${context}`,
    scope.onDenied,
  );
  const [caret, setCaret] = useState(0),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState(0),
    [filter, setFilter] = useState(""),
    [reference, setReference] = useState(false);
  const [validation, setValidation] = useState<{
    source: string;
    key: string;
    busy: boolean;
    result?: Validation;
    error?: unknown;
  }>();
  const pending = useRef<AbortController | null>(null);
  const insertion = useRef<{ source: string; position: number } | null>(null);
  useLayoutEffect(() => {
    const target = insertion.current;
    insertion.current = null;
    if (target?.source === value && area.current) {
      area.current.focus();
      area.current.setSelectionRange(target.position, target.position);
    }
  }, [value]);
  const key = `${base}:${context}`;
  const latest = useRef({ value, key });
  latest.current = { value, key };
  useEffect(() => {
    setValidation((previous) => (previous?.busy ? undefined : previous));
    return () => pending.current?.abort();
  }, [value, key]);
  // The compact reference is a popover: close it on outside press.
  useEffect(() => {
    if (!compact || !reference) return;
    const close = (event: MouseEvent) => {
      if (
        !root.current?.querySelector(".cel-ref")?.contains(event.target as Node)
      )
        setReference(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [compact, reference]);
  const candidate = profile.data?.data;
  const catalog =
    candidate &&
    candidate.context === context &&
    typeof candidate.profile === "string" &&
    Array.isArray(candidate.fields) &&
    Array.isArray(candidate.functions) &&
    Array.isArray(candidate.operators) &&
    candidate.limits
      ? candidate
      : undefined;
  const choices: Choice[] = catalog
    ? [
        ...catalog.fields.map((field) => ({
          label: field.name,
          text: field.name,
          detail: `${field.type}${field.nullable ? " · nullable" : ""}${field.values.length ? ` · ${field.values.join(", ")}` : ""}`,
          kind: "Field",
        })),
        ...catalog.functions.map((fn) => ({
          label: fn.name,
          text: fn.insert_text,
          detail: `${fn.signature} · ${fn.description}`,
          kind: "Function",
        })),
        ...catalog.operators.map((operator) => ({
          label: operator,
          text: operator,
          detail: "Supported operator",
          kind: "Operator",
        })),
      ]
    : [];
  const token = currentToken(value, caret);
  const receiver =
    token &&
    catalog?.fields.find(
      (field) =>
        field.type === "string" &&
        (token.text.startsWith(`${field.name}.`) ||
          token.text.startsWith(`alert.${field.name}.`)),
    );
  const completionPrefix = receiver
    ? token?.text.startsWith(`alert.${receiver.name}.`)
      ? `alert.${receiver.name}.`
      : `${receiver.name}.`
    : token?.text.startsWith("alert.")
      ? "alert."
      : "";
  const hasArgument = /\bhas\(\s*(?:alert\.)?[A-Za-z_]*$/.test(
    value.slice(0, caret),
  );
  const matches = hasArgument
    ? choices
        .filter(
          (choice) =>
            choice.kind === "Field" &&
            choice.label
              .toLowerCase()
              .startsWith(
                token?.text.replace(/^alert\./, "").toLowerCase() ?? "",
              ),
        )
        .slice(0, 12)
    : token
      ? choices
          .filter(
            (choice) =>
              (!receiver ||
                (choice.kind === "Function" &&
                  choice.detail.startsWith("string_field."))) &&
              choice.label
                .toLowerCase()
                .startsWith(
                  token.text.slice(completionPrefix.length).toLowerCase(),
                ),
          )
          .slice(0, 12)
      : [];
  const visible = open && !disabled && matches.length > 0;
  const active =
    validation?.key === key && validation.source === value
      ? validation
      : undefined;
  const bytes = new TextEncoder().encode(value).length;
  const tooLarge = catalog ? bytes > catalog.limits.source_bytes : false;
  const lines = value.split("\n");
  const fieldNames = new Set(catalog?.fields.map((field) => field.name));

  function insert(choice: Choice, completion = false) {
    const element = area.current;
    if (!element || disabled) return;
    const start =
      completion && token
        ? token.start + completionPrefix.length
        : element.selectionStart;
    const end = element.selectionEnd;
    const closeHas =
      choice.kind === "Field" &&
      /\bhas\(\s*(?:alert\.)?[A-Za-z_]*$/.test(value.slice(0, start));
    const text = closeHas ? `${choice.text})` : choice.text;
    const source = value.slice(0, start) + text + value.slice(end);
    const next = start + text.length;
    insertion.current = { source, position: next };
    onChange(source);
    setCaret(next);
    setOpen(choice.kind === "Function" && choice.label === "has");
  }
  async function validate() {
    if (disabled || tooLarge) return;
    setOpen(false);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const source = value,
      scopeKey = key;
    setValidation({ source, key: scopeKey, busy: true });
    try {
      const response = await request<Validation>(`${base}/validate`, {
        method: "POST",
        csrf: scope.session.csrf_token,
        body: { cel: source, context },
        signal: controller.signal,
      });
      const result = response.data;
      if (
        !result ||
        typeof result.valid !== "boolean" ||
        result.context !== context ||
        typeof result.profile !== "string" ||
        !Array.isArray(result.diagnostics)
      )
        throw new Error(
          "The validation service returned an unsupported result.",
        );
      if (
        !controller.signal.aborted &&
        latest.current.value === source &&
        latest.current.key === scopeKey
      )
        setValidation({ source, key: scopeKey, busy: false, result });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        scope.onDenied();
      if (latest.current.value === source && latest.current.key === scopeKey)
        setValidation({ source, key: scopeKey, busy: false, error });
    }
  }
  function focusDiagnostic(position: number) {
    if (!active || active.result?.position_encoding !== "unicode_codepoints")
      return;
    const start = Array.from(value).slice(0, position).join("").length;
    const end = start + (Array.from(value.slice(start))[0]?.length ?? 0);
    area.current?.focus();
    area.current?.setSelectionRange(start, end);
  }

  const textarea = (
    <textarea
      id={id}
      ref={area}
      className={compact ? "cel-input mono" : "cel-ta"}
      value={value}
      rows={compact ? 1 : Math.max(1, rows)}
      wrap={compact ? "off" : undefined}
      required
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      disabled={disabled}
      aria-describedby={[
        `${id}-help`,
        tooLarge ? `${id}-size-error` : null,
        active?.error ? `${id}-error` : null,
        active?.result ? `${id}-validation` : null,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-invalid={tooLarge || active?.result?.valid === false || undefined}
      aria-autocomplete="list"
      aria-controls={visible ? `${id}-choices` : undefined}
      aria-activedescendant={
        visible
          ? `${id}-choice-${Math.min(selected, matches.length - 1)}`
          : undefined
      }
      onChange={(event) => {
        onChange(event.target.value);
        setCaret(event.target.selectionStart);
        setOpen(
          Boolean(
            currentToken(event.target.value, event.target.selectionStart)?.text,
          ),
        );
        setSelected(0);
      }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
      onBlur={(event) => {
        if (
          !event.currentTarget
            .closest(".cel-editor")
            ?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          setOpen(false);
          if (onRun) onRun();
          else void validate();
        } else if (event.ctrlKey && event.code === "Space") {
          event.preventDefault();
          setOpen(true);
          setSelected(0);
        } else if (["Escape", "Tab"].includes(event.key)) setOpen(false);
        else if (visible && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          setSelected(
            (index) =>
              (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) %
              matches.length,
          );
        } else if (visible && event.key === "Enter") {
          event.preventDefault();
          insert(matches[Math.min(selected, matches.length - 1)], true);
        } else if (compact && event.key === "Enter") {
          // Single-line bar: Enter runs instead of adding a line.
          event.preventDefault();
          if (onRun) onRun();
        }
      }}
    />
  );

  const completions = visible && (
    <ul
      id={`${id}-choices`}
      role="listbox"
      aria-label="CEL completions"
      className="cel-choices"
    >
      {matches.map((choice, index) => (
        <li
          key={`${choice.kind}:${choice.label}`}
          id={`${id}-choice-${index}`}
          role="option"
          aria-selected={index === selected}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insert(choice, true)}
        >
          <b className="mono">{choice.label}</b>
          <span>
            {choice.kind} · {choice.detail}
          </span>
        </li>
      ))}
    </ul>
  );

  const validateButton = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={disabled || active?.busy || tooLarge}
      onClick={() => void validate()}
    >
      Validate CEL
    </button>
  );

  const valid = active?.result?.valid;
  const statusChip = active?.busy ? (
    <span className="chip b-neutral">Validating…</span>
  ) : active?.result ? (
    <span className={`chip ${valid ? "chip-ok" : "b-red"}`}>
      {valid ? "Valid" : "Invalid"}
    </span>
  ) : null;

  const diagnostics = (
    <>
      {tooLarge && (
        <p id={`${id}-size-error`} className="help cel-err" role="alert">
          Expression exceeds the published {catalog?.limits.source_bytes}-byte
          limit. Your draft is preserved.
        </p>
      )}
      <ErrorNotice id={`${id}-error`} error={active?.error} />
      {active?.result && (
        <div id={`${id}-validation`} role="status" className="cel-diags">
          <span className="sr-only">
            {valid ? "CEL expression is valid" : "CEL expression is invalid"} ·{" "}
            {active.result.profile}
          </span>
          {active.result.relative && (
            <p className="help">
              Relative time uses the server query snapshot, not the browser
              clock.
            </p>
          )}
          {active.result.diagnostics.map((diagnostic, index) => (
            <p key={index} className="help cel-err">
              {diagnostic.message}
              {diagnostic.line !== null && diagnostic.column !== null
                ? ` · line ${diagnostic.line}, column ${diagnostic.column}`
                : ""}
              {typeof diagnostic.position === "number" &&
                Number.isInteger(diagnostic.position) &&
                diagnostic.position >= 0 &&
                active.result?.position_encoding === "unicode_codepoints" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="cel-link"
                      onClick={() => focusDiagnostic(diagnostic.position!)}
                    >
                      Show source position
                    </button>
                  </>
                )}
            </p>
          ))}
        </div>
      )}
      {validation?.result && !active && (
        <p className="help">Expression changed. Validate this draft again.</p>
      )}
    </>
  );

  const referenceBody = (
    <div
      id={`${id}-reference`}
      className="cel-ref-body"
      onKeyDown={(event) => {
        if (compact && event.key === "Escape") {
          setReference(false);
          area.current?.focus();
        }
      }}
    >
      {compact && (
        <>
          <div className="cel-ref-row">
            {statusChip}
            <div className="grow" />
            {validateButton}
          </div>
          {diagnostics}
        </>
      )}
      <ErrorNotice error={profile.error} />
      {profile.loading && (
        <p role="status" className="help">
          Loading CEL profile…
        </p>
      )}
      {!profile.loading && !catalog && (
        <p className="help">Supported CEL catalog is unavailable.</p>
      )}
      {catalog && (
        <p className="help">
          {catalog.profile} · {catalog.cost_model} · {catalog.context}. Limits:{" "}
          {bytes} / {catalog.limits.source_bytes} UTF-8 bytes,{" "}
          {catalog.limits.ast_nodes} AST nodes, depth {catalog.limits.depth},{" "}
          {catalog.limits.list_members} list members.{" "}
          <button
            type="button"
            className="cel-link"
            onClick={() => profile.reload()}
            disabled={profile.loading}
          >
            Refresh CEL profile
          </button>
        </p>
      )}
      {!catalog && !profile.loading && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => profile.reload()}
        >
          Refresh CEL profile
        </button>
      )}
      {catalog && (
        <>
          <label className="sr-only" htmlFor={`${id}-filter`}>
            Filter supported CEL
          </label>
          <input
            id={`${id}-filter`}
            className="inp cel-filter"
            placeholder="Filter supported CEL"
            value={filter}
            onChange={(event) => {
              event.stopPropagation();
              setFilter(event.target.value);
            }}
          />
          <ul className="cel-catalog">
            {choices
              .filter((choice) =>
                `${choice.label} ${choice.detail}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((choice) => (
                <li key={`${choice.kind}:${choice.label}`}>
                  <button
                    type="button"
                    className="fchip"
                    disabled={disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(choice)}
                    aria-label={`Insert ${choice.label}`}
                  >
                    {choice.label}
                  </button>
                  <span className="help">
                    {choice.kind} · {choice.detail}
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );

  const helpText = (
    <span id={`${id}-help`} className="sr-only">
      Ctrl+Space shows supported completions. Arrow keys and Enter choose;
      Escape dismisses.{" "}
      {context !== "feed"
        ? "Rule expressions use the fixed rule catalog; moving time is unavailable."
        : "Queries return current retained alerts under the tenant and suppression filters."}
    </span>
  );

  if (compact)
    return (
      <section
        ref={root}
        className="cel-editor cel-compact"
        aria-label={`${label} editor`}
      >
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        {helpText}
        <div className={`cel-bar${disabled ? " cel-off" : ""}`}>
          <div className="cel-ref">
            <button
              type="button"
              className="cel-funnel"
              aria-expanded={reference}
              aria-controls={reference ? `${id}-reference` : undefined}
              aria-label="Supported fields and functions"
              title="Supported fields and functions"
              onClick={() => setReference((shown) => !shown)}
            >
              <FunnelIcon />
            </button>
            {reference && <div className="cel-pop">{referenceBody}</div>}
          </div>
          {textarea}
          <span className="help cel-hint">
            {hint ?? "Ctrl+Space completes"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-p cel-run"
            disabled={disabled || active?.busy || tooLarge}
            onClick={() => (onRun ? onRun() : void validate())}
            aria-label="Run query"
          >
            Run <span className="mono cel-kbd">Ctrl+Enter</span>
          </button>
          {completions}
        </div>
        {!reference &&
          (tooLarge ||
            Boolean(active?.error) ||
            active?.result ||
            (validation?.result && !active)) && (
            <div className="cel-under">{diagnostics}</div>
          )}
      </section>
    );

  return (
    <section
      ref={root}
      className="cel-editor cel-code f"
      aria-label={`${label} editor`}
    >
      <div className="cel-head">
        <label className="lbl" htmlFor={id}>
          {label}
        </label>
        <span className="help" aria-hidden="true">
          {hint ??
            `Ctrl+Space completes · Ctrl+Enter ${onRun ? "previews" : "validates"}`}
        </span>
      </div>
      {helpText}
      <div className="cel-wrap">
        <div
          className={`code cel-box${disabled ? " cel-off" : ""}`}
          style={
            {
              "--cel-gutter": `calc(${String(lines.length).length}ch + 18px)`,
              "--cel-rows": Math.max(1, rows),
            } as CSSProperties
          }
        >
          <pre className="cel-hl" aria-hidden="true">
            {lines.map((line, index) => (
              <span className="cel-l" key={index}>
                <span className="cel-n">{index + 1}</span>
                <span className="cel-t">{highlight(line, fieldNames)}</span>
              </span>
            ))}
          </pre>
          {textarea}
        </div>
        {completions}
      </div>
      {(!minimal || statusChip || status || statusAction) && (
        <div className="cel-status">
          {statusChip}
          {status && <span className="small muted">{status}</span>}
          <div className="grow" />
          {statusAction}
          {!minimal && validateButton}
        </div>
      )}
      {diagnostics}
      {fieldChips && catalog && (
        <div className="cel-fields">
          <span className="help">Insert field</span>
          {catalog.fields.map((field) => (
            <button
              key={field.name}
              type="button"
              className="fchip"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                insert({
                  label: field.name,
                  text: field.name,
                  detail: field.type,
                  kind: "Field",
                })
              }
              aria-label={`Insert field ${field.name}`}
            >
              {field.name}
            </button>
          ))}
        </div>
      )}
      {!minimal && (
        <div className="cel-ref cel-ref-inline">
          <button
            type="button"
            className="cel-link cel-toggle"
            aria-expanded={reference}
            aria-controls={reference ? `${id}-reference` : undefined}
            onClick={() => setReference((shown) => !shown)}
          >
            Supported fields and functions
            <span aria-hidden="true">{reference ? " ▾" : " ▸"}</span>
          </button>
          {catalog && (
            <span className="help">
              {" "}
              · {bytes} / {catalog.limits.source_bytes} bytes ·{" "}
              {catalog.profile}
            </span>
          )}
          {reference && referenceBody}
        </div>
      )}
    </section>
  );
}
