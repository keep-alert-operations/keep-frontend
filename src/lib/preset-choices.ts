"use client";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  request,
  tenantPath,
  type Envelope,
  type RecordData,
} from "./api";
import { useResource } from "./hooks";

// Keep one result page and at most the dashboard's 24 selected references.
export function usePresetChoices(
  path: string | null,
  selectedIds: string[],
  onDenied: () => void,
  version: number,
) {
  const [name, setName] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selectedKey = JSON.stringify(
    [...new Set(selectedIds.filter(Boolean))].sort(),
  );
  const selectionScope = `${path}:${selectedKey}:${version}:${refresh}`;
  const [selected, setSelected] = useState<{
    scope: string;
    rows: RecordData[];
    error?: unknown;
  }>({ scope: selectionScope, rows: [] });
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const query = new URLSearchParams({ limit: "200", name });
  if (cursor) query.set("cursor", cursor);
  const page = useResource<RecordData[]>(
    path ? `${path}?${query}` : null,
    onDenied,
    version + refresh,
  );
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const ids = JSON.parse(selectedKey) as string[];
    void Promise.all(
      ids.map(async (id) => {
        try {
          const result = (
            await request<RecordData>(`${path}/${encodeURIComponent(id)}`, {
              signal: controller.signal,
            })
          ).data;
          if (result?.id !== id || typeof result.revision !== "string")
            throw new ApiError(
              502,
              "invalid_response",
              "Preset details are unavailable.",
            );
          return result;
        } catch (error) {
          // An absent reference stays visible by ID in the draft but cannot preview.
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      }),
    ).then(
      (rows) => {
        if (!controller.signal.aborted)
          setSelected({
            scope: selectionScope,
            rows: rows.filter((row) => row !== null),
          });
      },
      (error) => {
        if (!controller.signal.aborted) {
          setSelected({ scope: selectionScope, rows: [], error });
          if (error instanceof ApiError && [401, 403].includes(error.status))
            denied.current();
        }
      },
    );
    return () => controller.abort();
  }, [path, selectedKey, selectionScope]);
  const resolved = selected.scope === selectionScope ? selected : undefined;
  const rows = new Map<string, RecordData>();
  for (const row of [...(page.data?.data ?? []), ...(resolved?.rows ?? [])])
    rows.set(row.id, row);
  return {
    rows: [...rows.values()],
    error: page.error ?? resolved?.error,
    loading: page.loading,
    cursor,
    nextCursor: page.data?.next_cursor,
    next: () => setCursor(page.data?.next_cursor ?? null),
    restart: () => {
      setCursor(null);
      setRefresh((value) => value + 1);
    },
    search: (value: string) => {
      setName(value);
      setCursor(null);
    },
  };
}

/** Preset definition vocabulary shared by the preset and dashboard screens. */
export interface SortItem {
  field: string;
  direction: string;
}
export const DEFAULT_COLUMNS = [
  "severity",
  "status",
  "message",
  "application",
  "component",
  "timestamp",
  "acknowledged",
  "assignee_id",
];
export const DEFAULT_SORT: SortItem[] = [
  { field: "timestamp", direction: "desc" },
];
export const SELECTABLE_COLUMNS = [
  "severity",
  "message",
  "status",
  "application",
  "component",
  "node_name",
  "site",
  "operator",
  "timestamp",
  "time_created",
  "acknowledged",
  "assignee_id",
  "suppressed",
  "impact",
  "active_incident_id",
];
export const SORT_FIELDS = [
  "timestamp",
  "severity",
  "status",
  "application",
  "component",
  "node_name",
  "site",
  "operator",
  "time_created",
  "acknowledged",
  "assignee_id",
];
/** Fields offered by the editor's "Insert field" chips (reference S06). */
export const INSERT_FIELDS = [
  "application",
  "component",
  "node_name",
  "site",
  "severity",
  "status",
  "suppressed",
  "acknowledged",
  "assignee_id",
  "operator",
  "impact",
  "message",
];
const LABELS: Record<string, string> = {
  severity: "Severity",
  message: "Message",
  status: "Status",
  application: "Application",
  component: "Component",
  node_name: "Node",
  site: "Site",
  operator: "Operator",
  timestamp: "Last received",
  last_received_at: "Last received",
  time_created: "Created",
  first_received_at: "First received",
  acknowledged: "Acknowledged",
  assignee_id: "Assignee",
  suppressed: "Suppressed",
  impact: "Impact",
  active_incident_id: "Incident",
  opened_at: "Opened",
  resolved_at: "Resolved",
};
export function fieldLabel(field: string) {
  return LABELS[field] ?? field.replaceAll("_", " ");
}
const TIME_FIELDS = new Set([
  "timestamp",
  "last_received_at",
  "time_created",
  "first_received_at",
  "opened_at",
  "resolved_at",
]);
export function directionLabel(field: string, direction: string) {
  if (TIME_FIELDS.has(field))
    return direction === "desc" ? "Newest first" : "Oldest first";
  return direction === "desc" ? "Descending" : "Ascending";
}
export function sortItems(value: unknown): SortItem[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is SortItem =>
          Boolean(item) &&
          typeof item.field === "string" &&
          typeof item.direction === "string",
      )
    : [];
}
/** "Last received ↓" or "Severity ↓, then last received ↓". */
export function sortSummary(value: unknown) {
  const items = sortItems(value);
  if (!items.length) return "Default order";
  return items
    .map((item, index) => {
      const label = fieldLabel(item.field);
      return `${index ? label.toLowerCase() : label} ${item.direction === "desc" ? "↓" : "↑"}`;
    })
    .join(", then ");
}
/** "Severity, then last received, newest first" (reference S07). */
export function sortSentence(value: unknown) {
  const items = sortItems(value);
  if (!items.length) return "Default order";
  return items
    .map((item, index) => {
      const label = fieldLabel(item.field);
      return `${index ? label.toLowerCase() : label}, ${directionLabel(item.field, item.direction).toLowerCase()}`;
    })
    .join(", then ");
}
export function columnsSummary(value: unknown) {
  return Array.isArray(value) && value.length
    ? value.map((column) => fieldLabel(String(column))).join(", ")
    : "None";
}

export type CelTokenKind = "k" | "s" | "o" | "n" | "t";
/** Lightweight CEL tokenizer for read-only syntax colouring. */
export function celTokens(
  source: string,
): { text: string; kind: CelTokenKind }[] {
  const tokens: { text: string; kind: CelTokenKind }[] = [];
  const pattern =
    /("(?:[^"\\n]|\.)*"?|'(?:[^'\\n]|\.)*'?)|(\b(?:\d+(?:\.\d+)?|true|false|null)\b)|(&&|\|\||==|!=|<=|>=|[<>!?:+\-*/%]|\bin\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ text: source.slice(last, index), kind: "t" });
    const [text, string, literal, operator, identifier] = match;
    let kind: CelTokenKind = "t";
    if (string) kind = "s";
    else if (literal) kind = "n";
    else if (operator) kind = "o";
    else if (identifier) {
      const next = source.slice(index + text.length).match(/^\s*\(/);
      kind = next ? "t" : "k";
    }
    tokens.push({ text, kind });
    last = index + text.length;
  }
  if (last < source.length)
    tokens.push({ text: source.slice(last), kind: "t" });
  return tokens;
}

/** Browser display timezone as "Asia/Jerusalem (UTC+03:00)". */
export function timezoneLabel() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let offset = "";
  try {
    offset =
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    offset = "";
  }
  offset = offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC");
  return offset ? `${zone} (${offset})` : zone;
}

/**
 * POST presets/preview for a saved preset (preset_id + expected_revision) or a
 * candidate definition (cel + sort + columns). Keeps the previous successful
 * page while a new request runs so the table can show it as stale.
 */
export function usePresetPreview(
  tenantId: string,
  csrf: string,
  onDenied: () => void,
  body: Record<string, unknown> | null,
  refresh: string | number = 0,
) {
  const serialized = body ? JSON.stringify(body) : null;
  const [state, setState] = useState<{
    key: string | null;
    resultKey?: string;
    result?: Envelope<RecordData[]>;
    error?: unknown;
    loading: boolean;
  }>({ key: null, loading: Boolean(body) });
  const denied = useRef(onDenied);
  denied.current = onDenied;
  useEffect(() => {
    if (!serialized) return;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, key: serialized, loading: true }));
    request<RecordData[]>(`${tenantPath(tenantId)}/presets/preview`, {
      method: "POST",
      csrf,
      body: JSON.parse(serialized),
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.data))
          setState((previous) => ({
            ...previous,
            loading: false,
            error: new ApiError(
              502,
              "invalid_response",
              "The preview response does not match its API contract.",
            ),
          }));
        else
          setState({
            key: serialized,
            resultKey: serialized,
            result,
            loading: false,
          });
      },
      (error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          denied.current();
        setState((previous) => ({
          ...previous,
          key: serialized,
          error,
          loading: false,
        }));
      },
    );
    return () => controller.abort();
  }, [tenantId, csrf, serialized, refresh]);
  return {
    ...state,
    loading: serialized ? state.loading || state.key !== serialized : false,
  };
}

/** Exact decimal total of one candidate/saved preview, or undefined. */
export async function previewTotal(
  tenantId: string,
  csrf: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const result = await request<RecordData[]>(
    `${tenantPath(tenantId)}/presets/preview`,
    { method: "POST", csrf, body: { ...body, limit: 1 }, signal },
  );
  const total = result.meta?.total;
  return typeof total === "string" && /^\d+$/.test(total) ? total : undefined;
}
