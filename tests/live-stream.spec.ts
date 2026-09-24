import { expect, test } from "@playwright/test";
import {
  LiveEventParser,
  liveStream,
  type LiveEvent,
} from "../src/lib/live-stream";

const path = "/api/tenants/00000000-0000-4000-8000-000000000001/events";
const encode = (text: string) => new TextEncoder().encode(text);
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function harness(status = 200) {
  let now = 0,
    id = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const connections: {
    signal: AbortSignal;
    emit: (text: string) => void;
    end: () => void;
    options: RequestInit;
  }[] = [];
  const events: LiveEvent[] = [];
  let degraded = 0,
    denied = 0,
    opened = 0;
  const stream = liveStream(
    {
      path,
      onEvent: (event) => events.push(event),
      onDegraded: () => {
        degraded++;
      },
      onDenied: () => {
        denied++;
      },
      onConnect: () => {
        opened++;
      },
    },
    {
      now: () => now,
      random: () => 0.5,
      later: (callback, delay) => {
        const key = ++id;
        timers.set(key, { due: now + delay, callback });
        return key as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (timer) => {
        timers.delete(timer as unknown as number);
      },
      fetch: async (_url, options) => {
        const signal = options!.signal!;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        });
        signal.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {}
        });
        connections.push({
          signal,
          options: options!,
          emit: (text) => controller.enqueue(encode(text)),
          end: () => controller.close(),
        });
        return new Response(body, {
          status,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  async function advance(milliseconds: number) {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    now = end;
    await flush();
  }
  return {
    stream,
    connections,
    events,
    advance,
    state: () => ({ degraded, denied, opened, timers: timers.size }),
  };
}

test("SSE parser handles split UTF-8, CRLF and multiline data and only complete heartbeats", () => {
  const events: LiveEvent[] = [];
  let heartbeats = 0;
  const parser = new LiveEventParser(
    (event) => events.push(event),
    () => {
      heartbeats++;
    },
  );
  const bytes = encode(
    'id: epoch:9\r\nevent: resync\r\ndata: {"message":\r\ndata: "😀"}\r\n\r\n: heartbeat',
  );
  for (const byte of bytes) parser.push(new Uint8Array([byte]));
  expect(events).toEqual([
    { id: "epoch:9", type: "resync", data: '{"message":\n"😀"}' },
  ]);
  expect(heartbeats).toBe(0);
  parser.push(encode("\n\n"));
  expect(heartbeats).toBe(1);
  parser.push(encode("event: invalidate\ndata: unfinished"));
  expect(events).toHaveLength(1);
});

test("SSE parser bounds whole partial frames, rejects invalid UTF-8 and releases completed frames", () => {
  const parser = new LiveEventParser(
    () => {},
    () => {},
  );
  expect(() => parser.push(encode("data: " + "a".repeat(65536)))).toThrow(
    "buffer limit",
  );
  const multiline = new LiveEventParser(
    () => {},
    () => {},
  );
  expect(() => multiline.push(encode("data: a\n".repeat(10000)))).toThrow(
    "buffer limit",
  );
  let received = 0;
  const complete = new LiveEventParser(
    () => {
      received++;
    },
    () => {},
  );
  complete.push(encode("data: a\n\n".repeat(10000)));
  expect(received).toBe(10000);
  expect(() =>
    new LiveEventParser(
      () => {},
      () => {},
    ).push(new Uint8Array([255, 10])),
  ).toThrow();
});

test("silent streams abort at30s, reconcile and reconnect with scoped last-event hints", async () => {
  const h = harness();
  h.stream.setVisible(true);
  await flush();
  h.connections[0].emit(
    'id: epoch:9\nevent: state\ndata: {"view_generation":"9"}\n\n',
  );
  await flush();
  await h.advance(29999);
  expect(h.state().degraded).toBe(0);
  await h.advance(1);
  expect(h.state().degraded).toBe(1);
  expect(h.connections[0].signal.aborted).toBe(true);
  await h.advance(999);
  expect(h.connections).toHaveLength(1);
  await h.advance(1);
  expect(h.connections).toHaveLength(2);
  expect(h.connections[1].options).toMatchObject({
    credentials: "same-origin",
    mode: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Last-Event-ID": "epoch:9" },
  });
  h.stream.close();
  expect(h.state().timers).toBe(0);
});

test("initial state does not reset flapping backoff; stable heartbeat connection does", async () => {
  const h = harness();
  h.stream.setVisible(true);
  await flush();
  h.connections[0].emit("event: state\ndata: {}\n\n");
  h.connections[0].end();
  await flush();
  await h.advance(1000);
  expect(h.connections).toHaveLength(2);
  h.connections[1].emit("event: state\ndata: {}\n\n");
  h.connections[1].end();
  await flush();
  await h.advance(1999);
  expect(h.connections).toHaveLength(2);
  await h.advance(1);
  expect(h.connections).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    await h.advance(15000);
    h.connections[2].emit(": heartbeat\n\n");
    await flush();
  }
  h.connections[2].end();
  await flush();
  await h.advance(999);
  expect(h.connections).toHaveLength(3);
  await h.advance(1);
  expect(h.connections).toHaveLength(4);
  h.stream.close();
});

test("hidden stream closes at60s, never reconnects hidden and aborts on unmount", async () => {
  const h = harness();
  h.stream.setVisible(true);
  await flush();
  h.stream.setVisible(false);
  for (let i = 0; i < 3; i++) {
    await h.advance(15000);
    h.connections[0].emit(": heartbeat\n\n");
    await flush();
  }
  await h.advance(14999);
  expect(h.connections[0].signal.aborted).toBe(false);
  await h.advance(1);
  expect(h.connections[0].signal.aborted).toBe(true);
  await h.advance(60000);
  expect(h.connections).toHaveLength(1);
  h.stream.setVisible(true);
  await flush();
  expect(h.connections).toHaveLength(2);
  h.stream.close();
  await h.advance(60000);
  expect(h.connections).toHaveLength(2);
  expect(h.state().timers).toBe(0);
});

test("authorization denial stops delivery and reconnect instead of retaining tenant hints", async () => {
  const h = harness(403);
  h.stream.setVisible(true);
  await flush();
  expect(h.state().denied).toBe(1);
  expect(h.events).toEqual([]);
  await h.advance(120000);
  h.stream.setVisible(true);
  await flush();
  expect(h.connections).toHaveLength(1);
  expect(h.state().timers).toBe(0);
  expect(() =>
    liveStream({
      path: "https://other.invalid/events",
      onEvent() {},
      onConnect() {},
      onDegraded() {},
      onDenied() {},
    }),
  ).toThrow("scope");
});

test("reconnect backoff remains capped and oversized frames are disconnected", async () => {
  const h = harness();
  h.stream.setVisible(true);
  await flush();
  for (const [index, delay] of [
    1000, 2000, 4000, 8000, 16000, 30000, 30000,
  ].entries()) {
    if (index === 0) h.connections[index].emit("data: " + "x".repeat(65536));
    else h.connections[index].end();
    await flush();
    await h.advance(delay - 1);
    expect(h.connections).toHaveLength(index + 1);
    await h.advance(1);
    expect(h.connections).toHaveLength(index + 2);
  }
  expect(h.events).toEqual([]);
  h.stream.close();
});

test("stalled headers time out and late responses after close cannot deliver hints", async () => {
  let callback: (() => void) | undefined, finish!: (response: Response) => void;
  let signal: AbortSignal | undefined,
    degraded = 0,
    opened = 0,
    received = 0,
    cancelled = false;
  const stream = liveStream(
    {
      path,
      onEvent() {
        received++;
      },
      onConnect() {
        opened++;
      },
      onDegraded() {
        degraded++;
      },
      onDenied() {},
    },
    {
      fetch: (_url, options) => {
        signal = options?.signal ?? undefined;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      now: () => 0,
      random: () => 0.5,
      later: (fn) => {
        callback = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    },
  );
  stream.setVisible(true);
  callback!();
  expect(signal?.aborted).toBe(true);
  expect(degraded).toBe(1);
  stream.close();
  finish(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encode("event: state\ndata: {}\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
  );
  await flush();
  expect({ opened, received, cancelled }).toEqual({
    opened: 0,
    received: 0,
    cancelled: true,
  });
});

test("workspace visibly degrades on silent fetch stream and clears it at logout", async ({
  page,
}) => {
  const tenant = "00000000-0000-4000-8000-000000000001";
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.fetch;
    const state = { opens: 0, aborts: 0 };
    Object.assign(window, { liveTest: state });
    window.fetch = async (input, options) => {
      if (typeof input === "string" && input.endsWith("/events")) {
        state.opens++;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: state\ndata: {"view_generation":"1"}\n\n',
              ),
            );
            options?.signal?.addEventListener("abort", () => {
              state.aborts++;
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return original(input, options);
    };
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        data: {
          principal: { id: "test", display_name: "Synthetic live user" },
          csrf_token: "test",
          tenants: [
            {
              id: tenant,
              name: "Global",
              kind: "global",
              role: "view",
              revision: "1",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/auth/logout", (route) =>
    route.fulfill({ json: { data: { provider_logout_completed: true } } }),
  );
  await page.route("**/api/tenants/**", (route) =>
    route.fulfill({
      json: {
        data: route.request().url().endsWith("view-state")
          ? { view_generation: "1" }
          : [],
        meta: { total: "0" },
      },
    }),
  );
  await page.goto(`/tenants/${tenant}/alerts`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Development StrictMode deliberately mounts, cleans up and remounts effects.
  const initialOpens = await page.evaluate(
    () => (window as unknown as { liveTest: { opens: number } }).liveTest.opens,
  );
  await page.clock.fastForward(30000);
  await expect(
    page.getByText("Live delivery degraded · reconciling", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(1200);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { liveTest: { opens: number } }).liveTest.opens,
    ),
  ).toBe(initialOpens + 1);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in with company account" }),
  ).toBeVisible();
  await page.clock.fastForward(60000);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { liveTest: { opens: number; aborts: number } })
          .liveTest,
    ),
  ).toEqual({ opens: initialOpens + 1, aborts: initialOpens + 1 });
});
