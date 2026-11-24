import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const maxSourceBytes = 2 * 1024 ** 3;
const maxArchiveBytes = 512 * 1024 ** 2;
const maxFieldBytes = 8 * 1024 ** 2;
const sensitiveField =
  /^(?:access|refresh|device|provider|auth)?(?:token|secret|credential)(?:hash)?$|^(?:apikey|authorization|password|pairingcode|privatekey|clientsecret)$/i;
const credentialText =
  /\bBearer\s+[^\s"']+|\b(?:ghp_|github_pat_|gho_|ghu_|ghs_|sk-proj-|sk-svcacct-)[A-Za-z0-9_-]{20,}/gi;

const records = [
  ["project", "projects", ["id", "display_name AS displayName", "path AS legacyPath"], "id"],
  ["session", "sessions", ["id", "summary_json AS summaryJson"], "id"],
  [
    "turn",
    "turns",
    ["id", "session_id AS sessionId", "prompt", "status", "created_at AS createdAt"],
    "session_id, created_at, id",
  ],
  [
    "event",
    "events",
    ["session_id AS sessionId", "sequence", "event_json AS eventJson"],
    "session_id, sequence",
  ],
  [
    "decision",
    "permissions",
    [
      "permission_id AS permissionId",
      "session_id AS sessionId",
      "turn_id AS turnId",
      "options_json AS optionsJson",
    ],
    "session_id, turn_id, permission_id",
    "resolved = 1",
  ],
];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requireSelfContainedCopy(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size === 0 || stats.size > maxSourceBytes) {
    throw new Error("Choose a regular SQLite backup copy no larger than 2 GiB");
  }
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(path + suffix))) {
    throw new Error("Choose a self-contained SQLite backup copy with no journal sidecars");
  }
}

function redact(value, depth = 0) {
  if (depth > 40) throw new Error("Historical record nesting exceeds the archive limit");
  if (typeof value === "string") {
    return value
      .replace(credentialText, "[redacted]")
      .replace(
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
        "[redacted private key]",
      );
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveField.test(key.replace(/[^a-z]/gi, "")) ? "[redacted]" : redact(item, depth + 1),
      ]),
    );
  }
  return value;
}

function archiveData(type, row) {
  const { summaryJson, eventJson, optionsJson, ...rest } = row;
  try {
    if (summaryJson !== undefined) rest.summary = JSON.parse(summaryJson);
    if (eventJson !== undefined) rest.event = JSON.parse(eventJson);
    if (optionsJson !== undefined) rest.options = JSON.parse(optionsJson);
  } catch {
    throw new Error(`Invalid JSON in legacy ${type} record`);
  }
  return redact(rest);
}

/** Export the audited legacy schema as historical data from an owner-supplied backup. */
export async function exportRacHistory({ sourceCopy, output }) {
  const sourcePath = resolve(sourceCopy);
  const outputPath = resolve(output);
  requireSelfContainedCopy(sourcePath);
  if (existsSync(outputPath)) throw new Error("The archive output already exists");

  const temporary = mkdtempSync(join(dirname(outputPath), ".rac-history-"));
  const snapshot = join(temporary, "source.sqlite");
  const archive = join(temporary, "history.jsonl");
  try {
    const sourceSha256 = await sha256(sourcePath);
    copyFileSync(sourcePath, snapshot);
    requireSelfContainedCopy(sourcePath);
    if ((await sha256(snapshot)) !== sourceSha256)
      throw new Error("The SQLite backup changed during export");

    const database = new DatabaseSync(snapshot, { readOnly: true });
    let outputFd;
    try {
      database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
      outputFd = openSync(archive, "wx", 0o600);
      let bytes = 0;
      const writeRecord = (record) => {
        const line = `${JSON.stringify(record)}\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > maxArchiveBytes) throw new Error("Historical archive exceeds 512 MiB");
        writeFileSync(outputFd, line);
      };
      writeRecord({
        type: "manifest",
        format: "rac-history",
        schemaVersion: 1,
        sourceSha256,
        authority: "historical",
      });
      const counts = {};
      for (const [type, table, columns, orderBy, filter = "1"] of records) {
        const lengths = columns.map((column) => `length(CAST(${column.split(" AS ")[0]} AS BLOB))`);
        const oversized = database
          .prepare(
            `SELECT 1 FROM ${table} WHERE (${filter}) AND max(${lengths.join(", ")}) > ? LIMIT 1`,
          )
          .get(maxFieldBytes);
        if (oversized) throw new Error(`Legacy ${type} field exceeds the 8 MiB archive limit`);
        const query = `SELECT ${columns.join(", ")} FROM ${table} WHERE ${filter} ORDER BY ${orderBy}`;
        counts[type] = 0;
        for (const row of database.prepare(query).iterate()) {
          writeRecord({ type, data: archiveData(type, row) });
          counts[type]++;
        }
      }
      writeRecord({ type: "summary", counts });
      fsyncSync(outputFd);
    } finally {
      if (outputFd !== undefined) closeSync(outputFd);
      database.close();
    }

    requireSelfContainedCopy(sourcePath);
    if ((await sha256(sourcePath)) !== sourceSha256)
      throw new Error("The SQLite backup changed during export");
    linkSync(archive, outputPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: { "source-copy": { type: "string" }, output: { type: "string" } },
    });
    if (!values["source-copy"] || !values.output) {
      throw new Error(
        "Usage: node tools/export-rac-history.mjs --source-copy <backup.sqlite> --output <history.jsonl>",
      );
    }
    await exportRacHistory({ sourceCopy: values["source-copy"], output: values.output });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
