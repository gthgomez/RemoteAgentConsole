import { afterEach, describe, expect, it } from "vitest";
import { createFakeRuntimeSupervisor } from "../src/fake-runtime.js";
import { createHostApp } from "../src/index.js";

const projectPath = process.cwd();
const project = { id: "demo", displayName: "Demo project", path: projectPath };
interface StreamEnvelope {
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
}

describe("host with the fake ACP runtime", () => {
  let closeApp: (() => Promise<void>) | undefined;
  let closeStream: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeStream?.();
    closeStream = undefined;
    await closeApp?.();
    closeApp = undefined;
  });

  it("streams a prompt through ACP, resolves the runtime permission, completes, and cancels", async () => {
    const supervisor = createFakeRuntimeSupervisor({ projects: [project] });
    const app = createHostApp({ machineId: "machine-test", projects: [project], supervisor });
    closeApp = () => app.close();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const projectsResponse = await fetch(`${address}/api/v1/projects`);
    expect(await projectsResponse.json()).toEqual({
      projects: [{ id: "demo", displayName: "Demo project" }],
    });
    const runtimeResponse = await fetch(`${address}/api/v1/runtimes`);
    expect((await runtimeResponse.json()).runtimes[0]).toMatchObject({
      id: "fake",
      displayName: "Fake ACP",
      installed: true,
    });

    const created = await fetch(`${address}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "create-1", projectId: "demo", runtimeId: "fake" }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()).session;
    expect(JSON.stringify(session)).not.toContain(projectPath);

    const eventsResponse = await fetch(`${address}/api/v1/sessions/${session.id}/events`, {
      headers: { "last-event-id": "2" },
    });
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    closeStream = async () => {
      await reader?.cancel();
    };
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async (): Promise<StreamEnvelope> => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) throw new Error("SSE stream ended unexpectedly");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const split = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error(`SSE frame had no data line: ${frame}`);
      return JSON.parse(data.slice(6)) as StreamEnvelope;
    };

    const promptResponse = await fetch(`${address}/api/v1/sessions/${session.id}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "prompt-1", text: "inspect the demo" }),
    });
    expect(promptResponse.status).toBe(202);
    const accepted = await promptResponse.json();
    const firstTurnEvents = [];
    for (;;) {
      const event = await nextEvent();
      firstTurnEvents.push(event);
      if (event.eventType === "permission.requested") {
        expect(event.payload.turnId).toBe(accepted.turnId);
        const permissionResponse = await fetch(
          `${address}/api/v1/permissions/${event.payload.permissionId as string}/respond`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: "permission-1", optionId: "allow-once" }),
          },
        );
        expect(permissionResponse.status).toBe(200);
      }
      if (event.eventType === "turn.completed") break;
    }
    expect(firstTurnEvents.some((event) => event.eventType === "message.delta")).toBe(true);
    expect(firstTurnEvents.some((event) => event.eventType === "tool.updated")).toBe(true);
    expect(firstTurnEvents.some((event) => event.eventType === "permission.resolved")).toBe(true);
    expect(firstTurnEvents.at(-1)?.eventType).toBe("turn.completed");
    for (const event of firstTurnEvents) {
      if ("turnId" in event.payload) expect(event.payload.turnId).toBe(accepted.turnId);
    }
    expect(firstTurnEvents.map((event) => event.sequence)).toEqual(
      firstTurnEvents.map((_, index) => index + 3),
    );

    const secondPrompt = await fetch(`${address}/api/v1/sessions/${session.id}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "prompt-2", text: "cancel this" }),
    });
    const secondAccepted = await secondPrompt.json();
    const cancelResponse = await fetch(`${address}/api/v1/sessions/${session.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "cancel-1", turnId: secondAccepted.turnId }),
    });
    expect(cancelResponse.status).toBe(202);
    let canceledEvent: StreamEnvelope;
    do {
      canceledEvent = await nextEvent();
    } while (canceledEvent.eventType !== "turn.failed");
    expect(canceledEvent.payload.message).toBe("Turn cancelled");
    expect(canceledEvent.payload.turnId).toBe(secondAccepted.turnId);
  }, 15_000);
});
