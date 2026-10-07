import {
  type AcceptedResponse,
  apiErrorSchema,
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

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function isDeviceCredential(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const finalCharacter = value.at(-1);
  // A 32-byte value encodes to 43 base64url characters. Its final 6-bit
  // symbol contains four data bits and two zero padding bits.
  return finalCharacter !== undefined && BASE64URL_ALPHABET.indexOf(finalCharacter) % 4 === 0;
}

export interface DeviceCredentialStore {
  get(): Promise<string | null>;
  set(credential: string): Promise<void>;
  clear(): Promise<void>;
  clearIfMatches(credential: string): Promise<boolean>;
}

export interface HostClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  credentialStore?: DeviceCredentialStore;
  onAuthenticationRequired?: (error: HostApiError) => void;
}

export class HostClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly credentialStore: DeviceCredentialStore | undefined;
  private readonly onAuthenticationRequired: ((error: HostApiError) => void) | undefined;

  constructor(options: HostClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.credentialStore = options.credentialStore;
    this.onAuthenticationRequired = options.onAuthenticationRequired;
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

  async createSession(input: CreateSessionRequest): Promise<SessionCreated> {
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

  async pairDevice(
    code: string,
    displayName: string,
  ): Promise<{ id: string; displayName: string }> {
    if (!this.credentialStore) throw new Error("Secure credential storage is unavailable");
    const value = await this.request<{ credential?: unknown; device?: unknown }>(
      "/api/v1/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({ code, displayName }),
      },
      false,
    );
    const credential = value.credential;
    const device = value.device as { id?: unknown; displayName?: unknown } | undefined;
    if (
      typeof credential !== "string" ||
      !isDeviceCredential(credential) ||
      typeof device?.id !== "string" ||
      typeof device.displayName !== "string"
    ) {
      throw new TypeError("Host returned an invalid pairing response");
    }
    await this.credentialStore.set(credential);
    return { id: device.id, displayName: device.displayName };
  }

  subscribe(
    sessionId: string,
    handlers: { onEvent(event: EventEnvelope): void; onReconnect(): void; onOpen?(): void },
  ): () => void {
    const controller = new AbortController();
    const path = `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    let lastEventId: string | null = null;
    let stopped = false;
    let halted = false;
    let historyRecoveries = 0;
    const maxHistoryRecoveries = 3;
    const reconnectDelayMs = 750;

    const connect = async () => {
      while (!stopped && !halted) {
        const headers = new Headers({ Accept: "text/event-stream" });
        if (lastEventId !== null) headers.set("Last-Event-ID", lastEventId);
        try {
          const credential = (await this.credentialStore?.get()) ?? null;
          if (credential) headers.set("Authorization", `Bearer ${credential}`);
          const response = await this.fetcher(path, { headers, signal: controller.signal });
          if (response.status === 401) {
            await this.handleAuthenticationRejected(response, undefined, credential);
            handlers.onReconnect();
            return;
          }
          if (response.status === 410) {
            const body = await response.json().catch(() => undefined);
            const parsed = apiErrorSchema.safeParse(body);
            const oldestSequence = parsed.success ? parsed.data.error.oldestSequence : undefined;
            if (
              !parsed.success ||
              parsed.data.error.code !== "event_history_expired" ||
              oldestSequence === undefined ||
              !Number.isSafeInteger(oldestSequence) ||
              oldestSequence < 1 ||
              historyRecoveries >= maxHistoryRecoveries
            ) {
              halted = true;
              handlers.onReconnect();
              return;
            }
            lastEventId = String(oldestSequence - 1);
            historyRecoveries += 1;
          } else {
            if (!response.ok || !response.body) throw new Error("Event stream unavailable");
            handlers.onOpen?.();
            await readEventStream(response.body, controller.signal, (id, data) => {
              if (id) lastEventId = id;
              try {
                const event = eventEnvelopeSchema.parse(JSON.parse(data));
                historyRecoveries = 0;
                handlers.onEvent(event);
              } catch {
                // Ignore malformed frames and keep the connection alive for later events.
              }
            });
          }
          if (!stopped) handlers.onReconnect();
        } catch {
          if (stopped) return;
          handlers.onReconnect();
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
      }
    };

    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const credential = authenticated ? ((await this.credentialStore?.get()) ?? null) : null;
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body as { error?: { code?: string; message?: string } } | undefined;
      const hostError = new HostApiError(
        error?.error?.message ?? `Host request failed (${response.status})`,
        response.status,
        error?.error?.code,
      );
      if (authenticated && response.status === 401) {
        await this.handleAuthenticationRejected(response, hostError, credential);
      }
      throw hostError;
    }
    return body as T;
  }

  private async handleAuthenticationRejected(
    response: Response,
    existingError?: HostApiError,
    rejectedCredential: string | null = null,
  ): Promise<void> {
    const body = existingError
      ? undefined
      : ((await response
          .clone()
          .json()
          .catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined);
    const error =
      existingError ??
      new HostApiError(
        body?.error?.message ?? "Device authentication is required",
        response.status,
        body?.error?.code,
      );
    try {
      if (rejectedCredential !== null) {
        const cleared = await this.credentialStore?.clearIfMatches(rejectedCredential);
        if (!cleared) return;
      } else if ((await this.credentialStore?.get()) != null) {
        return;
      }
    } catch {
      // Still require pairing if local storage cannot clear a revoked credential.
    }
    this.onAuthenticationRequired?.(error);
  }
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (id: string, data: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onFrame(eventId, data.join("\n"));
    data = [];
  };
  const parseLines = () => {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const rawLine = buffer.slice(0, newline);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        dispatch();
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "id" && !value.includes("\0")) eventId = value;
        if (field === "data") data.push(value);
      }
      newline = buffer.indexOf("\n");
    }
  };

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      parseLines();
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      buffer += "\n\n";
      parseLines();
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

export function makeRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export type { EventEnvelope, ProjectSummary, RuntimeSummary };
