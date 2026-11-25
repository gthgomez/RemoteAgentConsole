import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntimeOptions } from "@remote-agent-console/acp-client";
import type { RuntimeCapabilities } from "@remote-agent-console/contracts";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
} from "@remote-agent-console/runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp } from "../src/index.js";
import { createRuntimeSupervisor } from "../src/runtime-supervisor.js";

const capabilities: RuntimeCapabilities = {
  sessions: { create: true, resume: false, list: false },
  interaction: { cancel: true, permissions: true, questions: false },
  models: { selectable: false, effort: false },
  modes: false,
  plans: false,
  commands: false,
  images: false,
  files: false,
};
const temporaryDirectories: string[] = [];
const expectedVersions =
  process.platform === "win32"
    ? { commandCode: process.version, openCode: process.version.replace(/^v/, "") }
    : { commandCode: "1.2.3", openCode: "4.5.6" };

async function makeExecutable(directory: string, name: string, version: string): Promise<string> {
  // Windows needs a real named executable; a copied node.exe reports its own version.
  if (process.platform === "win32") {
    const path = join(directory, `${name}.exe`);
    await copyFile(process.execPath, path);
    return path;
  }
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
  return path;
}

async function makeRuntimeFixtures() {
  const directory = await mkdtemp(join(tmpdir(), "host-runtime-supervisor-"));
  temporaryDirectories.push(directory);
  return {
    commandCode: await makeExecutable(directory, "command-code", "1.2.3"),
    openCode: await makeExecutable(directory, "opencode", "v4.5.6"),
  };
}

function createFakeAcpFactory(received: AcpRuntimeOptions[], cancelled: string[] = []) {
  return (options: AcpRuntimeOptions): RuntimeAdapter => {
    received.push(options);
    return {
      id: options.id,
      displayName: options.displayName,
      async connect({ projectId }) {
        expect(options.projects[projectId]).toBeDefined();
        const listeners = new Set<(event: RuntimeEvent) => void>();
        const session: RuntimeSession = {
          id: `runtime-${options.id}-session`,
          capabilities,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt(text) {
            for (const listener of listeners) {
              listener({ type: "message.delta", turnId: "adapter-generated", text });
              listener({
                type: "permission.requested",
                turnId: "adapter-generated",
                permissionId: "runtime-permission",
                title: "Run tool",
                options: [{ optionId: "allow-once", name: "Allow once" }],
              });
            }
          },
          async cancel() {
            cancelled.push(options.id);
          },
          async resolvePermission(permissionId, optionId) {
            for (const listener of listeners) {
              listener({ type: "permission.resolved", permissionId, optionId });
            }
          },
          async close() {},
        };
        return {
          capabilities,
          async createSession() {
            return session;
          },
          async close() {},
        };
      },
    };
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("general runtime supervisor", () => {
  it("lists discovered runtimes and creates their ACP adapters from executable configuration", async () => {
    const executables = await makeRuntimeFixtures();
    const received: AcpRuntimeOptions[] = [];
    const cancelled: string[] = [];
    const project = { id: "repo", displayName: "Repo", path: "/tmp/repo" };
    const supervisor = createRuntimeSupervisor({
      projects: [project],
      env: {
        PATH: "/usr/bin",
        RAC_COMMAND_CODE_EXECUTABLE: executables.commandCode,
        RAC_OPENCODE_EXECUTABLE: executables.openCode,
      },
      adapterFactory: createFakeAcpFactory(received, cancelled),
    });

    expect(
      (await supervisor.runtimes()).map(({ id, installed, version }) => ({
        id,
        installed,
        version,
      })),
    ).toEqual([
      { id: "fake", installed: true, version: "0.1.0" },
      { id: "command-code", installed: true, version: expectedVersions.commandCode },
      { id: "opencode", installed: true, version: expectedVersions.openCode },
    ]);

    const onEvent = vi.fn();
    const session = await supervisor.createSession({
      sessionId: "host-session",
      projectId: project.id,
      projectPath: project.path,
      runtimeId: "opencode",
      onEvent,
    });
    await session.prompt("hello", "safe text");
    await session.respondPermission("host-session:runtime-permission", "allow-once");
    await session.cancel("hello");

    expect(received).toHaveLength(2);
    expect(cancelled).toEqual(["opencode"]);
    expect(received[1]).toMatchObject({
      id: "opencode",
      command: executables.openCode,
      args: ["acp"],
      projects: { repo: "/tmp/repo" },
    });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { eventType: "message.delta", payload: { turnId: "hello", text: "safe text" } },
      {
        eventType: "permission.requested",
        payload: {
          turnId: "hello",
          permissionId: "host-session:runtime-permission",
          title: "Run tool",
          options: [{ optionId: "allow-once", name: "Allow once" }],
        },
      },
      {
        eventType: "permission.resolved",
        payload: { permissionId: "host-session:runtime-permission", optionId: "allow-once" },
      },
    ]);
    await supervisor.close?.();
  });

  it("serves the runtime catalog and accepts selected runtimes through host REST", async () => {
    const executables = await makeRuntimeFixtures();
    const received: AcpRuntimeOptions[] = [];
    const project = { id: "repo", displayName: "Repo", path: "/tmp/repo" };
    const supervisor = createRuntimeSupervisor({
      projects: [project],
      env: {
        PATH: "/usr/bin",
        RAC_COMMAND_CODE_EXECUTABLE: executables.commandCode,
        RAC_OPENCODE_EXECUTABLE: executables.openCode,
      },
      adapterFactory: createFakeAcpFactory(received),
    });
    const app = createHostApp({ machineId: "machine", projects: [project], supervisor });

    const catalog = await app.inject({ method: "GET", url: "/api/v1/runtimes" });
    expect(catalog.json().runtimes.map((runtime: { id: string }) => runtime.id)).toEqual([
      "fake",
      "command-code",
      "opencode",
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { requestId: "create-1", projectId: "repo", runtimeId: "command-code" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session.runtimeId).toBe("command-code");
    expect(received[0]).toMatchObject({ id: "command-code", command: executables.commandCode });
    await app.close();
  });
});
