"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, Envelope, RecordData, request } from "./api";

/** Own a single search snapshot, including late responses after navigation. */
export function useSearchResource(
  path: string | null,
  csrf: string,
  onDenied: () => void,
  body: Record<string, unknown> | undefined,
  version: string | number = 0,
) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const key = path ? JSON.stringify([path, serialized]) : null;
  const [state, setState] = useState<{
    key: string | null;
    dataKey?: string | null;
    data?: Envelope<RecordData[]>;
    loading: boolean;
    error?: unknown;
  }>({ key, loading: !!path });
  const [refresh, setRefresh] = useState(0);
  const latest = useRef({ csrf, onDenied });
  latest.current = { csrf, onDenied };
  const trigger = useRef<() => void>(() => {});
  const owned = useRef<
    { token: string; base: string; csrf: string } | undefined
  >(undefined);
  function dispose(snapshot: typeof owned.current) {
    if (snapshot)
      void request(`${snapshot.base}/alerts/snapshot/close`, {
        method: "POST",
        csrf: snapshot.csrf,
        body: { token: snapshot.token },
      }).catch(() => {}); // A transport failure still has the bounded server PIT lifetime.
  }
  useEffect(
    () => () => {
      dispose(owned.current);
      owned.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!path) return;
    const base = path.split("/").slice(0, 4).join("/");
    const continuing = body
      ? !!body.cursor
      : new URL(path, location.origin).searchParams.has("cursor");
    let stopped = false,
      busy = false,
      pending = false,
      relative = false,
      // When a dismissal among the matching rows ends (REV-49), as epoch ms.
      nextChange: number | undefined;
    async function run() {
      if (stopped || document.visibilityState !== "visible") return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      setState((previous) => ({
        ...previous,
        key,
        loading: true,
        error: undefined,
      }));
      try {
        // Let an obsolete response finish so its cleanup token can be released.
        // There is never more than one in-flight request for this query.
        const result = await request<RecordData[]>(path!, {
          ...(serialized !== undefined
            ? { method: "POST", body: JSON.parse(serialized) }
            : {}),
          csrf: latest.current.csrf,
          signal: AbortSignal.timeout(15000),
        });
        const token = result.meta?.close_token;
        const snapshot =
          typeof token === "string"
            ? { token, base, csrf: latest.current.csrf }
            : undefined;
        if (stopped) {
          dispose(snapshot);
          return;
        }
        if (!Array.isArray(result.data)) {
          dispose(snapshot);
          throw new ApiError(
            502,
            "invalid_response",
            "The search response is unavailable.",
          );
        }
        if (!continuing) dispose(owned.current);
        owned.current = snapshot;
        relative = result.meta?.relative === true;
        const change = result.meta?.next_change_at;
        nextChange =
          typeof change === "string"
            ? Date.parse(change) || undefined
            : undefined;
        setState({ key, dataKey: key, data: result, loading: false });
      } catch (error) {
        if (stopped) return;
        const denied =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        if (denied) latest.current.onDenied();
        setState((previous) => ({
          ...previous,
          key,
          data: denied ? undefined : previous.data,
          error,
          loading: false,
        }));
      } finally {
        busy = false;
        if (pending && !stopped) {
          pending = false;
          void run();
        }
      }
    }
    trigger.current = () => void run();
    const clock = setInterval(() => {
      if (continuing) return;
      // A returning alert has no live event, so re-query once its dismissal ends.
      const changed = nextChange !== undefined && Date.now() >= nextChange;
      if (changed) nextChange = undefined;
      if (relative || changed) void run();
    }, 1000);
    function visibility() {
      if (document.visibilityState === "visible") void run();
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      trigger.current = () => {};
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key]);
  useEffect(() => trigger.current(), [key, version, refresh]);
  return {
    ...state,
    loading: !!path && (state.loading || state.key !== key),
    reload: useCallback(() => setRefresh((v) => v + 1), []),
  };
}
