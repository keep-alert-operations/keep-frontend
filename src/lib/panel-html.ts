import DOMPurify, { type DOMPurify as Purifier } from "dompurify";

/**
 * Browser sanitizing for HTML panels (REV-57). The server already stores only
 * sanitized HTML; this second pass uses the same allowlist as appchi-domain's
 * `appchi.configuration.html`, so keep the two in step.
 */
export const MAX_PANEL_HTML = 16_000;
const TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "span",
  "div",
  "hr",
];
const ATTRIBUTES: Record<string, string[]> = {
  "*": ["style"],
  a: ["href", "title"],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
};
const STYLES = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-align",
  "text-decoration",
  "border-radius",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
]);
const UNSAFE_VALUE = /url\(|expression|javascript:|\/\*|\*\/|[\\<>@{}]/i;

/** Keep only allowed style declarations, as the server does. */
export function panelStyle(value: string) {
  return value
    .split(";")
    .map((declaration) => {
      const at = declaration.indexOf(":");
      if (at < 0) return "";
      const name = declaration.slice(0, at).trim().toLowerCase();
      const rest = declaration.slice(at + 1).trim();
      return STYLES.has(name) && rest && !UNSAFE_VALUE.test(rest)
        ? `${name}: ${rest}`
        : "";
    })
    .filter(Boolean)
    .join("; ");
}

let purifier: Purifier | undefined;
function instance() {
  if (purifier || typeof window === "undefined") return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    const own = Object.hasOwn(ATTRIBUTES, tag) ? ATTRIBUTES[tag] : [];
    const allowed = [...ATTRIBUTES["*"], ...own];
    if (!allowed.includes(data.attrName)) {
      data.keepAttr = false;
      return;
    }
    if (data.attrName === "style") {
      data.attrValue = panelStyle(data.attrValue);
      if (!data.attrValue) data.keepAttr = false;
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return purifier;
}

/** Sanitized HTML for display; empty where no DOM is available. */
export function sanitizePanelHtml(html: string) {
  const current = instance();
  if (!current?.isSupported) return "";
  return current.sanitize(html, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: [...new Set(Object.values(ATTRIBUTES).flat())],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
