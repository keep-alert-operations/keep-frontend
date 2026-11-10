/**
 * Grafana panels (REV-68): one live Grafana panel framed on a dashboard. The
 * allowed Grafana addresses are deployment configuration; the API checks new and
 * changed addresses on save, and the browser runs the same checks, in the same
 * order, on input and before every frame is created.
 * Requirements: REV-68; dashboard operations 2, 3, 14, 16.
 */
import { tenantPath } from "./api";
import type { components } from "./generated";

type Schemas = components["schemas"];
/** One allowed Grafana: its origin and the base path it is served under ("" for none). */
export type GrafanaOrigin = Schemas["GrafanaOrigin"];
/** What any tenant reader learns about Grafana panels. */
export type GrafanaPanelStatus = Schemas["GrafanaPanelStatus"];
/** What a global super admin sees: also the configured entries Keep ignored. */
export type GrafanaPanelIntegration = Schemas["GrafanaPanelIntegration"];

export const MAX_GRAFANA_ADDRESS = 2048;
export const grafanaStatusPath = (tenantId: string) =>
  `${tenantPath(tenantId)}/grafana-panels/status`;
export const grafanaIntegrationPath = "/api/admin/integrations/grafana-panels";

export const GRAFANA_TURNED_OFF = "Grafana panels are turned off.";
/** Why Grafana panel can't be chosen while no Grafana is allowed. */
export const GRAFANA_NOT_AVAILABLE =
  "Not available. An admin allows Grafana addresses in deployment configuration.";
export const OPEN_IN_GRAFANA = "Open in Grafana";
/** An allowed Grafana as people read it: host and base path, without the scheme. */
export function originLabel(entry: GrafanaOrigin) {
  try {
    return `${new URL(entry.origin).host}${prefixOf(entry)}`;
  } catch {
    return `${entry.origin}${prefixOf(entry)}`;
  }
}

/** Keep's own address, as the checks need it; the page's location by default. */
export interface KeepLocation {
  origin: string;
  protocol: string;
}

export type GrafanaCheck =
  | { state: "empty" }
  /** The allowed Grafana addresses aren't known yet. */
  | { state: "pending"; snippet: boolean }
  | { state: "problem"; problem: string; snippet: boolean }
  | { state: "ok"; url: URL; origin: GrafanaOrigin; snippet: boolean };

/**
 * The address in pasted text: the text itself, or for Grafana's Share › Embed code
 * the first iframe's `src`. DOMParser builds an inert document, so the code runs
 * no scripts and loads no frames.
 */
export function extractAddress(raw: string): {
  source: string;
  snippet: boolean;
} {
  const text = raw.trim();
  if (!text.startsWith("<")) return { source: text, snippet: false };
  return { source: iframeSource(text), snippet: true };
}

/** The first iframe's `src` in some HTML, or "" when there is none. */
export function iframeSource(html: string) {
  if (typeof DOMParser !== "undefined") {
    const frame = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("iframe");
    return (frame?.getAttribute("src") ?? "").trim();
  }
  // Without a DOM (server rendering), read the first iframe's src attribute.
  const match = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
    html,
  );
  return (match?.[1] ?? match?.[2] ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

const prefixOf = (entry: GrafanaOrigin) =>
  entry.path_prefix.replace(/\/+$/, "");

/** The allowed Grafana an address falls under; the longest base path wins. */
function allowedEntry(url: URL, origins: GrafanaOrigin[]) {
  let found: GrafanaOrigin | undefined;
  for (const entry of origins) {
    const prefix = prefixOf(entry);
    if (
      entry.origin === url.origin &&
      (prefix === "" || url.pathname.startsWith(`${prefix}/`)) &&
      (!found || prefix.length > prefixOf(found).length)
    )
      found = entry;
  }
  return found;
}

/**
 * Checks pasted text in the design's order and returns the first failure. `status`
 * is the tenant's Grafana panel status; while it is unknown the checks that need
 * it are pending.
 */
export function checkGrafanaAddress(
  raw: string,
  status: GrafanaPanelStatus | undefined,
  keep: KeepLocation = window.location,
): GrafanaCheck {
  if (!raw.trim()) return { state: "empty" };
  const { source, snippet } = extractAddress(raw);
  const problem = (message: string): GrafanaCheck => ({
    state: "problem",
    problem: message,
    snippet,
  });
  if (snippet && !source)
    return problem(
      "No Grafana address found in that code. Copy it again from Share › Embed.",
    );
  if (!source) return { state: "empty" };
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return problem("This isn't a valid address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !/^https?:\/\//i.test(source)
  )
    return problem("The address must start with https://.");
  if (url.origin === keep.origin)
    return problem("Keep's own pages can't be shown in a Grafana panel.");
  if (!status) return { state: "pending", snippet };
  if (!status.enabled || !status.origins.length)
    return problem(GRAFANA_TURNED_OFF);
  if (url.username || url.password)
    return problem(
      "Remove the user name and password. The address is saved in the dashboard, where everyone could read it.",
    );
  if (
    url.protocol === "http:" &&
    keep.protocol === "https:" &&
    !loopback(url.hostname)
  )
    return problem(
      "Keep is served over https, so the panel address must be https too.",
    );
  const entry = allowedEntry(url, status.origins);
  if (!entry) return problem(`${url.host} isn't an allowed Grafana.`);
  if (!url.pathname.startsWith(`${prefixOf(entry)}/d-solo/`))
    return problem(
      "Use a single-panel address from Share › Embed. Whole dashboards can't be shown.",
    );
  if (url.href.length > MAX_GRAFANA_ADDRESS)
    return problem("The address is longer than 2,048 characters.");
  return { state: "ok", url, origin: entry, snippet };
}

const UNITS: Record<string, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  M: "month",
  y: "year",
};

/** What an address frames, for the dialog's "From this address" list. */
export function grafanaFacts(url: URL, origin: GrafanaOrigin) {
  const params = url.searchParams;
  const prefix = prefixOf(origin);
  // <prefix>/d-solo/<uid>/<slug>
  const [, , uid = "", slug = ""] = url.pathname
    .slice(prefix.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const from = params.get("from") || "now-6h",
    to = params.get("to") || "now";
  const relative = /^now-(\d+)([smhdwMy])$/.exec(from);
  const range =
    relative && to === "now"
      ? `Last ${relative[1]} ${UNITS[relative[2]]}${relative[1] === "1" ? "" : "s"}`
      : `${from} to ${to}`;
  const variables: string[] = [];
  params.forEach((value, key) => {
    if (key.startsWith("var-")) variables.push(`${key.slice(4)} = ${value}`);
  });
  return {
    grafana: `${url.host}${prefix}`,
    dashboard: slug ? `${slug} (${uid})` : uid,
    panel: `#${params.get("panelId") || "?"} · org ${params.get("orgId") || "1"}`,
    range,
    refresh: params.get("refresh")
      ? `Every ${params.get("refresh")}`
      : "Grafana's default",
    variables: variables.length ? variables.join(", ") : "None",
  };
}

/**
 * The full dashboard view of the same panel, with the same organization, time
 * range and variables: /d-solo/ becomes /d/ and panelId becomes viewPanel.
 */
export function openInGrafana(address: string) {
  const url = new URL(address);
  url.pathname = url.pathname.replace("/d-solo/", "/d/");
  const panel = url.searchParams.get("panelId");
  url.searchParams.delete("panelId");
  url.searchParams.delete("theme");
  if (panel) url.searchParams.set("viewPanel", panel);
  return url.href;
}

/** The frame's address: the checked one with Grafana's theme set to the viewer's Keep theme. */
export function framedSrc(address: string | URL, theme: "light" | "dark") {
  const url = new URL(address);
  url.searchParams.set("theme", theme);
  return url.href;
}

/** The Grafana-side settings, as plain text for Grafana admins. */
export function grafanaAdminSettings(keepOrigin: string) {
  return [
    "Settings Keep needs in Grafana (grafana.ini)",
    "",
    "1. Allow embedding, or panels stay blank.",
    "[security]",
    "allow_embedding = true",
    "",
    "2. Keep and Grafana on different sites? A framed panel gets the viewer's Grafana sign-in only with these. Otherwise use Grafana's anonymous access.",
    "[security]",
    "cookie_samesite = none",
    "cookie_secure = true",
    "",
    "3. Limit who can frame Grafana to Keep only.",
    "[security]",
    "content_security_policy = true",
    `content_security_policy_template = """… frame-ancestors ${keepOrigin}; …"""`,
    "",
    "4. Single sign-on pages usually refuse to be framed. Viewers sign in to Grafana in another tab first.",
  ].join("\n");
}
