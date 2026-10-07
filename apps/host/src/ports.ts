import type { EventEnvelope, RuntimeSummary } from "@remote-agent-console/contracts";

/** Runtime-neutral event input emitted by the injected session adapter. */
export type RuntimeEvent = EventEnvelope extends infer E
  ? E extends EventEnvelope
    ? Omit<E, "eventId" | "sequence" | "machineId" | "sessionId" | "timestamp">
    : never
  : never;

export interface RuntimeSessionPort {
  prompt(turnId: string, text: string): Promise<void>;
  cancel(turnId: string): Promise<void>;
  /** A successful response is reported through the session's onEvent callback. */
  respondPermission(permissionId: string, optionId: string): Promise<void>;
}

/** Narrow seam for a runtime-core adapter; ACP details stay behind this port. */
export interface RuntimeSupervisorPort {
  runtimes(): readonly RuntimeSummary[];
  close?(): Promise<void>;
  createSession(input: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    runtimeId: string;
    onEvent: (event: RuntimeEvent) => void;
  }): Promise<RuntimeSessionPort>;
}
