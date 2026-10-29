"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { display, tenantPath } from "@/lib/api";
import { usePresetChoices } from "@/lib/preset-choices";
import { useDirtyWarning } from "@/lib/hooks";
import type { Panel } from "./dashboard-counts";
import { Icon } from "./icons";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import "../app/styles/dashboard-panel-dialog.css";

const decimal = /^(0|[1-9][0-9]*)$/;
const colors = ["blue", "green", "amber", "red"];

export function DashboardPanelDialog({
  scope,
  panel,
  creating,
  error: placementError,
  onDirtyChange,
  returnFocus,
  onApply,
  onClose,
}: {
  scope: Scope;
  panel: Panel;
  creating: boolean;
  error?: string;
  onDirtyChange?: (dirty: boolean) => void;
  returnFocus?: HTMLElement | null;
  onApply: (panel: Panel) => void;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const addThreshold = useRef<HTMLButtonElement>(null);
  const baseline = useRef<Panel>({
    ...panel,
    title: panel.title ?? null,
    thresholds: (panel.thresholds ?? []).map((threshold) => ({ ...threshold })),
  });
  const [draft, setDraft] = useState<Panel>(baseline.current);
  // Typed text searches presets; null shows the selected preset's name instead.
  const [search, setSearch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const presets = usePresetChoices(
    `${tenantPath(scope.tenant.id)}/presets`,
    [draft.preset_id],
    scope.onDenied,
    scope.version,
  );
  const selected = presets.rows.find((preset) => preset.id === draft.preset_id);
  const selectedName = selected
    ? display(selected.name)
    : draft.preset_id
      ? `Preset not loaded · ${draft.preset_id}`
      : "";
  const listed = open && presets.rows.length > 0;
  const highlighted = Math.min(active, presets.rows.length - 1);
  const field = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<CSSProperties>();
  const thresholds = draft.thresholds ?? [];
  const dirty =
    JSON.stringify({
      ...draft,
      title: (draft.title ?? "").trim().normalize("NFC") || null,
    }) !== JSON.stringify(baseline.current);
  const dirtyChanged = useRef(onDirtyChange);
  dirtyChanged.current = onDirtyChange;
  const focusTarget = useRef(returnFocus);
  useDirtyWarning(dirty);
  useEffect(() => {
    dirtyChanged.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyChanged.current?.(false), []);

  useEffect(() => {
    const element = dialog.current;
    const opener = focusTarget.current ?? document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // The list is fixed below the field so it overlays the dialog instead of
  // growing or scrolling it; follow the field while the dialog scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const box = field.current?.getBoundingClientRect();
      if (box)
        setPlace({
          top: box.bottom + 4,
          left: box.left,
          width: box.width,
          maxHeight: Math.max(160, window.innerHeight - box.bottom - 16),
        });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  useEffect(() => {
    if (listed)
      document
        .getElementById(`${id}-preset-${highlighted}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [id, listed, highlighted]);

  function update(patch: Partial<Panel>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
  }

  const failure = Boolean(presets.error) && (
    <>
      <ErrorNotice error={presets.error} />
      <button type="button" className="btn btn-sm" onClick={presets.restart}>
        Retry loading presets
      </button>
    </>
  );

  function choose(preset: { id: string }) {
    update({ preset_id: preset.id });
    setSearch(null);
    setOpen(false);
  }

  function invalid(message: string, field: string) {
    setError(message);
    const element = form.current?.elements.namedItem(field);
    if (element instanceof HTMLElement) element.focus();
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) {
      invalid("Select an available shared preset.", "preset");
      return;
    }
    const title = (draft.title ?? "").trim().normalize("NFC");
    if (
      [...title].length > 120 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(title)
    ) {
      invalid("Use a single-line title of up to 120 characters.", "title");
      return;
    }
    let previous = -1n;
    for (const [index, threshold] of thresholds.entries()) {
      if (!decimal.test(threshold.lower_bound)) {
        invalid(
          "Enter each threshold as a nonnegative whole number without leading zeros.",
          `lower-bound-${index + 1}`,
        );
        return;
      }
      const bound = BigInt(threshold.lower_bound);
      if (bound <= previous) {
        invalid(
          "Thresholds must increase from the first to the last.",
          `lower-bound-${index + 1}`,
        );
        return;
      }
      if (!colors.includes(threshold.color)) {
        invalid("Select an available threshold color.", `color-${index + 1}`);
        return;
      }
      previous = bound;
    }
    onApply({ ...draft, title: title || null, thresholds });
  }

  return (
    <dialog
      ref={dialog}
      className="dlg dashboard-panel-dialog"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-save-help`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
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
      <h2 id={`${id}-heading`}>{creating ? "Create panel" : "Edit panel"}</h2>
      <form
        ref={form}
        className="dashboard-panel-form"
        onSubmit={apply}
        noValidate
      >
        <div
          className="f dashboard-panel-preset"
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setOpen(false);
            setSearch(null);
          }}
        >
          <label className="lbl" htmlFor={`${id}-preset`}>
            Saved preset
          </label>
          <div className="dashboard-panel-combo">
            <input
              ref={field}
              id={`${id}-preset`}
              name="preset"
              className="inp"
              role="combobox"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="Search shared presets"
              value={search ?? selectedName}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? `${id}-popup` : undefined}
              aria-activedescendant={
                listed ? `${id}-preset-${highlighted}` : undefined
              }
              onFocus={(event) => event.currentTarget.select()}
              onClick={() => setOpen(true)}
              onChange={(event) => {
                setSearch(event.target.value);
                presets.search(event.target.value);
                setOpen(true);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                  event.preventDefault();
                  if (!listed) {
                    setOpen(true);
                    return;
                  }
                  setActive(
                    (highlighted +
                      (event.key === "ArrowDown"
                        ? 1
                        : presets.rows.length - 1)) %
                      presets.rows.length,
                  );
                } else if (listed && event.key === "Enter") {
                  event.preventDefault();
                  choose(presets.rows[highlighted]);
                } else if (open && event.key === "Escape") {
                  // Close the list without closing the dialog.
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  setSearch(null);
                }
              }}
            />
            <button
              type="button"
              className="dashboard-panel-toggle"
              tabIndex={-1}
              aria-label={open ? "Hide presets" : "Show presets"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                field.current?.focus();
                setOpen((current) => !current);
              }}
            >
              <Icon name="chevron-down" size={16} />
            </button>
          </div>
          {open && (
            <div
              id={`${id}-popup`}
              className="dashboard-panel-popup"
              style={place}
            >
              {listed ? (
                <ul
                  id={`${id}-presets`}
                  role="listbox"
                  aria-label="Shared presets"
                  className="dashboard-panel-presets"
                >
                  {presets.rows.map((preset, index) => (
                    <li
                      key={preset.id}
                      id={`${id}-preset-${index}`}
                      role="option"
                      aria-selected={index === highlighted}
                      data-current={preset.id === draft.preset_id || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(preset)}
                    >
                      {display(preset.name)}
                    </li>
                  ))}
                </ul>
              ) : (
                !presets.loading &&
                !presets.error && (
                  <p className="help dashboard-panel-empty">
                    No presets match.
                  </p>
                )
              )}
              {failure}
              <div className="dashboard-panel-pager">
                <span className="help" role="status">
                  {presets.loading
                    ? "Loading presets…"
                    : `${presets.rows.length} available presets loaded`}
                </span>
                {presets.cursor && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={presets.loading}
                    onClick={() => {
                      presets.restart();
                      setActive(0);
                    }}
                  >
                    First page
                  </button>
                )}
                {presets.nextCursor && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={presets.loading}
                    onClick={() => {
                      presets.next();
                      setActive(0);
                    }}
                  >
                    Next page
                  </button>
                )}
              </div>
            </div>
          )}
          {!open && failure}
        </div>
        <label className="f">
          <span className="lbl">Custom title (optional)</span>
          <input
            name="title"
            className="inp"
            value={draft.title ?? ""}
            onChange={(event) => update({ title: event.target.value })}
            aria-describedby={`${id}-title-help`}
          />
          <span className="help" id={`${id}-title-help`}>
            Leave blank to use the preset name. Up to 120 characters.
          </span>
        </label>
        <fieldset className="dashboard-panel-thresholds">
          <legend className="lbl">Count thresholds</legend>
          <p className="help">
            Up to three increasing bounds. Counts below the first remain
            neutral.
          </p>
          {thresholds.map((threshold, index) => (
            <div className="dashboard-panel-threshold" key={index}>
              <label className="f">
                <span className="lbl">Exact lower bound {index + 1}</span>
                <input
                  name={`lower-bound-${index + 1}`}
                  className="inp"
                  inputMode="numeric"
                  pattern="0|[1-9][0-9]*"
                  required
                  value={threshold.lower_bound}
                  onChange={(event) =>
                    update({
                      thresholds: thresholds.map((item, position) =>
                        position === index
                          ? { ...item, lower_bound: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="f">
                <span className="lbl">Color {index + 1}</span>
                <select
                  name={`color-${index + 1}`}
                  className="inp"
                  value={threshold.color}
                  onChange={(event) =>
                    update({
                      thresholds: thresholds.map((item, position) =>
                        position === index
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    })
                  }
                >
                  {colors.map((color) => (
                    <option key={color} value={color}>
                      {color[0].toUpperCase() + color.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`Remove threshold ${index + 1}`}
                onClick={() => {
                  update({
                    thresholds: thresholds.filter(
                      (_, position) => position !== index,
                    ),
                  });
                  requestAnimationFrame(() => addThreshold.current?.focus());
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            ref={addThreshold}
            type="button"
            className="btn btn-sm"
            disabled={thresholds.length >= 3}
            onClick={() => {
              const last = thresholds.at(-1)?.lower_bound;
              const next =
                last && decimal.test(last) ? String(BigInt(last) + 1n) : "0";
              update({
                thresholds: [
                  ...thresholds,
                  { lower_bound: next, color: "blue" },
                ],
              });
            }}
          >
            Add threshold
          </button>
        </fieldset>
        {(error || placementError) && (
          <div role="alert" className="notice error">
            {error || placementError}
          </div>
        )}
        <p className="help" id={`${id}-save-help`}>
          Panel changes stay in your draft until you save the dashboard.
        </p>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" disabled={!selected}>
            {creating ? "Create panel" : "Apply changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
