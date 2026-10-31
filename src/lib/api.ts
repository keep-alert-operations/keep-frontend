import createClient from "openapi-fetch";
import type { paths } from "./generated";

// Generated path/method typing comes from the backend OpenAPI contract. Response
// envelopes remain explicit until every backend response model is published.
export const generatedClient = createClient<paths>({
  credentials: "same-origin",
  cache: "no-store",
});
export async function requestSession(
  signal?: AbortSignal,
): Promise<Envelope<Session>> {
  const result = await generatedClient.GET("/auth/session", { signal });
  if (!result.response.ok) {
    const failure = result.error as
      | { error?: { code?: string; message?: string; request_id?: string } }
      | undefined;
    throw new ApiError(
      result.response.status,
      failure?.error?.code ?? "session_unavailable",
      failure?.error?.message ?? "Session verification is unavailable.",
      failure?.error?.request_id,
    );
  }
  const payload = result.data as Envelope<Session> | undefined;
  if (!payload?.data?.principal || !Array.isArray(payload.data.tenants))
    throw new ApiError(
      502,
      "invalid_response",
      "The session response does not match its API contract.",
    );
  return payload;
}
export type Revision = string;
export type RecordData = {
  id: string;
  revision: Revision;
  [key: string]: unknown;
};
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  next_cursor?: string | null;
}
export interface Tenant {
  id: string;
  name: string;
  kind: string;
  role: "view" | "edit" | "admin";
  revision: Revision;
}
export interface Session {
  principal: { id: string; display_name: string };
  csrf_token: string;
  tenants: Tenant[];
  last_tenant_id?: string | null;
  global_super_admin?: boolean;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public fields?: unknown,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<Envelope<T>> {
  if (!path.startsWith("/api/") && !path.startsWith("/auth/"))
    throw new Error("Invalid API scope");
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "The service returned an unreadable response. Check the API connection.",
    );
  }
  if (!response.ok) {
    const detail = (
      payload as {
        error?: {
          code?: string;
          message?: string;
          request_id?: string;
          fields?: unknown;
        };
      } | null
    )?.error;
    throw new ApiError(
      response.status,
      detail?.code ?? "request_failed",
      detail?.message ?? "The request could not be completed.",
      detail?.request_id,
      detail?.fields,
    );
  }
  if (!payload || typeof payload !== "object" || !("data" in payload))
    throw new ApiError(
      502,
      "invalid_response",
      "The service response does not match its API contract.",
    );
  return payload as Envelope<T>;
}
export function message(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message} (${error.code})${error.requestId ? ` · Request ${error.requestId}` : ""}`;
  return error instanceof Error
    ? error.message
    : "The service is unavailable. Try again.";
}
export const tenantPath = (id: string) =>
  `/api/tenants/${encodeURIComponent(id)}`;
export function display(value: unknown): string {
  return value === null || value === undefined
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
/** An alert's title (REV-54): its name, which only v1 alerts lack. */
export function alertTitle(alert: Record<string, unknown>): string {
  return display(alert.name ?? alert.message ?? alert.application);
}
/** The message shown under a named alert's title. */
export function alertSubtitle(
  alert: Record<string, unknown>,
): string | undefined {
  return typeof alert.name === "string" && typeof alert.message === "string"
    ? alert.message
    : undefined;
}
export function count(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value).toLocaleString()
    : "Unavailable";
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "—";
  const date = new Date(value),
    pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
