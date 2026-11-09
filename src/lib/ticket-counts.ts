/**
 * ServiceNow ticket counts (REV-65): the wire shapes, paths and labels the
 * ServiceNow panel, its dialog and the Integrations admin page share. The API
 * server calls the ticket count service; the browser only asks the API.
 * Requirements: REV-65; dashboard operations 2, 3, 11, 16.
 */
import { request, tenantPath } from "./api";
import type { components } from "./generated";

type Schemas = components["schemas"];
export type TicketQuery = Schemas["TicketCountQuery"];
export type TicketState = TicketQuery["ticket_state"];
export type Detection = TicketQuery["detection"];
/** One answer, in the order of the queries asked; counts are decimal strings. */
export type TicketResult = Schemas["TicketCountResult"];
export type TicketStatus = TicketResult["status"];
export type TicketCountResults = Schemas["TicketCountResults"];
export type TicketCountStatus = Schemas["TicketCountStatus"];
/** What a super admin sees about the ticket count service (read-only, D2). */
export type TicketCountIntegration = Schemas["TicketCountIntegration"];
export type TicketCountTest = Schemas["TicketCountTest"];

export const MAX_TEAM = 200;
/** The most queries one request may carry; a dashboard holds at most 24 panels. */
export const MAX_QUERIES = 24;

export const ticketCountsPath = (tenantId: string) =>
  `${tenantPath(tenantId)}/ticket-counts`;
export const ticketCountStatusPath = (tenantId: string) =>
  `${ticketCountsPath(tenantId)}/status`;
export const integrationPath = "/api/admin/integrations/ticket-count";
export const integrationTestPath = `${integrationPath}/test`;

export const TICKET_STATES: {
  value: TicketState;
  name: string;
  line: string;
}[] = [
  { value: "open", name: "Open", line: "Open" },
  { value: "in_progress", name: "In progress", line: "In progress" },
  { value: "both", name: "Both", line: "Open and in progress" },
];
export const DETECTIONS: { value: Detection; name: string; help: string }[] = [
  {
    value: "hamal",
    name: "Hamal",
    help: "Hamal: incidents the monitoring center raised.",
  },
  {
    value: "direct",
    name: "Direct",
    help: "Direct: incidents reported straight to the team.",
  },
  { value: "all", name: "All", help: "All: both Hamal and direct incidents." },
];

/** "Team · Open · Hamal": the line under a ServiceNow panel's title. */
export function filterLine(query: TicketQuery) {
  const state =
    TICKET_STATES.find((item) => item.value === query.ticket_state)?.line ??
    query.ticket_state;
  const detection =
    DETECTIONS.find((item) => item.value === query.detection)?.name ??
    query.detection;
  return `${query.team.trim() || "No team"} · ${state} · ${detection}`;
}
/** The title a panel without its own shows. */
export const defaultTitle = (team: string) =>
  `${team.trim() || "Team"} tickets`;
/** Identical queries share one answer, so a batch asks each only once. */
export const queryKey = (query: TicketQuery) =>
  JSON.stringify([query.team, query.ticket_state, query.detection]);

const STATUSES: TicketStatus[] = [
  "count",
  "not_found",
  "no_count",
  "unavailable",
  "not_configured",
];
/** A canonical nonnegative decimal string, as the count panel accepts. */
export const decimal = /^(0|[1-9][0-9]*)$/;
const whole = (value: unknown) =>
  value === null || (typeof value === "string" && decimal.test(value));
const time = (value: unknown) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));

/**
 * A result that doesn't match the contract, such as a non-canonical count,
 * counts as the service being unavailable.
 */
function checked(value: unknown): TicketResult {
  const item = (value ?? {}) as Partial<TicketResult>;
  const count = item.count ?? null;
  const last = item.last_count ?? null;
  if (
    !STATUSES.includes(item.status as TicketStatus) ||
    !whole(count) ||
    !whole(last) ||
    !time(item.checked_at ?? null) ||
    !time(item.last_counted_at ?? null) ||
    (item.status === "count" && count === null)
  )
    return unavailable();
  return {
    status: item.status as TicketStatus,
    count,
    checked_at: item.checked_at ?? null,
    last_count: last,
    last_counted_at: item.last_counted_at ?? null,
  };
}
export const unavailable = (): TicketResult => ({
  status: "unavailable",
  count: null,
  checked_at: null,
  last_count: null,
  last_counted_at: null,
});

/** Asks the API for the counts of `queries`, at most 24 per request, in order. */
export async function fetchTicketCounts(
  tenantId: string,
  csrf: string,
  queries: TicketQuery[],
  signal?: AbortSignal,
): Promise<TicketResult[]> {
  const results: TicketResult[] = [];
  for (let start = 0; start < queries.length; start += MAX_QUERIES) {
    const part = queries.slice(start, start + MAX_QUERIES);
    const response = await request<TicketCountResults>(
      ticketCountsPath(tenantId),
      { method: "POST", csrf, signal, body: { queries: part } },
    );
    const answers = response.data?.results;
    if (!Array.isArray(answers) || answers.length !== part.length)
      results.push(...part.map(unavailable));
    else results.push(...answers.map(checked));
  }
  return results;
}
