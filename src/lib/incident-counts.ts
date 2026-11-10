import { request, tenantPath } from "./api";

/** Which incident statuses an incident count panel counts (REV-69). */
export type IncidentStatus = "open" | "investigating" | "both";

/** The panel's checkboxes; Firing is the incident status `open`. */
export const INCIDENT_STATUSES = [
  { value: "open", name: "Firing" },
  { value: "investigating", name: "Investigating" },
] as const;

/** The stored setting for the ticked boxes, or undefined when none is ticked. */
export function incidentStatus(
  firing: boolean,
  investigating: boolean,
): IncidentStatus | undefined {
  if (firing && investigating) return "both";
  if (firing) return "open";
  if (investigating) return "investigating";
  return undefined;
}

export const counts = (
  status: IncidentStatus,
  value: "open" | "investigating",
) => status === "both" || status === value;

/** "Firing", "Investigating" or "Firing and investigating". */
export function statusLine(status: IncidentStatus) {
  return status === "both"
    ? "Firing and investigating"
    : status === "open"
      ? "Firing"
      : "Investigating";
}

/** A panel's title when it has none: "<preset> incidents". */
export const defaultIncidentTitle = (presetName: string) =>
  `${presetName} incidents`;

/** The numbers behind an incident count, as decimal strings. */
export interface IncidentNumbers {
  count: string;
  alerts: string;
  linked_alerts: string;
}

const decimal = /^(0|[1-9]\d*)$/;

/**
 * Count the incidents a preset's alerts are in, the way a dashboard does: the
 * preset's query over current alerts, without suppressed ones (REV-69). Undefined
 * when the count cannot be given, for example with too many incidents.
 */
export async function previewIncidents(
  tenantId: string,
  csrf: string,
  cel: string,
  status: IncidentStatus,
  signal: AbortSignal,
): Promise<IncidentNumbers | undefined> {
  const result = await request<{
    incidents?: Record<string, Partial<IncidentNumbers>>;
  }>(`${tenantPath(tenantId)}/alerts/counts`, {
    method: "POST",
    csrf,
    body: { queries: [{ id: "total", cel, incident_status: status }] },
    signal,
  });
  const numbers = result.data.incidents?.total;
  return numbers &&
    [numbers.count, numbers.alerts, numbers.linked_alerts].every(
      (value) => typeof value === "string" && decimal.test(value),
    )
    ? (numbers as IncidentNumbers)
    : undefined;
}
