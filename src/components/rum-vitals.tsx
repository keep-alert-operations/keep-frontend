"use client";

import { useReportWebVitals } from "next/web-vitals";
import { rumVital } from "@/lib/rum";

// A stable function: the hook reports again whenever its callback changes.
const report = (metric: { name: string; value: number }) =>
  rumVital(metric.name, metric.value);

/** Page load timings as users experience them (REV-74, observability 9). */
export function RumVitals() {
  useReportWebVitals(report);
  return null;
}
