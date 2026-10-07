import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PairingAuthService } from "../../src/auth/device-auth.js";
import { SQLiteHostStore } from "../../src/store.js";

const directories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rac-auth-store-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLiteHostStore auth persistence", () => {
  it("removes expired pairing hashes when issuing a new code", () => {
    const filename = databasePath();
    let now = 1_000;
    const store = new SQLiteHostStore({ filename });
    const service = new PairingAuthService(store, { now: () => now, pairingTtlMs: 100 });
    service.issuePairingCode();
    now += 101;
    service.issuePairingCode();

    const database = new Database(filename, { readonly: true });
    const row = database.prepare("SELECT COUNT(*) AS count FROM pairings").get() as {
      count: number;
    };
    expect(row.count).toBe(1);
    database.close();
    store.close();
  });

  it("atomically creates one device from a one-time pairing across database connections", () => {
    const filename = databasePath();
    let now = 1_000;
    const first = new SQLiteHostStore({ filename });
    const service = new PairingAuthService(first, { now: () => now });
    const issued = service.issuePairingCode();
    const second = new SQLiteHostStore({ filename });
    const secondService = new PairingAuthService(second, { now: () => now });

    const firstPair = service.exchangePairingCode(issued.code, "first");
    const secondPair = secondService.exchangePairingCode(issued.code, "second");
    expect([firstPair, secondPair].filter(Boolean)).toHaveLength(1);
    now += 1;
    expect(first.listDeviceRecords()).toHaveLength(1);
    expect(second.listDeviceRecords()).toHaveLength(1);
    first.close();
    second.close();
  });

  it("rolls back pairing-code consumption if device creation fails", () => {
    const filename = databasePath();
    const store = new SQLiteHostStore({ filename });
    const service = new PairingAuthService(store, { now: () => 1_000 });
    const pairing = service.issuePairingCode();
    const credentialHash = createHash("sha256").update("existing").digest("hex");
    const deviceId = randomUUID();
    store.putDevice({
      id: deviceId,
      displayName: "Existing",
      credentialHash,
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: null,
    });
    const codeHash = createHash("sha256")
      .update(pairing.code.replaceAll("-", ""), "utf8")
      .digest("hex");

    expect(() =>
      store.pairDevice(codeHash, 1_000, {
        id: deviceId,
        displayName: "Duplicate",
        credentialHash: null as unknown as string,
        createdAt: 1_000,
        lastSeenAt: 1_000,
        revokedAt: null,
      }),
    ).toThrow();
    expect(
      store.pairDevice(codeHash, 1_000, {
        id: randomUUID(),
        displayName: "Retry",
        credentialHash,
        createdAt: 1_000,
        lastSeenAt: 1_000,
        revokedAt: null,
      }),
    ).toBe(true);
    store.close();
  });

  it("persists credential hashes, last-seen timestamps, and device revocation", () => {
    const filename = databasePath();
    let now = 20_000;
    const initialStore = new SQLiteHostStore({ filename });
    const initialAuth = new PairingAuthService(initialStore, { now: () => now });
    const pairing = initialAuth.issuePairingCode();
    const paired = initialAuth.exchangePairingCode(pairing.code, "Android phone");
    expect(paired).not.toBeNull();
    if (!paired) throw new Error("Pairing should produce a device credential");
    const initialRecord = initialStore.listDeviceRecords()[0];
    expect(initialRecord?.credentialHash).not.toBe(paired.credential);
    initialStore.close();

    const databaseContent = readFileSync(filename).toString("utf8");
    expect(databaseContent).not.toContain(paired.credential);

    now += 500;
    const restoredStore = new SQLiteHostStore({ filename });
    const restoredAuth = new PairingAuthService(restoredStore, { now: () => now });
    expect(restoredAuth.authenticate(paired.credential)).toMatchObject({
      id: paired.device.id,
      displayName: "Android phone",
      lastSeenAt: now,
      revokedAt: null,
    });
    expect(restoredAuth.revokeDevice(paired.device.id)).toBe(true);
    expect(restoredAuth.revokeDevice(paired.device.id)).toBe(false);
    expect(restoredAuth.authenticate(paired.credential)).toBeNull();
    restoredStore.close();

    const finalStore = new SQLiteHostStore({ filename });
    expect(finalStore.listDeviceRecords()[0]).toMatchObject({
      id: paired.device.id,
      lastSeenAt: now,
      revokedAt: now,
    });
    finalStore.close();
  });
});
