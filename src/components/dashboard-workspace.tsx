"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  display,
  request,
  tenantPath,
  type RecordData,
} from "@/lib/api";
import { useCommand, useDirtyWarning } from "@/lib/hooks";
import {
  compactPanels,
  firstPanelGap,
  placePanel,
} from "@/lib/dashboard-layout";
import type { Scope } from "./workspace";
import { Page, NavLink, useConfirm } from "./page";
import { Dialog } from "./definition-editor";
import { CommandFeedback, Menu } from "./ui";
import { Icon } from "./icons";
import {
  DashboardBoard,
  CountTile,
  HtmlTile,
  isCountPanel,
  isHtmlPanel,
  isTablePanel,
  type DashboardModel,
  type Panel,
} from "./dashboard-counts";
import { DashboardLayout } from "./dashboard-layout";
import { DashboardPanelDialog } from "./dashboard-panel-dialog";
import { TableTile } from "./dashboard-table-panel";

function definition(value?: Record<string, unknown>): {
  name: string;
  panels: Panel[];
} {
  return {
    name: String(value?.name ?? ""),
    panels: Array.isArray(value?.panels)
      ? compactPanels(
          (value.panels as Panel[]).map((panel): Panel => {
            const layout = {
              id: panel.id,
              title: panel.title ?? null,
              x: panel.x,
              y: panel.y,
              w: panel.w,
              h: panel.h,
            };
            if (isTablePanel(panel))
              return {
                ...layout,
                type: "table",
                preset_id: panel.preset_id,
                rows: panel.rows,
              };
            return isHtmlPanel(panel)
              ? { ...layout, type: "html", html: panel.html }
              : {
                  ...layout,
                  preset_id: panel.preset_id,
                  thresholds: (panel.thresholds ?? []).map((item) => ({
                    lower_bound: String(item.lower_bound),
                    color: item.color,
                  })),
                };
          }),
        )
      : [],
  };
}
const more = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

/** A memory-only dashboard draft, edited directly on the ordinary board. */
export function DashboardWorkspace({
  scope,
  existing,
  current,
  initialDraft,
  onSaved,
  onDiscard,
  context,
  model,
  reload,
  deleted = false,
  onDeletedClean,
}: {
  scope: Scope;
  existing?: RecordData;
  current?: RecordData;
  initialDraft?: Record<string, unknown>;
  onSaved: (saved?: RecordData) => void;
  onDiscard?: () => void;
  context?: ReactNode;
  model?: DashboardModel;
  reload?: () => void;
  deleted?: boolean;
  onDeletedClean?: () => void;
}) {
  const [base, setBase] = useState(existing);
  const [draft, setDraft] = useState(() =>
    definition(initialDraft ?? existing),
  );
  const [renaming, setRenaming] = useState(false);
  const beforeRename = useRef("");
  const nameInput = useRef<HTMLInputElement>(null);
  const nameTrigger = useRef<HTMLButtonElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [panelDialog, setPanelDialog] = useState<{
    panel: Panel;
    creating: boolean;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [panelError, setPanelError] = useState("");
  const [panelDraftDirty, setPanelDraftDirty] = useState(false);
  const [copying, setCopying] = useState(false),
    [copyName, setCopyName] = useState("");
  const [saved, setSaved] = useState<RecordData>();
  const save = useCommand(scope.session.csrf_token, scope.onDenied);
  const copy = useCommand(scope.session.csrf_token, scope.onDenied);
  const remove = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmation, confirm] = useConfirm();
  const id = useId();
  const canEdit = scope.tenant.role !== "view";
  const key = JSON.stringify(draft);
  const dirty = canEdit && key !== JSON.stringify(definition(base));
  const locked =
    save.busy ||
    save.uncertain ||
    copy.busy ||
    copy.uncertain ||
    remove.busy ||
    remove.uncertain;
  const list = `/tenants/${scope.tenant.id}/dashboards`;
  const api = `${tenantPath(scope.tenant.id)}/dashboards`;
  const countedDefinition = model?.state.definition;
  const latest =
    current &&
    countedDefinition &&
    /^\d+$/.test(current.revision) &&
    /^\d+$/.test(countedDefinition.revision) &&
    BigInt(current.revision) > BigInt(countedDefinition.revision)
      ? current
      : (countedDefinition ?? current);
  const absent =
    deleted || (save.error instanceof ApiError && save.error.status === 404);
  const newer =
    base &&
    latest &&
    /^\d+$/.test(base.revision) &&
    /^\d+$/.test(latest.revision) &&
    BigInt(latest.revision) > BigInt(base.revision);
  const cleanDeletion = useRef(onDeletedClean);
  cleanDeletion.current = onDeletedClean;
  useEffect(() => {
    if (absent && !dirty && !panelDraftDirty && !locked)
      cleanDeletion.current?.();
  }, [absent, dirty, panelDraftDirty, locked]);
  useDirtyWarning(dirty || panelDraftDirty);
  useEffect(() => {
    scope.setDirty(dirty || panelDraftDirty);
    return () => scope.setDirty(false);
  }, [dirty, panelDraftDirty, scope.setDirty]);
  useEffect(() => {
    if (newer && !dirty && !locked && !panelDialog && !renaming) {
      setBase(latest);
      setDraft(definition(latest));
    }
  }, [newer, latest, dirty, locked, panelDialog, renaming]);
  useEffect(() => {
    if (renaming) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [renaming]);
  useEffect(() => {
    if (!canEdit) {
      setDraft(definition(latest ?? base));
      setPanelDialog(null);
      setPanelDraftDirty(false);
      setRenaming(false);
      setCopying(false);
    }
  }, [canEdit]);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  useEffect(() => {
    if (saved) savedCallback.current(saved);
  }, [saved]);
  function beginRename() {
    beforeRename.current = draft.name;
    setRenaming(true);
  }
  function finishRename(cancel = false) {
    if (cancel)
      setDraft((previous) => ({ ...previous, name: beforeRename.current }));
    setRenaming(false);
    requestAnimationFrame(() => nameTrigger.current?.focus());
  }
  async function submit() {
    if (absent) return;
    if (!save.uncertain && (!dirty || locked || panelDialog)) return;
    if (!draft.name.trim()) {
      setMessage("Enter a name for this dashboard.");
      beginRename();
      return;
    }
    const response = await save.execute<RecordData>(
      `${api}${base ? `/${base.id}` : ""}`,
      { ...draft, ...(base ? { expected_revision: base.revision } : {}) },
      base ? "PUT" : "POST",
    );
    if (response?.data) {
      setBase(response.data);
      setDraft(definition(response.data));
      setMessage("Dashboard saved.");
      setSaved(response.data);
    }
  }
  async function discard() {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: (
          <p>Your draft will be lost. The shared dashboard is unchanged.</p>
        ),
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      }))
    )
      return;
    if (onDiscard) {
      scope.setDirty(false);
      onDiscard();
      return;
    }
    if (!base) return;
    try {
      const response = await request<RecordData>(`${api}/${base.id}`);
      if (response.data) {
        setBase(response.data);
        setDraft(definition(response.data));
        setMessage("Loaded the current saved dashboard.");
        reload?.();
        requestAnimationFrame(() => nameTrigger.current?.focus());
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status))
        scope.onDenied();
      setMessage(
        "The saved dashboard could not be loaded. Your draft is still here.",
      );
    }
  }
  function applyPanel(panel: Panel) {
    if (panelDialog?.creating) {
      const placed = firstPanelGap(draft.panels, panel);
      if (!placed) {
        setPanelError(
          "There is no room for this panel. Make other panels smaller to free space.",
        );
        return;
      }
      setDraft((previous) => ({
        ...previous,
        panels: compactPanels([...previous.panels, placed]),
      }));
    } else {
      const next = placePanel(draft.panels, panel.id, {
        x: Math.min(panel.x, 12 - panel.w),
        y: Math.min(panel.y, 100 - panel.h),
        w: panel.w,
        h: panel.h,
      });
      if (!next) {
        setPanelError(
          "There is no room for that size. Move the panel higher or make it smaller.",
        );
        return;
      }
      setDraft((previous) => ({
        ...previous,
        panels: next.map((item) =>
          item.id === panel.id ? { ...panel, x: item.x, y: item.y } : item,
        ),
      }));
    }
    setPanelDialog(null);
    setPanelDraftDirty(false);
    setPanelError("");
    setMessage("Panel updated. Save the dashboard to keep your changes.");
  }
  const observation = (panel: Panel) =>
    !isCountPanel(panel)
      ? undefined
      : model?.state.batch?.panels.find(
          (item) =>
            item.panel_id === panel.id && item.preset_id === panel.preset_id,
        );
  const panelLabel = (panel: Panel) =>
    panel.title ??
    (isHtmlPanel(panel)
      ? "HTML panel"
      : isTablePanel(panel)
        ? "Alert table"
        : observation(panel)?.preset_name) ??
    "Panel";
  function editPanel(panelId: string) {
    const panel = draft.panels.find((item) => item.id === panelId);
    if (!panel) return;
    setPanelError("");
    setPanelDialog({ panel, creating: false });
  }
  // REV-61: E opens Edit panel for the panel under the pointer, or else the
  // panel holding keyboard focus, whenever the menu item would be available.
  const editShortcut = useRef<(event: KeyboardEvent) => void>(() => {});
  editShortcut.current = (event) => {
    if (
      event.key.toLowerCase() !== "e" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.repeat ||
      event.defaultPrevented ||
      !canEdit ||
      locked ||
      panelDialog ||
      copying ||
      renaming ||
      model?.fullscreen
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox]",
      ) ||
      document.querySelector(
        "dialog[open], [aria-modal=true], .dlg-backdrop, [role=menu], .de-tile-active",
      )
    )
      return;
    const tile =
      document.querySelector<HTMLElement>(
        ".de-tile[data-layout-panel]:hover",
      ) ??
      document.activeElement?.closest<HTMLElement>(
        ".de-tile[data-layout-panel]",
      );
    const panelId = tile?.dataset.layoutPanel;
    if (!panelId || !draft.panels.some((item) => item.id === panelId)) return;
    event.preventDefault();
    editPanel(panelId);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => editShortcut.current(event);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  function panelOptions(panel: Panel) {
    return (
      <div className="db-panel-options">
        <Menu
          label={`Options for ${panelLabel(panel)}`}
          className="btn btn-g btn-sm"
          content={more}
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                aria-keyshortcuts="E"
                disabled={locked}
                onClick={() => {
                  close();
                  editPanel(panel.id);
                }}
              >
                Edit panel
                <span className="db-menu-key" aria-hidden="true">
                  E
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-danger"
                disabled={locked}
                onClick={() => {
                  close();
                  setDraft((previous) => ({
                    ...previous,
                    panels: compactPanels(
                      previous.panels.filter((item) => item.id !== panel.id),
                    ),
                  }));
                  setMessage(
                    "Panel deleted from the draft. Save to keep this change.",
                  );
                  requestAnimationFrame(() => createTrigger.current?.focus());
                }}
              >
                Delete panel
              </button>
            </>
          )}
        </Menu>
      </div>
    );
  }
  async function saveCopy() {
    if (!canEdit) return;
    const response = await copy.execute<RecordData>(api, {
      name: copyName,
      panels: draft.panels.map((panel) => ({
        ...panel,
        id: crypto.randomUUID(),
      })),
    });
    if (response?.data) {
      scope.setDirty(false);
      setCopying(false);
      setBase(response.data);
      setDraft(definition(response.data));
      setSaved(response.data);
    }
  }
  async function deleteDashboard() {
    if (absent) return;
    if (
      !base ||
      !(await confirm({
        title: `Delete dashboard “${display(base.name)}”?`,
        body: (
          <p>
            It is removed for everyone in {scope.tenant.name}. Its presets and
            alerts are kept. Retained history stays readable; there is no
            undelete.{dirty && " Your unsaved changes will also be lost."}
          </p>
        ),
        confirmLabel: "Delete dashboard",
        danger: true,
      }))
    )
      return;
    const response = await remove.execute(`${api}/${base.id}`, {}, "DELETE", {
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": `"${base.revision}"`,
    });
    if (response) {
      scope.setDirty(false);
      scope.navigate(list);
    }
  }
  return (
    <Page
      scope={scope}
      className="dashboard-view dashboard-workspace"
      crumbs={[{ label: "Dashboards", href: list }]}
      title={
        canEdit ? (
          renaming ? (
            <input
              ref={nameInput}
              className="inp db-name-input"
              aria-label="Dashboard name"
              value={draft.name}
              maxLength={128}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  name: event.target.value,
                }))
              }
              onBlur={() => finishRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault();
                  finishRename(event.key === "Escape");
                }
              }}
            />
          ) : (
            <button
              ref={nameTrigger}
              type="button"
              className="db-name"
              aria-label="Edit dashboard name"
              disabled={locked}
              onClick={beginRename}
            >
              <span className="db-name-text">
                {draft.name || "New dashboard"}
              </span>
              <Icon name="edit" size={18} />
            </button>
          )
        ) : (
          display(latest?.name ?? base?.name)
        )
      }
      extra={dirty && <span className="chip chip-warn">Unsaved changes</span>}
      actions={
        <>
          {canEdit && (
            <button
              type="button"
              className="btn"
              disabled={!dirty || locked || !!panelDialog}
              onClick={() => void discard()}
            >
              Discard changes
            </button>
          )}
          {model && (
            <>
              <button type="button" className="btn" onClick={model.refresh}>
                Refresh counts
              </button>
              <button
                ref={model.trigger}
                type="button"
                className="btn"
                disabled={!!panelDialog}
                onClick={() => model.setFullscreen(true)}
              >
                Fullscreen
              </button>
            </>
          )}
          {canEdit && (
            <>
              <button
                ref={createTrigger}
                type="button"
                className="btn"
                disabled={locked || !!panelDialog || draft.panels.length >= 24}
                onClick={() => {
                  setPanelError("");
                  setPanelDialog({
                    creating: true,
                    panel: {
                      id: crypto.randomUUID(),
                      preset_id: "",
                      title: null,
                      x: 0,
                      y: 0,
                      w: 3,
                      h: 2,
                      thresholds: [],
                    },
                  });
                }}
              >
                <Icon name="plus" size={15} />
                Create panel
              </button>
              <button
                type="button"
                className="btn btn-p"
                disabled={
                  absent ||
                  save.busy ||
                  copy.busy ||
                  remove.busy ||
                  copy.uncertain ||
                  remove.uncertain ||
                  !!panelDialog ||
                  (!save.uncertain && !dirty)
                }
                onClick={() => void submit()}
              >
                {save.uncertain ? "Retry original command" : "Save"}
              </button>
            </>
          )}
          {base && (
            <Menu label="More dashboard actions" content={more}>
              {(close) => (
                <>
                  {base && (
                    <>
                      <NavLink
                        scope={scope}
                        role="menuitem"
                        className="menu-item"
                        href={`${list}/${base.id}/history`}
                        onClick={close}
                      >
                        History
                      </NavLink>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            disabled={locked}
                            onClick={() => {
                              close();
                              setCopyName("");
                              setCopying(true);
                            }}
                          >
                            Save as new…
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="menu-item menu-danger"
                            disabled={locked || absent}
                            onClick={() => {
                              close();
                              void deleteDashboard();
                            }}
                          >
                            Delete dashboard
                          </button>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
        </>
      }
    >
      {confirmation}
      {context}
      {absent && (
        <p className="banner bn-warn" role="status">
          This shared dashboard was deleted.
          {dirty && " Your draft is still here."}{" "}
          {canEdit && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={locked}
              onClick={() => {
                setCopyName("");
                setCopying(true);
              }}
            >
              Save as new…
            </button>
          )}
        </p>
      )}
      {newer && dirty && (
        <p className="banner bn-warn" role="status">
          A newer shared version is available. Your draft is based on an earlier
          version. Discard changes to load it, or save as a new dashboard.
        </p>
      )}
      {save.error instanceof ApiError && save.error.status === 409 && (
        <p className="banner bn-warn">
          Your draft was kept. Discard changes to load and compare the current
          saved dashboard, or choose Save as new from the dashboard options.
        </p>
      )}
      {(save.error || save.uncertain || save.busy) && (
        <CommandFeedback command={save} />
      )}
      {(remove.error || remove.uncertain) && (
        <>
          <CommandFeedback command={remove} />
          {remove.uncertain && (
            <button
              type="button"
              className="btn"
              onClick={() => void deleteDashboard()}
            >
              Retry dashboard deletion
            </button>
          )}
        </>
      )}
      {message && (
        <p className="help db-draft-message" role="status">
          {message}
        </p>
      )}
      {model ? (
        <DashboardBoard
          scope={scope}
          model={model}
          draftPanels={canEdit ? draft.panels : undefined}
          editing={
            canEdit
              ? {
                  disabled: locked || !!panelDialog,
                  onChange: (panels) =>
                    setDraft((previous) => ({
                      ...previous,
                      panels: compactPanels(panels),
                    })),
                  options: panelOptions,
                }
              : undefined
          }
        />
      ) : draft.panels.length ? (
        <DashboardLayout
          panels={draft.panels}
          disabled={locked || !!panelDialog || !canEdit}
          label={panelLabel}
          onChange={(panels) =>
            setDraft((previous) => ({
              ...previous,
              panels: compactPanels(panels),
            }))
          }
          onSelect={() => {}}
          renderPanel={(panel, controls, active, style) => {
            const layoutControls = (
              <>
                {controls}
                {canEdit && panelOptions(panel)}
              </>
            );
            if (isTablePanel(panel))
              return (
                <TableTile
                  key={panel.id}
                  scope={scope}
                  panel={panel}
                  layoutControls={layoutControls}
                  layoutActive={active}
                  layoutStyle={style}
                />
              );
            return isHtmlPanel(panel) ? (
              <HtmlTile
                key={panel.id}
                panel={panel}
                layoutControls={layoutControls}
                layoutActive={active}
                layoutStyle={style}
              />
            ) : (
              <CountTile
                key={panel.id}
                scope={scope}
                panel={panel}
                title={panelLabel(panel)}
                placeholder="Save the dashboard to count this panel"
                layoutControls={layoutControls}
                layoutActive={active}
                layoutStyle={style}
              />
            );
          }}
        />
      ) : (
        <div className="panel db-empty">
          <h2>This dashboard has no panels</h2>
          <p>
            {canEdit
              ? "Create a panel to count or list a saved preset's alerts, or show your own notes."
              : "Panels created by editors appear here."}
          </p>
        </div>
      )}
      {panelDialog && canEdit && (
        <DashboardPanelDialog
          key={panelDialog.panel.id}
          scope={scope}
          {...panelDialog}
          latestCount={observation(panelDialog.panel)?.count}
          error={panelError}
          onDirtyChange={setPanelDraftDirty}
          onApply={applyPanel}
          onClose={() => {
            setPanelDialog(null);
            setPanelDraftDirty(false);
            setPanelError("");
          }}
        />
      )}
      {copying && canEdit && (
        <Dialog
          title="Save as a new dashboard"
          onClose={() => {
            if (!copy.busy && !copy.uncertain) setCopying(false);
          }}
          actions={
            <>
              <button
                type="button"
                className="btn"
                disabled={copy.busy || copy.uncertain}
                onClick={() => setCopying(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                form={`${id}-copy`}
                className="btn btn-p"
                disabled={copy.busy || (!copy.uncertain && !copyName.trim())}
              >
                {copy.uncertain ? "Retry original command" : "Create dashboard"}
              </button>
            </>
          }
        >
          <form
            id={`${id}-copy`}
            className="f"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCopy();
            }}
          >
            <label className="lbl" htmlFor={`${id}-copy-name`}>
              New dashboard name
            </label>
            <input
              id={`${id}-copy-name`}
              className="inp"
              value={copyName}
              disabled={copy.busy || copy.uncertain}
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
