import { describe, expect, it, vi } from "vitest";
import {
  createHostApp,
  InMemoryHostStore,
  type RuntimeSessionPort,
  type RuntimeSupervisorPort,
} from "../src/index.js";

const project = { id: "project-1", displayName: "Demo project", path: "/private/demo" };

function harness() {
  const callbacks = new Map<string, (event: unknown) => void>();
  const calls = {
    prompts: [] as Array<{ turnId: string; text: string }>,
    cancels: [] as string[],
    permissions: [] as Array<{ permissionId: string; optionId: string }>,
  };
  let sessionNumber = 0;
  let emitRuntimeEvent: ((event: unknown) => void) | undefined;
  const store = new InMemoryHostStore();
  const supervisor: RuntimeSupervisorPort = {
    runtimes: () => [
      {
        id: "fake",
        displayName: "Fake ACP",
        installed: true,
        version: "1.0.0",
        capabilities: {
          sessions: { create: true, resume: true, list: true },
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
    createSession: vi.fn(async ({ sessionId, onEvent }): Promise<RuntimeSessionPort> => {
      callbacks.set(sessionId, onEvent);
      emitRuntimeEvent = onEvent;
      return {
        prompt: async (turnId, text) => {
          calls.prompts.push({ turnId, text });
        },
        cancel: async (turnId) => {
          calls.cancels.push(turnId);
          emitRuntimeEvent?.({
            eventType: "turn.failed",
            payload: { turnId, message: "Turn cancelled" },
          });
        },
        respondPermission: async (permissionId, optionId) => {
          calls.permissions.push({ permissionId, optionId });
          emitRuntimeEvent?.({
            eventType: "permission.resolved",
            payload: { permissionId, optionId },
          });
        },
      };
    }),
  };
  const app = createHostApp({
    machineId: "machine-1",
    projects: [project],
    supervisor,
    store,
    makeId: (kind) => `${kind}-${++sessionNumber}`,
  });
  return {
    app,
    callbacks,
    calls,
    supervisor,
    store,
    emitRuntimeEvent: (event: unknown) => emitRuntimeEvent?.(event),
  };
}

describe("host API", () => {
  it("creates sessions from allowlisted IDs and never returns local paths", async () => {
    const { app, supervisor } = harness();
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).json()).toEqual({
      status: "ok",
    });
    const runtimes = await app.inject({ method: "GET", url: "/api/v1/runtimes" });
    expect(runtimes.json().runtimes[0]).toMatchObject({ id: "fake", installed: true });
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual({
      projects: [{ id: "project-1", displayName: "Demo project" }],
    });
    expect(projects.body).not.toContain("/private/demo");

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-path", projectId: "/private/demo", runtimeId: "fake" },
    });
    expect(denied.statusCode).toBe(404);
    const createRequest = {
      method: "POST" as const,
      url: "/api/v1/sessions",
      payload: { requestId: "create-1", projectId: "project-1", runtimeId: "fake" },
    };
    const [created, retried] = await Promise.all([
      app.inject(createRequest),
      app.inject(createRequest),
    ]);
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({
      id: "session-1",
      projectId: "project-1",
      runtimeId: "fake",
      status: "idle",
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toEqual(created.json());
    expect(supervisor.createSession).toHaveBeenCalledTimes(1);
    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-1", projectId: "project-1", runtimeId: "different" },
    });
    expect(reused.statusCode).toBe(409);
    await app.close();
  });

  it("validates prompt bodies, returns an idempotent result, and conflicts on another active turn", async () => {
    const { app, calls } = harness();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-2", projectId: "project-1", runtimeId: "fake" },
    });
    const id = session.json().session.id as string;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/prompts`,
      payload: { requestId: "r0", text: "", extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    const payload = { requestId: "prompt-1", text: "hello" };
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/prompts`,
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, requestId: "prompt-1" });
    expect(accepted.json().turnId).toBeTypeOf("string");
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/prompts`,
      payload,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(accepted.json());
    expect(calls.prompts).toHaveLength(1);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/prompts`,
      payload: { requestId: "prompt-2", text: "second" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("active_turn");
    expect(calls.prompts).toHaveLength(1);
    await app.close();
  });

  it("responds only with an exact stored permission option and supports cancellation", async () => {
    const { app, callbacks, calls, store } = harness();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-3", projectId: "project-1", runtimeId: "fake" },
    });
    const id = session.json().session.id as string;
    const prompt = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/prompts`,
      payload: { requestId: "p1", text: "work" },
    });
    const turnId = prompt.json().turnId as string;
    callbacks.get(id)?.({
      eventType: "permission.requested",
      payload: {
        turnId,
        permissionId: "permission-1",
        title: "Run?",
        options: [{ optionId: "allow-once", name: "Allow once" }],
      },
    });
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/permissions/permission-1/respond",
      payload: { requestId: "answer-1", optionId: "allow" },
    });
    expect(bad.statusCode).toBe(400);
    expect(calls.permissions).toHaveLength(0);
    const good = await app.inject({
      method: "POST",
      url: "/api/v1/permissions/permission-1/respond",
      payload: { requestId: "answer-1", optionId: "allow-once" },
    });
    expect(good.statusCode).toBe(200);
    expect(
      store.events.get(id)?.filter((event) => event.eventType === "permission.resolved"),
    ).toHaveLength(1);
    expect(calls.permissions).toEqual([{ permissionId: "permission-1", optionId: "allow-once" }]);
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/permissions/permission-1/respond",
      payload: { requestId: "answer-1", optionId: "allow-once" },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(good.json());
    expect(calls.permissions).toHaveLength(1);
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/cancel`,
      payload: { requestId: "cancel-1", turnId },
    });
    expect(canceled.statusCode).toBe(202);
    const cancelRetry = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/cancel`,
      payload: { requestId: "cancel-1", turnId },
    });
    expect(cancelRetry.json()).toEqual(canceled.json());
    expect(calls.cancels).toEqual([turnId]);
    await app.close();
  });

  it("fails the active turn on a runtime session error and clears the turn", async () => {
    const { app, emitRuntimeEvent, store } = harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-error", projectId: "project-1", runtimeId: "fake" },
    });
    const sessionId = created.json().session.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/prompts`,
      payload: { requestId: "prompt-error", text: "run" },
    });
    const turnId = accepted.json().turnId as string;

    emitRuntimeEvent({
      eventType: "session.error",
      payload: { message: "ACP process exited unexpectedly" },
    });

    const detail = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    expect(detail.json().session).toMatchObject({ status: "failed", activeTurnId: null });
    expect(store.events.get(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "turn.failed",
          payload: { turnId, message: "ACP process exited unexpectedly" },
        }),
        expect.objectContaining({
          eventType: "session.error",
          payload: { message: "ACP process exited unexpectedly" },
        }),
      ]),
    );
    await app.close();
  });

  it("expires a pending permission when its active turn is canceled", async () => {
    const { app, callbacks } = harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-cancel-permission", projectId: "project-1", runtimeId: "fake" },
    });
    const sessionId = created.json().session.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/prompts`,
      payload: { requestId: "prompt-cancel-permission", text: "run" },
    });
    const turnId = accepted.json().turnId as string;
    callbacks.get(sessionId)?.({
      eventType: "permission.requested",
      payload: {
        turnId,
        permissionId: "permission-pending",
        title: "Run?",
        options: [{ optionId: "allow-once", name: "Allow once" }],
      },
    });

    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/cancel`,
      payload: { requestId: "cancel-pending-permission", turnId },
    });
    expect(canceled.statusCode).toBe(202);
    const detail = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    expect(detail.json().session).toMatchObject({ status: "failed", activeTurnId: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/permissions/permission-pending/respond",
      payload: { requestId: "answer-expired", optionId: "allow-once" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("permission_not_found");
    await app.close();
  });

  it("replays later per-session events and continues with live events without sequence gaps", async () => {
    const { app, callbacks } = harness();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-4", projectId: "project-1", runtimeId: "fake" },
    });
    const id = session.json().session.id as string;
    callbacks.get(id)?.({ eventType: "message.delta", payload: { turnId: "t", text: "one" } });
    callbacks.get(id)?.({ eventType: "message.delta", payload: { turnId: "t", text: "two" } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/sessions/${id}/events`, {
      headers: { "last-event-id": "3" },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes('"text":"live"')) {
      const read = reader?.read();
      if (!read) throw new Error("SSE reader missing");
      const chunk = await Promise.race([
        read,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out reading SSE")), 1500),
        ),
      ]);
      if (chunk.done) break;
      body += decoder.decode(chunk.value);
      if (body.includes('"text":"two"')) {
        callbacks.get(id)?.({ eventType: "message.delta", payload: { turnId: "t", text: "live" } });
      }
    }
    await reader?.cancel();
    expect(body).toContain("id: 4");
    expect(body).toContain('"text":"two"');
    expect(body).toContain("id: 5");
    expect(body).toContain('"text":"live"');
    expect(body).not.toContain("event:");
    await app.close();
  });

  it("maps missing sessions and invalid replay cursors to stable API errors", async () => {
    const { app } = harness();
    const missing = await app.inject({ method: "GET", url: "/api/v1/sessions/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    const badCursor = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/nope/events",
      headers: { "last-event-id": "bad" },
    });
    expect(badCursor.statusCode).toBe(400);
    await app.close();
  });
});
