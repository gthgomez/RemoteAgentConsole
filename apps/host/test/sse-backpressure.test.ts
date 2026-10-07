import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type RuntimeEvent, type RuntimeSupervisorPort } from "../src/index.js";

const project = { id: "demo", displayName: "Demo", path: "/private/demo" };

describe("SSE backpressure", () => {
  let closeApp: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeApp?.();
    closeApp = undefined;
  });

  it("disconnects when replay reaches a slow writer and releases its stream slot", async () => {
    let slow = true;
    const writeSlowFrame = lowWaterMarkWriter();
    const app = createHostApp({
      machineId: "machine-1",
      projects: [project],
      supervisor: runtimeSupervisor(() => {}),
      sseConnectionLimits: { global: 1, perDevice: 1 },
      sseWrite: (response, chunk) => {
        if (slow) {
          slow = false;
          return writeSlowFrame(response, chunk);
        }
        return response.write(chunk);
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const sessionId = await createSession(address);

    await fetchEventStream(address, sessionId)
      .then((response) => response.body?.cancel())
      .catch(() => {});

    const replacement = await fetchEventStream(address, sessionId);
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
  });

  it("disconnects a slow live stream and releases its stream slot", async () => {
    let emit: (event: RuntimeEvent) => void = () => {};
    let slow = false;
    const writeSlowFrame = lowWaterMarkWriter();
    const app = createHostApp({
      machineId: "machine-1",
      projects: [project],
      supervisor: runtimeSupervisor((onEvent) => {
        emit = onEvent;
      }),
      sseConnectionLimits: { global: 1, perDevice: 1 },
      sseWrite: (response, chunk) =>
        slow ? writeSlowFrame(response, chunk) : response.write(chunk),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    closeApp = () => app.close();
    const sessionId = await createSession(address);
    const stream = await fetchEventStream(address, sessionId);
    expect(stream.status).toBe(200);

    slow = true;
    emit({ eventType: "session.status_changed", payload: { status: "idle" } });
    slow = false;
    await stream.body?.cancel().catch(() => {});

    const replacement = await fetchEventStream(address, sessionId);
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
  });
});

function lowWaterMarkWriter() {
  const slowWritable = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 10);
    },
  });
  return (_response: import("node:http").ServerResponse, chunk: string) =>
    slowWritable.write(chunk);
}

function runtimeSupervisor(
  onCreated: (onEvent: (event: RuntimeEvent) => void) => void,
): RuntimeSupervisorPort {
  return {
    runtimes: () => [
      {
        id: "fake",
        displayName: "Fake ACP",
        installed: true,
        version: "1.0.0",
        capabilities: {
          sessions: { create: true, resume: false, list: false },
          interaction: { cancel: true, permissions: true, questions: false },
          models: { selectable: false, effort: false },
          modes: false,
          plans: false,
          commands: false,
          images: false,
          files: false,
        },
      },
    ],
    createSession: async ({ onEvent }) => {
      onCreated(onEvent);
      return { prompt: async () => {}, cancel: async () => {}, respondPermission: async () => {} };
    },
  };
}

async function createSession(address: string): Promise<string> {
  const response = await fetch(`${address}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "session-1", projectId: "demo", runtimeId: "fake" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

function fetchEventStream(address: string, sessionId: string) {
  return fetch(`${address}/api/v1/sessions/${sessionId}/events`);
}
