import { randomUUID } from "node:crypto";
import type { EventEnvelope, SessionSummary } from "@remote-agent-console/contracts";
import {
  apiErrorSchema,
  cancelAcceptedResponseSchema,
  cancelTurnRequestSchema,
  createSessionRequestSchema,
  eventEnvelopeSchema,
  healthResponseSchema,
  permissionAcceptedResponseSchema,
  permissionResponseRequestSchema,
  projectsResponseSchema,
  promptAcceptedResponseSchema,
  promptRequestSchema,
  runtimeSummarySchema,
  runtimesResponseSchema,
  sessionResponseSchema,
  sessionSchema,
  sessionsResponseSchema,
} from "@remote-agent-console/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  InMemoryRateLimiter,
  type PairingAuthService,
  type RateLimitResult,
} from "./auth/device-auth.js";
import type { RuntimeEvent, RuntimeSupervisorPort } from "./ports.js";
import {
  type HostProject,
  type HostStore,
  type IdempotencyResult,
  InMemoryHostStore,
  type StoredSession,
} from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    authenticatedDeviceId: string | null;
  }
}

export type { HostProject } from "./store.js";

export interface HostAppOptions {
  machineId: string;
  projects: readonly HostProject[];
  supervisor: RuntimeSupervisorPort;
  store?: HostStore;
  pairingAuth?: PairingAuthService;
  rateLimiter?: InMemoryRateLimiter;
  pairingRateLimit?: { limit: number; windowMs: number };
  authFailureRateLimit?: { limit: number; windowMs: number };
  mutationRateLimit?: { limit: number; windowMs: number };
  makeId?: (kind: "session" | "turn" | "event") => string;
}

const emptyError = (code: string, message: string) =>
  apiErrorSchema.parse({ error: { code, message } });
const activeStatuses = new Set(["running", "waiting_permission", "waiting_input", "stopping"]);

export function createHostApp(options: HostAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("authenticatedDeviceId", null);
  const store = options.store ?? new InMemoryHostStore();
  const rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();
  const pairingRateLimit = options.pairingRateLimit ?? { limit: 5, windowMs: 60_000 };
  const authFailureRateLimit = options.authFailureRateLimit ?? { limit: 20, windowMs: 60_000 };
  const mutationRateLimit = options.mutationRateLimit ?? { limit: 60, windowMs: 60_000 };
  store.replaceProjects(options.projects);
  const makeId = options.makeId ?? ((kind: string) => `${kind}-${randomUUID()}`);
  const projects = new Map(options.projects.map((project) => [project.id, project]));
  app.addHook("onClose", async () => {
    if (options.supervisor.close) await options.supervisor.close();
    store.close?.();
  });
  const createInFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<IdempotencyResult> }
  >();

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === "object" && error !== null && "validation" in error) {
      return reply
        .code(400)
        .send(emptyError("validation_error", "Request did not match the API schema"));
    }
    app.log.error(error);
    return reply.code(400).send(emptyError("bad_request", "Request could not be parsed"));
  });

  const rateLimited = (result: RateLimitResult, reply: FastifyReply) => {
    if (result.allowed) return false;
    reply
      .header("retry-after", String(Math.ceil(result.retryAfterMs / 1_000)))
      .code(429)
      .send(emptyError("rate_limited", "Too many requests; try again later"));
    return true;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!options.pairingAuth) return;
    const path = request.url.split("?", 1)[0];
    if (request.method === "GET" && path === "/api/v1/health") return;
    if (request.method === "POST" && path === "/api/v1/devices/pair") {
      if (
        rateLimited(
          rateLimiter.consume(
            `pair:${request.ip}`,
            pairingRateLimit.limit,
            pairingRateLimit.windowMs,
          ),
          reply,
        )
      ) {
        return;
      }
      return;
    }

    const authHeader = request.headers.authorization;
    const match =
      typeof authHeader === "string" ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authHeader) : null;
    const credential = match?.[1];
    const denyAuth = () =>
      rateLimited(
        rateLimiter.consume(
          `auth:${request.ip}`,
          authFailureRateLimit.limit,
          authFailureRateLimit.windowMs,
        ),
        reply,
      );
    if (!credential) {
      if (denyAuth()) return;
      return reply
        .code(401)
        .send(emptyError("auth_required", "A paired device credential is required"));
    }
    const device = options.pairingAuth.authenticate(credential);
    if (!device) {
      if (denyAuth()) return;
      return reply
        .code(401)
        .send(emptyError("auth_required", "A paired device credential is required"));
    }
    request.authenticatedDeviceId = device.id;
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (
        rateLimited(
          rateLimiter.consume(
            `mutation:${device.id}`,
            mutationRateLimit.limit,
            mutationRateLimit.windowMs,
          ),
          reply,
        )
      ) {
        return;
      }
    }
  });

  const expirePendingPermissions = (sessionId: string, turnId: string) => {
    for (const permission of store.permissions.values()) {
      if (
        permission.sessionId === sessionId &&
        permission.turnId === turnId &&
        !permission.resolved
      ) {
        permission.resolved = true;
      }
    }
  };

  const append = (sessionId: string, input: RuntimeEvent): EventEnvelope | null => {
    const stored = store.sessions.get(sessionId);
    if (!stored) return null;
    const sequence = store.nextSequence(sessionId);
    let event: EventEnvelope;
    try {
      event = eventEnvelopeSchema.parse({
        ...input,
        eventId: makeId("event"),
        sequence,
        machineId: options.machineId,
        sessionId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      if (input.eventType === "session.error") return null;
      return append(sessionId, {
        eventType: "session.error",
        payload: { message: "Runtime emitted an invalid event" },
      });
    }
    stored.summary.updatedAt = new Date().toISOString();
    let interruptedTurnId: string | null = null;
    if (event.eventType === "permission.requested") {
      store.permissions.set(event.payload.permissionId, {
        sessionId,
        turnId: event.payload.turnId,
        options: event.payload.options,
        resolved: false,
      });
      stored.summary.status = "waiting_permission";
    } else if (event.eventType === "permission.resolved") {
      const permission = store.permissions.get(event.payload.permissionId);
      if (permission) permission.resolved = true;
      stored.summary.status = "running";
    } else if (event.eventType === "turn.completed") {
      expirePendingPermissions(sessionId, event.payload.turnId);
      if (stored.summary.activeTurnId === event.payload.turnId) {
        stored.summary.activeTurnId = null;
        stored.summary.status = "idle";
      }
    } else if (event.eventType === "turn.failed") {
      expirePendingPermissions(sessionId, event.payload.turnId);
      if (stored.summary.activeTurnId === event.payload.turnId) {
        stored.summary.activeTurnId = null;
        stored.summary.status = "failed";
      }
    } else if (event.eventType === "session.error") {
      interruptedTurnId = stored.summary.activeTurnId;
      if (interruptedTurnId) expirePendingPermissions(sessionId, interruptedTurnId);
      stored.summary.activeTurnId = null;
      stored.summary.status = "failed";
    } else if (event.eventType === "session.status_changed") {
      stored.summary.status = event.payload.status;
    }
    store.appendEvent(sessionId, event);
    if (event.eventType === "session.error" && interruptedTurnId) {
      append(sessionId, {
        eventType: "turn.failed",
        payload: { turnId: interruptedTurnId, message: event.payload.message },
      });
    }
    return event;
  };

  const summary = (stored: StoredSession): SessionSummary => sessionSchema.parse(stored.summary);
  const idemKey = (scope: string, requestId: string) => `${scope}:${requestId}`;
  const replayIdempotency = (
    key: string,
    fingerprint: string,
    reply: { code: (status: number) => typeof reply; send: (body: unknown) => unknown },
  ): boolean => {
    const previous = store.idempotency.get(key);
    if (!previous) return false;
    if (previous.fingerprint !== fingerprint) {
      reply
        .code(409)
        .send(
          emptyError("idempotency_conflict", "Request ID was already used with different input"),
        );
    } else {
      reply.code(previous.statusCode).send(previous.body);
    }
    return true;
  };
  const saveIdempotency = (key: string, fingerprint: string, statusCode: number, body: unknown) => {
    const result: IdempotencyResult = { fingerprint, statusCode, body };
    store.saveIdempotency(key, result);
  };

  // Runtime child processes are not restored by this host. Preserve history and mark any
  // in-flight work interrupted so the client cannot mistake a stale turn for live execution.
  for (const [sessionId, stored] of store.sessions) {
    if (stored.runtimeSession) continue;
    const activeTurnId = stored.summary.activeTurnId;
    if (activeTurnId) {
      append(sessionId, {
        eventType: "turn.failed",
        payload: { turnId: activeTurnId, message: "Host restarted during the active turn" },
      });
    } else if (stored.summary.status === "creating") {
      append(sessionId, { eventType: "session.status_changed", payload: { status: "failed" } });
    } else if (stored.summary.status === "idle") {
      append(sessionId, {
        eventType: "session.status_changed",
        payload: { status: "disconnected" },
      });
    }
  }

  app.get("/api/v1/health", async () => healthResponseSchema.parse({ status: "ok" }));

  app.post<{ Body: { code?: unknown; displayName?: unknown } }>(
    "/api/v1/devices/pair",
    async (request, reply) => {
      if (!options.pairingAuth)
        return reply.code(404).send(emptyError("not_found", "Pairing is unavailable"));
      const { code, displayName } = request.body ?? {};
      if (typeof code !== "string" || typeof displayName !== "string" || displayName.length > 120) {
        return reply.code(400).send(emptyError("validation_error", "Invalid pairing request"));
      }
      const paired = options.pairingAuth.exchangePairingCode(code, displayName);
      if (!paired)
        return reply
          .code(401)
          .send(emptyError("pairing_invalid", "Pairing code is invalid or expired"));
      return reply.code(201).send(paired);
    },
  );

  app.get("/api/v1/devices", async (_request, reply) => {
    if (!options.pairingAuth)
      return reply.code(404).send(emptyError("not_found", "Device management is unavailable"));
    return reply.send({ devices: options.pairingAuth.listDevices() });
  });

  app.delete<{ Params: { deviceId: string } }>(
    "/api/v1/devices/:deviceId",
    async (request, reply) => {
      if (!options.pairingAuth)
        return reply.code(404).send(emptyError("not_found", "Device management is unavailable"));
      if (!options.pairingAuth.revokeDevice(request.params.deviceId))
        return reply.code(404).send(emptyError("device_not_found", "Device was not found"));
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/projects", async (_request, reply) => {
    const result = projectsResponseSchema.parse({
      projects: [...projects.values()].map(({ id, displayName }) => ({ id, displayName })),
    });
    return reply.send(result);
  });

  app.get("/api/v1/runtimes", async (_request, reply) => {
    const result = runtimesResponseSchema.parse({
      runtimes: (await options.supervisor.runtimes()).map((runtime) =>
        runtimeSummarySchema.parse(runtime),
      ),
    });
    return reply.send(result);
  });

  app.get("/api/v1/sessions", async (_request, reply) => {
    return reply.send(
      sessionsResponseSchema.parse({ sessions: [...store.sessions.values()].map(summary) }),
    );
  });

  app.post("/api/v1/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send(emptyError("validation_error", "Invalid session request"));
    const key = idemKey("create-session", parsed.data.requestId);
    const fingerprint = JSON.stringify(parsed.data);
    if (replayIdempotency(key, fingerprint, reply)) return;
    const pending = createInFlight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        return reply
          .code(409)
          .send(
            emptyError("idempotency_conflict", "Request ID was already used with different input"),
          );
      const result = await pending.promise;
      return reply.code(result.statusCode).send(result.body);
    }
    const project = projects.get(parsed.data.projectId);
    if (!project)
      return reply.code(404).send(emptyError("project_not_found", "Project is not allowlisted"));
    const runtime = (await options.supervisor.runtimes()).find(
      (item) => item.id === parsed.data.runtimeId,
    );
    if (!runtime)
      return reply.code(404).send(emptyError("runtime_not_found", "Runtime is not available"));
    if (!runtime.installed)
      return reply.code(409).send(emptyError("runtime_unavailable", "Runtime is not installed"));

    const promise = Promise.resolve().then(async (): Promise<IdempotencyResult> => {
      const sessionId = makeId("session");
      const createdAt = new Date().toISOString();
      const stored: StoredSession = {
        summary: sessionSchema.parse({
          id: sessionId,
          machineId: options.machineId,
          projectId: project.id,
          runtimeId: runtime.id,
          status: "creating",
          createdAt,
          updatedAt: createdAt,
          activeTurnId: null,
        }),
        runtimeSession: null,
      };
      store.sessions.set(sessionId, stored);
      append(sessionId, {
        eventType: "session.created",
        payload: { projectId: project.id, runtimeId: runtime.id },
      });
      let result: IdempotencyResult;
      try {
        stored.runtimeSession = await options.supervisor.createSession({
          sessionId,
          projectId: project.id,
          projectPath: project.path,
          runtimeId: runtime.id,
          onEvent: (event) => append(sessionId, event),
        });
        stored.summary.status = "idle";
        stored.summary.updatedAt = new Date().toISOString();
        append(sessionId, { eventType: "session.status_changed", payload: { status: "idle" } });
        result = {
          fingerprint,
          statusCode: 201,
          body: sessionResponseSchema.parse({ session: summary(stored) }),
        };
      } catch {
        stored.summary.status = "failed";
        stored.summary.updatedAt = new Date().toISOString();
        append(sessionId, { eventType: "session.status_changed", payload: { status: "failed" } });
        result = {
          fingerprint,
          statusCode: 502,
          body: emptyError("runtime_error", "Runtime could not create a session"),
        };
      }
      store.saveIdempotency(key, result);
      return result;
    });
    createInFlight.set(key, { fingerprint, promise });
    try {
      const result = await promise;
      return reply.code(result.statusCode).send(result.body);
    } finally {
      createInFlight.delete(key);
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (request, reply) => {
      const stored = store.sessions.get(request.params.sessionId);
      if (!stored) return reply.code(404).send(emptyError("not_found", "Session was not found"));
      return reply.send(sessionResponseSchema.parse({ session: summary(stored) }));
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/prompts",
    async (request, reply) => {
      const parsed = promptRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(emptyError("validation_error", "Invalid prompt request"));
      const stored = store.sessions.get(request.params.sessionId);
      if (!stored) return reply.code(404).send(emptyError("not_found", "Session was not found"));
      const key = idemKey(`prompt:${request.params.sessionId}`, parsed.data.requestId);
      const fingerprint = JSON.stringify(parsed.data);
      if (replayIdempotency(key, fingerprint, reply)) return;
      if (stored.summary.activeTurnId || activeStatuses.has(stored.summary.status)) {
        return reply
          .code(409)
          .send(emptyError("active_turn", "Session already has an active turn"));
      }
      if (!stored.runtimeSession)
        return reply
          .code(409)
          .send(emptyError("session_unavailable", "Session runtime is unavailable"));

      const turnId = makeId("turn");
      stored.summary.activeTurnId = turnId;
      stored.summary.status = "running";
      stored.summary.updatedAt = new Date().toISOString();
      store.createTurn({
        id: turnId,
        sessionId: request.params.sessionId,
        prompt: parsed.data.text,
        status: "running",
        createdAt: stored.summary.updatedAt,
      });
      append(request.params.sessionId, { eventType: "turn.started", payload: { turnId } });
      append(request.params.sessionId, {
        eventType: "session.status_changed",
        payload: { status: "running" },
      });
      const body = promptAcceptedResponseSchema.parse({
        accepted: true,
        requestId: parsed.data.requestId,
        turnId,
      });
      saveIdempotency(key, fingerprint, 202, body);
      try {
        await stored.runtimeSession.prompt(turnId, parsed.data.text);
      } catch {
        append(request.params.sessionId, {
          eventType: "turn.failed",
          payload: { turnId, message: "Runtime rejected the prompt" },
        });
      }
      return reply.code(202).send(body);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/cancel",
    async (request, reply) => {
      const parsed = cancelTurnRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(emptyError("validation_error", "Invalid cancellation request"));
      const stored = store.sessions.get(request.params.sessionId);
      if (!stored) return reply.code(404).send(emptyError("not_found", "Session was not found"));
      const key = idemKey(`cancel:${request.params.sessionId}`, parsed.data.requestId);
      const fingerprint = JSON.stringify(parsed.data);
      if (replayIdempotency(key, fingerprint, reply)) return;
      if (stored.summary.activeTurnId !== parsed.data.turnId) {
        return reply
          .code(409)
          .send(emptyError("turn_mismatch", "Turn is not active in this session"));
      }
      if (!stored.runtimeSession)
        return reply
          .code(409)
          .send(emptyError("session_unavailable", "Session runtime is unavailable"));
      const body = cancelAcceptedResponseSchema.parse({
        accepted: true,
        requestId: parsed.data.requestId,
        turnId: parsed.data.turnId,
      });
      saveIdempotency(key, fingerprint, 202, body);
      stored.summary.status = "stopping";
      stored.summary.updatedAt = new Date().toISOString();
      append(request.params.sessionId, {
        eventType: "session.status_changed",
        payload: { status: "stopping" },
      });
      try {
        await stored.runtimeSession.cancel(parsed.data.turnId);
      } catch {
        store.deleteIdempotency(key);
        stored.summary.status = "running";
        stored.summary.updatedAt = new Date().toISOString();
        append(request.params.sessionId, {
          eventType: "session.status_changed",
          payload: { status: "running" },
        });
        append(request.params.sessionId, {
          eventType: "session.error",
          payload: { message: "Runtime cancellation failed" },
        });
        return reply.code(502).send(emptyError("runtime_error", "Runtime cancellation failed"));
      }
      return reply.code(202).send(body);
    },
  );

  app.post<{ Params: { permissionId: string } }>(
    "/api/v1/permissions/:permissionId/respond",
    async (request, reply) => {
      const parsed = permissionResponseRequestSchema
        .omit({ permissionId: true })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(emptyError("validation_error", "Invalid permission response"));
      const permissionId = request.params.permissionId;
      const key = idemKey(`permission:${permissionId}`, parsed.data.requestId);
      const fingerprint = JSON.stringify(parsed.data);
      if (replayIdempotency(key, fingerprint, reply)) return;
      const permission = store.permissions.get(permissionId);
      if (!permission || permission.resolved)
        return reply
          .code(404)
          .send(emptyError("permission_not_found", "Permission is not pending"));
      if (!permission.options.some((option) => option.optionId === parsed.data.optionId)) {
        return reply
          .code(400)
          .send(
            emptyError("invalid_permission_option", "Option ID was not provided by the runtime"),
          );
      }
      const stored = store.sessions.get(permission.sessionId);
      if (!stored?.runtimeSession)
        return reply
          .code(409)
          .send(emptyError("session_unavailable", "Session runtime is unavailable"));
      const body = permissionAcceptedResponseSchema.parse({
        accepted: true as const,
        requestId: parsed.data.requestId,
        permissionId,
        optionId: parsed.data.optionId,
      });
      saveIdempotency(key, fingerprint, 200, body);
      permission.resolved = true;
      try {
        await stored.runtimeSession.respondPermission(permissionId, parsed.data.optionId);
      } catch {
        permission.resolved = false;
        store.deleteIdempotency(key);
        return reply
          .code(502)
          .send(emptyError("runtime_error", "Runtime rejected the permission response"));
      }
      return reply.code(200).send(body);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const header = request.headers["last-event-id"];
      let afterSequence = 0;
      if (header !== undefined) {
        if (
          typeof header !== "string" ||
          !/^\d+$/.test(header) ||
          !Number.isSafeInteger(Number(header))
        ) {
          return reply
            .code(400)
            .send(
              emptyError("invalid_event_cursor", "Last-Event-ID must be a non-negative integer"),
            );
        }
        afterSequence = Number(header);
      }
      const sessionId = request.params.sessionId;
      if (!store.sessions.has(sessionId))
        return reply.code(404).send(emptyError("not_found", "Session was not found"));

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.flushHeaders();
      const writeEvent = (event: EventEnvelope) => {
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const subscription = store.subscribe(sessionId, afterSequence, writeEvent);
      for (const event of subscription.replay) writeEvent(event);
      request.raw.on("close", subscription.close);
    },
  );

  return app;
}

export { createFakeRuntimeSupervisor } from "./fake-runtime.js";
export type { RuntimeEvent, RuntimeSessionPort, RuntimeSupervisorPort } from "./ports.js";
export { createRuntimeSupervisor } from "./runtime-supervisor.js";
export { InMemoryHostStore, SQLiteHostStore } from "./store.js";
