import { describe, expect, it, vi } from "vitest";
import { HostClient } from "../../../packages/client-sdk/src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HostClient event history recovery", () => {
  it("restarts from the oldest retained event after a valid 410", async () => {
    const requests: Array<string | null> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push(headers.get("Last-Event-ID"));
      if (requests.length === 1) {
        return jsonResponse(410, {
          error: {
            code: "event_history_expired",
            message: "Cursor expired",
            oldestSequence: 17,
          },
        });
      }
      const event = {
        eventId: "event-17",
        sequence: 17,
        machineId: "machine-1",
        sessionId: "session-1",
        timestamp: "2026-10-07T00:00:00.000Z",
        eventType: "session.status_changed",
        payload: { status: "idle" },
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`id: 17\ndata: ${JSON.stringify(event)}\n\n`),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const onEvent = vi.fn();
    const client = new HostClient({ fetch: fetcher as typeof fetch });
    const stop = client.subscribe("session-1", { onEvent, onReconnect: () => {} });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(requests).toEqual([null, "16"]);
    stop();
  });

  it("stops reconnecting when a 410 response has an invalid recovery cursor", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () =>
        jsonResponse(410, {
          error: { code: "event_history_expired", message: "Cursor expired", oldestSequence: 0 },
        }),
      );
      const client = new HostClient({ fetch: fetcher as unknown as typeof fetch });
      const stop = client.subscribe("session-1", { onEvent: () => {}, onReconnect: () => {} });

      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds repeated valid 410 recovery responses", async () => {
    vi.useFakeTimers();
    try {
      const cursors: Array<string | null> = [];
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        cursors.push(new Headers(init?.headers).get("Last-Event-ID"));
        return jsonResponse(410, {
          error: {
            code: "event_history_expired",
            message: "Cursor expired",
            oldestSequence: cursors.length + 20,
          },
        });
      });
      const client = new HostClient({ fetch: fetcher as typeof fetch });
      const stop = client.subscribe("session-1", { onEvent: () => {}, onReconnect: () => {} });

      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      for (let recovery = 0; recovery < 3; recovery += 1) {
        await vi.advanceTimersByTimeAsync(750);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(recovery + 2));
      }
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(cursors).toEqual([null, "20", "21", "22"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
