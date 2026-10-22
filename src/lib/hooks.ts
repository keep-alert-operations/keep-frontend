"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, Envelope, request } from "./api";

export function useResource<T>(
  path: string | null,
  onDenied: () => void,
  version = 0,
) {
  const [state, setState] = useState<{
    path: string | null;
    data?: Envelope<T>;
    error?: unknown;
    loading: boolean;
  }>({ path, loading: true });
  const [refresh, setRefresh] = useState(0);
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const trigger = useRef<() => void>(() => {});
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let busy = false,
      pending = false;
    async function run() {
      if (controller.signal.aborted) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      setState((previous) => ({
        path,
        data: previous.path === path ? previous.data : undefined,
        loading: true,
      }));
      try {
        const data = await request<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted)
          setState((previous) => {
            const before = (
              previous.data?.data as { revision?: string } | undefined
            )?.revision;
            const after = (data.data as { revision?: string } | undefined)
              ?.revision;
            if (
              previous.path === path &&
              before &&
              after &&
              /^\d+$/.test(before) &&
              /^\d+$/.test(after) &&
              BigInt(before) > BigInt(after)
            )
              return { ...previous, loading: false };
            return { path, data, loading: false };
          });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          denied.current();
        setState((previous) => ({
          path,
          data:
            error instanceof ApiError && [401, 403, 404].includes(error.status)
              ? undefined
              : previous.path === path
                ? previous.data
                : undefined,
          error,
          loading: false,
        }));
      } finally {
        busy = false;
        if (pending && !controller.signal.aborted) {
          pending = false;
          void run();
        }
      }
    }
    trigger.current = () => void run();
    return () => {
      controller.abort();
      trigger.current = () => {};
    };
  }, [path]);
  useEffect(() => {
    trigger.current();
  }, [path, refresh, version]);
  const install = (data: Envelope<T>) =>
    setState((previous) => {
      const before = (previous.data?.data as { revision?: string } | undefined)
        ?.revision;
      const after = (data.data as { revision?: string } | undefined)?.revision;
      if (
        previous.path === path &&
        before &&
        after &&
        /^\d+$/.test(before) &&
        /^\d+$/.test(after) &&
        BigInt(before) > BigInt(after)
      )
        return previous;
      return { path, data, loading: false };
    });
  return {
    ...(state.path === path
      ? state
      : { path, data: undefined, error: undefined, loading: true }),
    install,
    reload: useCallback(() => setRefresh((v) => v + 1), []),
  };
}

// The pending body is retained verbatim after transport uncertainty. A retry must
// preserve its UUID and revision even if the user subsequently edits a form.
const ownCommandListeners = new Set<(path: string) => void>();
/** Observes commands this tab committed or may have committed, by request path. */
export function onOwnCommand(listener: (path: string) => void) {
  ownCommandListeners.add(listener);
  return () => void ownCommandListeners.delete(listener);
}
function announceCommand(path: string) {
  for (const listener of ownCommandListeners) listener(path);
}
export function useCommand(csrf: string, onDenied: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{
    path: string;
    body: unknown;
    method: string;
    headers?: Record<string, string>;
  } | null>(null);
  const alive = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      pending.current = null;
    };
  }, []);
  async function execute<T>(
    path: string,
    body: Record<string, unknown>,
    method = "POST",
    headers?: Record<string, string>,
  ): Promise<Envelope<T> | undefined> {
    if (busy) return;
    const command = pending.current ?? {
      path,
      body: { ...body, command_id: crypto.randomUUID() },
      method,
      headers,
    };
    pending.current = command;
    controller.current = new AbortController();
    setBusy(true);
    setError(undefined);
    const operatorCommand = /^\/api\/tenants\/[^/]+\/operators(?:\/|$)/.test(
      command.path,
    );
    const timer = setTimeout(
      () => controller.current?.abort(),
      operatorCommand ? 105000 : 15000,
    );
    try {
      const data = await request<T>(command.path, {
        method: command.method,
        body: command.method === "DELETE" ? undefined : command.body,
        headers: command.headers,
        csrf,
        signal: controller.current.signal,
      });
      announceCommand(command.path);
      if (!alive.current) return;
      pending.current = null;
      setUncertain(false);
      return data;
    } catch (failure) {
      if (!alive.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status))
        onDenied();
      // 5xx and invalid responses can follow a committed transaction.
      const operationRecorded =
        failure instanceof ApiError &&
        failure.fields !== null &&
        typeof failure.fields === "object" &&
        "operation_id" in failure.fields;
      const unknownOutcome =
        !operationRecorded &&
        (!(failure instanceof ApiError) || failure.status >= 500);
      if (operationRecorded || unknownOutcome) announceCommand(command.path);
      if (!unknownOutcome) pending.current = null;
      setUncertain(unknownOutcome);
      setError(failure);
    } finally {
      clearTimeout(timer);
      if (alive.current) setBusy(false);
    }
  }
  return { execute, busy, error, uncertain };
}
export function useDirtyWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
}
