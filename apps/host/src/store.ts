import type { EventEnvelope, SessionSummary } from "@remote-agent-console/contracts";
import type { RuntimeSessionPort } from "./ports.js";

export interface StoredSession {
  summary: SessionSummary;
  runtimeSession: RuntimeSessionPort | null;
}

export interface IdempotencyResult {
  fingerprint: string;
  statusCode: number;
  body: unknown;
}

/** Ephemeral store. Event append completes before listeners are invoked. */
export class InMemoryHostStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly events = new Map<string, EventEnvelope[]>();
  readonly idempotency = new Map<string, IdempotencyResult>();
  readonly permissions = new Map<
    string,
    {
      sessionId: string;
      turnId: string;
      options: readonly { optionId: string }[];
      resolved: boolean;
    }
  >();

  private readonly listeners = new Map<string, Set<(event: EventEnvelope) => void>>();

  appendEvent(sessionId: string, event: EventEnvelope): void {
    const stream = this.events.get(sessionId) ?? [];
    stream.push(event);
    this.events.set(sessionId, stream);
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }

  subscribe(sessionId: string, afterSequence: number, listener: (event: EventEnvelope) => void) {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    const replay = (this.events.get(sessionId) ?? []).filter(
      (event) => event.sequence > afterSequence,
    );
    return {
      replay,
      close: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.listeners.delete(sessionId);
      },
    };
  }
}
