/** Same-origin SSE hints. No event is an authorization or freshness proof. */
import { rumLive, rumLiveDisconnect } from "./rum";

export interface LiveEvent {
  type: string;
  data: string;
  id?: string;
}
const MAX_FRAME_BYTES = 64 * 1024;

export class LiveEventParser {
  private line: number[] = [];
  private frameBytes = 0;
  private skipLf = false;
  private type = "message";
  private data: string[] = [];
  private id: string | undefined;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private event: (event: LiveEvent) => void,
    private heartbeat: () => void,
  ) {}
  push(chunk: Uint8Array) {
    for (const byte of chunk) {
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 10) continue;
      }
      if (++this.frameBytes > MAX_FRAME_BYTES)
        throw new Error("Live event exceeds buffer limit");
      if (byte === 10 || byte === 13) {
        this.finishLine();
        this.skipLf = byte === 13;
      } else this.line.push(byte);
    }
  }
  private finishLine() {
    const line = this.decoder.decode(new Uint8Array(this.line));
    this.line = [];
    if (line === "") {
      if (this.data.length)
        this.event({
          type: this.type,
          data: this.data.join("\n"),
          id: this.id,
        });
      this.type = "message";
      this.data = [];
      this.id = undefined;
      this.frameBytes = 0;
    } else if (line.startsWith(":")) {
      // Only the existing protocol's complete heartbeat comment renews liveness.
      if (line.slice(1).trim() === "heartbeat") this.heartbeat();
    } else {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") this.type = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id" && !value.includes("\0")) this.id = value;
      // Server retry directives cannot override the bounded reconnect policy.
    }
  }
}

interface Runtime {
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  later: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}
interface Options {
  path: string;
  onEvent: (event: LiveEvent) => void;
  onDegraded: () => void;
  onDenied: () => void;
  onConnect: () => void;
}

export function liveStream(
  options: Options,
  runtime: Runtime = {
    fetch: (...args) => fetch(...args),
    now: () => performance.now(),
    random: Math.random,
    later: (callback, delay) => setTimeout(callback, delay),
    cancel: (timer) => clearTimeout(timer),
  },
) {
  if (!/^\/api\/tenants\/[^/]+\/events$/.test(options.path))
    throw new Error("Invalid live stream scope");
  let stopped = false,
    visible = true,
    failures = 0,
    generation = 0,
    lastId = "";
  let active: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hidden: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  function disconnect() {
    generation += 1;
    active?.abort();
    active = undefined;
    runtime.cancel(watchdog);
    watchdog = undefined;
  }
  async function connect() {
    if (stopped || !visible || active) return;
    runtime.cancel(retry);
    retry = undefined;
    const controller = new AbortController();
    active = controller;
    const attempt = ++generation;
    const current = () =>
      !stopped && generation === attempt && !controller.signal.aborted;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let opened = runtime.now();
    let cause = "network";
    function fail(denied = false, reason = cause, status?: number) {
      if (!current()) return;
      disconnect();
      rumLiveDisconnect(denied ? "denied" : reason, status);
      rumLive(denied ? "denied" : "degraded");
      if (denied) {
        stopped = true;
        runtime.cancel(hidden);
        options.onDenied();
        return;
      }
      options.onDegraded();
      const delay = Math.min(
        30000,
        1000 * 2 ** Math.min(failures++, 5) * (0.8 + runtime.random() * 0.4),
      );
      if (visible) retry = runtime.later(() => void connect(), delay);
    }
    function arm() {
      runtime.cancel(watchdog);
      watchdog = runtime.later(() => fail(false, "watchdog"), 30000);
    }
    arm(); // Also bound response-header stalls.
    rumLive("connecting");
    try {
      const response = await runtime.fetch(options.path, {
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          ...(lastId ? { "Last-Event-ID": lastId } : {}),
        },
      });
      if (!current()) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        // Known denial is authoritative even if cancelling a broken response
        // body rejects or never settles. Cleanup cannot postpone clearing scope.
        fail(
          [401, 403, 404].includes(response.status),
          "http_status",
          response.status,
        );
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "text/event-stream" ||
        !response.body
      ) {
        await response.body?.cancel();
        cause = "invalid_response";
        throw new Error("Invalid live stream response");
      }
      opened = runtime.now();
      options.onConnect();
      rumLive("connected");
      const parser = new LiveEventParser(
        (event) => {
          if (!current()) return;
          if (event.id !== undefined && event.id.length <= 4096)
            lastId = event.id;
          if (["state", "invalidate", "resync"].includes(event.type))
            options.onEvent(event);
        },
        () => {
          if (!current()) return;
          arm();
          // A fresh initial state on a flapping connection is not stability.
          if (runtime.now() - opened >= 30000) failures = 0;
        },
      );
      reader = response.body.getReader();
      while (current()) {
        const result = await reader.read();
        if (!current()) return;
        if (result.done) {
          fail(false, "stream_end");
          return;
        }
        parser.push(result.value);
      }
    } catch {
      fail();
    } finally {
      try {
        await reader?.cancel();
      } catch {
        /* Aborted network reader. */
      }
      reader?.releaseLock();
    }
  }
  return {
    setVisible(next: boolean) {
      if (stopped) return;
      visible = next;
      runtime.cancel(hidden);
      runtime.cancel(retry);
      retry = undefined;
      if (!next)
        hidden = runtime.later(() => {
          disconnect();
          rumLive("hidden");
        }, 60000);
      else {
        disconnect();
        void connect();
      }
    },
    close() {
      stopped = true;
      runtime.cancel(hidden);
      runtime.cancel(retry);
      disconnect();
      rumLive(undefined);
    },
  };
}
