import type { RecordData } from "./api";

/** Keep the stable v2 operator ID for queries while showing its current name. */
export function alertOperatorLabel(alert: RecordData): string {
  if (
    typeof alert.operator_display_name === "string" &&
    alert.operator_display_name
  )
    return alert.operator_display_name;
  if (alert.schema_version === "v1" && typeof alert.operator === "string")
    return alert.operator;
  return "Unknown operator";
}
