import { describe, expect, it } from "vitest";
import {
  createCredentialHash,
  InMemoryAuthStore,
  InMemoryRateLimiter,
  PairingAuthService,
} from "../../src/auth/device-auth.js";

describe("PairingAuthService", () => {
  it("issues a short-lived pairing code and exchanges it for a 256-bit credential", () => {
    let now = 1_000;
    const service = new PairingAuthService(new InMemoryAuthStore(), { now: () => now });
    const pairing = service.issuePairingCode();

    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairing.code).not.toMatch(/[IO01]/);
    expect(pairing.expiresAt).toBe(601_000);
    const result = service.exchangePairingCode(pairing.code.toLowerCase(), "Pixel phone");
    if (!result) throw new Error("Expected the valid pairing code to be accepted");
    expect(Buffer.from(result.credential, "base64url")).toHaveLength(32);
    expect(result.device.displayName).toBe("Pixel phone");
    expect("credentialHash" in result.device).toBe(false);
    expect(service.authenticate(result.credential)?.id).toBe(result.device.id);

    now += 600_000;
    expect(service.exchangePairingCode(pairing.code, "second device")).toBeNull();
  });

  it("persists only the credential hash and allows a pairing code to be exchanged once", () => {
    const store = new InMemoryAuthStore();
    const service = new PairingAuthService(store);
    const pairing = service.issuePairingCode();
    const first = service.exchangePairingCode(pairing.code, "Phone");

    if (!first) throw new Error("Expected the valid pairing code to be accepted");
    const stored = store.listDeviceRecords()[0];
    if (!stored) throw new Error("Expected the device record to be stored");
    expect(stored.credentialHash).toBe(createCredentialHash(first.credential));
    expect(stored.credentialHash).not.toContain(first.credential);
    expect(service.exchangePairingCode(pairing.code, "Again")).toBeNull();
  });

  it("rejects expired pairing codes and malformed credentials", () => {
    let now = 0;
    const service = new PairingAuthService(new InMemoryAuthStore(), {
      now: () => now,
      pairingTtlMs: 50,
    });
    const pairing = service.issuePairingCode();
    now = 50;
    expect(service.exchangePairingCode(pairing.code, "Phone")).toBeNull();
    expect(service.authenticate("not a credential")).toBeNull();
  });

  it("lists and revokes devices without returning credential hashes", () => {
    const service = new PairingAuthService(new InMemoryAuthStore());
    const pairing = service.issuePairingCode();
    const created = service.exchangePairingCode(pairing.code, "Phone");
    if (!created) throw new Error("Expected the valid pairing code to be accepted");

    expect(service.listDevices()).toEqual([created.device]);
    expect(service.revokeDevice(created.device.id)).toBe(true);
    expect(service.authenticate(created.credential)).toBeNull();
    expect(service.listDevices()[0]?.revokedAt).not.toBeNull();
  });
});

describe("InMemoryRateLimiter", () => {
  it("allows a bounded number of attempts in a fixed window and resets after expiry", () => {
    let now = 10;
    const limiter = new InMemoryRateLimiter(() => now);

    expect(limiter.consume("pair:client", 2, 1_000).allowed).toBe(true);
    expect(limiter.consume("pair:client", 2, 1_000).allowed).toBe(true);
    expect(limiter.consume("pair:client", 2, 1_000)).toMatchObject({
      allowed: false,
      retryAfterMs: 1_000,
    });
    now += 1_000;
    expect(limiter.consume("pair:client", 2, 1_000).allowed).toBe(true);
  });
});
