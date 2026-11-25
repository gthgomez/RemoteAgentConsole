import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "@remote-agent-console/runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntimeAdapter } from "../src/index.js";

const fakeAgent = fileURLToPath(new URL("../../testkit/src/fake-agent.js", import.meta.url));
const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

function adapter(script = fakeAgent, extraArgs: string[] = []) {
  return createAcpRuntimeAdapter({
    id: "fake",
    displayName: "Fake ACP",
    command: process.execPath,
    args: [script, ...extraArgs],
    projects: { demo: process.cwd() },
  });
}

describe("ACP runtime adapter", () => {
  it("normalizes streamed text and tool updates and continues after the chosen permission option", async () => {
    const connection = await adapter().connect({ projectId: "demo" });
    const session = await connection.createSession();
    sessions.push(session);
    expect(session.capabilities.modes).toBe(true);
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      session.subscribe((event) => {
        seen.push(event.type);
        if (event.type === "permission.requested") {
          expect(event.options.map((option) => option.optionId)).toEqual([
            "allow-once",
            "reject-once",
          ]);
          void session.resolvePermission(event.permissionId, "allow-once");
        }
        if (event.type === "turn.completed") resolve();
      });
    });

    await session.prompt("inspect the project");
    await done;
    expect(seen).toContain("message.delta");
    expect(seen).toContain("tool.updated");
    expect(seen).toContain("permission.requested");
  });

  it("cancels a running turn", async () => {
    const connection = await adapter().connect({ projectId: "demo" });
    const session = await connection.createSession();
    sessions.push(session);
    const canceled = new Promise<void>((resolve) => {
      session.subscribe((event) => {
        if (event.type === "turn.failed" && event.message === "Turn cancelled") resolve();
      });
    });
    await session.prompt("cancel this");
    await session.cancel();
    await canceled;
  });

  it("answers a pending permission as cancelled when cancelling the turn", async () => {
    const connection = await adapter().connect({ projectId: "demo" });
    const session = await connection.createSession();
    sessions.push(session);
    const canceled = new Promise<void>((resolve) => {
      session.subscribe((event) => {
        if (event.type === "permission.requested") void session.cancel();
        if (event.type === "turn.failed" && event.message === "Turn cancelled") resolve();
      });
    });
    await session.prompt("cancel while permission is pending");
    await canceled;
  });

  it("uses unique permission ids across independent runtime connections", async () => {
    const [firstConnection, secondConnection] = await Promise.all([
      adapter().connect({ projectId: "demo" }),
      adapter().connect({ projectId: "demo" }),
    ]);
    const [first, second] = await Promise.all([
      firstConnection.createSession(),
      secondConnection.createSession(),
    ]);
    sessions.push(first, second);
    const ids = new Set<string>();
    const done = new Promise<void>((resolve) => {
      let completed = 0;
      const receive = (session: typeof first, event: RuntimeEvent) => {
        if (event.type === "permission.requested") {
          ids.add(event.permissionId);
          void session.resolvePermission(event.permissionId, "allow-once");
        }
        if (event.type === "turn.completed" && ++completed === 2) resolve();
      };
      first.subscribe((event) => receive(first, event));
      second.subscribe((event) => receive(second, event));
    });
    await Promise.all([first.prompt("first"), second.prompt("second")]);
    await done;
    expect(ids.size).toBe(2);
  });

  it("rejects connection setup when the child exits before ACP initialization", async () => {
    const failed = createAcpRuntimeAdapter({
      id: "crash",
      displayName: "Crash",
      command: process.execPath,
      args: ["-e", "process.exit(23)"],
      projects: { demo: process.cwd() },
    });
    await expect(failed.connect({ projectId: "demo" })).rejects.toThrow(
      "The runtime could not initialize ACP.",
    );
  });

  it("does not expose a local executable path when the child cannot be spawned", async () => {
    const secretPath = `${process.cwd()}/private/runtime-binary`;
    const failed = createAcpRuntimeAdapter({
      id: "missing",
      displayName: "Missing",
      command: secretPath,
      projects: { demo: process.cwd() },
    });

    const error = await failed.connect({ projectId: "demo" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The runtime could not initialize ACP.");
    expect((error as Error).message).not.toContain(secretPath);
  });

  it("sanitizes local paths in ACP protocol errors before emitting session.error", async () => {
    const connection = await adapter(
      fileURLToPath(new URL("./protocol-error-agent.js", import.meta.url)),
    ).connect({ projectId: "demo" });
    const session = await connection.createSession();
    sessions.push(session);
    const event = new Promise<Extract<RuntimeEvent, { type: "session.error" }>>((resolve) => {
      session.subscribe((entry) => {
        if (entry.type === "session.error") resolve(entry);
      });
    });

    await session.prompt("fail with a private path");

    const failure = await event;
    expect(failure.message).toBe("The runtime could not complete the prompt.");
    expect(failure.message).not.toContain(process.cwd());
  });

  it("sanitizes local paths in ACP session creation failures", async () => {
    const connection = await adapter(
      fileURLToPath(new URL("./protocol-error-agent.js", import.meta.url)),
      ["session-new"],
    ).connect({ projectId: "demo" });
    try {
      const error = await connection.createSession().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("The runtime could not create a session.");
      expect((error as Error).message).not.toContain(process.cwd());
    } finally {
      await connection.close();
    }
  });

  it("reports a child crash after session creation", async () => {
    const connection = await adapter(
      fileURLToPath(new URL("./crash-agent.js", import.meta.url)),
    ).connect({
      projectId: "demo",
    });
    expect(connection.capabilities.sessions).toEqual({ create: true, resume: true, list: true });
    const session = await connection.createSession();
    sessions.push(session);
    const failed = new Promise<Extract<RuntimeEvent, { type: "session.error" }>>((resolve) => {
      session.subscribe((event) => {
        if (event.type === "session.error") resolve(event);
      });
    });
    const error = await failed;
    expect(error.message).toBe("The runtime process failed.");
    expect(error.message).not.toContain(process.cwd());
  });
});
