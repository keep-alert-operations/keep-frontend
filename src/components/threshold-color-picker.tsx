"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  THRESHOLD_HUES,
  THRESHOLD_PALETTE,
  hexToHsv,
  hsvToHex,
  isCustomColor,
  isPaletteColor,
  parseHex,
  resolvedHex,
  thresholdColorCss,
  thresholdColorLabel,
  type Hsv,
} from "@/lib/threshold-colors";
import "../app/styles/threshold-color-picker.css";

type Tab = "colors" | "custom";
const COLUMNS = THRESHOLD_HUES.length;
const WIDTH = 264;
/** Room the taller (Custom) tab needs before the picker opens upward instead. */
const HEIGHT = 340;

/**
 * A threshold color button and its picker (REV-64): palette swatches or a custom
 * color from a saturation/brightness area, hue slider and hex field. The picker
 * is a light-dismiss popover, so a click outside or Escape closes it.
 */
export function ThresholdColorPicker({
  name,
  label,
  value,
  onChange,
}: {
  /** Form name of the button, so validation can focus it. */
  name: string;
  /** Field label, such as "Color 1". */
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("colors");
  const [hsv, setHsv] = useState<Hsv>({ h: 0, s: 0, v: 0 });
  const [hex, setHex] = useState("");
  const [position, setPosition] = useState<CSSProperties>({});
  const named = isPaletteColor(value);
  const shown = thresholdColorLabel(value);
  const hexValid = parseHex(hex) !== undefined;
  const selectedIndex = THRESHOLD_PALETTE.findIndex(
    (color) => color.name === value,
  );

  // Place the popover under the button, or above it when the window lacks room.
  useEffect(() => {
    const element = popover.current;
    if (!element) return;
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open" || !button.current) return;
      const rect = button.current.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - WIDTH - 8),
      );
      setPosition(
        window.innerHeight - rect.bottom >= HEIGHT + 8 || rect.top < HEIGHT + 8
          ? { left, top: rect.bottom + 6 }
          : { left, bottom: window.innerHeight - rect.top + 6 },
      );
      const start = resolvedHex(value);
      setTab(isCustomColor(value) ? "custom" : "colors");
      setHsv(hexToHsv(start));
      setHex(start);
    };
    const toggled = (event: Event) => {
      const next = (event as ToggleEvent).newState === "open";
      setOpen(next);
      if (next) {
        const target = popover.current?.querySelector<HTMLElement>(
          '[data-picker-focus="true"]',
        );
        target?.focus();
      }
    };
    element.addEventListener("beforetoggle", before);
    element.addEventListener("toggle", toggled);
    return () => {
      element.removeEventListener("beforetoggle", before);
      element.removeEventListener("toggle", toggled);
    };
  }, [value]);

  // The popover is fixed in place, so scrolling the form underneath closes it.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (popover.current?.contains(event.target as Node)) return;
      popover.current?.hidePopover();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function custom(next: Hsv) {
    setHsv(next);
    const color = hsvToHex(next);
    setHex(color);
    onChange(color);
  }

  function showTab(next: Tab) {
    setTab(next);
    if (next === "custom") {
      const start = resolvedHex(value);
      setHsv(hexToHsv(start));
      setHex(start);
    }
  }

  function area(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    custom({
      h: hsv.h,
      s: clamp((event.clientX - rect.left) / rect.width),
      v: 1 - clamp((event.clientY - rect.top) / rect.height),
    });
  }

  function areaKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.01;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: clamp(hsv.s - step) },
      ArrowRight: { s: clamp(hsv.s + step) },
      ArrowUp: { v: clamp(hsv.v + step) },
      ArrowDown: { v: clamp(hsv.v - step) },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    custom({ ...hsv, ...move });
  }

  // Arrow keys move between swatches; only one swatch is in the Tab order.
  function swatchKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -COLUMNS,
      ArrowDown: COLUMNS,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = index + move;
    if (next >= 0 && next < THRESHOLD_PALETTE.length)
      swatches.current[next]?.focus();
  }

  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  return (
    <>
      <button
        ref={button}
        type="button"
        name={name}
        className="tcp-button"
        popoverTarget={`${id}-picker`}
        aria-haspopup="dialog"
        aria-label={`${label}: ${shown}`}
      >
        <span
          className="tcp-dot"
          style={{ background: thresholdColorCss(value) }}
          aria-hidden="true"
        />
        <span className={`tcp-name ${named ? "" : "tcp-hex"}`}>{shown}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        ref={popover}
        id={`${id}-picker`}
        popover="auto"
        role="dialog"
        aria-label={`${label} color`}
        className="tcp-popover"
        style={position}
      >
        <div className="tcp-tabs">
          <button
            type="button"
            aria-pressed={tab === "colors"}
            onClick={() => showTab("colors")}
          >
            Colors
          </button>
          <button
            type="button"
            aria-pressed={tab === "custom"}
            onClick={() => showTab("custom")}
          >
            Custom
          </button>
        </div>
        {tab === "colors" ? (
          <>
            <div className="tcp-swatches" aria-label="Palette" role="group">
              {THRESHOLD_PALETTE.map((color, index) => (
                <button
                  key={color.name}
                  ref={(element) => {
                    swatches.current[index] = element;
                  }}
                  type="button"
                  className={`tcp-swatch ${color.shade === 2 ? "tcp-main" : ""}`}
                  style={{ background: `var(--tc-${color.name})` }}
                  title={color.label}
                  aria-label={color.label}
                  aria-pressed={color.name === value}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-picker-focus={index === focusIndex ? "true" : undefined}
                  onKeyDown={(event) => swatchKey(event, index)}
                  onClick={() => onChange(color.name)}
                />
              ))}
            </div>
            <p className="help">
              Selected: <b>{shown}</b>. Palette colors adjust for dark mode.
            </p>
          </>
        ) : (
          <>
            <div
              className="tcp-area"
              role="slider"
              tabIndex={0}
              aria-label="Saturation and brightness"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv.s * 100)}
              aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
              data-picker-focus="true"
              style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
              onKeyDown={areaKey}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                area(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  area(event);
              }}
            >
              <span
                className="tcp-area-dot"
                aria-hidden="true"
                style={{
                  left: `${hsv.s * 100}%`,
                  top: `${(1 - hsv.v) * 100}%`,
                  background: hsvToHex(hsv),
                }}
              />
            </div>
            <input
              type="range"
              className="tcp-hue"
              min={0}
              max={359}
              aria-label="Hue"
              value={hsv.h}
              onChange={(event) =>
                custom({ ...hsv, h: Number(event.target.value) })
              }
            />
            <div className="tcp-hex-row">
              <span
                className="tcp-big-dot"
                style={{ background: hexValid ? parseHex(hex) : value }}
                aria-hidden="true"
              />
              <label className="f">
                <span className="lbl">Hex</span>
                <input
                  className="inp"
                  value={hex}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!hexValid}
                  aria-describedby={hexValid ? undefined : `${id}-hex-error`}
                  onChange={(event) => {
                    setHex(event.target.value);
                    const parsed = parseHex(event.target.value);
                    if (parsed) {
                      setHsv(hexToHsv(parsed));
                      onChange(parsed);
                    }
                  }}
                />
              </label>
            </div>
            {!hexValid && (
              <p className="help tcp-error" id={`${id}-hex-error`}>
                Enter six hex digits, like #E0569B.
              </p>
            )}
            <p className="help">
              Custom colors stay the same in light and dark mode.
            </p>
          </>
        )}
      </div>
    </>
  );
}
