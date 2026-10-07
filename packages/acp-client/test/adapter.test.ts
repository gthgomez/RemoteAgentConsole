import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntimeAdapter } from "../src/index.js";

const fakeAgent = new URL("../../testkit/src/fake-agent.js", import.meta.url);
const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

function adapter(script = fakeAgent.pathname) {
  return createAcpRuntimeAdapter({
    id: "fake",
    displayName: "Fake ACP",
    command: process.execPath,
    args: [script],
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

  it("rejects connection setup when the child exits before ACP initialization", async () => {
    const failed = createAcpRuntimeAdapter({
      id: "crash",
      displayName: "Crash",
      command: process.execPath,
      args: ["-e", "process.exit(23)"],
      projects: { demo: process.cwd() },
    });
    await expect(failed.connect({ projectId: "demo" })).rejects.toThrow();
  });

  it("reports a child crash after session creation", async () => {
    const connection = await adapter(new URL("./crash-agent.js", import.meta.url).pathname).connect(
      {
        projectId: "demo",
      },
    );
    const session = await connection.createSession();
    sessions.push(session);
    const failed = new Promise<void>((resolve) => {
      session.subscribe((event) => {
        if (event.type === "session.error") resolve();
      });
    });
    await failed;
  });
});
