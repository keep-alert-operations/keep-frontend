/**
 * Real user monitoring (REV-74, observability 9): what users experience, sent to the
 * Product API in bounded batches.
 *
 * Events carry a section of the UI, a route with every identifier replaced, an
 * outcome, a timing and, for errors, the alert or incident being viewed. Never an
 * address, query text, error text or content. Nothing here may break the UI: every
 * entry point swallows its own failures, and all of it is inert outside a browser.
 */
type RumEvent = { kind: string } & Record<string, unknown>;

const ENDPOINT = "/api/rum-events";
const FLUSH_MS = 30000;
const MAX_BUFFER = 300;
const MAX_BATCH = 100;
const MAX_BYTES = 60000;
const MAX_ERRORS = 20;
const STORE = "keep-rum-events";
const OFF = "keep-rum-off";
// Upper bounds, in seconds, of the buckets API calls are counted into; one more
// bucket holds everything slower. The Product API reads them in this order.
const BOUNDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS: Record<string, string> = {
  alerts: "alerts",
  incidents: "incidents",
  presets: "presets",
  "correlation-rules": "rules",
  maintenance: "maintenance",
  dashboards: "dashboards",
  reports: "reports",
  operators: "admin",
  administration: "admin",
  "global-admin": "admin",
};

let started = false;
let disabled = false;
let sending = false;
let csrf: string | undefined;
let buffer: RumEvent[] = [];
let dropped = 0;
let errors = 0;
const calls = new Map<
  string,
  { route: string; method: string; outcome: string; buckets: number[] }
>();
let liveState: string | undefined;
let liveSince = 0;
const liveSeconds = new Map<string, number>();
let tabState = "visible";
let tabSince = 0;
const tabSeconds = new Map<string, number>();

const inBrowser = () =>
  typeof window !== "undefined" && typeof document !== "undefined";

/** Monitoring never breaks the UI and does nothing once switched off. */
function guarded<T extends unknown[]>(run: (...args: T) => void) {
  return (...args: T) => {
    try {
      if (inBrowser() && !disabled) run(...args);
    } catch {
      /* A monitoring failure is not the user's problem. */
    }
  };
}

/** The section of the UI a path belongs to; one of a fixed list. */
export function viewOf(pathname: string): string {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  if (parts[0] === "sign-in" || parts[0] === "sign-in-expired")
    return "sign_in";
  if (parts[0] !== "tenants") return "other";
  const view = SECTIONS[parts[2] ?? "alerts"] ?? "other";
  const detail = parts[3] !== undefined && UUID.test(parts[3]);
  if (detail && view === "alerts") return "alert";
  if (detail && view === "incidents") return "incident";
  return view;
}

/** A path as the Product API names its routes: every identifier replaced. */
export function routeOf(path: string): string {
  return path
    .split("?")[0]
    .split("/")
    .map((part) => (UUID.test(part) ? "{id}" : part))
    .join("/");
}

/** How a Product API answer ended, for the browser's own count of calls. */
export function apiOutcome(status: number): string {
  if (status < 400) return "ok";
  if (status === 409) return "conflict";
  if (status === 401 || status === 403) return "denied";
  return status >= 500 ? "server_error" : "rejected";
}

function push(event: RumEvent) {
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped += 1;
  }
  buffer.push(event);
}

const rounded = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** The alert or incident whose page is open, for an error raised there. */
function viewed(): Record<string, string> {
  const parts = location.pathname.split("/").filter(Boolean);
  const id = parts[3];
  if (parts[0] !== "tenants" || id === undefined || !UUID.test(id)) return {};
  if (parts[2] === "alerts") return { alert_id: id.toLowerCase() };
  if (parts[2] === "incidents") return { incident_id: id.toLowerCase() };
  return {};
}

/** Same-origin frames only, as "function (file:line)"; no addresses or text. */
function frames(stack: string): string | undefined {
  const lines: string[] = [];
  for (const line of stack.split("\n")) {
    const found = /https?:\/\/[^\s)]+/.exec(line);
    if (!found) continue;
    let url: URL;
    try {
      url = new URL(found[0]);
    } catch {
      continue;
    }
    if (url.origin !== location.origin) continue;
    const place = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(
      url.pathname.split("/").pop() ?? "",
    );
    const name = line
      .slice(0, found.index)
      .replace(/^\s*at\s+/, "")
      .replace(/[(@\s]+$/, "")
      .trim();
    lines.push(
      `${name || "anonymous"} (${place?.[1] ?? "script"}${place?.[2] ? `:${place[2]}` : ""})`,
    );
    if (lines.length === 20) break;
  }
  return lines.length ? lines.join("\n").slice(0, 1500) : undefined;
}

/** The session is known: batches can be sent from now on. */
export const rumSession = guarded((token: string) => {
  csrf = token;
});

/** One Product API call as the browser saw it, including one that got no answer. */
export const rumApi = guarded(
  (
    path: string,
    method: string,
    since: number,
    outcome: string,
    status?: number,
    requestId?: string,
  ) => {
    const verb = method.toUpperCase();
    if (path.startsWith(ENDPOINT) || !METHODS.includes(verb)) return;
    const route = routeOf(path);
    const key = `${verb} ${route} ${outcome}`;
    let entry = calls.get(key);
    if (!entry) {
      if (calls.size >= 200) return;
      entry = {
        route,
        method: verb,
        outcome,
        buckets: new Array(BOUNDS.length + 1).fill(0),
      };
      calls.set(key, entry);
    }
    const seconds = (performance.now() - since) / 1000;
    const bucket = BOUNDS.findIndex((bound) => seconds <= bound);
    entry.buckets[bucket < 0 ? BOUNDS.length : bucket] += 1;
    if (["server_error", "network", "unreadable"].includes(outcome))
      push({
        kind: "api_error",
        route,
        method: verb,
        outcome,
        view: viewOf(location.pathname),
        ...(status !== undefined ? { status } : {}),
        ...(requestId && UUID.test(requestId)
          ? { request_id: requestId.toLowerCase() }
          : {}),
      });
  },
);

/** The live update connection entered a state; undefined ends the measurement. */
export const rumLive = guarded((state: string | undefined) => {
  const now = performance.now();
  if (liveState)
    liveSeconds.set(
      liveState,
      (liveSeconds.get(liveState) ?? 0) + (now - liveSince) / 1000,
    );
  liveState = state;
  liveSince = now;
});

export const rumLiveDisconnect = guarded((reason: string, status?: number) => {
  push({
    kind: "live_disconnect",
    reason,
    view: viewOf(location.pathname),
    ...(status ? { status } : {}),
  });
});

/** A page timing reported by the browser (milliseconds, except layout shift). */
export const rumVital = guarded((name: string, value: number) => {
  const vital = name.toLowerCase();
  if (!["ttfb", "fcp", "lcp", "inp", "cls"].includes(vital)) return;
  if (!Number.isFinite(value) || value < 0) return;
  push({
    kind: "web_vital",
    name: vital,
    view: viewOf(location.pathname),
    value:
      vital === "cls"
        ? Math.round(value * 10000) / 10000
        : rounded(Math.min(value / 1000, 3600)),
  });
});

export const rumPageView = guarded((url: string) => {
  push({
    kind: "page_view",
    view: viewOf(new URL(url, location.origin).pathname),
  });
});

/** An error nothing handled: its class and same-origin frames, never its text. */
export const rumError = guarded(
  (kind: "error" | "unhandled_rejection", error: unknown) => {
    if (errors >= MAX_ERRORS) return;
    errors += 1;
    const name = error instanceof Error ? error.name : "Error";
    const stack =
      error instanceof Error && error.stack ? frames(error.stack) : undefined;
    push({
      kind: "js_error",
      name: kind,
      view: viewOf(location.pathname),
      error_name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error",
      ...(stack ? { stack } : {}),
      ...viewed(),
    });
  },
);

function tab(next: string) {
  const now = performance.now();
  tabSeconds.set(
    tabState,
    (tabSeconds.get(tabState) ?? 0) + (now - tabSince) / 1000,
  );
  tabState = next;
  tabSince = now;
}

/** Turn what was counted since the last batch into events. */
function drain() {
  for (const entry of calls.values())
    push({
      kind: "api",
      route: entry.route,
      method: entry.method,
      outcome: entry.outcome,
      count: entry.buckets.reduce((sum, calls) => sum + calls, 0),
      buckets: entry.buckets,
    });
  calls.clear();
  if (liveState) rumLive(liveState);
  for (const [state, seconds] of liveSeconds)
    if (seconds >= 0.001)
      push({ kind: "live", state, value: rounded(Math.min(seconds, 86400)) });
  liveSeconds.clear();
  tab(tabState);
  for (const [state, seconds] of tabSeconds)
    if (seconds >= 0.001)
      push({ kind: "tab", state, value: rounded(Math.min(seconds, 86400)) });
  tabSeconds.clear();
  if (dropped) {
    const count = dropped;
    dropped = 0;
    push({ kind: "dropped", count });
  }
}

function requeue(events: RumEvent[]) {
  buffer = [...events, ...buffer].slice(-MAX_BUFFER);
}

/** Send one batch. A missing endpoint means monitoring is off: stop for good. */
export const rumFlush = guarded(() => {
  if (!csrf || sending) return;
  drain();
  const events: RumEvent[] = [];
  let size = 12;
  while (buffer.length && events.length < MAX_BATCH) {
    const length = JSON.stringify(buffer[0]).length + 1;
    if (events.length && size + length > MAX_BYTES) break;
    events.push(buffer.shift()!);
    size += length;
  }
  if (!events.length) return;
  sending = true;
  fetch(ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ events }),
  })
    .then((response) => {
      if (response.status === 404) {
        disabled = true;
        buffer = [];
        try {
          sessionStorage.setItem(OFF, "1");
        } catch {
          /* Storage is optional. */
        }
      } else if (response.status >= 500) requeue(events);
    })
    .catch(() => requeue(events))
    .finally(() => {
      sending = false;
    });
});

/** Begin collecting. Called once, before the application becomes interactive. */
export const rumStart = guarded(() => {
  if (started) return;
  started = true;
  try {
    if (sessionStorage.getItem(OFF)) {
      disabled = true;
      return;
    }
    const saved = sessionStorage.getItem(STORE);
    if (saved) {
      sessionStorage.removeItem(STORE);
      const events = JSON.parse(saved);
      if (Array.isArray(events)) buffer = events.slice(-MAX_BUFFER);
    }
  } catch {
    /* Storage is optional. */
  }
  tabState = document.visibilityState === "hidden" ? "hidden" : "visible";
  tabSince = performance.now();
  push({ kind: "page_view", view: viewOf(location.pathname) });
  setInterval(rumFlush, FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    try {
      tab(document.visibilityState === "hidden" ? "hidden" : "visible");
    } catch {
      /* A monitoring failure is not the user's problem. */
    }
    if (document.visibilityState === "hidden") rumFlush();
  });
  window.addEventListener("pagehide", () => {
    rumFlush();
    try {
      // Not signed in yet, or the send is still in flight: keep them for the next page.
      if (buffer.length && !disabled)
        sessionStorage.setItem(STORE, JSON.stringify(buffer.slice(-MAX_BATCH)));
    } catch {
      /* Storage is optional. */
    }
  });
});
