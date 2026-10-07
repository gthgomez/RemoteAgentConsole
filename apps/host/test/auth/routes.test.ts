import { describe, expect, it } from "vitest";
import {
  InMemoryAuthStore,
  InMemoryRateLimiter,
  PairingAuthService,
} from "../../src/auth/device-auth.js";
import { createHostApp, type RuntimeSupervisorPort } from "../../src/index.js";

const project = { id: "demo", displayName: "Demo", path: "/private/demo" };
const supervisor: RuntimeSupervisorPort = {
  runtimes: () => [
    {
      id: "fake",
      displayName: "Fake ACP",
      installed: true,
      version: "1.0.0",
      capabilities: {
        sessions: { create: true, resume: false, list: false },
        interaction: { cancel: true, permissions: true, questions: false },
        models: { selectable: false, effort: false },
        modes: false,
        plans: false,
        commands: false,
        images: false,
        files: false,
      },
    },
  ],
  createSession: async () => ({
    prompt: async () => {},
    cancel: async () => {},
    respondPermission: async () => {},
  }),
};

describe("device authentication routes", () => {
  it("bounds authenticated SSE streams globally and per device, then releases slots on disconnect", async () => {
    const pairingAuth = new PairingAuthService(new InMemoryAuthStore());
    const firstPairing = pairingAuth.issuePairingCode();
    const secondPairing = pairingAuth.issuePairingCode();
    const app = createHostApp({
      machineId: "machine-1",
      projects: [project],
      supervisor,
      pairingAuth,
      sseConnectionLimits: { global: 2, perDevice: 1 },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const pair = async (code: string, displayName: string) => {
      const response = await fetch(`${address}/api/v1/devices/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, displayName }),
      });
      return (await response.json()) as { credential: string };
    };
    const firstDevice = await pair(firstPairing.code, "Phone one");
    const secondDevice = await pair(secondPairing.code, "Phone two");
    const created = await fetch(`${address}/api/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${firstDevice.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "stream-session", projectId: "demo", runtimeId: "fake" }),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
    const stream = (credential: string) =>
      fetch(`${address}/api/v1/sessions/${sessionId}/events`, {
        headers: { authorization: `Bearer ${credential}` },
      });

    const first = await stream(firstDevice.credential);
    expect(first.status).toBe(200);
    const perDeviceLimited = await stream(firstDevice.credential);
    expect(perDeviceLimited.status).toBe(429);
    expect(perDeviceLimited.headers.get("retry-after")).toBe("1");
    expect(await perDeviceLimited.json()).toMatchObject({
      error: {
        code: "sse_connection_limit",
        message: expect.stringContaining("retry"),
      },
    });

    const second = await stream(secondDevice.credential);
    expect(second.status).toBe(200);
    const globallyLimited = await stream(secondDevice.credential);
    expect(globallyLimited.status).toBe(429);

    await first.body?.cancel();
    const replacement = await stream(firstDevice.credential);
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
    await second.body?.cancel();
    await app.close();
  });

  it("requires a paired device credential for private APIs and supports pair, list, and revoke", async () => {
    const pairingAuth = new PairingAuthService(new InMemoryAuthStore());
    const pairing = pairingAuth.issuePairingCode();
    const app = createHostApp({
      machineId: "machine-1",
      projects: [project],
      supervisor,
      pairingAuth,
    });

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);

    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe("auth_required");

    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { code: pairing.code, displayName: "Phone" },
    });
    expect(paired.statusCode).toBe(201);
    expect(paired.json().device.credentialHash).toBeUndefined();
    const { credential, device } = paired.json();

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.body).not.toContain("/private/demo");

    const devices = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(devices.json().devices).toHaveLength(1);
    expect(devices.body).not.toContain("credentialHash");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${device.id}`,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(revoked.statusCode).toBe(204);
    const revokedCredential = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(revokedCredential.statusCode).toBe(401);
    await app.close();
  });

  it("rate limits pairing attempts by remote address", async () => {
    let now = 1_000;
    const pairingAuth = new PairingAuthService(new InMemoryAuthStore(), { now: () => now });
    const app = createHostApp({
      machineId: "machine-1",
      projects: [project],
      supervisor,
      pairingAuth,
      rateLimiter: new InMemoryRateLimiter(() => now),
      pairingRateLimit: { limit: 1, windowMs: 60_000 },
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { code: "invalid", displayName: "Phone" },
    });
    expect(first.statusCode).toBe(401);
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { code: "invalid", displayName: "Phone" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    now += 60_000;
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { code: "invalid", displayName: "Phone" },
    });
    expect(reset.statusCode).toBe(401);
    await app.close();
  });
});
