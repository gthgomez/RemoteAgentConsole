import {
  type AcceptedResponse,
  type CreateSessionRequest,
  type EventEnvelope,
  eventEnvelopeSchema,
  type ProjectSummary,
  type PromptRequest,
  projectSummarySchema,
  type RuntimeSummary,
  runtimeSummarySchema,
  type Session,
  sessionSchema,
} from "@remote-agent-console/contracts";

export interface SessionSummary extends Session {
  projectDisplayName?: string;
}

export interface SessionCreated extends Session {}
export type CreateSessionInput = CreateSessionRequest & { requestId: string };

export class HostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostApiError";
  }
}

export interface HostClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
}

export class HostClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly eventSourceFactory: (url: string) => EventSource;

  constructor(options: HostClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url));
  }

  async getProjects(): Promise<ProjectSummary[]> {
    const value = await this.request<{ projects: unknown }>("/api/v1/projects");
    return projectSummarySchema.array().parse(value.projects);
  }

  async getRuntimes(): Promise<RuntimeSummary[]> {
    const value = await this.request<{ runtimes: unknown }>("/api/v1/runtimes");
    return runtimeSummarySchema.array().parse(value.runtimes);
  }

  async getSessions(): Promise<SessionSummary[]> {
    const value = await this.request<{ sessions: unknown }>("/api/v1/sessions");
    if (!Array.isArray(value.sessions))
      throw new TypeError("Host returned an invalid session list");
    return value.sessions.map((item: unknown) => {
      if (!item || typeof item !== "object")
        throw new TypeError("Host returned an invalid session");
      const { projectDisplayName, ...session } = item as Record<string, unknown>;
      return {
        ...sessionSchema.parse(session),
        ...(typeof projectDisplayName === "string" ? { projectDisplayName } : {}),
      };
    });
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreated> {
    const value = await this.request<{ session: unknown }>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return sessionSchema.parse(value.session);
  }

  async getSession(sessionId: string): Promise<Session> {
    const value = await this.request<{ session: unknown }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
    return sessionSchema.parse(value.session);
  }

  async sendPrompt(
    sessionId: string,
    input: PromptRequest,
  ): Promise<AcceptedResponse & { turnId: string }> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async cancelTurn(
    sessionId: string,
    requestId: string,
    turnId: string,
  ): Promise<AcceptedResponse> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ requestId, turnId }),
    });
  }

  async respondToPermission(
    permissionId: string,
    requestId: string,
    optionId: string,
  ): Promise<AcceptedResponse> {
    return this.request(`/api/v1/permissions/${encodeURIComponent(permissionId)}/respond`, {
      method: "POST",
      body: JSON.stringify({ requestId, optionId }),
    });
  }

  subscribe(
    sessionId: string,
    handlers: { onEvent(event: EventEnvelope): void; onReconnect(): void; onOpen?(): void },
  ): () => void {
    const source = this.eventSourceFactory(
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    source.onmessage = (message) => {
      try {
        handlers.onEvent(eventEnvelopeSchema.parse(JSON.parse(message.data)));
      } catch {
        // Ignore malformed frames and keep the connection alive for later events.
      }
    };
    source.onopen = () => handlers.onOpen?.();
    source.onerror = () => handlers.onReconnect();
    return () => source.close();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body as { error?: { code?: string; message?: string } } | undefined;
      throw new HostApiError(
        error?.error?.message ?? `Host request failed (${response.status})`,
        response.status,
        error?.error?.code,
      );
    }
    return body as T;
  }
}

export function makeRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export type { EventEnvelope, ProjectSummary, RuntimeSummary };
