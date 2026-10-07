import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_BYTES = 8;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
const DUMMY_HASH = Buffer.alloc(32);

export interface PairingRecord {
  codeHash: string;
  expiresAt: number;
}

/** Internal persistence shape. The raw credential is never stored. */
export interface DeviceRecord {
  id: string;
  displayName: string;
  credentialHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export type PublicDevice = Omit<DeviceRecord, "credentialHash">;

/** Implementations must consume a pairing record atomically. */
export interface AuthStore {
  putPairing(record: PairingRecord): void;
  purgeExpiredPairings(now: number): void;
  pairDevice(codeHash: string, now: number, record: DeviceRecord): boolean;
  putDevice(record: DeviceRecord): void;
  listDeviceRecords(): DeviceRecord[];
  revokeDevice(id: string, revokedAt: number): boolean;
  touchDevice(id: string, lastSeenAt: number): void;
}

export interface PairingAuthOptions {
  now?: () => number;
  pairingTtlMs?: number;
}

export interface PairedDeviceResult {
  device: PublicDevice;
  /** Returned once to the client. Do not log or persist this value. */
  credential: string;
}

export function createCredentialHash(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function publicDevice(record: DeviceRecord): PublicDevice {
  const { credentialHash: _credentialHash, ...device } = record;
  return device;
}

function normalizePairingCode(value: string): string | null {
  const normalized = value.replaceAll("-", "").trim().toUpperCase();
  if (normalized.length !== PAIRING_CODE_BYTES) return null;
  for (const character of normalized) {
    if (!PAIRING_ALPHABET.includes(character)) return null;
  }
  return normalized;
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function securePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_BYTES);
  let code = "";
  // The alphabet has 32 symbols, so masking avoids modulo bias.
  for (const byte of bytes) code += PAIRING_ALPHABET[byte & 31];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class PairingAuthService {
  private readonly now: () => number;
  private readonly pairingTtlMs: number;

  constructor(
    private readonly store: AuthStore,
    options: PairingAuthOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    if (!Number.isSafeInteger(this.pairingTtlMs) || this.pairingTtlMs <= 0) {
      throw new RangeError("pairingTtlMs must be a positive safe integer");
    }
  }

  issuePairingCode(): { code: string; expiresAt: number } {
    const code = securePairingCode();
    const now = this.now();
    const expiresAt = now + this.pairingTtlMs;
    this.store.purgeExpiredPairings(now);
    this.store.putPairing({ codeHash: hashPairingCode(code.replace("-", "")), expiresAt });
    return { code, expiresAt };
  }

  exchangePairingCode(codeInput: string, displayName: string): PairedDeviceResult | null {
    const code = normalizePairingCode(codeInput);
    if (!code) return null;
    const now = this.now();
    const credential = randomBytes(32).toString("base64url");
    const record: DeviceRecord = {
      id: randomUUID(),
      displayName: displayName.trim().slice(0, 80) || "Paired device",
      credentialHash: createCredentialHash(credential),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    };
    if (!this.store.pairDevice(hashPairingCode(code), now, record)) return null;
    return { device: publicDevice(record), credential };
  }

  authenticate(credential: string): PublicDevice | null {
    const candidate = createCredentialHash(credential);
    const records = this.store.listDeviceRecords();
    let record: DeviceRecord | null = null;
    const actual = Buffer.from(candidate, "hex");
    let matched = false;
    if (records.length === 0) timingSafeEqual(DUMMY_HASH, actual);
    for (const candidateRecord of records) {
      const expected = Buffer.from(candidateRecord.credentialHash, "hex");
      const validHash = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (validHash) {
        record = candidateRecord;
        matched = true;
      }
    }
    if (!record || !matched || record.revokedAt !== null) return null;
    const lastSeenAt = this.now();
    this.store.touchDevice(record.id, lastSeenAt);
    return publicDevice({ ...record, lastSeenAt });
  }

  listDevices(): PublicDevice[] {
    return this.store.listDeviceRecords().map(publicDevice);
  }

  revokeDevice(id: string): boolean {
    return this.store.revokeDevice(id, this.now());
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

/** In-memory fixed-window limiter primitive; callers choose keys and policies. */
export class InMemoryRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be positive");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError("windowMs must be positive");
    }
    const now = this.now();
    for (const [storedKey, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(storedKey);
    }
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    if (window.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, window.resetAt - now) };
    }
    window.count += 1;
    return {
      allowed: true,
      remaining: limit - window.count,
      retryAfterMs: Math.max(0, window.resetAt - now),
    };
  }
}

/** Test/local implementation. Production wiring should provide a durable AuthStore. */
export class InMemoryAuthStore implements AuthStore {
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly devices = new Map<string, DeviceRecord>();

  putPairing(record: PairingRecord): void {
    this.pairings.set(record.codeHash, record);
  }

  purgeExpiredPairings(now: number): void {
    for (const [codeHash, record] of this.pairings) {
      if (record.expiresAt <= now) this.pairings.delete(codeHash);
    }
  }

  pairDevice(codeHash: string, now: number, record: DeviceRecord): boolean {
    const pairing = this.pairings.get(codeHash);
    if (!pairing || pairing.expiresAt <= now) {
      this.pairings.delete(codeHash);
      return false;
    }
    // Write before consuming so a failed device insert leaves the code usable.
    this.putDevice(record);
    this.pairings.delete(codeHash);
    return true;
  }

  putDevice(record: DeviceRecord): void {
    this.devices.set(record.id, record);
  }

  listDeviceRecords(): DeviceRecord[] {
    return [...this.devices.values()].map((record) => ({ ...record }));
  }

  revokeDevice(id: string, revokedAt: number): boolean {
    const record = this.devices.get(id);
    if (!record || record.revokedAt !== null) return false;
    this.devices.set(id, { ...record, revokedAt });
    return true;
  }

  touchDevice(id: string, lastSeenAt: number): void {
    const record = this.devices.get(id);
    if (record && record.revokedAt === null) this.devices.set(id, { ...record, lastSeenAt });
  }
}
