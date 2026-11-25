import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export const STABLE_BUNDLE = "codex_app_server_protocol.schemas.json";
export const V2_BUNDLE = "codex_app_server_protocol.v2.schemas.json";

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walk(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

/** Canonical manifest hash used by the native receipt (sorted path/sha pairs). */
export function canonicalManifestHash(files) {
  const entries = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, entry]) => [path, entry.sha256]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function verifyNativeBinding({
  schemaDir,
  receiptPath,
  expectations,
  expectedReceiptSha256,
}) {
  const receiptText = await readFile(receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  const { evidenceContentSha256, ...withoutHash } = receipt;
  const recomputedReceiptHash = createHash("sha256")
    .update(`${JSON.stringify(withoutHash, null, 2)}\n`)
    .digest("hex");

  const files = {};
  let totalBytes = 0;
  for (const path of await walk(schemaDir)) {
    const info = await stat(path);
    files[
      path
        .split(sep)
        .join("/")
        .slice(schemaDir.replaceAll("\\", "/").length + 1)
    ] = {
      sha256: await sha256File(path),
      bytes: info.size,
    };
    totalBytes += info.size;
  }
  const manifestHash = canonicalManifestHash(files);
  const aggregateHashes = {};
  for (const bundle of [STABLE_BUNDLE, V2_BUNDLE]) {
    aggregateHashes[bundle] = files[bundle]?.sha256 ?? null;
  }

  const problems = [];
  if (receipt.status !== "PASS") problems.push(`native receipt status is ${receipt.status}`);
  if (receipt.identity?.sha256 !== expectations.native.binarySha256) {
    problems.push("native receipt binary digest does not match the pinned digest");
  }
  if (receipt.version?.reported !== expectations.native.cliVersion) {
    problems.push("native receipt CLI version does not match the pinned version");
  }
  if (manifestHash !== expectations.native.schemaManifestSha256) {
    problems.push("schema manifest hash does not match the pinned native schema");
  }
  if (manifestHash !== receipt.schema?.generation?.manifestSha256) {
    problems.push("schema manifest hash does not match the native receipt");
  }
  if (Object.keys(files).length !== expectations.native.schemaFileCount) {
    problems.push(`schema file count is ${Object.keys(files).length}`);
  }
  for (const [bundle, expected] of Object.entries(expectations.native.aggregateHashes)) {
    if (aggregateHashes[bundle] !== expected)
      problems.push(`aggregate hash mismatch for ${bundle}`);
  }
  if (recomputedReceiptHash !== expectedReceiptSha256) {
    problems.push("native receipt content hash does not match the bound receipt");
  }

  return {
    ok: problems.length === 0,
    problems,
    receipt: {
      status: receipt.status,
      evidenceContentSha256,
      recomputedReceiptHash,
      expectedReceiptSha256,
      receiptHashMatches: recomputedReceiptHash === expectedReceiptSha256,
      manifestHash,
      totalBytes,
      fileCount: Object.keys(files).length,
      aggregateHashes,
      binarySha256: receipt.identity?.sha256 ?? null,
      cliVersion: receipt.version?.reported ?? null,
    },
  };
}

function methodList(bundle, definitionName) {
  const definition = bundle.definitions?.[definitionName];
  if (!definition?.oneOf) return [];
  return definition.oneOf
    .map((variant) => variant?.properties?.method?.enum?.[0])
    .filter((value) => typeof value === "string");
}

export async function classifyStableSchema(schemaDir) {
  const stable = JSON.parse(await readFile(join(schemaDir, STABLE_BUNDLE), "utf8"));
  const v2 = JSON.parse(await readFile(join(schemaDir, V2_BUNDLE), "utf8"));
  const definitions = stable.definitions ?? {};
  const clientMethods = methodList(stable, "ClientRequest");
  const serverNotifications = methodList(stable, "ServerNotification");
  const interrupt = definitions.v2?.TurnInterruptParams;
  const completed = definitions.v2?.TurnCompletedNotification;
  const turn = definitions.v2?.Turn;
  const revert = definitions.v2?.ThreadRevertParams;
  return {
    methods: {
      hasThreadRollback: clientMethods.includes("thread/rollback"),
      hasThreadRevert: clientMethods.includes("thread/revert"),
      hasTurnInterrupt: clientMethods.includes("turn/interrupt"),
      hasTurnCompleted: serverNotifications.includes("turn/completed"),
      hasTurnInterrupted: serverNotifications.includes("turn/interrupted"),
      hasThreadReverted: serverNotifications.includes("thread/reverted"),
      clientMethodCount: clientMethods.length,
      serverNotificationCount: serverNotifications.length,
    },
    shapes: {
      interruptRequired: interrupt?.required ?? [],
      interruptProperties: Object.keys(interrupt?.properties ?? {}),
      completedRequired: completed?.required ?? [],
      turnRequired: turn?.required ?? [],
      turnStatus: definitions.v2?.TurnStatus?.enum ?? [],
      revertRequired: revert?.required ?? [],
      v2DefinitionCount: Object.keys(v2.definitions ?? {}).length,
    },
  };
}
