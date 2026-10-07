import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { createAcpRuntimeAdapter } from "@remote-agent-console/acp-client";
import type { RuntimeCapabilities } from "@remote-agent-console/contracts";
import type {
  RuntimeEvent as AcpRuntimeEvent,
  RuntimeAdapter,
  RuntimeSession,
} from "@remote-agent-console/runtime-core";
import type { HostProject } from "./index.js";
import type { RuntimeEvent, RuntimeSessionPort, RuntimeSupervisorPort } from "./ports.js";

export interface FakeRuntimeSupervisorOptions {
  projects: readonly HostProject[];
}

const require = createRequire(import.meta.url);

const fakeCapabilities: RuntimeCapabilities = {
  sessions: { create: true, resume: false, list: false },
  interaction: { cancel: true, permissions: true, questions: false },
  models: { selectable: false, effort: false },
  modes: true,
  plans: false,
  commands: false,
  images: false,
  files: false,
};

/** Composes the testkit ACP process behind the runtime-neutral host port. */
export function createFakeRuntimeSupervisor(
  options: FakeRuntimeSupervisorOptions,
): RuntimeSupervisorPort {
  const projects = new Map(options.projects.map((project) => [project.id, project]));
  const adapter: RuntimeAdapter = createAcpRuntimeAdapter({
    id: "fake",
    displayName: "Fake ACP",
    command: process.execPath,
    args: [require.resolve("@remote-agent-console/testkit")],
    projects: Object.fromEntries(options.projects.map((project) => [project.id, project.path])),
  });
  const sessions = new Set<RuntimeSessionPort & { close(): Promise<void> }>();

  return {
    runtimes: () => [
      {
        id: adapter.id,
        displayName: adapter.displayName,
        installed: true,
        version: "0.1.0",
        capabilities: fakeCapabilities,
      },
    ],
    async createSession(input): Promise<RuntimeSessionPort> {
      const project: HostProject | undefined = projects.get(input.projectId);
      if (!project || !isAbsolute(project.path) || project.path !== input.projectPath) {
        throw new Error("Runtime session project does not match the host allowlist");
      }

      const connection = await adapter.connect({ projectId: input.projectId });
      let runtimeSession: RuntimeSession;
      try {
        runtimeSession = await connection.createSession();
      } catch (error) {
        await connection.close();
        throw error;
      }

      let hostTurnId: string | null = null;
      const runtimePermissionIds = new Map<string, string>();
      const toHostEvent = (event: AcpRuntimeEvent): RuntimeEvent => {
        switch (event.type) {
          case "message.delta":
            return {
              eventType: "message.delta",
              payload: { turnId: hostTurnId ?? event.turnId, text: event.text },
            };
          case "tool.updated":
            return {
              eventType: "tool.updated",
              payload: {
                turnId: hostTurnId ?? event.turnId,
                toolCallId: event.toolCallId,
                title: event.title,
                status: event.status,
              },
            };
          case "permission.requested": {
            const publicPermissionId = `${input.sessionId}:${event.permissionId}`;
            runtimePermissionIds.set(event.permissionId, publicPermissionId);
            return {
              eventType: "permission.requested",
              payload: {
                turnId: hostTurnId ?? event.turnId,
                permissionId: publicPermissionId,
                title: event.title,
                options: event.options.map((option) => ({ ...option })),
              },
            };
          }
          case "permission.resolved": {
            const permissionId = runtimePermissionIds.get(event.permissionId);
            if (!permissionId) {
              return {
                eventType: "session.error",
                payload: { message: "Runtime resolved an unknown permission" },
              };
            }
            runtimePermissionIds.delete(event.permissionId);
            return {
              eventType: "permission.resolved",
              payload: { permissionId, optionId: event.optionId },
            };
          }
          case "turn.completed": {
            const turnId = hostTurnId ?? event.turnId;
            hostTurnId = null;
            return { eventType: "turn.completed", payload: { turnId } };
          }
          case "turn.failed": {
            const turnId = hostTurnId ?? event.turnId;
            hostTurnId = null;
            return { eventType: "turn.failed", payload: { turnId, message: event.message } };
          }
          case "session.error":
            return { eventType: "session.error", payload: { message: event.message } };
          default: {
            const exhaustive: never = event;
            return exhaustive;
          }
        }
      };
      const unsubscribe = runtimeSession.subscribe((event) => input.onEvent(toHostEvent(event)));
      const sessionPort: RuntimeSessionPort & { close(): Promise<void> } = {
        async prompt(turnId, text) {
          hostTurnId = turnId;
          try {
            await runtimeSession.prompt(text);
          } catch (error) {
            hostTurnId = null;
            throw error;
          }
        },
        async cancel(_turnId) {
          await runtimeSession.cancel();
        },
        async respondPermission(permissionId, optionId) {
          const runtimePermissionId = [...runtimePermissionIds].find(
            ([, publicId]) => publicId === permissionId,
          )?.[0];
          if (!runtimePermissionId) throw new Error(`Unknown permission: ${permissionId}`);
          await runtimeSession.resolvePermission(runtimePermissionId, optionId);
        },
        async close() {
          unsubscribe();
          try {
            await runtimeSession.close();
          } finally {
            sessions.delete(sessionPort);
            await connection.close();
          }
        },
      };
      sessions.add(sessionPort);
      return sessionPort;
    },
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
    },
  };
}
