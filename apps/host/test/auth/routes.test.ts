import { describe, expect, it } from "vitest";
import {
  InMemoryAuthStore,
  InMemoryRateLimiter,
  PairingAuthService,
} from "../../src/auth/device-auth.js";
import { createHostApp, type RuntimeSupervisorPort } from "../../src/index.js";

const project = { id: "demo", displayName: "Demo", path: "/private/demo" };
const supervisor: RuntimeSupervisorPort = {
  runtimes: () => [],
  createSession: async () => ({
    prompt: async () => {},
    cancel: async () => {},
    respondPermission: async () => {},
  }),
};

describe("device authentication routes", () => {
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
