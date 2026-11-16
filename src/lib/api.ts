import createClient from "openapi-fetch";
import type { paths } from "./generated";
import { apiOutcome, rumApi, rumSession } from "./rum";

// Generated path/method typing comes from the backend OpenAPI contract. Response
// envelopes remain explicit until every backend response model is published.
export const generatedClient = createClient<paths>({
  credentials: "same-origin",
  cache: "no-store",
});
export async function requestSession(
  signal?: AbortSignal,
): Promise<Envelope<Session>> {
  const since = performance.now();
  let result: Awaited<
    ReturnType<
      typeof generatedClient.GET<"/auth/session", { signal?: AbortSignal }>
    >
  >;
  try {
    result = await generatedClient.GET("/auth/session", { signal });
  } catch (failure) {
    if (!signal?.aborted) rumApi("/auth/session", "GET", since, "network");
    throw failure;
  }
  rumApi(
    "/auth/session",
    "GET",
    since,
    apiOutcome(result.response.status),
    result.response.status,
  );
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
  rumSession(payload.data.csrf_token);
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
type RequestOptions = {
  method?: string;
  body?: unknown;
  csrf?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Envelope<T>> {
  return (await requestStatus<T>(path, options)).envelope;
}
/** `request` that also reports the success status, such as 200 or 202. */
export async function requestStatus<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; envelope: Envelope<T> }> {
  if (!path.startsWith("/api/") && !path.startsWith("/auth/"))
    throw new Error("Invalid API scope");
  const method = options.method ?? "GET";
  const since = performance.now();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
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
  } catch (failure) {
    // A request the UI itself cancelled is not a failure the user met.
    if (!options.signal?.aborted) rumApi(path, method, since, "network");
    throw failure;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!options.signal?.aborted)
      rumApi(path, method, since, "unreadable", response.status);
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
    rumApi(
      path,
      method,
      since,
      apiOutcome(response.status),
      response.status,
      detail?.request_id,
    );
    throw new ApiError(
      response.status,
      detail?.code ?? "request_failed",
      detail?.message ?? "The request could not be completed.",
      detail?.request_id,
      detail?.fields,
    );
  }
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    rumApi(path, method, since, "unreadable", response.status);
    throw new ApiError(
      502,
      "invalid_response",
      "The service response does not match its API contract.",
    );
  }
  rumApi(path, method, since, "ok", response.status);
  return { status: response.status, envelope: payload as Envelope<T> };
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
/** Where an alert came from (REV-55); a v2 alert awaiting backfill has none. */
export function providerLabel(value: unknown): string {
  return value === "grafana" ? "Grafana" : value === "api" ? "API" : "—";
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
