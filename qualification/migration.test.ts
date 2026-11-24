import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { exportRacHistory } from "../tools/export-rac-history.mjs";

function setupDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (id TEXT, display_name TEXT, path TEXT);
    CREATE TABLE sessions (id TEXT, summary_json TEXT);
    CREATE TABLE turns (id TEXT, session_id TEXT, prompt TEXT, status TEXT, created_at TEXT);
    CREATE TABLE events (session_id TEXT, sequence INTEGER, event_json TEXT);
    CREATE TABLE permissions (permission_id TEXT, session_id TEXT, turn_id TEXT, options_json TEXT, resolved INTEGER);
    CREATE TABLE devices (credential_hash TEXT);
    CREATE TABLE pairings (code_hash TEXT);
    CREATE TABLE idempotency_keys (request_key TEXT);
    INSERT INTO projects VALUES ('project', 'Fixture project', 'Fixture');
    INSERT INTO sessions VALUES ('session', '{"status":"running"}');
    INSERT INTO turns VALUES ('turn-b', 'session', 'second', 'completed', '2026-11-24T01:00:00.000Z');
    INSERT INTO turns VALUES ('turn-a', 'session', 'first', 'running', '2026-11-24T00:00:00.000Z');
    INSERT INTO events VALUES ('session', 2, '{"eventType":"permission.resolved","optionId":"reject"}');
    INSERT INTO events VALUES ('session', 1, '{"eventType":"turn.started","accessToken":"fixture-event-credential"}');
    INSERT INTO permissions VALUES ('denied-id', 'session', 'turn-a', '[{"optionId":"reject"}]', 1);
    INSERT INTO permissions VALUES ('pending-id', 'session', 'turn-b', '[]', 0);
    INSERT INTO devices VALUES ('fixture-device-credential');
    INSERT INTO pairings VALUES ('fixture-pairing-credential');
    INSERT INTO idempotency_keys VALUES ('fixture-operation-identity');
  `);
  database.close();
}

test("exports chronological history from a copy without exporting device or operation authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rac-export-fixture-"));
  try {
    const source = join(directory, "backup.sqlite");
    const output = join(directory, "history.jsonl");
    setupDatabase(source);
    const original = readFileSync(source);

    await exportRacHistory({ sourceCopy: source, output });

    const raw = readFileSync(output, "utf8");
    const records = raw
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].format, "rac-history");
    assert.equal(records[0].sourceSha256, createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(
      records.filter((record) => record.type === "turn").map((record) => record.data.id),
      ["turn-a", "turn-b"],
    );
    assert.deepEqual(
      records.filter((record) => record.type === "event").map((record) => record.data.sequence),
      [1, 2],
    );
    assert.deepEqual(records.at(-1).counts, {
      project: 1,
      session: 1,
      turn: 2,
      event: 2,
      decision: 1,
    });
    assert.doesNotMatch(
      raw,
      /fixture-(event|device|pairing)-credential|fixture-operation-identity|pending-id/,
    );
    assert.deepEqual(readFileSync(source), original);
    await assert.rejects(exportRacHistory({ sourceCopy: source, output }), /exists/i);
    assert.equal(readFileSync(output, "utf8"), raw);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires a self-contained database copy and leaves the archive unpublished on failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rac-export-fixture-"));
  try {
    const source = join(directory, "backup.sqlite");
    const output = join(directory, "history.jsonl");
    setupDatabase(source);
    writeFileSync(`${source}-wal`, "fixture sidecar");
    await assert.rejects(exportRacHistory({ sourceCopy: source, output }), /self-contained/i);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detects oversized history before publishing or modifying the backup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rac-export-fixture-"));
  try {
    const source = join(directory, "backup.sqlite");
    const output = join(directory, "history.jsonl");
    setupDatabase(source);
    const db = new DatabaseSync(source);
    try {
      db.exec("UPDATE turns SET prompt = CAST(zeroblob(8388609) AS TEXT) WHERE id = 'turn-a'");
    } finally {
      db.close();
    }
    const original = readFileSync(source);
    await assert.rejects(exportRacHistory({ sourceCopy: source, output }), /turn field exceeds/);
    assert.equal(existsSync(output), false);
    assert.deepEqual(readFileSync(source), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
