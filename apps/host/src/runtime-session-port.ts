import type {
  RuntimeEvent as AcpRuntimeEvent,
  RuntimeAdapter,
  RuntimeSession,
} from "@remote-agent-console/runtime-core";
import type { RuntimeEvent, RuntimeSessionPort } from "./ports.js";

export async function createRuntimeSessionPort(
  adapter: RuntimeAdapter,
  input: {
    sessionId: string;
    projectId: string;
    onEvent: (event: RuntimeEvent) => void;
  },
): Promise<RuntimeSessionPort & { close(): Promise<void> }> {
  const connection = await adapter.connect({ projectId: input.projectId });
  let runtimeSession: RuntimeSession;
  try {
    runtimeSession = await connection.createSession();
  } catch (error) {
    await connection.close();
    throw error;
  }

  let hostTurnId: string | null = null;
  let closed = false;
  const permissionIds = new Map<string, string>();
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
        const permissionId = `${input.sessionId}:${event.permissionId}`;
        permissionIds.set(event.permissionId, permissionId);
        return {
          eventType: "permission.requested",
          payload: {
            turnId: hostTurnId ?? event.turnId,
            permissionId,
            title: event.title,
            options: event.options.map((option) => ({ ...option })),
          },
        };
      }
      case "permission.resolved": {
        const permissionId = permissionIds.get(event.permissionId);
        if (!permissionId) {
          return {
            eventType: "session.error",
            payload: { message: "Runtime resolved an unknown permission" },
          };
        }
        permissionIds.delete(event.permissionId);
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
        hostTurnId = null;
        return { eventType: "session.error", payload: { message: event.message } };
    }
  };
  const unsubscribe = runtimeSession.subscribe((event) => input.onEvent(toHostEvent(event)));

  return {
    async prompt(turnId, text) {
      if (closed) throw new Error("Runtime session is closed");
      hostTurnId = turnId;
      try {
        await runtimeSession.prompt(text);
      } catch (error) {
        if (hostTurnId === turnId) hostTurnId = null;
        throw error;
      }
    },
    async cancel(_turnId) {
      if (closed) return;
      await runtimeSession.cancel();
    },
    async respondPermission(permissionId, optionId) {
      if (closed) throw new Error("Runtime session is closed");
      const runtimePermissionId = [...permissionIds].find(
        ([, publicId]) => publicId === permissionId,
      )?.[0];
      if (!runtimePermissionId) throw new Error(`Unknown permission: ${permissionId}`);
      await runtimeSession.resolvePermission(runtimePermissionId, optionId);
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      try {
        await runtimeSession.close();
      } finally {
        await connection.close();
      }
    },
  };
}
