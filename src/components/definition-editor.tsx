"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  display,
  message,
  request,
  RecordData,
  tenantPath,
} from "@/lib/api";
import { useCommand, useDirtyWarning } from "@/lib/hooks";
import {
  celTokens,
  currentAlertColumns,
  DEFAULT_COLUMNS,
  DEFAULT_SORT,
  directionLabel,
  fieldLabel,
  previewTotal,
  SELECTABLE_COLUMNS,
  SORT_FIELDS,
  sortItems,
  usePresetChoices,
  usePresetPreview,
  type SortItem,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice } from "./ui";
import { CelEditor } from "./cel-editor";
import { Page, useConfirm, type Crumb } from "./page";
import {
  AlertTable,
  composeCel,
  QuickViews,
  useQuickViewCounts,
  type QuickViewKey,
} from "./alert-table";
import { CountTile } from "./dashboard-counts";

interface Panel {
  id: string;
  preset_id: string;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  thresholds: { lower_bound: string; color: string }[];
}
export function CelCode({ source }: { source: string }) {
  return (
    <>
      {celTokens(source).map((token, index) =>
        token.kind === "t" ? (
          token.text
        ) : (
          <span key={index} className={token.kind}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

/** Small popover menu (⋯ actions, preset switcher). */
export function Menu({
  label,
  className = "btn",
  content,
  children,
  align = "right",
  style,
}: {
  label: string;
  className?: string;
  content: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    root.current
      ?.querySelector<HTMLElement>(".menu-pop input, .menu-pop [role=menuitem]")
      ?.focus();
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        style={style}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {content}
      </button>
      {open && (
        <div
          className={`menu-pop menu-${align}`}
          role="menu"
          aria-label={label}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Modal dialog in the reference dialog style. */
export function Dialog({
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    box.current
      ?.querySelector<HTMLElement>(
        "input:not([disabled]), select, textarea, button:not([disabled]), a[href]",
      )
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={`dlg ${wide ? "dlg-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <h2 id={id}>{title}</h2>
        {children}
        {actions && <div className="dlg-actions">{actions}</div>}
      </div>
    </div>
  );
}

function presetDefinition(value?: Record<string, unknown>) {
  return {
    name: String(value?.name ?? ""),
    cel: typeof value?.cel === "string" ? value.cel : "true",
    columns:
      Array.isArray(value?.columns) && value.columns.length
        ? currentAlertColumns((value.columns as unknown[]).map(String))
        : DEFAULT_COLUMNS,
    sort: sortItems(value?.sort).length ? sortItems(value?.sort) : DEFAULT_SORT,
  };
}

/** Keep the editor's dirty flag in the workspace navigation guard. */
function useDirtyGuard(scope: Scope, dirty: boolean) {
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
}

/* ------------------------------------------------------------------ */
/* Preset editor (reference S06).                                      */
/* ------------------------------------------------------------------ */

export function PresetEditor({
  scope,
  existing,
  current,
  initialDraft,
  onSaved,
  onDiscard,
  context,
}: {
  scope: Scope;
  /** Saved revision being edited (absent for a new preset). */
  existing?: RecordData;
  /** Latest shared revision, for the newer-revision notice. */
  current?: RecordData;
  initialDraft?: Record<string, unknown>;
  onSaved: (saved?: RecordData) => void;
  onDiscard: () => void;
  /** Optional provenance line (e.g. retained revision source). */
  context?: ReactNode;
}) {
  const baseline = presetDefinition(existing);
  const initial = presetDefinition(initialDraft ?? existing);
  const [name, setName] = useState(initial.name),
    [cel, setCel] = useState(initial.cel),
    [selectedColumns, setColumns] = useState<string[]>(initial.columns),
    [sort, setSort] = useState<SortItem[]>(initial.sort);
  const [previewCel, setPreviewCel] = useState(initial.cel);
  const [quick, setQuick] = useState<QuickViewKey>("all"),
    [suppressed, setSuppressed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false),
    [copyName, setCopyName] = useState("");
  const [savedRow, setSavedRow] = useState<RecordData | null>(null);
  const [nameError, setNameError] = useState("");
  const save = useCommand(scope.session.csrf_token, scope.onDenied);
  const copy = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmation, confirm] = useConfirm();
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const draft = { name, cel, columns: selectedColumns, sort };
  const dirty = !savedRow && JSON.stringify(draft) !== JSON.stringify(baseline);
  useDirtyGuard(scope, dirty);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    // Reported after the render that cleared the navigation guard.
    if (savedRow) saved.current(savedRow);
  }, [savedRow]);
  const tenantId = scope.tenant.id,
    csrf = scope.session.csrf_token;
  const ready = selectedColumns.length > 0 && sort.length > 0;
  const preview = usePresetPreview(
    tenantId,
    csrf,
    scope.onDenied,
    ready && previewCel.trim()
      ? {
          cel: composeCel(previewCel, quick),
          sort,
          columns: selectedColumns,
          q: "",
          include_suppressed: suppressed,
          limit: 50,
        }
      : null,
  );
  const [savedTotal, setSavedTotal] = useState<string>();
  const savedKey = existing
    ? JSON.stringify([
        baseline.cel,
        baseline.sort,
        baseline.columns,
        quick,
        suppressed,
      ])
    : "";
  useEffect(() => {
    if (!savedKey) return;
    const [savedCel, savedSort, savedColumns, view, include] = JSON.parse(
      savedKey,
    ) as [string, SortItem[], string[], QuickViewKey, boolean];
    const controller = new AbortController();
    setSavedTotal(undefined);
    previewTotal(
      tenantId,
      csrf,
      {
        cel: composeCel(savedCel, view),
        sort: savedSort,
        columns: savedColumns,
        include_suppressed: include,
      },
      controller.signal,
    ).then(
      (total) => {
        if (!controller.signal.aborted) setSavedTotal(total);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [savedKey, tenantId, csrf]);
  const counts = useQuickViewCounts(
    (source, include, signal) =>
      previewTotal(
        tenantId,
        csrf,
        {
          cel: source,
          sort,
          columns: selectedColumns,
          include_suppressed: include,
        },
        signal,
      ),
    ready && previewCel.trim() ? previewCel : null,
    suppressed,
    JSON.stringify([previewCel, sort, selectedColumns]),
  );
  function runPreview() {
    setPreviewCel(cel);
  }
  async function submit() {
    if (!name.trim()) {
      setNameError("Enter a name for this preset.");
      nameRef.current?.focus();
      return;
    }
    setNameError("");
    const result = await save.execute<RecordData>(
      `${tenantPath(tenantId)}/presets${existing ? `/${existing.id}` : ""}`,
      {
        name,
        cel,
        sort,
        columns: selectedColumns,
        ...(existing ? { expected_revision: existing.revision } : {}),
      },
      existing ? "PUT" : "POST",
    );
    if (result) setSavedRow(result.data ?? ({} as RecordData));
  }
  async function submitCopy() {
    const result = await copy.execute<RecordData>(
      `${tenantPath(tenantId)}/presets`,
      { name: copyName, cel, sort, columns: selectedColumns },
    );
    if (result) {
      setCopying(false);
      setSavedRow(result.data ?? ({} as RecordData));
    }
  }
  async function discard() {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: (
          <p>
            Your draft{existing ? ` of “${display(existing.name)}”` : ""} will
            be lost. The shared preset is unchanged.
          </p>
        ),
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      }))
    )
      return;
    scope.setDirty(false);
    onDiscard();
  }
  const moveColumn = (index: number, delta: number) =>
    setColumns((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const lines = Math.max(1, cel.split("\n").length);
  const draftChanged = cel !== previewCel;
  const total = preview.result?.meta?.total;
  const exact = typeof total === "string" && /^\d+$/.test(total);
  const invalid =
    preview.error instanceof ApiError &&
    [400, 422].includes(preview.error.status);
  const newer =
    existing &&
    current &&
    current.revision !== existing.revision &&
    /^\d+$/.test(current.revision) &&
    /^\d+$/.test(existing.revision) &&
    BigInt(current.revision) > BigInt(existing.revision);
  const title = existing ? display(existing.name) : name.trim() || "New preset";
  const crumbs: Crumb[] = [
    { label: "Presets", href: `/tenants/${tenantId}/presets` },
    ...(existing
      ? [
          {
            label: display(existing.name),
            href: `/tenants/${tenantId}/presets/${existing.id}`,
          },
        ]
      : []),
  ];
  if (scope.tenant.role === "view")
    return (
      <Page scope={scope} title={title} crumbs={crumbs}>
        <p className="banner bn-warn">
          Editing presets requires edit access in this tenant.
        </p>
      </Page>
    );
  return (
    <Page
      scope={scope}
      className="preset-edit"
      title={title}
      crumbs={crumbs}
      extra={dirty && <span className="chip chip-warn">Unsaved changes</span>}
      actions={
        <>
          <button
            type="button"
            className="btn btn-g"
            disabled={save.busy || copy.busy}
            onClick={() => void discard()}
          >
            Discard
          </button>
          {existing && (
            <button
              type="button"
              className="btn"
              disabled={save.busy || copy.busy || !selectedColumns.length}
              onClick={() => {
                setCopyName("");
                setCopying(true);
              }}
            >
              Save as new…
            </button>
          )}
          <button
            type="submit"
            form={formId}
            className="btn btn-p"
            disabled={
              save.busy ||
              copy.busy ||
              !selectedColumns.length ||
              (!save.uncertain && existing !== undefined && !dirty)
            }
          >
            {save.uncertain
              ? "Retry original command"
              : existing
                ? "Save changes"
                : "Create preset"}
          </button>
        </>
      }
    >
      {confirmation}
      {context}
      {newer && (
        <p className="banner bn-warn" role="status">
          A newer shared revision {current!.revision} is available. Your draft
          is based on revision {existing!.revision}; saving reports a conflict.
          Discard to review it.
        </p>
      )}
      {(Boolean(save.error) || save.uncertain || save.busy) && (
        <div className="pe-feedback">
          <CommandFeedback command={save} />
        </div>
      )}
      <QuickViews
        value={quick}
        onChange={setQuick}
        counts={counts.counts}
        hidden={counts.hidden}
        includeSuppressed={suppressed}
        onIncludeSuppressed={setSuppressed}
      />
      <div className="pe-split">
        <section className="panel pe-preview" aria-label="Draft preview">
          <div className="pe-strip" role="status">
            <span className="pe-strip-text">
              <b>Previewing your unsaved draft</b>
              {preview.loading
                ? " · updating…"
                : exact
                  ? ` · ${BigInt(total as string).toLocaleString()} matching`
                  : preview.error
                    ? " · preview unavailable"
                    : ""}
              {existing && savedTotal !== undefined
                ? ` · the saved preset shows ${BigInt(savedTotal).toLocaleString()}`
                : ""}
            </span>
            {draftChanged && (
              <span className="pe-strip-note">
                Filter edited · Preview draft to update
              </span>
            )}
          </div>
          {preview.error !== undefined && !invalid && (
            <div className="pe-table-note">
              <ErrorNotice error={preview.error} />
            </div>
          )}
          {!selectedColumns.length ? (
            <div className="pe-empty">
              Choose at least one column to preview.
            </div>
          ) : invalid ? (
            <div className="pe-empty">
              The filter is invalid. Fix it and preview again; your saved preset
              is unchanged.
            </div>
          ) : preview.result && preview.result.data.length === 0 ? (
            <div className="pe-empty">No alerts match this draft.</div>
          ) : (
            <div
              className={`pe-table ${preview.loading ? "is-stale" : ""}`}
              aria-busy={preview.loading}
            >
              <AlertTable
                scope={scope}
                rows={preview.result?.data ?? []}
                columns={selectedColumns}
                sort={sort}
                narrow
              />
            </div>
          )}
        </section>
        <aside className="panel pe-def" aria-label="Edit preset">
          <div className="panel-h">
            <h2>Definition</h2>
            <div style={{ flexGrow: 1 }} />
            <span className="help">
              Changes apply to everyone in {scope.tenant.name} once saved
            </span>
          </div>
          <form
            id={formId}
            className="pe-def-body"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="f">
              <label className="lbl" htmlFor={`${formId}-name`}>
                Name
              </label>
              <input
                id={`${formId}-name`}
                ref={nameRef}
                className="inp"
                value={name}
                maxLength={128}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={
                  nameError ? `${formId}-name-error` : undefined
                }
                onChange={(event) => setName(event.target.value)}
              />
              {nameError && (
                <span id={`${formId}-name-error`} className="help pe-error">
                  {nameError}
                </span>
              )}
            </div>
            <CelEditor
              scope={scope}
              label="Filter (CEL)"
              hint="Ctrl+Space completes · Ctrl+Enter previews"
              rows={Math.max(6, lines)}
              value={cel}
              context="feed"
              onChange={setCel}
              onRun={runPreview}
              fieldChips
              status={
                <span className="pe-check">
                  {draftChanged ? (
                    <span className="chip b-neutral">Not previewed</span>
                  ) : preview.loading ? (
                    <span className="chip b-neutral">Checking…</span>
                  ) : invalid ? (
                    <span className="chip b-red">Invalid</span>
                  ) : preview.error ? (
                    <span className="chip b-amber">Unchecked</span>
                  ) : (
                    <span className="chip chip-ok">Valid</span>
                  )}
                  <span className="pe-check-text">
                    {draftChanged
                      ? ""
                      : invalid
                        ? message(preview.error)
                        : exact
                          ? `${BigInt(total as string).toLocaleString()} matching in preview`
                          : ""}
                  </span>
                </span>
              }
              statusAction={
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!cel.trim()}
                  onClick={runPreview}
                >
                  Preview draft
                </button>
              }
            />
            <div className="f">
              <div className="pe-label-row">
                <span className="lbl" id={`${formId}-columns`}>
                  Columns
                </span>
                <div style={{ flexGrow: 1 }} />
                <button
                  type="button"
                  className="btn btn-g btn-sm"
                  aria-expanded={adding}
                  disabled={selectedColumns.length >= SELECTABLE_COLUMNS.length}
                  onClick={() => setAdding((value) => !value)}
                >
                  Add column
                </button>
              </div>
              {adding && (
                <div className="pe-add" role="group" aria-label="Add a column">
                  {SELECTABLE_COLUMNS.filter(
                    (column) => !selectedColumns.includes(column),
                  ).map((column) => (
                    <button
                      key={column}
                      type="button"
                      className="fchip"
                      onClick={() => {
                        setColumns((previous) => [...previous, column]);
                        setAdding(false);
                      }}
                    >
                      + {fieldLabel(column)}
                    </button>
                  ))}
                </div>
              )}
              <ul className="pe-columns" aria-labelledby={`${formId}-columns`}>
                {selectedColumns.map((column, index) => (
                  <li key={column}>
                    <span className="pe-n">{index + 1}</span>
                    <span className="pe-col-label">{fieldLabel(column)}</span>
                    <button
                      type="button"
                      className="pe-mini"
                      aria-label={`Move ${fieldLabel(column)} up`}
                      disabled={index === 0}
                      onClick={() => moveColumn(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="pe-mini"
                      aria-label={`Move ${fieldLabel(column)} down`}
                      disabled={index === selectedColumns.length - 1}
                      onClick={() => moveColumn(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="pe-mini"
                      aria-label={`Remove ${fieldLabel(column)}`}
                      onClick={() =>
                        setColumns((previous) =>
                          previous.filter((item) => item !== column),
                        )
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              {!selectedColumns.length && (
                <span className="help pe-error">
                  Choose at least one column.
                </span>
              )}
            </div>
            <div className="f">
              <span className="lbl">Sort</span>
              {sort.map((item, index) => (
                <div className="pe-sort" key={index}>
                  <span className="pe-n">{index + 1}</span>
                  <select
                    className="inp"
                    aria-label={`Sort field ${index + 1}`}
                    value={item.field}
                    onChange={(event) =>
                      setSort((previous) =>
                        previous.map((entry, i) =>
                          i === index
                            ? { ...entry, field: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  >
                    {!SORT_FIELDS.includes(item.field) && (
                      <option value={item.field}>
                        {fieldLabel(item.field)}
                      </option>
                    )}
                    {SORT_FIELDS.filter(
                      (field) =>
                        field === item.field ||
                        !sort.some((entry) => entry.field === field),
                    ).map((field) => (
                      <option key={field} value={field}>
                        {fieldLabel(field)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="inp pe-dir"
                    aria-label={`Sort direction ${index + 1}`}
                    value={item.direction}
                    onChange={(event) =>
                      setSort((previous) =>
                        previous.map((entry, i) =>
                          i === index
                            ? { ...entry, direction: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  >
                    <option value="desc">
                      {directionLabel(item.field, "desc")}
                    </option>
                    <option value="asc">
                      {directionLabel(item.field, "asc")}
                    </option>
                  </select>
                  {index === 0 ? (
                    <button
                      type="button"
                      className="btn btn-g btn-sm"
                      disabled={sort.length >= 3}
                      onClick={() =>
                        setSort((previous) => [
                          ...previous,
                          {
                            field:
                              SORT_FIELDS.find(
                                (field) =>
                                  !previous.some(
                                    (entry) => entry.field === field,
                                  ),
                              ) ?? "application",
                            direction: "asc",
                          },
                        ])
                      }
                    >
                      Add level
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-g btn-sm"
                      aria-label={`Remove sort level ${index + 1}`}
                      onClick={() =>
                        setSort((previous) =>
                          previous.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </form>
        </aside>
      </div>
      {copying && (
        <Dialog
          title="Save as a new preset"
          onClose={() => {
            if (!copy.busy) setCopying(false);
          }}
          actions={
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={copy.busy}
                onClick={() => setCopying(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                form={`${formId}-copy`}
                className="btn btn-sm btn-p"
                disabled={copy.busy || (!copy.uncertain && !copyName.trim())}
              >
                {copy.uncertain ? "Retry original command" : "Create preset"}
              </button>
            </>
          }
        >
          <p>
            Creates a separate shared preset with its own history. “
            {display(existing?.name)}” and its links stay unchanged.
          </p>
          <form
            id={`${formId}-copy`}
            className="f"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCopy();
            }}
          >
            <label className="lbl" htmlFor={`${formId}-copy-name`}>
              New preset name
            </label>
            <input
              id={`${formId}-copy-name`}
              className="inp"
              value={copyName}
              maxLength={128}
              onChange={(event) => setCopyName(event.target.value)}
            />
          </form>
          <CommandFeedback command={copy} />
        </Dialog>
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard editor (no reference artboard; follows S06's language).   */
/* ------------------------------------------------------------------ */

function packPanels(next: Panel[]) {
  let x = 0,
    y = 0,
    rowHeight = 0;
  return next.map((panel) => {
    if (x + panel.w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const result = { ...panel, x, y };
    x += panel.w;
    rowHeight = Math.max(rowHeight, panel.h);
    return result;
  });
}
function dashboardDefinition(value?: Record<string, unknown>) {
  return {
    name: String(value?.name ?? ""),
    panels: Array.isArray(value?.panels)
      ? (value.panels as Panel[]).map((panel) => ({
          id: panel.id,
          preset_id: panel.preset_id,
          title: panel.title ?? null,
          x: Number(panel.x),
          y: Number(panel.y),
          w: Number(panel.w),
          h: Number(panel.h),
          thresholds: Array.isArray(panel.thresholds)
            ? panel.thresholds.map((item) => ({
                lower_bound: String(item.lower_bound),
                color: String(item.color),
              }))
            : [],
        }))
      : [],
  };
}
interface DraftCheck {
  key: string;
  kind: "validate" | "preview";
  busy: boolean;
  valid?: boolean;
  counts?: Map<string, { count?: string; error?: boolean }>;
  error?: unknown;
}

export function DashboardEditor({
  scope,
  existing,
  current,
  initialDraft,
  onSaved,
  onDiscard,
  context,
}: {
  scope: Scope;
  existing?: RecordData;
  current?: RecordData;
  initialDraft?: Record<string, unknown>;
  onSaved: (saved?: RecordData) => void;
  onDiscard: () => void;
  context?: ReactNode;
}) {
  const baseline = dashboardDefinition(existing);
  const initial = dashboardDefinition(initialDraft ?? existing);
  const [name, setName] = useState(initial.name),
    [panels, setPanels] = useState<Panel[]>(initial.panels);
  const [selected, setSelected] = useState<string | null>(null);
  const [presetSearch, setPresetSearch] = useState("");
  const [copying, setCopying] = useState(false),
    [copyName, setCopyName] = useState("");
  const [savedRow, setSavedRow] = useState<RecordData | null>(null);
  const [nameError, setNameError] = useState("");
  const [check, setCheck] = useState<DraftCheck>();
  const save = useCommand(scope.session.csrf_token, scope.onDenied);
  const copy = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmation, confirm] = useConfirm();
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const checkController = useRef<AbortController | null>(null);
  const formId = useId();
  const tenantId = scope.tenant.id;
  const presets = usePresetChoices(
    `${tenantPath(tenantId)}/presets`,
    panels.map((panel) => panel.preset_id),
    scope.onDenied,
    scope.version,
  );
  const draft = { name, panels };
  const draftKey = JSON.stringify(draft);
  const dirty = !savedRow && draftKey !== JSON.stringify(baseline);
  useDirtyGuard(scope, dirty);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => () => checkController.current?.abort(), []);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    if (savedRow) saved.current(savedRow);
  }, [savedRow]);
  const presetName = (id: string) => {
    const row = presets.rows.find((preset) => preset.id === id);
    return row ? display(row.name) : undefined;
  };
  const activeCheck = check?.key === draftKey ? check : undefined;
  const allResolved = panels.every((panel) =>
    presets.rows.some((preset) => preset.id === panel.preset_id),
  );
  function update(id: string, patch: Partial<Panel>) {
    setPanels((previous) =>
      packPanels(
        previous.map((panel) =>
          panel.id === id ? { ...panel, ...patch } : panel,
        ),
      ),
    );
  }
  function move(index: number, delta: number) {
    setPanels((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return packPanels(next);
    });
  }
  function select(id: string) {
    setSelected(id);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-panel="${id}"] select`)
      ?.focus();
  }
  async function run(kind: "validate" | "preview") {
    checkController.current?.abort();
    const controller = new AbortController();
    checkController.current = controller;
    const key = draftKey;
    setCheck({ key, kind, busy: true });
    const body: Record<string, unknown> = { name, panels };
    if (kind === "preview")
      body.preset_revisions = Object.fromEntries(
        panels.map((panel) => [
          panel.preset_id,
          presets.rows.find((preset) => preset.id === panel.preset_id)
            ?.revision,
        ]),
      );
    try {
      const result = await request<Record<string, unknown>>(
        `${tenantPath(tenantId)}/dashboards/${kind}`,
        {
          method: "POST",
          body,
          csrf: scope.session.csrf_token,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      const counts = new Map<string, { count?: string; error?: boolean }>();
      const rows = Array.isArray(result.data?.panels)
        ? (result.data.panels as {
            panel_id?: string;
            count?: unknown;
            error?: unknown;
          }[])
        : [];
      for (const row of rows)
        if (typeof row.panel_id === "string")
          counts.set(row.panel_id, {
            count:
              typeof row.count === "string" && /^\d+$/.test(row.count)
                ? row.count
                : undefined,
            error: row.error !== undefined,
          });
      setCheck({
        key,
        kind,
        busy: false,
        valid: kind === "validate" ? result.data?.valid !== false : true,
        counts: kind === "preview" ? counts : undefined,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        scope.onDenied();
      setCheck({ key, kind, busy: false, error });
    }
  }
  async function submit() {
    if (!name.trim()) {
      setNameError("Enter a name for this dashboard.");
      nameRef.current?.focus();
      return;
    }
    setNameError("");
    const result = await save.execute<RecordData>(
      `${tenantPath(tenantId)}/dashboards${existing ? `/${existing.id}` : ""}`,
      {
        name,
        panels,
        ...(existing ? { expected_revision: existing.revision } : {}),
      },
      existing ? "PUT" : "POST",
    );
    if (result) setSavedRow(result.data ?? ({} as RecordData));
  }
  async function submitCopy() {
    const result = await copy.execute<RecordData>(
      `${tenantPath(tenantId)}/dashboards`,
      {
        name: copyName,
        panels: panels.map((panel) => ({ ...panel, id: crypto.randomUUID() })),
      },
    );
    if (result) {
      setCopying(false);
      setSavedRow(result.data ?? ({} as RecordData));
    }
  }
  async function discard() {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: (
          <p>
            Your draft{existing ? ` of “${display(existing.name)}”` : ""} will
            be lost. The shared dashboard is unchanged.
          </p>
        ),
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      }))
    )
      return;
    scope.setDirty(false);
    onDiscard();
  }
  const newer =
    existing &&
    current &&
    /^\d+$/.test(current.revision) &&
    /^\d+$/.test(existing.revision) &&
    BigInt(current.revision) > BigInt(existing.revision);
  const title = existing
    ? display(existing.name)
    : name.trim() || "New dashboard";
  const crumbs: Crumb[] = [
    { label: "Dashboards", href: `/tenants/${tenantId}/dashboards` },
    ...(existing
      ? [
          {
            label: display(existing.name),
            href: `/tenants/${tenantId}/dashboards/${existing.id}`,
          },
        ]
      : []),
  ];
  if (scope.tenant.role === "view")
    return (
      <Page scope={scope} title={title} crumbs={crumbs}>
        <p className="banner bn-warn">
          Editing dashboards requires edit access in this tenant.
        </p>
      </Page>
    );
  const busy = save.busy || copy.busy;
  return (
    <Page
      scope={scope}
      className="dashboard-edit"
      title={title}
      crumbs={crumbs}
      extra={dirty && <span className="chip chip-warn">Unsaved changes</span>}
      actions={
        <>
          <button
            type="button"
            className="btn btn-g"
            disabled={busy}
            onClick={() => void discard()}
          >
            Discard
          </button>
          {existing && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setCopyName("");
                setCopying(true);
              }}
            >
              Save as new…
            </button>
          )}
          <button
            type="submit"
            form={formId}
            className="btn btn-p"
            disabled={
              busy || (!save.uncertain && existing !== undefined && !dirty)
            }
          >
            {save.uncertain
              ? "Retry original command"
              : existing
                ? "Save changes"
                : "Create dashboard"}
          </button>
        </>
      }
    >
      {confirmation}
      {context}
      {newer && (
        <p className="banner bn-warn" role="status">
          A newer shared revision {current!.revision} is available. Your draft
          is based on revision {existing!.revision}; saving reports a conflict.
          Discard to review it.
        </p>
      )}
      {(Boolean(save.error) || save.uncertain || save.busy) && (
        <div className="pe-feedback">
          <CommandFeedback command={save} />
        </div>
      )}
      <div className="pe-split">
        <section className="panel de-layout" aria-label="Layout preview">
          <div className="pe-strip de-strip" role="status">
            <span className="pe-strip-text">
              <b>
                {activeCheck?.kind === "preview" && !activeCheck.busy
                  ? activeCheck.error
                    ? "Draft counts unavailable"
                    : "Previewing your unsaved draft"
                  : "Layout of your unsaved draft"}
              </b>
              {activeCheck?.busy
                ? " · checking…"
                : activeCheck?.kind === "validate" && !activeCheck.error
                  ? activeCheck.valid
                    ? " · definition is valid"
                    : " · definition is invalid"
                  : ""}
              {` · ${panels.length} of 24 panels · thresholds change presentation only`}
            </span>
            <span style={{ flexGrow: 1 }} />
            <button
              type="button"
              className="btn btn-sm"
              disabled={activeCheck?.busy}
              onClick={() => void run("validate")}
            >
              Validate
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={activeCheck?.busy || !panels.length || !allResolved}
              onClick={() => void run("preview")}
            >
              Preview draft
            </button>
          </div>
          {activeCheck?.error !== undefined && (
            <div className="pe-table-note">
              <ErrorNotice error={activeCheck.error} />
            </div>
          )}
          <div className="de-canvas">
            {panels.length ? (
              <div className="pg">
                {panels.map((panel) => {
                  const counted = activeCheck?.counts?.get(panel.id);
                  const preset = presetName(panel.preset_id);
                  return (
                    <CountTile
                      key={panel.id}
                      scope={scope}
                      panel={panel}
                      title={
                        panel.title ??
                        preset ??
                        (panel.preset_id
                          ? "Preset not loaded"
                          : "Choose a preset")
                      }
                      presetName={preset}
                      value={counted?.count}
                      unavailable={counted?.error ? "Unavailable" : undefined}
                      placeholder={
                        counted
                          ? undefined
                          : `${panel.w} × ${panel.h} · ${
                              panel.thresholds.length
                                ? panel.thresholds
                                    .map(
                                      (item) =>
                                        `≥ ${item.lower_bound || "?"} ${item.color}`,
                                    )
                                    .join(", ")
                                : "no thresholds"
                            }`
                      }
                      selected={selected === panel.id}
                      onSelect={() => select(panel.id)}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="pe-empty">
                No panels yet. Add a panel and choose the saved preset it
                counts.
              </div>
            )}
          </div>
        </section>
        <aside className="panel pe-def" aria-label="Edit dashboard">
          <div className="panel-h">
            <h2>Definition</h2>
            <div style={{ flexGrow: 1 }} />
            <span className="help">
              Changes apply to everyone in {scope.tenant.name} once saved
            </span>
          </div>
          <form
            id={formId}
            className="pe-def-body"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="f">
              <label className="lbl" htmlFor={`${formId}-name`}>
                Name
              </label>
              <input
                id={`${formId}-name`}
                ref={nameRef}
                className="inp"
                value={name}
                maxLength={128}
                aria-invalid={nameError ? true : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {nameError && <span className="help pe-error">{nameError}</span>}
            </div>
            <div className="f">
              <div className="pe-label-row">
                <span className="lbl" id={`${formId}-panels`}>
                  Panels
                </span>
                <span className="help">{panels.length}/24</span>
                <div style={{ flexGrow: 1 }} />
                <button
                  type="button"
                  className="btn btn-g btn-sm"
                  disabled={panels.length >= 24}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    setPanels((previous) =>
                      packPanels([
                        ...previous,
                        {
                          id,
                          preset_id: "",
                          title: null,
                          x: 0,
                          y: 0,
                          w: 3,
                          h: 2,
                          thresholds: [],
                        },
                      ]),
                    );
                    setSelected(id);
                  }}
                >
                  Add panel
                </button>
              </div>
              <div className="de-presets">
                <label className="lbl sr-only" htmlFor={`${formId}-find`}>
                  Find shared presets
                </label>
                <input
                  id={`${formId}-find`}
                  className="inp"
                  placeholder="Find shared presets"
                  value={presetSearch}
                  maxLength={128}
                  onChange={(event) => setPresetSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      presets.search(presetSearch);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => presets.search(presetSearch)}
                >
                  Search presets
                </button>
              </div>
              <div className="de-presets-nav">
                <span className="help">
                  {presets.loading
                    ? "Loading preset choices…"
                    : `${presets.rows.length} preset${presets.rows.length === 1 ? "" : "s"} available`}
                </span>
                <div style={{ flexGrow: 1 }} />
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  disabled={!presets.cursor || presets.loading}
                  onClick={presets.restart}
                  aria-label="First preset page"
                >
                  First page
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  disabled={!presets.nextCursor || presets.loading}
                  onClick={presets.next}
                  aria-label="Next preset page"
                >
                  Next page
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-g"
                  onClick={presets.restart}
                  aria-label="Refresh preset choices"
                >
                  Refresh
                </button>
              </div>
              <ErrorNotice error={presets.error} />
              <ol
                ref={listRef}
                className="de-panels"
                aria-labelledby={`${formId}-panels`}
              >
                {panels.map((panel, index) => (
                  <li
                    key={panel.id}
                    data-panel={panel.id}
                    className={selected === panel.id ? "de-on" : undefined}
                    onFocus={() => setSelected(panel.id)}
                  >
                    <div className="de-panel-h">
                      <span className="pe-n">{index + 1}</span>
                      <strong className="cell">
                        {panel.title ??
                          presetName(panel.preset_id) ??
                          "New panel"}
                      </strong>
                      <span style={{ flexGrow: 1 }} />
                      <button
                        type="button"
                        className="pe-mini"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="pe-mini"
                        aria-label="Move down"
                        disabled={index === panels.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="pe-mini"
                        aria-label="Remove panel"
                        onClick={() =>
                          setPanels((previous) =>
                            packPanels(
                              previous.filter((item) => item.id !== panel.id),
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                    <div className="de-fields">
                      <label className="de-field de-wide">
                        <span>Saved preset</span>
                        <select
                          className="inp"
                          required
                          value={panel.preset_id}
                          onChange={(event) =>
                            update(panel.id, { preset_id: event.target.value })
                          }
                        >
                          <option value="">Select shared preset</option>
                          {panel.preset_id &&
                            !presets.rows.some(
                              (preset) => preset.id === panel.preset_id,
                            ) && (
                              <option value={panel.preset_id} disabled>
                                Preset not loaded · {panel.preset_id}
                              </option>
                            )}
                          {presets.rows.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {display(preset.name)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="de-field de-wide">
                        <span>Custom title (optional)</span>
                        <input
                          className="inp"
                          value={panel.title ?? ""}
                          maxLength={120}
                          onChange={(event) =>
                            update(panel.id, {
                              title: event.target.value || null,
                            })
                          }
                        />
                      </label>
                      <label className="de-field">
                        <span>Width</span>
                        <select
                          className="inp"
                          value={panel.w}
                          onChange={(event) =>
                            update(panel.id, { w: Number(event.target.value) })
                          }
                        >
                          {[3, 4, 6, 12].map((w) => (
                            <option key={w} value={w}>
                              {w} columns
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="de-field">
                        <span>Height</span>
                        <select
                          className="inp"
                          value={panel.h}
                          onChange={(event) =>
                            update(panel.id, { h: Number(event.target.value) })
                          }
                        >
                          {[2, 3, 4].map((h) => (
                            <option key={h} value={h}>
                              {h} units
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <fieldset className="de-thresholds">
                      <legend className="help">
                        Count thresholds · up to three increasing bounds;
                        neutral below the first
                      </legend>
                      {panel.thresholds.map((threshold, thresholdIndex) => (
                        <div className="de-threshold" key={thresholdIndex}>
                          <span className="small muted">At least</span>
                          <input
                            className="inp"
                            aria-label={`Exact lower bound ${thresholdIndex + 1}`}
                            inputMode="numeric"
                            pattern="0|[1-9][0-9]*"
                            required
                            value={threshold.lower_bound}
                            onChange={(event) =>
                              update(panel.id, {
                                thresholds: panel.thresholds.map((item, i) =>
                                  i === thresholdIndex
                                    ? {
                                        ...item,
                                        lower_bound: event.target.value,
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                          <select
                            className="inp"
                            aria-label={`Color ${thresholdIndex + 1}`}
                            value={threshold.color}
                            onChange={(event) =>
                              update(panel.id, {
                                thresholds: panel.thresholds.map((item, i) =>
                                  i === thresholdIndex
                                    ? { ...item, color: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          >
                            {["blue", "green", "amber", "red"].map((color) => (
                              <option key={color} value={color}>
                                {color[0].toUpperCase() + color.slice(1)}
                              </option>
                            ))}
                          </select>
                          <i
                            className={`de-swatch mn-${threshold.color}`}
                            aria-hidden="true"
                          />
                          <button
                            type="button"
                            className="pe-mini"
                            aria-label={`Remove threshold ${thresholdIndex + 1}`}
                            onClick={() =>
                              update(panel.id, {
                                thresholds: panel.thresholds.filter(
                                  (_, i) => i !== thresholdIndex,
                                ),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-g btn-sm"
                        disabled={panel.thresholds.length >= 3}
                        onClick={() =>
                          update(panel.id, {
                            thresholds: [
                              ...panel.thresholds,
                              { lower_bound: "", color: "blue" },
                            ],
                          })
                        }
                      >
                        Add threshold
                      </button>
                    </fieldset>
                  </li>
                ))}
              </ol>
              <span className="help">
                Panels always use their referenced preset’s current saved query.
                No time range or suppression switch is saved.
              </span>
            </div>
          </form>
        </aside>
      </div>
      {copying && (
        <Dialog
          title="Save as a new dashboard"
          onClose={() => {
            if (!copy.busy) setCopying(false);
          }}
          actions={
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={copy.busy}
                onClick={() => setCopying(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                form={`${formId}-copy`}
                className="btn btn-sm btn-p"
                disabled={copy.busy || (!copy.uncertain && !copyName.trim())}
              >
                {copy.uncertain ? "Retry original command" : "Create dashboard"}
              </button>
            </>
          }
        >
          <p>
            Creates a separate shared dashboard with new panel IDs and the same
            preset references. “{display(existing?.name)}” stays unchanged.
          </p>
          <form
            id={`${formId}-copy`}
            className="f"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCopy();
            }}
          >
            <label className="lbl" htmlFor={`${formId}-copy-name`}>
              New dashboard name
            </label>
            <input
              id={`${formId}-copy-name`}
              className="inp"
              value={copyName}
              maxLength={128}
              onChange={(event) => setCopyName(event.target.value)}
            />
          </form>
          <CommandFeedback command={copy} />
        </Dialog>
      )}
    </Page>
  );
}
