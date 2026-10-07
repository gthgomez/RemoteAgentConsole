import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("atomically consumes a one-time pairing across database connections", () => {
    const filename = databasePath();
    let now = 1_000;
    const first = new SQLiteHostStore({ filename });
    const service = new PairingAuthService(first, { now: () => now });
    const issued = service.issuePairingCode();
    const codeHash = createHash("sha256")
      .update(issued.code.replaceAll("-", ""), "utf8")
      .digest("hex");
    const second = new SQLiteHostStore({ filename });

    expect(first.consumePairing(codeHash)).toEqual({ codeHash, expiresAt: issued.expiresAt });
    expect(second.consumePairing(codeHash)).toBeNull();
    now += 1;
    expect(first.consumePairing(codeHash)).toBeNull();
    first.close();
    second.close();
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
