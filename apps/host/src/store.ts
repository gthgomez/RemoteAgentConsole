import type { EventEnvelope, SessionSummary } from "@remote-agent-console/contracts";
import Database from "better-sqlite3";
import type { AuthStore, DeviceRecord, PairingRecord } from "./auth/device-auth.js";
import type { RuntimeSessionPort } from "./ports.js";

export interface HostProject {
  id: string;
  displayName: string;
  path: string;
}

export interface StoredSession {
  summary: SessionSummary;
  runtimeSession: RuntimeSessionPort | null;
}

export interface StoredTurn {
  id: string;
  sessionId: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
}

export interface StoredPermission {
  sessionId: string;
  turnId: string;
  options: readonly { optionId: string }[];
  resolved: boolean;
}

export interface IdempotencyResult {
  fingerprint: string;
  statusCode: number;
  body: unknown;
}

export interface HostStore {
  readonly projects: Map<string, HostProject>;
  readonly sessions: Map<string, StoredSession>;
  readonly turns: Map<string, StoredTurn>;
  readonly events: Map<string, EventEnvelope[]>;
  readonly idempotency: Map<string, IdempotencyResult>;
  readonly permissions: Map<string, StoredPermission>;
  replaceProjects(projects: readonly HostProject[]): void;
  createTurn(turn: StoredTurn): void;
  nextSequence(sessionId: string): number;
  appendEvent(sessionId: string, event: EventEnvelope): void;
  saveIdempotency(key: string, result: IdempotencyResult): void;
  deleteIdempotency(key: string): void;
  subscribe(
    sessionId: string,
    afterSequence: number,
    listener: (event: EventEnvelope) => void,
  ): { replay: EventEnvelope[]; close: () => void };
  close?(): void;
}

abstract class BaseHostStore implements HostStore {
  readonly projects = new Map<string, HostProject>();
  readonly sessions = new Map<string, StoredSession>();
  readonly turns = new Map<string, StoredTurn>();
  readonly events = new Map<string, EventEnvelope[]>();
  readonly idempotency = new Map<string, IdempotencyResult>();
  readonly permissions = new Map<string, StoredPermission>();

  close(): void {}

  protected readonly listeners = new Map<string, Set<(event: EventEnvelope) => void>>();

  replaceProjects(projects: readonly HostProject[]): void {
    this.projects.clear();
    for (const project of projects) this.projects.set(project.id, project);
  }

  createTurn(turn: StoredTurn): void {
    this.turns.set(turn.id, turn);
  }

  nextSequence(sessionId: string): number {
    return (this.events.get(sessionId)?.at(-1)?.sequence ?? 0) + 1;
  }

  appendEvent(sessionId: string, event: EventEnvelope): void {
    if (
      event.eventType === "turn.started" ||
      event.eventType === "turn.completed" ||
      event.eventType === "turn.failed"
    ) {
      const turn = this.turns.get(event.payload.turnId);
      if (turn && turn.sessionId === sessionId) {
        turn.status =
          event.eventType === "turn.completed"
            ? "completed"
            : event.eventType === "turn.failed"
              ? "failed"
              : "running";
      }
    }
    const stream = this.events.get(sessionId) ?? [];
    stream.push(event);
    this.events.set(sessionId, stream);
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }

  saveIdempotency(key: string, result: IdempotencyResult): void {
    this.idempotency.set(key, result);
  }

  deleteIdempotency(key: string): void {
    this.idempotency.delete(key);
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

/** Ephemeral test/development store. Event append completes before listeners are invoked. */
export class InMemoryHostStore extends BaseHostStore {}

interface SQLiteHostStoreOptions {
  filename: string;
  projects?: readonly HostProject[];
}

/** Local durable store. Persisted transcripts remain a remote-control event log, not runtime authority. */
export class SQLiteHostStore extends BaseHostStore implements AuthStore {
  private readonly database: Database.Database;

  constructor(options: SQLiteHostStoreOptions) {
    super();
    this.database = new Database(options.filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id);
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        request_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        body_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permissions (
        permission_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        options_json TEXT NOT NULL,
        resolved INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS permissions_session_idx ON permissions(session_id);
      CREATE TABLE IF NOT EXISTS pairings (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
    `);
    this.load();
    if (options.projects) this.replaceProjects(options.projects);
  }

  private load(): void {
    const projectRows = this.database
      .prepare("SELECT id, display_name, path FROM projects")
      .all() as Array<{ id: string; display_name: string; path: string }>;
    for (const row of projectRows) {
      this.projects.set(row.id, {
        id: row.id,
        displayName: row.display_name,
        path: row.path,
      });
    }

    const sessionRows = this.database
      .prepare("SELECT id, summary_json FROM sessions")
      .all() as Array<{
      id: string;
      summary_json: string;
    }>;
    for (const row of sessionRows) {
      this.sessions.set(row.id, {
        summary: JSON.parse(row.summary_json) as SessionSummary,
        runtimeSession: null,
      });
    }

    const turnRows = this.database
      .prepare("SELECT id, session_id, prompt, status, created_at FROM turns")
      .all() as Array<{
      id: string;
      session_id: string;
      prompt: string;
      status: StoredTurn["status"];
      created_at: string;
    }>;
    for (const row of turnRows) {
      this.turns.set(row.id, {
        id: row.id,
        sessionId: row.session_id,
        prompt: row.prompt,
        status: row.status,
        createdAt: row.created_at,
      });
    }

    const eventRows = this.database
      .prepare("SELECT session_id, event_json FROM events ORDER BY session_id, sequence")
      .all() as Array<{ session_id: string; event_json: string }>;
    for (const row of eventRows) {
      const stream = this.events.get(row.session_id) ?? [];
      stream.push(JSON.parse(row.event_json) as EventEnvelope);
      this.events.set(row.session_id, stream);
    }

    const idempotencyRows = this.database
      .prepare("SELECT request_key, fingerprint, status_code, body_json FROM idempotency_keys")
      .all() as Array<{
      request_key: string;
      fingerprint: string;
      status_code: number;
      body_json: string;
    }>;
    for (const row of idempotencyRows) {
      this.idempotency.set(row.request_key, {
        fingerprint: row.fingerprint,
        statusCode: row.status_code,
        body: JSON.parse(row.body_json) as unknown,
      });
    }

    const permissionRows = this.database
      .prepare("SELECT permission_id, session_id, turn_id, options_json, resolved FROM permissions")
      .all() as Array<{
      permission_id: string;
      session_id: string;
      turn_id: string;
      options_json: string;
      resolved: number;
    }>;
    for (const row of permissionRows) {
      this.permissions.set(row.permission_id, {
        sessionId: row.session_id,
        turnId: row.turn_id,
        options: JSON.parse(row.options_json) as Array<{ optionId: string }>,
        resolved: row.resolved !== 0,
      });
    }
  }

  override replaceProjects(projects: readonly HostProject[]): void {
    const replace = this.database.transaction(() => {
      this.database.prepare("DELETE FROM projects").run();
      const insert = this.database.prepare(
        "INSERT INTO projects(id, display_name, path) VALUES (?, ?, ?)",
      );
      for (const project of projects) insert.run(project.id, project.displayName, project.path);
    });
    replace();
    super.replaceProjects(projects);
  }

  override createTurn(turn: StoredTurn): void {
    super.createTurn(turn);
  }

  override nextSequence(sessionId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events WHERE session_id = ?",
      )
      .get(sessionId) as { next_sequence: number };
    return row.next_sequence;
  }

  override appendEvent(sessionId: string, event: EventEnvelope): void {
    const expectedSequence = this.nextSequence(sessionId);
    if (event.sequence !== expectedSequence) {
      throw new Error(`Event sequence must be ${expectedSequence} for session ${sessionId}`);
    }
    const storedSession = this.sessions.get(sessionId);
    const transaction = this.database.transaction(() => {
      this.database
        .prepare("INSERT INTO events(session_id, sequence, event_json) VALUES (?, ?, ?)")
        .run(sessionId, event.sequence, JSON.stringify(event));
      if (storedSession) {
        this.database
          .prepare("INSERT OR REPLACE INTO sessions(id, summary_json) VALUES (?, ?)")
          .run(sessionId, JSON.stringify(storedSession.summary));
      }
      if (event.eventType === "turn.started") {
        const turn = this.turns.get(event.payload.turnId);
        if (turn && turn.sessionId === sessionId) {
          this.database
            .prepare(
              "INSERT OR REPLACE INTO turns(id, session_id, prompt, status, created_at) VALUES (?, ?, ?, 'running', ?)",
            )
            .run(turn.id, turn.sessionId, turn.prompt, turn.createdAt);
        }
        this.database
          .prepare("UPDATE turns SET status = 'running' WHERE id = ? AND session_id = ?")
          .run(event.payload.turnId, sessionId);
      } else if (event.eventType === "turn.completed") {
        this.database
          .prepare("UPDATE turns SET status = 'completed' WHERE id = ? AND session_id = ?")
          .run(event.payload.turnId, sessionId);
      } else if (event.eventType === "turn.failed") {
        this.database
          .prepare("UPDATE turns SET status = 'failed' WHERE id = ? AND session_id = ?")
          .run(event.payload.turnId, sessionId);
      }
      this.database.prepare("DELETE FROM permissions WHERE session_id = ?").run(sessionId);
      const insertPermission = this.database.prepare(
        "INSERT INTO permissions(permission_id, session_id, turn_id, options_json, resolved) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [permissionId, permission] of this.permissions) {
        if (permission.sessionId === sessionId) {
          insertPermission.run(
            permissionId,
            sessionId,
            permission.turnId,
            JSON.stringify(permission.options),
            permission.resolved ? 1 : 0,
          );
        }
      }
    });
    transaction();
    super.appendEvent(sessionId, event);
  }

  override saveIdempotency(key: string, result: IdempotencyResult): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO idempotency_keys(request_key, fingerprint, status_code, body_json) VALUES (?, ?, ?, ?)",
      )
      .run(key, result.fingerprint, result.statusCode, JSON.stringify(result.body));
    super.saveIdempotency(key, result);
  }

  override deleteIdempotency(key: string): void {
    this.database.prepare("DELETE FROM idempotency_keys WHERE request_key = ?").run(key);
    super.deleteIdempotency(key);
  }

  override close(): void {
    this.database.close();
  }

  putPairing(record: PairingRecord): void {
    this.database
      .prepare("INSERT OR REPLACE INTO pairings(code_hash, expires_at) VALUES (?, ?)")
      .run(record.codeHash, record.expiresAt);
  }

  purgeExpiredPairings(now: number): void {
    this.database.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(now);
  }

  pairDevice(codeHash: string, now: number, record: DeviceRecord): boolean {
    const pairDevice = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT code_hash, expires_at FROM pairings WHERE code_hash = ?")
        .get(codeHash) as { code_hash: string; expires_at: number } | undefined;
      if (!row || row.expires_at <= now) {
        this.database.prepare("DELETE FROM pairings WHERE code_hash = ?").run(codeHash);
        return false;
      }
      this.database.prepare("DELETE FROM pairings WHERE code_hash = ?").run(codeHash);
      this.putDevice(record);
      return true;
    });
    return pairDevice.immediate();
  }

  putDevice(record: DeviceRecord): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO devices(id, display_name, credential_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.displayName,
        record.credentialHash,
        record.createdAt,
        record.lastSeenAt,
        record.revokedAt,
      );
  }

  listDeviceRecords(): DeviceRecord[] {
    const rows = this.database
      .prepare(
        "SELECT id, display_name, credential_hash, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at, id",
      )
      .all() as Array<{
      id: string;
      display_name: string;
      credential_hash: string;
      created_at: number;
      last_seen_at: number | null;
      revoked_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      credentialHash: row.credential_hash,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeDevice(id: string, revokedAt: number): boolean {
    const result = this.database
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(revokedAt, id);
    return result.changes > 0;
  }

  touchDevice(id: string, lastSeenAt: number): void {
    this.database
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(lastSeenAt, id);
  }
}
