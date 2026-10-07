import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { RuntimeCapabilities } from "@remote-agent-console/contracts";
import type {
  RuntimeAdapter,
  RuntimeConnection,
  RuntimeEvent,
  RuntimeSession,
} from "@remote-agent-console/runtime-core";

export interface AcpRuntimeOptions {
  id: string;
  displayName: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  projects: Readonly<Record<string, string>>;
}

const noCapabilities: RuntimeCapabilities = {
  sessions: { create: true, resume: false, list: false },
  interaction: { cancel: true, permissions: true, questions: false },
  models: { selectable: false, effort: false },
  modes: false,
  plans: false,
  commands: false,
  images: false,
  files: false,
};

type DeferredPermission = {
  resolve: (response: acp.RequestPermissionResponse) => void;
  options: readonly acp.PermissionOption[];
};

export function createAcpRuntimeAdapter(options: AcpRuntimeOptions): RuntimeAdapter {
  return {
    id: options.id,
    displayName: options.displayName,
    async connect({ projectId }): Promise<RuntimeConnection> {
      const cwd = options.projects[projectId];
      if (!cwd || !isAbsolute(cwd)) throw new Error(`Project is not allowlisted: ${projectId}`);
      const child = spawn(options.command, [...(options.args ?? [])], {
        cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const app = acp.client({ name: "remote-agent-console" });
      const listeners = new Set<(event: RuntimeEvent) => void>();
      const permissions = new Map<string, DeferredPermission>();
      let turnId = "turn-1";
      let permissionSequence = 0;
      let sessionId: string | undefined;
      let ended = false;
      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };
      const fail = (message: string) => {
        if (ended) return;
        ended = true;
        for (const permission of permissions.values()) {
          permission.resolve({ outcome: { outcome: "cancelled" } });
        }
        permissions.clear();
        emit({ type: "session.error", message });
      };

      app.onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const permissionId = `permission-${++permissionSequence}`;
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          permissions.set(permissionId, { resolve, options: params.options });
          emit({
            type: "permission.requested",
            turnId,
            permissionId,
            title: params.toolCall.title ?? params.toolCall.toolCallId,
            options: params.options.map((option) => ({ ...option })),
          });
        });
      });
      app.onNotification(acp.methods.client.session.update, ({ params }) => {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          emit({ type: "message.delta", turnId, text: update.content.text });
        } else if (update.sessionUpdate === "tool_call") {
          emit({
            type: "tool.updated",
            turnId,
            toolCallId: update.toolCallId,
            title: update.title,
            status:
              update.status === "in_progress"
                ? "running"
                : update.status === "completed"
                  ? "completed"
                  : "failed",
          });
        } else if (update.sessionUpdate === "tool_call_update") {
          emit({
            type: "tool.updated",
            turnId,
            toolCallId: update.toolCallId,
            title: update.title ?? update.toolCallId,
            status:
              update.status === "in_progress"
                ? "running"
                : update.status === "completed"
                  ? "completed"
                  : update.status === "failed"
                    ? "failed"
                    : "pending",
          });
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", (error) => fail(error.message));
      child.once("exit", (code, signal) => {
        if (!ended)
          fail(`ACP process exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`);
      });
      const connection = app.connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
      let initialized: acp.InitializeResponse;
      try {
        initialized = await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "remote-agent-console", version: "0.1.0" },
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : "ACP initialization failed");
        throw error;
      }
      const capabilities = projectCapabilities(initialized.agentCapabilities);
      let session: RuntimeSession | undefined;
      return {
        capabilities,
        async createSession() {
          if (session) throw new Error("ACP connection already has a session");
          const created = await connection.agent.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          });
          sessionId = created.sessionId;
          const sessionCapabilities = { ...capabilities, modes: Boolean(created.modes) };
          session = {
            id: created.sessionId,
            capabilities: sessionCapabilities,
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            async prompt(text) {
              if (ended) throw new Error("ACP process is not available");
              turnId = `turn-${Date.now()}`;
              const currentTurnId = turnId;
              void connection.agent
                .request(acp.methods.agent.session.prompt, {
                  sessionId: created.sessionId,
                  prompt: [{ type: "text", text }],
                })
                .then((result) => {
                  if (result.stopReason === "end_turn" || result.stopReason === "max_tokens") {
                    emit({ type: "turn.completed", turnId: currentTurnId });
                  } else if (result.stopReason === "cancelled") {
                    emit({ type: "turn.failed", turnId: currentTurnId, message: "Turn cancelled" });
                  } else {
                    emit({
                      type: "turn.failed",
                      turnId: currentTurnId,
                      message: `Turn stopped: ${result.stopReason}`,
                    });
                  }
                })
                .catch((error: unknown) =>
                  fail(error instanceof Error ? error.message : "ACP prompt failed"),
                );
            },
            async cancel() {
              if (!sessionId || ended) return;
              for (const pending of permissions.values()) {
                pending.resolve({ outcome: { outcome: "cancelled" } });
              }
              permissions.clear();
              await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
            },
            async resolvePermission(permissionId, optionId) {
              const pending = permissions.get(permissionId);
              if (!pending) throw new Error(`Unknown permission: ${permissionId}`);
              if (!pending.options.some((option) => option.optionId === optionId)) {
                throw new Error(`Unknown permission option: ${optionId}`);
              }
              permissions.delete(permissionId);
              pending.resolve({ outcome: { outcome: "selected", optionId } });
              emit({ type: "permission.resolved", permissionId, optionId });
            },
            async close() {
              if (ended) return;
              ended = true;
              for (const pending of permissions.values())
                pending.resolve({ outcome: { outcome: "cancelled" } });
              permissions.clear();
              child.kill();
            },
          };
          return session;
        },
        async close() {
          if (!ended) {
            ended = true;
            child.kill();
          }
        },
      };
    },
  };
}

function projectCapabilities(
  agent: acp.InitializeResponse["agentCapabilities"] = {},
): RuntimeCapabilities {
  return {
    ...noCapabilities,
    sessions: {
      create: true,
      resume: Boolean(agent.sessionCapabilities?.resume ?? agent.loadSession),
      list: Boolean(agent.sessionCapabilities?.list),
    },
    modes: false,
    images: Boolean(agent.promptCapabilities?.image),
  };
}

import { Readable, Writable } from "node:stream";
