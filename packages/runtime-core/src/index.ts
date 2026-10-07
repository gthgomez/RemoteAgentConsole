import type { RuntimeCapabilities } from "@remote-agent-console/contracts";

export type RuntimeEvent =
  | { type: "message.delta"; turnId: string; text: string }
  | {
      type: "tool.updated";
      turnId: string;
      toolCallId: string;
      title: string;
      status: "pending" | "running" | "completed" | "failed";
    }
  | {
      type: "permission.requested";
      turnId: string;
      permissionId: string;
      title: string;
      options: readonly RuntimePermissionOption[];
    }
  | { type: "permission.resolved"; permissionId: string; optionId: string }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string; message: string }
  | { type: "session.error"; message: string };

export interface RuntimePermissionOption {
  optionId: string;
  name: string;
  kind?: string;
  [field: string]: unknown;
}

export interface RuntimeSession {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  resolvePermission(permissionId: string, optionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeConnection {
  readonly capabilities: RuntimeCapabilities;
  createSession(): Promise<RuntimeSession>;
  close(): Promise<void>;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  connect(input: { projectId: string }): Promise<RuntimeConnection>;
}
