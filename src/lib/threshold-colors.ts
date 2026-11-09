/**
 * Count panel threshold colors (REV-64): a palette name or a custom `#RRGGBB`.
 * Palette names resolve to `--tc-<name>` in theme.css, so they follow the light or
 * dark theme; custom colors render exactly as stored.
 */
export const THRESHOLD_HUES = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "purple",
  "gray",
] as const;
/** Shade prefixes from lightest to darkest; the middle shade is the hue alone. */
export const THRESHOLD_SHADES = [
  "lightest-",
  "light-",
  "",
  "dark-",
  "darkest-",
] as const;
const SHADE_WORDS = ["Lightest ", "Light ", "", "Dark ", "Darkest "];

export interface PaletteColor {
  name: string;
  label: string;
  /** Shade index, 0 (lightest) to 4 (darkest). */
  shade: number;
}

/** The palette in display order: one row per shade, one column per hue. */
export const THRESHOLD_PALETTE: PaletteColor[] = THRESHOLD_SHADES.flatMap(
  (prefix, shade) =>
    THRESHOLD_HUES.map((hue) => {
      const label = SHADE_WORDS[shade] + hue;
      return {
        name: prefix + hue,
        label: label[0].toUpperCase() + label.slice(1),
        shade,
      };
    }),
);
const byName = new Map(THRESHOLD_PALETTE.map((color) => [color.name, color]));

const HEX = /^#[0-9A-F]{6}$/;
/** Six hex digits, with or without `#`, in either case. */
const HEX_INPUT = /^#?[0-9a-fA-F]{6}$/;

export const isPaletteColor = (value: string) => byName.has(value);
export const isCustomColor = (value: string) => HEX.test(value);
export const isThresholdColor = (value: string) =>
  isPaletteColor(value) || isCustomColor(value);

/** Canonical stored form of typed hex input, or undefined when it is not six digits. */
export function parseHex(input: string) {
  const value = input.trim();
  return HEX_INPUT.test(value)
    ? `#${value.replace("#", "").toUpperCase()}`
    : undefined;
}

/** "Dark teal" for a palette name, the hex value for a custom color. */
export function thresholdColorLabel(value: string) {
  return byName.get(value)?.label ?? value;
}

/** The CSS color a threshold paints; unknown values stay neutral. */
export function thresholdColorCss(value: string | undefined) {
  if (value && isPaletteColor(value)) return `var(--tc-${value})`;
  if (value && isCustomColor(value)) return value;
  return "var(--border)";
}

/** The hex a color shows in the current theme, for the custom editor's start point. */
export function resolvedHex(value: string) {
  if (isCustomColor(value)) return value;
  if (isPaletteColor(value) && typeof document !== "undefined") {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(`--tc-${value}`)
      .trim();
    const parsed = parseHex(resolved);
    if (parsed) return parsed;
  }
  return "#0A6FB0";
}

export interface Hsv {
  /** Hue, 0–359 degrees. */
  h: number;
  /** Saturation, 0–1. */
  s: number;
  /** Brightness, 0–1. */
  v: number;
}

export function hsvToHex({ h, s, v }: Hsv) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

export function hexToHsv(hex: string): Hsv {
  const digits = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(
    (start) => parseInt(digits.slice(start, start + 2), 16) / 255,
  );
  const max = Math.max(r, g, b),
    delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h: h % 360, s: max ? delta / max : 0, v: max };
}
