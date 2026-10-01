/** Assignment determines the visible status; source lifecycle stays independent. */
export function alertStatus(status: unknown, assigneeId: unknown): string {
  if (status === "resolved") return "resolved";
  if (status === "firing" || status === "acknowledged")
    return assigneeId ? "acknowledged" : "firing";
  return typeof status === "string" ? status : "";
}
