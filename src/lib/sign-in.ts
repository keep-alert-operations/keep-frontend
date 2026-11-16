import { ApiError, generatedClient } from "./api";

/**
 * A local relative path to open after sign-in, else "/" (identity configuration
 * 2). The Product API validates `return_to` again; this keeps the browser from
 * following anything but a same-origin path, and from looping back to sign-in.
 */
export function localReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "/";
  let decoded = value;
  try {
    for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
  } catch {
    return "/";
  }
  const unsafe = (path: string) =>
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path);
  if (unsafe(value) || unsafe(decoded)) return "/";
  if (/^\/(sign-in|signed-out|sign-in-expired)(?:[/?#]|$)/.test(value))
    return "/";
  return value;
}

/** Keep's sign-in page (REV-73), returning to a local path and query. */
export function signInPath(returnTo?: string) {
  const target = localReturnPath(returnTo);
  return target === "/"
    ? "/sign-in"
    : `/sign-in?return_to=${encodeURIComponent(target)}`;
}

export interface SignedIn {
  return_to: string;
  absolute_at?: string;
}

/**
 * `POST /auth/login` (identity configuration 2–3). The password travels only
 * in this same-origin JSON body; it is never stored or put in a URL.
 */
export async function signIn(
  credentials: { username: string; password: string; returnTo: string },
  signal?: AbortSignal,
): Promise<SignedIn> {
  const returnTo = localReturnPath(credentials.returnTo);
  let result;
  try {
    result = await generatedClient.POST("/auth/login", {
      body: {
        username: credentials.username,
        password: credentials.password,
        return_to: returnTo === "/" ? null : returnTo,
      },
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal,
    });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new ApiError(0, "network_error", "Keep could not be reached.");
  }
  if (!result.response.ok) {
    const failure = result.error as
      | { error?: { code?: string; message?: string; request_id?: string } }
      | undefined;
    throw new ApiError(
      result.response.status,
      failure?.error?.code ?? "sign_in_failed",
      failure?.error?.message ?? "Sign-in could not be completed.",
      failure?.error?.request_id,
    );
  }
  const payload = result.data as { data?: Partial<SignedIn> } | undefined;
  return {
    return_to: localReturnPath(payload?.data?.return_to),
    absolute_at: payload?.data?.absolute_at,
  };
}
