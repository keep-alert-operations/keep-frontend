"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  display,
  message as errorMessage,
  request,
  tenantPath,
} from "@/lib/api";
import {
  currentAlertColumns,
  fieldLabel,
  previewTotal,
  usePresetChoices,
} from "@/lib/preset-choices";
import { useDirtyWarning } from "@/lib/hooks";
import { MAX_PANEL_HTML, sanitizePanelHtml } from "@/lib/panel-html";
import {
  DEFAULT_LINK_LABEL,
  MAX_LINK_LABEL,
  labelProblem,
  linkProblem,
  panelLink,
} from "@/lib/panel-link";
import { PanelLinkButton } from "./dashboard-panel-link";
import {
  IMAGE_TYPES,
  MAX_IMAGE_DESCRIPTION,
  addressProblem,
  fileProblem,
  fileSize,
  uploadPanelImage,
} from "@/lib/panel-image";
import {
  CountTile,
  ImageTile,
  type CountPanel,
  type HtmlPanel,
  type ImagePanel,
  type Panel,
  type TablePanel,
} from "./dashboard-counts";
import { TableTile } from "./dashboard-table-panel";
import { ThresholdColorPicker } from "./threshold-color-picker";
import { isThresholdColor } from "@/lib/threshold-colors";
import { Icon } from "./icons";
import type { Scope } from "./workspace";
import { ErrorNotice } from "./ui";
import "../app/styles/dashboard-panel-dialog.css";

const decimal = /^(0|[1-9][0-9]*)$/;
type Kind = "count" | "html" | "image" | "table";
const MAX_ROWS = 50;
type Source = "upload" | "link";
/** The uploaded file an image panel shows: its ID, plus local details once chosen here. */
interface Upload {
  id?: string;
  name?: string;
  size?: number;
  width?: string;
  height?: string;
  preview?: string;
  uploading?: boolean;
  problem?: string;
}
interface Removal {
  panel_id: string;
  line: number;
  what: string;
}

const glyph = (path: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);
/** Panel types in the order the type list shows them (REV-57). */
const TYPES: {
  id: Kind;
  name: string;
  description: string;
  icon: ReactNode;
}[] = [
  {
    id: "count",
    name: "Alert count",
    description: "Exact count from a saved preset, with color thresholds.",
    icon: glyph("M9 4 7 20M17 4l-2 16M4 9h17M3 15h17"),
  },
  {
    id: "table",
    name: "Alert table",
    description:
      "The latest alerts from a saved preset, in the preset's columns.",
    icon: glyph("M3 5h18v14H3zM3 10h18M3 14.5h18M9 10v9"),
  },
  {
    id: "html",
    name: "HTML",
    description: "Your own notes, links and tables, written as HTML.",
    icon: glyph("M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16"),
  },
  {
    id: "image",
    name: "Image",
    description:
      "A picture you upload or link to, such as a diagram or screenshot.",
    icon: glyph(
      "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM21 16l-5-5-9 8M9 10h.01",
    ),
  },
];

const layoutOf = (panel: Panel) => ({
  id: panel.id,
  title: panel.title ?? null,
  x: panel.x,
  y: panel.y,
  w: panel.w,
  h: panel.h,
  // Every panel type may have a link (REV-66).
  link: panel.link ? panelLink(panel.link.url, panel.link.label ?? "") : null,
});
function normalized(panel: Panel): Panel {
  const title = (panel.title ?? "").trim().normalize("NFC") || null;
  if (panel.type === "table")
    return {
      ...layoutOf(panel),
      title,
      type: "table",
      preset_id: panel.preset_id,
      rows: panel.rows,
    };
  if (panel.type === "image")
    return {
      ...layoutOf(panel),
      title,
      type: "image",
      image_id: panel.image_id ?? null,
      url: panel.url ?? null,
      fit: panel.fit ?? "contain",
      alt: (panel.alt ?? "").trim().normalize("NFC") || null,
    };
  return panel.type === "html"
    ? { ...layoutOf(panel), title, type: "html", html: panel.html }
    : {
        ...layoutOf(panel),
        title,
        preset_id: panel.preset_id,
        thresholds: (panel.thresholds ?? []).map((item) => ({ ...item })),
      };
}

/** The panel type field: a dropdown list of types with a search box. */
function TypeField({
  id,
  value,
  locked,
  onChange,
}: {
  id: string;
  value: Kind;
  locked: boolean;
  onChange: (kind: Kind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = TYPES.find((type) => type.id === value) ?? TYPES[0];
  const words = query.trim().toLowerCase();
  const shown = TYPES.filter((type) =>
    `${type.name} ${type.description}`.toLowerCase().includes(words),
  );
  const highlighted = Math.min(active, shown.length - 1);
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  function close(focus = true) {
    setOpen(false);
    setQuery("");
    if (focus) button.current?.focus();
  }
  function choose(kind: Kind) {
    onChange(kind);
    close();
  }
  return (
    <div
      className="f dashboard-panel-type"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
    >
      <span className="lbl" id={`${id}-type-label`}>
        Panel type
      </span>
      <button
        ref={button}
        type="button"
        className="dashboard-panel-type-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-type-label ${id}-type-value`}
        disabled={locked}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="dashboard-panel-type-icon">{current.icon}</span>
        <span className="dashboard-panel-type-text" id={`${id}-type-value`}>
          <b>{current.name}</b>
          <span className="help">{current.description}</span>
        </span>
        {!locked && <Icon name="chevron-down" size={16} />}
      </button>
      {locked && (
        <span className="help">
          A panel keeps its type. To show something else, create a new panel.
        </span>
      )}
      {open && (
        <div className="dashboard-panel-type-popup">
          <input
            ref={search}
            type="search"
            className="inp"
            placeholder="Search panel types"
            aria-label="Search panel types"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-types`}
            aria-activedescendant={
              shown.length ? `${id}-type-${shown[highlighted].id}` : undefined
            }
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (
                ["ArrowDown", "ArrowUp"].includes(event.key) &&
                shown.length
              ) {
                event.preventDefault();
                setActive(
                  (highlighted +
                    (event.key === "ArrowDown" ? 1 : shown.length - 1)) %
                    shown.length,
                );
              } else if (event.key === "Enter" && shown.length) {
                event.preventDefault();
                choose(shown[highlighted].id);
              } else if (event.key === "Escape") {
                // Close the list without closing the dialog.
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          />
          {shown.length ? (
            <ul
              id={`${id}-types`}
              role="listbox"
              aria-label="Panel types"
              className="dashboard-panel-type-list"
            >
              {shown.map((type, index) => (
                <li
                  key={type.id}
                  id={`${id}-type-${type.id}`}
                  role="option"
                  aria-selected={index === highlighted}
                  data-current={type.id === value || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(type.id)}
                >
                  <span className="dashboard-panel-type-icon">{type.icon}</span>
                  <span className="dashboard-panel-type-text">
                    <b>{type.name}</b>
                    <span className="help">{type.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="help dashboard-panel-empty">No panel types match.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The preview area: the panel at its current grid size. */
function Preview({ panel, children }: { panel: Panel; children: ReactNode }) {
  return (
    <div className="f">
      <span className="lbl">Preview</span>
      <div className="dashboard-panel-preview">{children}</div>
      <p className="help">
        Shown at the panel&apos;s current size, {panel.w} × {panel.h}. Resize it
        on the dashboard grid.
      </p>
    </div>
  );
}
const previewSize = (panel: Panel): CSSProperties => ({
  width: `${Math.min(100, (panel.w / 6) * 100)}%`,
  minWidth: 220,
  height: Math.min(panel.h * 48 + (panel.h - 1) * 12, 420),
});

export function DashboardPanelDialog({
  scope,
  panel,
  creating,
  latestCount,
  error: placementError,
  onDirtyChange,
  returnFocus,
  onApply,
  onClose,
}: {
  scope: Scope;
  panel: Panel;
  creating: boolean;
  /** The last count of the panel being edited, for a local threshold preview. */
  latestCount?: string;
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
  const gutter = useRef<HTMLDivElement>(null);
  const baseline = useRef<Panel>(normalized(panel));
  const [kind, setKind] = useState<Kind>(panel.type ?? "count");
  // Each type keeps its own draft, so switching types while creating loses nothing.
  // Count and table panels share the preset choice and title (REV-63).
  const [draft, setDraft] = useState<CountPanel>(
    panel.type === "table"
      ? { ...layoutOf(panel), preset_id: panel.preset_id, thresholds: [] }
      : (panel.type ?? "count") === "count"
        ? (baseline.current as CountPanel)
        : { ...layoutOf(panel), preset_id: "", thresholds: [] },
  );
  // The typed text of "Alerts to show"; it is checked when applying.
  const [rowsText, setRowsText] = useState(
    String(panel.type === "table" ? panel.rows : 10),
  );
  const [htmlDraft, setHtmlDraft] = useState<HtmlPanel>(
    panel.type === "html"
      ? (baseline.current as HtmlPanel)
      : { ...layoutOf(panel), type: "html", html: "" },
  );
  // An image panel keeps its upload and its address apart, so switching the
  // source back and forth loses neither (REV-62).
  const [imageDraft, setImageDraft] = useState<ImagePanel>(
    panel.type === "image"
      ? (baseline.current as ImagePanel)
      : {
          ...layoutOf(panel),
          type: "image",
          image_id: null,
          url: null,
          fit: "contain",
          alt: null,
        },
  );
  const [source, setSource] = useState<Source>(
    panel.type === "image" && panel.url ? "link" : "upload",
  );
  const [upload, setUpload] = useState<Upload>(
    panel.type === "image" && panel.image_id ? { id: panel.image_id } : {},
  );
  const [address, setAddress] = useState(
    panel.type === "image" ? (panel.url ?? "") : "",
  );
  const [addressTouched, setAddressTouched] = useState(false);
  // The panel link follows the panel across types, like the title (REV-66).
  const [linkAddress, setLinkAddress] = useState(panel.link?.url ?? "");
  const [linkText, setLinkText] = useState(panel.link?.label ?? "");
  const [linkTouched, setLinkTouched] = useState(false);
  const link = panelLink(linkAddress, linkText);
  // Previews show the button only for an address that can be saved.
  const shownLink = linkProblem(linkAddress) ? null : link;
  const [linkStatus, setLinkStatus] = useState("loading");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useRef<AbortController | null>(null);
  // Typed text searches presets; null shows the selected preset's name instead.
  const [search, setSearch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [removed, setRemoved] = useState<Removal[]>([]);
  const [previewCount, setPreviewCount] = useState<{
    preset: string;
    value?: string;
    failed?: boolean;
  }>();
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
  const imagePanel: ImagePanel = {
    ...imageDraft,
    image_id: source === "upload" ? (upload.id ?? null) : null,
    url: source === "link" ? address.trim() || null : null,
    link: shownLink,
  };
  const rowsValue = /^[1-9][0-9]?$/.test(rowsText.trim())
    ? Number(rowsText.trim())
    : undefined;
  const tableDraft: TablePanel = {
    ...layoutOf(draft),
    // A new table panel starts at 6 × 6 so its rows have room (REV-63).
    ...(creating ? { w: Math.max(draft.w, 6), h: Math.max(draft.h, 6) } : {}),
    title: draft.title,
    type: "table",
    preset_id: draft.preset_id,
    link: shownLink,
    rows:
      rowsValue !== undefined && rowsValue <= MAX_ROWS
        ? rowsValue
        : panel.type === "table"
          ? panel.rows
          : 10,
  };
  const current: Panel = {
    ...(kind === "html"
      ? htmlDraft
      : kind === "image"
        ? imagePanel
        : kind === "table"
          ? tableDraft
          : draft),
    link,
  };
  const title = current.title ?? "";
  const dirty =
    JSON.stringify(normalized(current)) !== JSON.stringify(baseline.current);
  const shownHtml = useMemo(
    () => (kind === "html" ? sanitizePanelHtml(htmlDraft.html) : ""),
    [kind, htmlDraft.html],
  );
  const lines = Math.max(1, htmlDraft.html.split("\n").length);
  const dirtyChanged = useRef(onDirtyChange);
  dirtyChanged.current = onDirtyChange;
  const focusTarget = useRef(returnFocus);
  useDirtyWarning(dirty);
  useEffect(() => {
    dirtyChanged.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyChanged.current?.(false), []);
  useEffect(
    () => () => {
      if (upload.preview) URL.revokeObjectURL(upload.preview);
    },
    [upload.preview],
  );
  useEffect(() => () => uploads.current?.abort(), []);

  useEffect(() => {
    const element = dialog.current;
    const opener = focusTarget.current ?? document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const csrf = scope.session.csrf_token;
  // Count the chosen preset for the preview the way a dashboard does: its saved
  // query over current alerts, without suppressed ones.
  const selectedCel =
    selected && typeof selected.cel === "string" ? selected.cel : undefined;
  useEffect(() => {
    if (kind !== "count" || !draft.preset_id || selectedCel === undefined)
      return;
    const preset = draft.preset_id;
    const controller = new AbortController();
    setPreviewCount({ preset });
    previewTotal(
      scope.tenant.id,
      csrf,
      { cel: selectedCel },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted)
          setPreviewCount({ preset, value, failed: value === undefined });
      },
      () => {
        if (!controller.signal.aborted)
          setPreviewCount({ preset, failed: true });
      },
    );
    return () => controller.abort();
  }, [kind, draft.preset_id, selectedCel, scope.tenant.id, csrf]);

  // The server's sanitizer is the authority on what an HTML panel keeps; ask it
  // shortly after typing stops which parts it would remove.
  useEffect(() => {
    if (kind !== "html" || !htmlDraft.html.trim()) {
      setRemoved([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<{ valid: boolean; removed?: Removal[] }>(
        `${tenantPath(scope.tenant.id)}/dashboards/validate`,
        {
          method: "POST",
          csrf,
          signal: controller.signal,
          body: {
            name: "Panel check",
            panels: [
              {
                id: htmlDraft.id,
                type: "html",
                x: 0,
                y: 0,
                w: htmlDraft.w,
                h: Math.min(htmlDraft.h, 100),
                html: htmlDraft.html,
              },
            ],
          },
        },
      )
        .then((response) => setRemoved(response.data.removed ?? []))
        .catch(() => {
          if (!controller.signal.aborted) setRemoved([]);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    kind,
    htmlDraft.html,
    htmlDraft.id,
    htmlDraft.w,
    htmlDraft.h,
    scope.tenant.id,
    csrf,
  ]);

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

  function update(patch: Partial<CountPanel>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
  }
  function updateHtml(patch: Partial<HtmlPanel>) {
    setHtmlDraft((current) => ({ ...current, ...patch }));
    setError("");
  }
  function updateImage(patch: Partial<ImagePanel>) {
    setImageDraft((current) => ({ ...current, ...patch }));
    setError("");
  }
  function setTitle(value: string) {
    if (kind === "html") updateHtml({ title: value });
    else if (kind === "image") updateImage({ title: value });
    else update({ title: value });
  }
  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setError("");
    const problem = fileProblem(file);
    if (problem) {
      setUpload((current) => ({ ...current, problem }));
      return;
    }
    uploads.current?.abort();
    const controller = new AbortController();
    uploads.current = controller;
    const preview = URL.createObjectURL(file);
    setUpload({ name: file.name, size: file.size, preview, uploading: true });
    try {
      const stored = await uploadPanelImage(
        scope.tenant.id,
        csrf,
        file,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setUpload({
        id: stored.id,
        name: file.name,
        size: file.size,
        width: stored.width,
        height: stored.height,
        preview,
      });
    } catch (failure) {
      if (controller.signal.aborted) return;
      setUpload({
        problem: `${file.name} wasn't uploaded. ${errorMessage(failure)}`,
      });
    }
  }
  function removeFile() {
    uploads.current?.abort();
    setUpload({});
    requestAnimationFrame(() =>
      document.getElementById(`${id}-choose-file`)?.focus(),
    );
  }
  function switchKind(next: Kind) {
    if (next === kind) return;
    // The title follows the panel across types; type-specific settings stay put.
    if (next === "html") setHtmlDraft((current) => ({ ...current, title }));
    else if (next === "image")
      setImageDraft((current) => ({ ...current, title }));
    else setDraft((current) => ({ ...current, title }));
    setKind(next);
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
    const trimmed = title.trim().normalize("NFC");
    if (
      [...trimmed].length > 120 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(trimmed)
    ) {
      invalid("Use a single-line title of up to 120 characters.", "title");
      return;
    }
    if (linkProblem(linkAddress)) {
      setLinkTouched(true);
      invalid(linkProblem(linkAddress), "link-url");
      return;
    }
    if (link && labelProblem(linkText)) {
      invalid(labelProblem(linkText), "link-label");
      return;
    }
    if (kind === "image") {
      if (source === "upload" && !upload.id) {
        invalid(
          upload.uploading
            ? "Wait for the image to finish uploading."
            : "Upload an image or switch to a link.",
          "image-file",
        );
        return;
      }
      if (source === "link" && addressProblem(address)) {
        setAddressTouched(true);
        invalid(addressProblem(address), "url");
        return;
      }
      const alt = (imageDraft.alt ?? "").trim().normalize("NFC");
      if (
        [...alt].length > MAX_IMAGE_DESCRIPTION ||
        /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(alt)
      ) {
        invalid(
          `Use a single-line description of up to ${MAX_IMAGE_DESCRIPTION} characters.`,
          "alt",
        );
        return;
      }
      onApply({ ...imagePanel, title: trimmed || null, alt: alt || null });
      return;
    }
    if (kind === "html") {
      if (htmlDraft.html.length > 65_536 || shownHtml.length > MAX_PANEL_HTML) {
        invalid(
          `Keep the HTML under ${MAX_PANEL_HTML.toLocaleString()} characters after removed parts.`,
          "html",
        );
        return;
      }
      onApply({ ...htmlDraft, title: trimmed || null, link });
      return;
    }
    if (!selected) {
      invalid("Select an available shared preset.", "preset");
      return;
    }
    if (kind === "table") {
      if (rowsValue === undefined || rowsValue > MAX_ROWS) {
        invalid(`Show from 1 to ${MAX_ROWS} alerts.`, "rows");
        return;
      }
      onApply({ ...tableDraft, title: trimmed || null, rows: rowsValue });
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
      if (!isThresholdColor(threshold.color)) {
        invalid("Select an available threshold color.", `color-${index + 1}`);
        return;
      }
      previous = bound;
    }
    onApply({ ...draft, title: trimmed || null, thresholds, link });
  }

  const titleField = (
    <label className="f">
      <span className="lbl">Title (optional)</span>
      <input
        name="title"
        className="inp"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-describedby={`${id}-title-help`}
      />
      <span className="help" id={`${id}-title-help`}>
        {kind === "html"
          ? "Shown above the content. Leave blank for a panel without a header."
          : kind === "image"
            ? "Shown above the image. Leave blank to let the image fill the whole panel."
            : "Leave blank to use the preset name. Up to 120 characters."}
      </span>
    </label>
  );

  const presetField = (
    <div
      className="f dashboard-panel-preset"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOpen(false);
        setSearch(null);
      }}
    >
      <label className="lbl" htmlFor={`${id}-preset`}>
        Preset
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
                  (event.key === "ArrowDown" ? 1 : presets.rows.length - 1)) %
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
        <div id={`${id}-popup`} className="dashboard-panel-popup" style={place}>
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
              <p className="help dashboard-panel-empty">No presets match.</p>
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
  );

  const countSettings = (
    <>
      {titleField}
      {presetField}
      <fieldset className="dashboard-panel-thresholds">
        <legend className="lbl">Count thresholds</legend>
        <p className="help">
          Up to three increasing bounds. Counts below the first remain neutral.
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
            <div className="f">
              <span className="lbl" aria-hidden="true">
                Color {index + 1}
              </span>
              <ThresholdColorPicker
                name={`color-${index + 1}`}
                label={`Color ${index + 1}`}
                value={threshold.color}
                onChange={(color) =>
                  update({
                    thresholds: thresholds.map((item, position) =>
                      position === index ? { ...item, color } : item,
                    ),
                  })
                }
              />
            </div>
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
              thresholds: [...thresholds, { lower_bound: next, color: "blue" }],
            });
          }}
        >
          Add threshold
        </button>
      </fieldset>
    </>
  );

  // The live count wins; until it arrives, an unchanged saved panel keeps its last count.
  const live =
    previewCount?.preset === draft.preset_id ? previewCount : undefined;
  const counted =
    live?.value ??
    ((panel.type ?? "count") === "count" &&
    draft.preset_id === (panel as CountPanel).preset_id
      ? latestCount
      : undefined);
  const countPreview = (
    <Preview panel={draft}>
      <CountTile
        scope={scope}
        panel={{ ...draft, thresholds, link: shownLink }}
        title={title.trim() || selectedName || "Select a preset"}
        presetName={selected ? display(selected.name) : undefined}
        value={counted}
        placeholder={
          counted !== undefined
            ? undefined
            : !selected
              ? "Choose a preset to see its count"
              : live?.failed
                ? "Count unavailable"
                : "Counting…"
        }
        layoutStyle={previewSize(draft)}
      />
    </Preview>
  );

  const columns =
    selected && Array.isArray(selected.columns)
      ? (selected.columns as unknown[]).map(String)
      : undefined;
  const tableSettings = (
    <>
      {titleField}
      {presetField}
      <div className="f">
        <label className="lbl" htmlFor={`${id}-rows`}>
          Alerts to show
        </label>
        <input
          id={`${id}-rows`}
          name="rows"
          className="inp dashboard-panel-rows"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ROWS}
          step={1}
          required
          value={rowsText}
          aria-describedby={`${id}-rows-help`}
          onChange={(event) => {
            setRowsText(event.target.value);
            setError("");
          }}
        />
        <span className="help" id={`${id}-rows-help`}>
          From 1 to {MAX_ROWS}. Newest first by last received; rows that
          don&apos;t fit the panel scroll inside it.
        </span>
      </div>
      <div className="f">
        <span className="lbl">Columns</span>
        {columns ? (
          <ul className="dashboard-panel-columns" aria-label="Preset columns">
            {currentAlertColumns(columns).map((field) => (
              <li key={field}>
                {field === "message" ? "Alert" : fieldLabel(field)}
              </li>
            ))}
          </ul>
        ) : (
          <span className="help">Choose a preset to see its columns.</span>
        )}
        <span className="help">
          Taken from the preset. Columns that don&apos;t fit the panel&apos;s
          width are hidden from the right; Alert always stays.
        </span>
      </div>
    </>
  );

  const tablePreview = (
    <Preview panel={tableDraft}>
      {selected ? (
        <TableTile
          scope={scope}
          panel={tableDraft}
          title={title.trim() || display(selected.name)}
          layoutStyle={previewSize(tableDraft)}
        />
      ) : (
        <article
          className="pn pn-table"
          aria-label="Alert table preview"
          style={previewSize(tableDraft)}
        >
          <span className="pn-head">
            <span className="pn-title">Select a preset</span>
            <span style={{ flexGrow: 1 }} />
            <PanelLinkButton link={shownLink} />
          </span>
          <p className="small muted pnt-state">
            Choose a preset to see its latest alerts
          </p>
        </article>
      )}
    </Preview>
  );

  const htmlSettings = (
    <>
      {titleField}
      <div className="f">
        <label className="lbl" htmlFor={`${id}-html`}>
          HTML
        </label>
        <div className="dashboard-panel-code">
          <div
            className="dashboard-panel-gutter"
            ref={gutter}
            aria-hidden="true"
          >
            {Array.from({ length: lines }, (_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
          <textarea
            id={`${id}-html`}
            name="html"
            spellCheck={false}
            wrap="off"
            value={htmlDraft.html}
            aria-describedby={`${id}-html-help`}
            onChange={(event) => updateHtml({ html: event.target.value })}
            onScroll={(event) => {
              if (gutter.current)
                gutter.current.scrollTop = event.currentTarget.scrollTop;
            }}
          />
        </div>
        <div className="dashboard-panel-code-help">
          <p className="help" id={`${id}-html-help`}>
            Text, headings, lists, tables, links and inline styles render.
            Scripts, images, iframes, forms and event handlers are removed.
          </p>
          <span className="help">
            {shownHtml.length.toLocaleString()} /{" "}
            {MAX_PANEL_HTML.toLocaleString()}
          </span>
        </div>
      </div>
      {removed.length > 0 && (
        <div className="banner bn-warn" role="status">
          These parts won&apos;t be saved:{" "}
          {removed
            .map((item) => `${item.what} on line ${item.line}`)
            .join(", ")}
          . The preview shows what everyone will see.
        </div>
      )}
    </>
  );

  const htmlPreview = (
    <Preview panel={htmlDraft}>
      <article
        className="pn pn-html"
        aria-label={`${title.trim() || "HTML panel"} preview`}
        style={previewSize(htmlDraft)}
      >
        {(title.trim() || shownLink) && (
          <span className="pn-head">
            {title.trim() && <span className="pn-title">{title.trim()}</span>}
            <span style={{ flexGrow: 1 }} />
            <PanelLinkButton link={shownLink} />
          </span>
        )}
        <div
          className="pn-html-body"
          dangerouslySetInnerHTML={{ __html: shownHtml }}
        />
      </article>
    </Preview>
  );

  const linkError =
    addressTouched && source === "link" ? addressProblem(address) : "";
  const fitChoices: {
    value: "contain" | "cover";
    name: string;
    help: string;
  }[] = [
    {
      value: "contain",
      name: "Show whole image",
      help: "Empty space may show around it.",
    },
    { value: "cover", name: "Fill the panel", help: "Edges may be cropped." },
  ];
  const imageSettings = (
    <>
      {titleField}
      <fieldset className="dashboard-panel-source">
        <legend className="lbl">Image source</legend>
        <div className="dashboard-panel-segments">
          {(
            [
              ["upload", "Upload a file"],
              ["link", "Link to an image"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} data-on={source === value || undefined}>
              <input
                type="radio"
                name="image-source"
                value={value}
                checked={source === value}
                onChange={() => {
                  setSource(value);
                  setError("");
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {source === "upload" ? (
        <div className="f">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept={IMAGE_TYPES.join(",")}
            onChange={(event) => {
              void chooseFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {upload.id || upload.uploading ? (
            <div className="dashboard-panel-file">
              <span className="dashboard-panel-file-text">
                <b>{upload.name ?? "Uploaded image"}</b>
                <span className="help" role="status">
                  {upload.uploading
                    ? "Uploading…"
                    : [
                        upload.size !== undefined
                          ? fileSize(upload.size)
                          : undefined,
                        upload.width && upload.height
                          ? `${upload.width} × ${upload.height} px`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Stored with the dashboard"}
                </span>
              </span>
              <button
                type="button"
                name="image-file"
                className="btn btn-sm"
                onClick={() => fileInput.current?.click()}
              >
                Replace
              </button>
              <button type="button" className="btn btn-sm" onClick={removeFile}>
                Remove
              </button>
            </div>
          ) : (
            <div
              className="dashboard-panel-drop"
              data-dragging={dragging || undefined}
              data-problem={upload.problem ? true : undefined}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void chooseFile(event.dataTransfer.files?.[0]);
              }}
            >
              {upload.problem ? (
                <span role="alert">{upload.problem}</span>
              ) : (
                <span>Drag an image here, or</span>
              )}
              <button
                type="button"
                id={`${id}-choose-file`}
                name="image-file"
                className="btn btn-sm"
                onClick={() => fileInput.current?.click()}
              >
                {upload.problem ? "Choose another file" : "Choose file"}
              </button>
            </div>
          )}
          <span className="help">
            PNG, JPEG, GIF or WebP, up to 5 MB. The file is stored with the
            dashboard, so everyone who can open the dashboard can see it.
          </span>
        </div>
      ) : (
        <div className="f">
          <label className="lbl" htmlFor={`${id}-url`}>
            Image address
          </label>
          <input
            id={`${id}-url`}
            name="url"
            type="url"
            inputMode="url"
            className="inp"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://"
            value={address}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={`${id}-url-help${linkError ? ` ${id}-url-error` : ""}`}
            onChange={(event) => {
              setAddress(event.target.value);
              setError("");
            }}
            onBlur={() => setAddressTouched(true)}
          />
          {linkError && (
            <span className="dashboard-panel-error" id={`${id}-url-error`}>
              {linkError}
            </span>
          )}
          <span className="help" id={`${id}-url-help`}>
            The image loads from this address each time the dashboard opens, so
            it changes when the source changes. Everyone who opens the dashboard
            needs access to it.
          </span>
          {!linkError && address.trim() && linkStatus === "failed" && (
            <div className="banner bn-warn" role="status">
              No image loaded from this address. Check that the link points to
              an image you can open, or upload the file instead. You can still
              create the panel.
            </div>
          )}
        </div>
      )}
      <label className="f">
        <span className="lbl">Image description</span>
        <input
          name="alt"
          className="inp"
          value={imageDraft.alt ?? ""}
          maxLength={MAX_IMAGE_DESCRIPTION}
          onChange={(event) => updateImage({ alt: event.target.value })}
          aria-describedby={`${id}-alt-help`}
        />
        <span className="help" id={`${id}-alt-help`}>
          Read aloud by screen readers. Describe what the image shows.
        </span>
      </label>
      <fieldset className="dashboard-panel-fit">
        <legend className="lbl">Fit</legend>
        <div className="dashboard-panel-fits">
          {fitChoices.map((choice) => (
            <label
              key={choice.value}
              data-on={
                (imageDraft.fit ?? "contain") === choice.value || undefined
              }
            >
              <input
                type="radio"
                name="fit"
                value={choice.value}
                checked={(imageDraft.fit ?? "contain") === choice.value}
                onChange={() => updateImage({ fit: choice.value })}
              />
              <span
                className={`dashboard-panel-fit-pic dashboard-panel-fit-${choice.value}`}
                aria-hidden="true"
              >
                <span />
              </span>
              <span className="dashboard-panel-type-text">
                <b>{choice.name}</b>
                <span className="help">{choice.help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
  const imagePreview = (
    <Preview panel={imagePanel}>
      <ImageTile
        tenantId={scope.tenant.id}
        panel={imagePanel}
        src={source === "upload" ? upload.preview : undefined}
        emptyText={
          source === "upload"
            ? upload.uploading
              ? undefined
              : "Upload an image to see it here."
            : linkError
              ? "Only https addresses are shown."
              : "Paste an image address to see it here."
        }
        onStatus={source === "link" ? setLinkStatus : undefined}
        layoutStyle={previewSize(imagePanel)}
      />
    </Preview>
  );
  const shownLinkProblem = linkTouched ? linkProblem(linkAddress) : "";
  const linkSection = (
    <fieldset className="dashboard-panel-link">
      <legend className="lbl">Panel link</legend>
      <p className="help">
        Adds a button to the panel that opens this address in a new tab.
      </p>
      <div className="dashboard-panel-link-fields">
        <div className="f">
          <label className="lbl" htmlFor={`${id}-link-url`}>
            Link (optional)
          </label>
          <input
            id={`${id}-link-url`}
            name="link-url"
            type="url"
            inputMode="url"
            className="inp"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://"
            value={linkAddress}
            aria-invalid={shownLinkProblem ? true : undefined}
            aria-describedby={`${id}-link-url-help${shownLinkProblem ? ` ${id}-link-url-error` : ""}`}
            onChange={(event) => {
              setLinkAddress(event.target.value);
              setError("");
            }}
            onBlur={() => setLinkTouched(true)}
          />
          {shownLinkProblem && (
            <span className="dashboard-panel-error" id={`${id}-link-url-error`}>
              {shownLinkProblem}
            </span>
          )}
          <span className="help" id={`${id}-link-url-help`}>
            Starts with https:// or http://. Leave blank for no button.
          </span>
        </div>
        <label className="f">
          <span className="lbl">Button text (optional)</span>
          <input
            name="link-label"
            className="inp"
            placeholder={DEFAULT_LINK_LABEL}
            value={linkText}
            disabled={!linkAddress.trim()}
            onChange={(event) => {
              setLinkText(event.target.value);
              setError("");
            }}
            aria-describedby={`${id}-link-label-help`}
          />
          <span className="help" id={`${id}-link-label-help`}>
            Up to {MAX_LINK_LABEL} characters. Blank shows “{DEFAULT_LINK_LABEL}
            ”.
          </span>
        </label>
      </div>
      {(linkAddress || linkText) && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setLinkAddress("");
            setLinkText("");
            setLinkTouched(false);
            setError("");
            document.getElementById(`${id}-link-url`)?.focus();
          }}
        >
          Remove link
        </button>
      )}
    </fieldset>
  );
  const blocked =
    ((kind === "count" || kind === "table") && !selected) ||
    (kind === "image" && (source === "upload" ? !upload.id : !address.trim()));

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
      <form
        ref={form}
        className="dashboard-panel-form"
        onSubmit={apply}
        noValidate
      >
        <div className="dashboard-panel-top">
          <div className="dashboard-panel-head">
            <h2 id={`${id}-heading`}>
              {creating ? "Create panel" : "Edit panel"}
            </h2>
            <button
              type="button"
              className="btn btn-g btn-sm dashboard-panel-close"
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
          <TypeField
            id={id}
            value={kind}
            locked={!creating}
            onChange={switchKind}
          />
        </div>
        <div className="dashboard-panel-body">
          <div className="dashboard-panel-column">
            {kind === "html"
              ? htmlSettings
              : kind === "image"
                ? imageSettings
                : kind === "table"
                  ? tableSettings
                  : countSettings}
            {linkSection}
            {(error || placementError) && (
              <div role="alert" className="notice error">
                {error || placementError}
              </div>
            )}
          </div>
          <div className="dashboard-panel-column">
            {kind === "html"
              ? htmlPreview
              : kind === "image"
                ? imagePreview
                : kind === "table"
                  ? tablePreview
                  : countPreview}
          </div>
        </div>
        <div className="dashboard-panel-foot">
          <p className="help" id={`${id}-save-help`}>
            Panel changes stay in your draft until you save the dashboard.
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" disabled={blocked}>
            {creating ? "Create panel" : "Apply changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
