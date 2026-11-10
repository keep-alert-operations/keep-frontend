import { expect, test } from "@playwright/test";
import {
  checkGrafanaAddress,
  framedSrc,
  grafanaFacts,
  openInGrafana,
  type GrafanaPanelStatus,
} from "../src/lib/grafana-panel";

// Unit checks of the browser's Grafana address rules, without a page.
// Requirements: REV-68; dashboard operations 3 and 14.
const keep = { origin: "https://keep.ops.example", protocol: "https:" };
const on: GrafanaPanelStatus = {
  enabled: true,
  origins: [
    { origin: "https://grafana.ops.example", path_prefix: "" },
    { origin: "https://tools.example", path_prefix: "/grafana" },
  ],
};
const good =
  "https://grafana.ops.example/d-solo/ck81x/checkout?orgId=1&from=now-6h&to=now&refresh=1m&var-env=prod&var-region=eu-west&panelId=4";
const problem = (raw: string, status: GrafanaPanelStatus = on) => {
  const result = checkGrafanaAddress(raw, status, keep);
  return result.state === "problem" ? result.problem : result.state;
};

test("addresses fail on the first broken rule, in the design's order", () => {
  // Requirements: REV-68 validation 1-11.
  expect(problem("   ")).toBe("empty");
  expect(problem("This isn't a URL")).toBe("This isn't a valid address.");
  expect(problem("ftp://grafana.ops.example/d-solo/a/b")).toBe(
    "The address must start with https://.",
  );
  // Parses as https, but the text doesn't start with https://.
  expect(problem("https:grafana.ops.example/d-solo/a/b")).toBe(
    "The address must start with https://.",
  );
  expect(problem("https://keep.ops.example/d-solo/a/b")).toBe(
    "Keep's own pages can't be shown in a Grafana panel.",
  );
  // Keep's own pages are refused even while the feature is off.
  expect(
    problem("https://keep.ops.example/d-solo/a/b", {
      enabled: false,
      origins: [],
    }),
  ).toBe("Keep's own pages can't be shown in a Grafana panel.");
  expect(problem(good, { enabled: false, origins: [] })).toBe(
    "Grafana panels are turned off.",
  );
  // Credentials and http are reported before the allowlist.
  expect(problem("https://admin:pw@grafana-old.example/d-solo/a/b")).toBe(
    "Remove the user name and password. The address is saved in the dashboard, where everyone could read it.",
  );
  expect(problem("http://grafana-old.example/d-solo/a/b")).toBe(
    "Keep is served over https, so the panel address must be https too.",
  );
  expect(problem("https://grafana-old.example/d-solo/a/b")).toBe(
    "grafana-old.example isn't an allowed Grafana.",
  );
  // A base path must match exactly, followed by "/".
  expect(problem("https://tools.example/grafana2/d-solo/a/b")).toBe(
    "tools.example isn't an allowed Grafana.",
  );
  expect(
    problem("https://grafana.ops.example/d/ck81x/checkout?viewPanel=4"),
  ).toBe(
    "Use a single-panel address from Share › Embed. Whole dashboards can't be shown.",
  );
  expect(problem("https://tools.example/grafana/d/a/b")).toBe(
    "Use a single-panel address from Share › Embed. Whole dashboards can't be shown.",
  );
  expect(problem(`${good}&x=${"a".repeat(2048)}`)).toBe(
    "The address is longer than 2,048 characters.",
  );
  expect(problem(good)).toBe("ok");
  expect(problem("https://tools.example/grafana/d-solo/a/b?panelId=2")).toBe(
    "ok",
  );
  // Until the status is known, nothing is framed.
  expect(checkGrafanaAddress(good, undefined, keep).state).toBe("pending");
});

test("http is allowed for loopback Grafana or when Keep itself is on http", () => {
  // Requirements: REV-68 validation 8; REV-65 loopback development rule.
  const local: GrafanaPanelStatus = {
    enabled: true,
    origins: [{ origin: "http://localhost:3000", path_prefix: "" }],
  };
  expect(
    checkGrafanaAddress("http://localhost:3000/d-solo/a/b", local, keep).state,
  ).toBe("ok");
  expect(
    checkGrafanaAddress(
      "http://grafana.dev.example/d-solo/a/b",
      {
        enabled: true,
        origins: [{ origin: "http://grafana.dev.example", path_prefix: "" }],
      },
      { origin: "http://keep.dev.example", protocol: "http:" },
    ).state,
  ).toBe("ok");
});

test("facts, the Open in Grafana link and the framed address come from the URL", () => {
  // Requirements: REV-68 authoring and the frame.
  const result = checkGrafanaAddress(good, on, keep);
  if (result.state !== "ok") throw new Error(result.state);
  expect(grafanaFacts(result.url, result.origin)).toEqual({
    grafana: "grafana.ops.example",
    dashboard: "checkout (ck81x)",
    panel: "#4 · org 1",
    range: "Last 6 hours",
    refresh: "Every 1m",
    variables: "env = prod, region = eu-west",
  });
  const bare = checkGrafanaAddress(
    "https://tools.example/grafana/d-solo/s2/orders?orgId=3&panelId=2&from=now-1d&to=now-1h",
    on,
    keep,
  );
  if (bare.state !== "ok") throw new Error(bare.state);
  expect(grafanaFacts(bare.url, bare.origin)).toMatchObject({
    grafana: "tools.example/grafana",
    dashboard: "orders (s2)",
    panel: "#2 · org 3",
    range: "now-1d to now-1h",
    refresh: "Grafana's default",
    variables: "None",
  });
  expect(openInGrafana(`${good}&theme=dark`)).toBe(
    "https://grafana.ops.example/d/ck81x/checkout?orgId=1&from=now-6h&to=now&refresh=1m&var-env=prod&var-region=eu-west&viewPanel=4",
  );
  expect(framedSrc(`${good}&theme=light`, "dark")).toBe(`${good}&theme=dark`);
  expect(framedSrc(good, "light")).toBe(`${good}&theme=light`);
});
