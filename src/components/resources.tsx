"use client";
import type { Scope } from "./workspace";
import { PresetPages } from "./presets-pages";
import { DashboardPages } from "./dashboards-pages";
import { IncidentPages } from "./incidents-pages";
import { RulePages } from "./rules-pages";
import { MaintenancePages } from "./maintenance-pages";
import { ReportPages } from "./reports-pages";
import { AdminPages } from "./admin-pages";

/** Routes a tenant section to its screen area (see docs/ui-design.md). */
export function Resources(scope: Scope & { section: string; id?: string }) {
  switch (scope.section) {
    case "presets":
      return <PresetPages {...scope} />;
    case "dashboards":
      return <DashboardPages {...scope} />;
    case "incidents":
      return <IncidentPages {...scope} />;
    case "correlation-rules":
      return <RulePages {...scope} />;
    case "maintenance":
      return <MaintenancePages {...scope} />;
    case "reports":
      return <ReportPages {...scope} />;
    default:
      return <AdminPages {...scope} />;
  }
}
