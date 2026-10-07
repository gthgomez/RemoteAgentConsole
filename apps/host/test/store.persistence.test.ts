import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp } from "../src/index.js";
import type { RuntimeSupervisorPort } from "../src/ports.js";
import { SQLiteHostStore } from "../src/store.js";

const directories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rac-store-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLiteHostStore", () => {
  it("persists projects, sessions, turns, events, sequence numbers, and idempotency results", () => {
    const filename = databasePath();
    const project = { id: "project-1", displayName: "Demo", path: "/private/demo" };
    const first = new SQLiteHostStore({ filename, projects: [project] });
    first.sessions.set("session-1", {
      summary: {
        id: "session-1",
        machineId: "machine-1",
        projectId: project.id,
        runtimeId: "fake",
        status: "running",
        createdAt: "2026-10-07T00:00:00.000Z",
        updatedAt: "2026-10-07T00:00:01.000Z",
        activeTurnId: "turn-1",
      },
      runtimeSession: null,
    });
    first.createTurn({
      id: "turn-1",
      sessionId: "session-1",
      prompt: "inspect verifier",
      status: "running",
      createdAt: "2026-10-07T00:00:01.000Z",
    });
    first.appendEvent("session-1", {
      eventId: "event-1",
      sequence: first.nextSequence("session-1"),
      machineId: "machine-1",
      sessionId: "session-1",
      timestamp: "2026-10-07T00:00:01.000Z",
      eventType: "turn.started",
      payload: { turnId: "turn-1" },
    });
    first.saveIdempotency("prompt:session-1:request-1", {
      fingerprint: '{"requestId":"request-1","text":"inspect verifier"}',
      statusCode: 202,
      body: { accepted: true, requestId: "request-1", turnId: "turn-1" },
    });
    first.close();

    const restored = new SQLiteHostStore({ filename });
    expect(restored.projects.get(project.id)).toEqual(project);
    expect(restored.sessions.get("session-1")?.summary).toMatchObject({
      id: "session-1",
      activeTurnId: "turn-1",
      status: "running",
    });
    expect(restored.sessions.get("session-1")?.runtimeSession).toBeNull();
    expect(restored.turns.get("turn-1")).toMatchObject({ prompt: "inspect verifier" });
    expect(restored.nextSequence("session-1")).toBe(2);
    expect(restored.events.get("session-1")).toHaveLength(1);
    expect(restored.idempotency.get("prompt:session-1:request-1")).toMatchObject({
      statusCode: 202,
      body: { turnId: "turn-1" },
    });
    restored.close();
  });

  it("replays persisted events after the requested sequence", () => {
    const filename = databasePath();
    const store = new SQLiteHostStore({ filename });
    store.sessions.set("session-1", {
      summary: {
        id: "session-1",
        machineId: "machine-1",
        projectId: "project-1",
        runtimeId: "fake",
        status: "idle",
        createdAt: "2026-10-07T00:00:00.000Z",
        updatedAt: "2026-10-07T00:00:00.000Z",
        activeTurnId: null,
      },
      runtimeSession: null,
    });
    const makeEvent = (sequence: number) => ({
      eventId: `event-${sequence}`,
      sequence,
      machineId: "machine-1",
      sessionId: "session-1",
      timestamp: "2026-10-07T00:00:00.000Z",
      eventType: "message.delta" as const,
      payload: { turnId: "turn-1", text: String(sequence) },
    });
    store.appendEvent("session-1", makeEvent(1));
    store.appendEvent("session-1", makeEvent(2));
    store.close();

    const restored = new SQLiteHostStore({ filename });
    const subscription = restored.subscribe("session-1", 1, () => {});
    expect(subscription.replay.map((event) => event.sequence)).toEqual([2]);
    subscription.close();
    restored.close();
  });

  it("recovers event sequence and replays prior prompt results after a host restart", async () => {
    const filename = databasePath();
    const project = { id: "project-1", displayName: "Demo", path: "/private/demo" };
    const projectList = [project];
    const prompts: string[] = [];
    let nextId = 0;
    const makeId = (kind: "session" | "turn" | "event") => `${kind}-${++nextId}`;
    const supervisor: RuntimeSupervisorPort = {
      runtimes: () => [
        {
          id: "fake",
          displayName: "Fake ACP",
          installed: true,
          version: "1",
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
      createSession: async () => ({
        prompt: async (_turnId, prompt) => {
          prompts.push(prompt);
        },
        cancel: async () => {},
        respondPermission: async () => {},
      }),
    };

    const firstStore = new SQLiteHostStore({ filename, projects: projectList });
    const firstApp = createHostApp({
      machineId: "machine-1",
      projects: projectList,
      supervisor,
      store: firstStore,
      makeId,
    });
    const created = await firstApp.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-1", projectId: project.id, runtimeId: "fake" },
    });
    const sessionId = created.json().session.id as string;
    const firstPrompt = await firstApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/prompts`,
      payload: { requestId: "prompt-1", text: "inspect verifier" },
    });
    const priorSequence = firstStore.nextSequence(sessionId) - 1;
    expect(firstPrompt.statusCode).toBe(202);
    expect(prompts).toEqual(["inspect verifier"]);
    await firstApp.close();

    const secondStore = new SQLiteHostStore({ filename });
    const secondApp = createHostApp({
      machineId: "machine-1",
      projects: projectList,
      supervisor,
      store: secondStore,
      makeId,
    });
    const sessions = await secondApp.inject({ method: "GET", url: "/api/v1/sessions" });
    expect(sessions.json().sessions[0]).toMatchObject({ id: sessionId, status: "failed" });
    expect(secondStore.turns.get(firstPrompt.json().turnId as string)?.status).toBe("failed");
    const retry = await secondApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/prompts`,
      payload: { requestId: "prompt-1", text: "inspect verifier" },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(firstPrompt.json());
    expect(prompts).toEqual(["inspect verifier"]);
    const conflict = await secondApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/prompts`,
      payload: { requestId: "prompt-1", text: "different mutation" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(prompts).toEqual(["inspect verifier"]);

    const address = await secondApp.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/sessions/${sessionId}/events`, {
      headers: { "last-event-id": String(priorSequence) },
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const read = await reader?.read();
    const body = new TextDecoder().decode(read?.value);
    await reader?.cancel();
    expect(response.status).toBe(200);
    expect(body).toContain("Host restarted during the active turn");
    expect(body).toContain(`id: ${priorSequence + 1}`);
    await secondApp.close();
  });
});
