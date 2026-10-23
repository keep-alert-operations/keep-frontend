"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  layoutOrder,
  PANEL_HEIGHTS,
  PANEL_WIDTHS,
  placePanel,
  type GridPanel,
} from "@/lib/dashboard-layout";

type Action = "move" | "resize";
type Gesture<T> = {
  id: string;
  action: Action;
  pointerId: number;
  startX: number;
  startY: number;
  scrollTop: number;
  column: number;
  left: number;
  top: number;
  width: number;
  height: number;
  panels: T[];
  preview: T[];
  changed: boolean;
  started: boolean;
  style: CSSProperties;
  handle: HTMLButtonElement;
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
function nearest(value: number, allowed: readonly number[]) {
  return allowed.reduce((best, item) =>
    Math.abs(item - value) < Math.abs(best - value) ? item : best,
  );
}

/** Follow the pointer in pixels; only the drop destination uses grid coordinates. */
export function DashboardLayout<T extends GridPanel>({
  panels,
  disabled,
  label,
  onChange,
  onSelect,
  renderPanel,
}: {
  panels: T[];
  disabled: boolean;
  label: (panel: T) => string;
  onChange: (panels: T[]) => void;
  onSelect: (id: string) => void;
  renderPanel: (
    panel: T,
    controls: ReactNode,
    active: boolean,
    style?: CSSProperties,
  ) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture<T> | null>(null);
  const [preview, setPreview] = useState<T[] | null>(null);
  const [visual, setVisual] = useState<{
    id: string;
    style: CSSProperties;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const painted = useRef<T[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const helpId = useId();
  function capturePositions() {
    before.current = new Map(
      Array.from(
        grid.current?.querySelectorAll<HTMLElement>("[data-layout-panel]") ??
          [],
      ).map((element) => [
        element.dataset.layoutPanel!,
        element.getBoundingClientRect(),
      ]),
    );
  }
  // Start at the visible rectangle even when a prior settling animation is running.
  useLayoutEffect(() => {
    const positions = before.current;
    before.current = null;
    if (
      !positions ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    for (const element of grid.current?.querySelectorAll<HTMLElement>(
      "[data-layout-panel]",
    ) ?? []) {
      if (visual?.id === element.dataset.layoutPanel) continue;
      const previous = positions.get(element.dataset.layoutPanel!);
      if (!previous) continue;
      animations.current.get(element)?.cancel();
      const next = element.getBoundingClientRect();
      if (
        !next.width ||
        !next.height ||
        Math.abs(previous.x - next.x) +
          Math.abs(previous.y - next.y) +
          Math.abs(previous.width - next.width) +
          Math.abs(previous.height - next.height) <
          0.5
      )
        continue;
      const animation = element.animate(
        [
          {
            transform: `translate3d(${previous.x - next.x}px, ${previous.y - next.y}px, 0) scale(${previous.width / next.width}, ${previous.height / next.height})`,
          },
          { transform: "none" },
        ],
        { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
      animations.current.set(element, animation);
      animation.onfinish = () => {
        if (animations.current.get(element) === animation)
          animations.current.delete(element);
      };
    }
  });
  function paint() {
    frame.current = null;
    const current = gesture.current;
    if (!current?.started) return;
    if (
      !painted.current ||
      current.preview.some((panel) => {
        const old = painted.current!.find((item) => item.id === panel.id);
        return (
          !old ||
          old.x !== panel.x ||
          old.y !== panel.y ||
          old.w !== panel.w ||
          old.h !== panel.h
        );
      })
    )
      capturePositions();
    painted.current = current.preview;
    setPreview(current.preview);
    setVisual({ id: current.id, style: current.style });
  }
  function finish(commit: boolean) {
    const current = gesture.current;
    if (!current) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (current.started) capturePositions();
    else {
      const element = current.handle.closest<HTMLElement>(
        "[data-layout-panel]",
      );
      if (element) animations.current.get(element)?.play();
    }
    gesture.current = null;
    painted.current = null;
    setPreview(null);
    setVisual(null);
    if (current.handle.hasPointerCapture(current.pointerId))
      current.handle.releasePointerCapture(current.pointerId);
    if (commit && current.changed) {
      onChange(current.preview);
      announce(current.preview.find((panel) => panel.id === current.id)!);
      requestAnimationFrame(
        () => current.handle.isConnected && current.handle.focus(),
      );
    } else if (!commit) setAnnouncement("Layout change cancelled.");
  }
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        finish(false);
      }
    };
    document.addEventListener("keydown", cancel);
    return () => {
      document.removeEventListener("keydown", cancel);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      animations.current.forEach((animation) => animation.cancel());
      gesture.current = null;
    };
  }, []);
  useEffect(() => {
    if (gesture.current && gesture.current.panels !== panels) finish(false);
  }, [panels]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const cancel = () => {
      if (!media.matches) finish(false);
    };
    media.addEventListener("change", cancel);
    if (disabled) finish(false);
    return () => media.removeEventListener("change", cancel);
  }, [disabled]);
  function announce(panel: T) {
    setAnnouncement(
      `${label(panel)}: column ${panel.x + 1}, row ${panel.y + 1}, ${panel.w} columns wide and ${panel.h} units high. Save changes to keep this layout.`,
    );
  }
  function start(
    event: PointerEvent<HTMLButtonElement>,
    panel: T,
    action: Action,
  ) {
    if (
      disabled ||
      event.button !== 0 ||
      gesture.current ||
      !grid.current ||
      !window.matchMedia("(min-width: 1024px)").matches
    )
      return;
    event.preventDefault();
    event.currentTarget.focus();
    onSelect(panel.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const element = event.currentTarget.closest<HTMLElement>(
      "[data-layout-panel]",
    )!;
    const bounds = element.getBoundingClientRect();
    const gridBounds = grid.current.getBoundingClientRect();
    // Picking up a settling panel retains its visible position under the pointer.
    animations.current.get(element)?.pause();
    gesture.current = {
      id: panel.id,
      action,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollTop: grid.current.parentElement!.scrollTop,
      column: (gridBounds.width + 12) / 12,
      left: bounds.left - gridBounds.left,
      top: bounds.top - gridBounds.top,
      width: bounds.width,
      height: bounds.height,
      panels,
      preview: panels,
      changed: false,
      started: false,
      style: {},
      handle: event.currentTarget,
    };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId || !grid.current)
      return;
    const panel = current.panels.find((item) => item.id === current.id)!;
    const dx = event.clientX - current.startX;
    const dy =
      event.clientY -
      current.startY +
      grid.current.parentElement!.scrollTop -
      current.scrollTop;
    if (
      !current.started &&
      Math.abs(event.clientX - current.startX) +
        Math.abs(event.clientY - current.startY) <
        4
    )
      return;
    current.started = true;
    const active = grid.current.querySelector<HTMLElement>(
      `[data-layout-panel="${current.id}"]`,
    );
    if (active) {
      animations.current.get(active)?.cancel();
      animations.current.delete(active);
    }
    const left = clamp(current.left + dx, 0, (12 - panel.w) * current.column);
    const top = clamp(current.top + dy, 0, (100 - panel.h) * 60);
    const width = clamp(
      current.width + dx,
      PANEL_WIDTHS[0] * current.column - 12,
      PANEL_WIDTHS.filter((w) => panel.x + w <= 12).at(-1)! * current.column -
        12,
    );
    const height = clamp(
      current.height + dy,
      PANEL_HEIGHTS[0] * 60 - 12,
      PANEL_HEIGHTS.at(-1)! * 60 - 12,
    );
    const patch =
      current.action === "move"
        ? {
            x: Math.round(left / current.column),
            y: Math.round(top / 60),
          }
        : {
            w: nearest(
              (width + 12) / current.column,
              PANEL_WIDTHS.filter((w) => panel.x + w <= 12),
            ),
            h: nearest((height + 12) / 60, PANEL_HEIGHTS),
          };
    const next = placePanel(current.panels, panel.id, patch);
    if (!next) {
      setAnnouncement(
        "There is no room for that layout. Move the panel higher or make it smaller.",
      );
      return;
    }
    current.preview = next;
    current.changed = next.some((item) => {
      const original = current.panels.find((other) => other.id === item.id)!;
      return (
        item.x !== original.x ||
        item.y !== original.y ||
        item.w !== original.w ||
        item.h !== original.h
      );
    });
    const target = next.find((item) => item.id === panel.id)!;
    current.style = {
      transform: `translate3d(${(current.action === "move" ? left : current.left) - target.x * current.column}px, ${(current.action === "move" ? top : current.top) - target.y * 60}px, 0)`,
      width: current.action === "resize" ? width : current.width,
      height: current.action === "resize" ? height : current.height,
    };
    if (frame.current === null) frame.current = requestAnimationFrame(paint);
  }
  function key(
    event: KeyboardEvent<HTMLButtonElement>,
    panel: T,
    action: Action,
  ) {
    if (
      disabled ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    if (gesture.current) return;
    const dx =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const widths = PANEL_WIDTHS.filter((w) => panel.x + w <= 12);
    const patch =
      action === "move"
        ? {
            x: clamp(panel.x + dx, 0, 12 - panel.w),
            y: clamp(panel.y + dy, 0, 100 - panel.h),
          }
        : {
            w: widths[
              clamp(
                widths.indexOf(panel.w as (typeof widths)[number]) + dx,
                0,
                widths.length - 1,
              )
            ],
            h: PANEL_HEIGHTS[
              clamp(
                PANEL_HEIGHTS.indexOf(
                  panel.h as (typeof PANEL_HEIGHTS)[number],
                ) + dy,
                0,
                PANEL_HEIGHTS.length - 1,
              )
            ],
          };
    const next = placePanel(panels, panel.id, patch);
    if (next) {
      const handle = event.currentTarget;
      capturePositions();
      onSelect(panel.id);
      onChange(next);
      announce(next.find((item) => item.id === panel.id)!);
      requestAnimationFrame(() => handle.isConnected && handle.focus());
    } else
      setAnnouncement(
        "There is no room for that layout. Move the panel higher or make it smaller.",
      );
  }
  function handle(panel: T, action: Action) {
    return (
      <button
        type="button"
        className={`de-${action}-handle`}
        aria-label={`${action === "move" ? "Move" : "Resize"} ${label(panel)}`}
        aria-describedby={helpId}
        disabled={disabled}
        onPointerDown={(event) => start(event, panel, action)}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (gesture.current?.pointerId !== event.pointerId) return;
          move(event);
          finish(true);
        }}
        onPointerCancel={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        }}
        onLostPointerCapture={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        }}
        onKeyDown={(event) => key(event, panel, action)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          {action === "move" ? (
            <path
              d="M8 5h1m6 0h1M8 12h1m6 0h1M8 19h1m6 0h1"
              strokeLinecap="round"
            />
          ) : (
            <path d="M8 20 20 8M14 20l6-6" strokeLinecap="round" />
          )}
        </svg>
      </button>
    );
  }
  return (
    <>
      <p className="sr-only" id={helpId}>
        Drag the grip to move a panel; drag its lower-right corner to resize.
        Arrow keys also work on either handle. Width and Height controls are
        available in each panel’s options under Edit panel. Save to keep the
        layout.
      </p>
      <div className="pg de-grid" ref={grid}>
        {preview &&
          visual &&
          (() => {
            const target = preview.find((panel) => panel.id === visual.id)!;
            return (
              <div
                className="de-drop-placeholder"
                aria-hidden="true"
                style={{
                  gridColumn: `${target.x + 1} / span ${target.w}`,
                  gridRow: `${target.y + 1} / span ${target.h}`,
                }}
              />
            );
          })()}
        {[...panels].sort(layoutOrder).map((original) => {
          // Keep DOM order fixed during pointer capture; moving the ancestor
          // can make the browser release capture before the gesture finishes.
          const panel =
            preview?.find((item) => item.id === original.id) ?? original;
          return renderPanel(
            panel,
            <>
              {handle(panel, "move")}
              {handle(panel, "resize")}
            </>,
            preview !== null && gesture.current?.id === panel.id,
            visual?.id === panel.id ? visual.style : undefined,
          );
        })}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
