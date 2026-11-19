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
  DEFAULT_SORT,
  directionLabel,
  fieldLabel,
  previewTotal,
  alertVocabulary,
  sortItems,
  usePresetPreview,
  type SortItem,
} from "@/lib/preset-choices";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice } from "./ui";
import { CelEditor } from "./cel-editor";
import { AlarmSample } from "./preset-alarm";
import { Page, useConfirm, type Crumb } from "./page";
import {
  AlertTable,
  composeCel,
  QuickViews,
  useQuickViewCounts,
  type QuickViewKey,
} from "./alert-table";
import {
  groupFieldsFor,
  groupFieldLabel,
  isGroupField,
  type GroupField,
} from "./alert-groups";
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

function presetDefinition(value?: Record<string, unknown>, kind?: string) {
  return {
    name: String(value?.name ?? ""),
    cel: typeof value?.cel === "string" ? value.cel : "true",
    columns:
      Array.isArray(value?.columns) && value.columns.length
        ? currentAlertColumns((value.columns as unknown[]).map(String), kind)
        : alertVocabulary(kind).defaultColumns,
    sort: sortItems(value?.sort).length ? sortItems(value?.sort) : DEFAULT_SORT,
    group_by: isGroupField(value?.group_by) ? value.group_by : null,
    // Revisions saved before REV-58 have no alarm flag: they were silent.
    noisy: value?.noisy === true,
  };
}

const SETTINGS_TABS = [
  ["filter", "Filter"],
  ["columns", "Columns"],
  ["sort", "Sort"],
  ["group", "Group by"],
  ["sound", "Sound"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];

function GripIcon() {
  return (
    <svg className="pe-grip" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </svg>
  );
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
  const baseline = presetDefinition(existing, scope.tenant.kind);
  const initial = presetDefinition(initialDraft ?? existing, scope.tenant.kind);
  const vocabulary = alertVocabulary(scope.tenant.kind);
  const groupChoices: [GroupField | null, string][] = [
    [null, "No grouping"],
    ...groupFieldsFor(scope.tenant.kind).map(
      (field) => [field, groupFieldLabel(field)] as [GroupField, string],
    ),
  ];
  const [name, setName] = useState(initial.name),
    [cel, setCel] = useState(initial.cel),
    [selectedColumns, setColumns] = useState<string[]>(initial.columns),
    [sort, setSort] = useState<SortItem[]>(initial.sort),
    [groupBy, setGroupBy] = useState<GroupField | null>(initial.group_by),
    [noisy, setNoisy] = useState(initial.noisy);
  const [previewCel, setPreviewCel] = useState(initial.cel);
  const [quick, setQuick] = useState<QuickViewKey>("all"),
    [suppressed, setSuppressed] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("filter"),
    [celValid, setCelValid] = useState<boolean | undefined>();
  const [dragging, setDragging] = useState<number | null>(null),
    [dropTarget, setDropTarget] = useState<number | null>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const [copying, setCopying] = useState(false),
    [copyName, setCopyName] = useState("");
  const [savedRow, setSavedRow] = useState<RecordData | null>(null);
  const [nameError, setNameError] = useState("");
  const save = useCommand(scope.session.csrf_token, scope.onDenied);
  // A save rejected for its definition is almost always the filter: show it
  // and focus the editor once its panel is visible.
  const [focusFilter, setFocusFilter] = useState(false);
  useEffect(() => {
    if (!(save.error instanceof ApiError) || save.error.status !== 422) return;
    setTab("filter");
    setFocusFilter(true);
  }, [save.error]);
  useEffect(() => {
    if (!focusFilter || tab !== "filter") return;
    setFocusFilter(false);
    filterPanel.current?.querySelector("textarea")?.focus();
  }, [focusFilter, tab]);
  const copy = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmation, confirm] = useConfirm();
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const draft = {
    name,
    cel,
    columns: selectedColumns,
    sort,
    group_by: groupBy,
    noisy,
  };
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
    csrf = scope.session.csrf_token,
    me = scope.session.principal.id;
  const ready = selectedColumns.length > 0 && sort.length > 0;
  const preview = usePresetPreview(
    tenantId,
    csrf,
    scope.onDenied,
    ready && previewCel.trim()
      ? {
          cel: composeCel(previewCel, quick, me),
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
        cel: composeCel(savedCel, view, me),
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
  }, [savedKey, tenantId, csrf, me]);
  const counts = useQuickViewCounts(
    scope,
    ready && previewCel.trim() ? previewCel : null,
    suppressed,
    "",
    JSON.stringify([preview.result?.meta?.evaluated_at]),
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
        group_by: groupBy,
        noisy,
        ...(existing ? { expected_revision: existing.revision } : {}),
      },
      existing ? "PUT" : "POST",
    );
    if (result) setSavedRow(result.data ?? ({} as RecordData));
  }
  async function submitCopy() {
    const result = await copy.execute<RecordData>(
      `${tenantPath(tenantId)}/presets`,
      {
        name: copyName,
        cel,
        sort,
        columns: selectedColumns,
        group_by: groupBy,
        noisy,
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
  const moveColumnTo = (from: number, to: number) =>
    setColumns((previous) => {
      if (from === to || to < 0 || to >= previous.length) return previous;
      const next = [...previous];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  const addable = vocabulary.selectableColumns.filter(
    (column) => !selectedColumns.includes(column),
  );
  const lines = Math.max(1, cel.split("\n").length);
  const draftChanged = cel !== previewCel;
  const total = preview.result?.meta?.total;
  const exact = typeof total === "string" && /^\d+$/.test(total);
  const invalid =
    preview.error instanceof ApiError &&
    [400, 422].includes(preview.error.status);
  const filterInvalid = (invalid && !draftChanged) || celValid === false;
  // Tab summaries; a problem in a hidden tab shows as a red flag.
  const tabBadge = (key: SettingsTab) =>
    key === "filter" ? (
      filterInvalid && <span className="pe-tab-flag">Invalid</span>
    ) : key === "columns" ? (
      selectedColumns.length ? (
        <b>{selectedColumns.length}</b>
      ) : (
        <span className="pe-tab-flag">None</span>
      )
    ) : key === "sort" ? (
      <b>{sort.length}</b>
    ) : key === "group" ? (
      groupBy && <b>{groupFieldLabel(groupBy)}</b>
    ) : (
      noisy && <b>On</b>
    );
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
          <div className="pe-views">
            <QuickViews
              kind={scope.tenant.kind}
              value={quick}
              onChange={setQuick}
              counts={counts.counts}
              hidden={counts.hidden}
              includeSuppressed={suppressed}
              onIncludeSuppressed={setSuppressed}
            />
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
        <section
          className="panel pe-def"
          aria-labelledby={`${formId}-settings`}
        >
          <form
            id={formId}
            className="pe-def-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="pe-def-head">
              <h2 id={`${formId}-settings`}>Preset settings</h2>
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
            </div>
            <div
              className="tabbar pe-tabs"
              role="tablist"
              aria-label="Preset settings"
              onKeyDown={(event) => {
                const index = SETTINGS_TABS.findIndex(([key]) => key === tab);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % SETTINGS_TABS.length
                    : event.key === "ArrowLeft"
                      ? (index + SETTINGS_TABS.length - 1) %
                        SETTINGS_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? SETTINGS_TABS.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                const key = SETTINGS_TABS[next][0];
                setTab(key);
                document.getElementById(`${formId}-tab-${key}`)?.focus();
              }}
            >
              {SETTINGS_TABS.map(([key, label]) => (
                <button
                  key={key}
                  id={`${formId}-tab-${key}`}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={tab === key}
                  aria-controls={`${formId}-panel-${key}`}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => setTab(key)}
                >
                  {label}
                  {tabBadge(key) && <> {tabBadge(key)}</>}
                </button>
              ))}
            </div>
            <div className="pe-def-body">
              <div
                ref={filterPanel}
                id={`${formId}-panel-filter`}
                role="tabpanel"
                aria-labelledby={`${formId}-tab-filter`}
                className="pe-panel"
                hidden={tab !== "filter"}
              >
                <CelEditor
                  scope={scope}
                  label="Filter (CEL)"
                  hint="Ctrl+Space completes · Ctrl+Enter previews"
                  rows={Math.max(8, lines)}
                  value={cel}
                  context="feed"
                  onChange={setCel}
                  onRun={runPreview}
                  referencePopover
                  onValidity={setCelValid}
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
              </div>
              <div
                id={`${formId}-panel-columns`}
                role="tabpanel"
                aria-labelledby={`${formId}-tab-columns`}
                className="pe-panel"
                hidden={tab !== "columns"}
              >
                <div className="pe-label-row">
                  <span className="lbl" id={`${formId}-columns`}>
                    Columns, in order
                  </span>
                  <span className="help">
                    Drag or use the arrows to reorder
                  </span>
                </div>
                <ol
                  className="pe-columns"
                  aria-labelledby={`${formId}-columns`}
                >
                  {selectedColumns.map((column, index) => (
                    <li
                      key={column}
                      draggable
                      className={
                        dragging === index
                          ? "pe-dragging"
                          : dropTarget === index
                            ? "pe-drop"
                            : undefined
                      }
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", column);
                        setDragging(index);
                      }}
                      onDragOver={(event) => {
                        if (dragging === null) return;
                        event.preventDefault();
                        setDropTarget(index);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragging !== null) moveColumnTo(dragging, index);
                        setDragging(null);
                        setDropTarget(null);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setDropTarget(null);
                      }}
                    >
                      <GripIcon />
                      <span className="pe-n">{index + 1}</span>
                      <span className="pe-col-label">{fieldLabel(column)}</span>
                      <span className="pe-col-moves">
                        <button
                          type="button"
                          className="pe-mini"
                          aria-label={`Move ${fieldLabel(column)} up`}
                          disabled={index === 0}
                          onClick={() => moveColumnTo(index, index - 1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="pe-mini"
                          aria-label={`Move ${fieldLabel(column)} down`}
                          disabled={index === selectedColumns.length - 1}
                          onClick={() => moveColumnTo(index, index + 1)}
                        >
                          ↓
                        </button>
                      </span>
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
                </ol>
                {!selectedColumns.length && (
                  <span className="help pe-error">
                    Choose at least one column.
                  </span>
                )}
                <fieldset className="pe-add">
                  <legend className="lbl">Add columns</legend>
                  {addable.length ? (
                    <div className="pe-add-list">
                      {addable.map((column) => (
                        <label key={column}>
                          <input
                            type="checkbox"
                            checked={false}
                            onChange={() =>
                              setColumns((previous) => [...previous, column])
                            }
                          />
                          {fieldLabel(column)}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <span className="help">Every column is shown.</span>
                  )}
                  <span className="help">
                    A ticked column is added at the end.
                  </span>
                </fieldset>
              </div>
              <div
                id={`${formId}-panel-sort`}
                role="tabpanel"
                aria-labelledby={`${formId}-tab-sort`}
                className="pe-panel"
                hidden={tab !== "sort"}
              >
                <span className="lbl">Sort rows by</span>
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
                      {!vocabulary.sortFields.includes(item.field) && (
                        <option value={item.field}>
                          {fieldLabel(item.field)}
                        </option>
                      )}
                      {vocabulary.sortFields
                        .filter(
                          (field) =>
                            field === item.field ||
                            !sort.some((entry) => entry.field === field),
                        )
                        .map((field) => (
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
                                vocabulary.sortFields.find(
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
                <span className="help">
                  Up to three levels. A later level orders only the rows the
                  earlier ones tie.
                </span>
              </div>
              <div
                id={`${formId}-panel-group`}
                role="tabpanel"
                aria-labelledby={`${formId}-tab-group`}
                className="pe-panel"
                hidden={tab !== "group"}
              >
                <span className="lbl" id={`${formId}-group`}>
                  Group by
                </span>
                <div
                  className="pe-radios"
                  role="radiogroup"
                  aria-labelledby={`${formId}-group`}
                  aria-describedby={`${formId}-group-help`}
                >
                  {groupChoices.map(([field, label]) => (
                    <label
                      key={field ?? ""}
                      className={groupBy === field ? "pe-radio-on" : undefined}
                    >
                      <input
                        type="radio"
                        name={`${formId}-group`}
                        checked={groupBy === field}
                        onChange={() => setGroupBy(field)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <span id={`${formId}-group-help`} className="help">
                  {groupBy
                    ? `Each ${groupFieldLabel(groupBy).toLowerCase()} gets its own table. Rows inside follow the sort.`
                    : "Results show as one table."}
                </span>
              </div>
              <div
                id={`${formId}-panel-sound`}
                role="tabpanel"
                aria-labelledby={`${formId}-tab-sound`}
                className="pe-panel pe-sound"
                hidden={tab !== "sound"}
              >
                <div className="pe-switch-row">
                  <button
                    type="button"
                    role="switch"
                    className="pe-switch"
                    aria-checked={noisy}
                    aria-labelledby={`${formId}-noisy`}
                    aria-describedby={`${formId}-noisy-help`}
                    onClick={() => setNoisy((value) => !value)}
                  />
                  <span className="pe-switch-text">
                    <span className="pe-switch-title" id={`${formId}-noisy`}>
                      Noisy preset
                    </span>
                    <span className="help" id={`${formId}-noisy-help`}>
                      Play an alarm while this preset, or a dashboard panel
                      showing it, is open and alerts match.
                    </span>
                  </span>
                </div>
                <div className={`pe-alarm ${noisy ? "" : "is-off"}`}>
                  <span className="lbl">Alarm</span>
                  <div className="pe-alarm-row">
                    <AlarmSample />
                    <span className="help">
                      Heavy trailer alarm · 27 s, repeats
                    </span>
                  </div>
                </div>
                <ul className="pe-notes">
                  <li>
                    Everyone who opens this preset or such a dashboard hears it
                    until no alerts match or they mute it.
                  </li>
                  <li>
                    Anyone can mute it on their own screen. Muting doesn&apos;t
                    change the preset.
                  </li>
                  <li>
                    Browsers play sound only after a click on the page, so a
                    reloaded screen asks to turn sound on.
                  </li>
                </ul>
              </div>
            </div>
            <p className="help pe-def-foot">
              Changes apply to everyone in {scope.tenant.name} once saved
            </p>
          </form>
        </section>
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
