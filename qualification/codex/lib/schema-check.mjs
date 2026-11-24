import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createByteBoundedBuffer } from "./bounds.mjs";

/**
 * Stable app-server schema generation and verification.
 *
 * `codex app-server generate-json-schema` is itself marked experimental, but
 * the bundle it writes is the binary's own protocol description. Running it
 * without `--experimental` yields the stable (non-experimental) method and
 * field surface, which is what the controller is allowed to depend on.
 */

export const SCHEMA_BUNDLE = "codex_app_server_protocol.schemas.json";
export const SCHEMA_V2_BUNDLE = "codex_app_server_protocol.v2.schemas.json";

export async function generateStableSchema({
  exePath,
  outDir,
  env,
  timeoutMs = 180000,
  maxStdoutBytes = 16 * 1024,
  maxStderrBytes = 16 * 1024,
}) {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(exePath, ["app-server", "generate-json-schema", "--out", outDir], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createByteBoundedBuffer(maxStdoutBytes);
    const stderr = createByteBoundedBuffer(maxStderrBytes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        reason: "spawn-error",
        durationMs: Date.now() - startedAt,
        stdout: stdout.summary(),
        stderr: stderr.summary(),
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.summary(),
        stderr: stderr.summary(),
      });
    });
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function walkFiles(root) {
  const output = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await walk(root);
  return output;
}

export function toPosixPath(path) {
  return path.split(sep).join("/");
}

/** Hashes every generated schema file, keyed by POSIX-style relative path. */
export async function buildSchemaManifest(root) {
  const absoluteRoot = resolve(root);
  const files = await walkFiles(absoluteRoot);
  const manifest = {};
  let totalBytes = 0;
  for (const path of files) {
    const info = await stat(path);
    manifest[toPosixPath(relative(absoluteRoot, path))] = {
      sha256: await sha256File(path),
      bytes: info.size,
    };
    totalBytes += info.size;
  }
  const sorted = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key];
  return { files: sorted, fileCount: files.length, totalBytes };
}

export function hashManifest(manifest) {
  const canonical = JSON.stringify(
    Object.entries(manifest)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, entry]) => [path, entry.sha256]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Compares the generated manifest against the pinned expectation. */
export function compareManifests(expected, actual) {
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [path, entry] of Object.entries(expected)) {
    if (!actual[path]) missing.push(path);
    else if (actual[path].sha256 !== entry.sha256) {
      changed.push({ path, expected: entry.sha256, actual: actual[path].sha256 });
    }
  }
  for (const path of Object.keys(actual)) {
    if (!expected[path]) extra.push(path);
  }
  return {
    missing,
    extra,
    changed,
    identical: !missing.length && !extra.length && !changed.length,
  };
}

function methodList(bundle, definitionName) {
  const definition = bundle.definitions?.[definitionName];
  if (!definition?.oneOf) return [];
  return definition.oneOf
    .map((variant) => variant?.properties?.method?.enum?.[0])
    .filter((value) => typeof value === "string");
}

function collectStrings(schema) {
  const output = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) if (typeof value === "string") output.add(value);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(schema);
  return output;
}

function requiredOf(schema) {
  return Array.isArray(schema?.required) ? schema.required : [];
}

function itemVariantsWithoutId(bundle) {
  const item = bundle.definitions?.v2?.ThreadItem;
  if (!item?.oneOf) return ["ThreadItem union missing"];
  return item.oneOf
    .filter((variant) => !requiredOf(variant).includes("id"))
    .map((variant) => variant?.properties?.type?.enum?.[0] ?? "unknown-variant");
}

/**
 * Verifies the stable protocol surface against the controller's required
 * contract. Every expectation comes from the caller (expectations.json) so the
 * audit trail names the exact method, message and identifier being required.
 */
export async function verifyStableContract({ schemaDir, expectations }) {
  const stablePath = join(schemaDir, SCHEMA_BUNDLE);
  const v2Path = join(schemaDir, SCHEMA_V2_BUNDLE);
  const stable = JSON.parse(await readFile(stablePath, "utf8"));
  const v2 = JSON.parse(await readFile(v2Path, "utf8"));
  const definitions = stable.definitions ?? {};

  const clientMethods = methodList(stable, "ClientRequest");
  const clientNotifications = methodList(stable, "ClientNotification");
  const serverRequests = methodList(stable, "ServerRequest");
  const serverNotifications = methodList(stable, "ServerNotification");

  const checks = [];
  const missing = (kind, required, actual) => {
    const absent = required.filter((method) => !actual.includes(method));
    checks.push({
      id: `contract.${kind}`,
      ok: absent.length === 0,
      detail:
        absent.length === 0
          ? `${required.length} required ${kind} entries present`
          : `missing ${kind}: ${absent.join(", ")}`,
      missing: absent,
    });
  };

  missing("client-methods", expectations.requiredClientMethods, clientMethods);
  missing("client-notifications", expectations.requiredClientNotifications, clientNotifications);
  missing("server-requests", expectations.requiredServerRequests, serverRequests);
  missing("server-notifications", expectations.requiredServerNotifications, serverNotifications);

  const initializeParams = definitions.InitializeParams;
  checks.push({
    id: "contract.initialize-shape",
    ok:
      requiredOf(initializeParams).includes("clientInfo") &&
      Boolean(definitions.InitializeResponse?.properties?.codexHome),
    detail: "initialize requires clientInfo and responds with codexHome",
  });

  const threadRequired = requiredOf(definitions.v2?.Thread);
  const turnRequired = requiredOf(definitions.v2?.Turn);
  const startRequired = requiredOf(definitions.v2?.ThreadStartResponse);
  const noIdVariants = itemVariantsWithoutId(stable);
  checks.push({
    id: "contract.identifier-fields",
    ok:
      threadRequired.includes("id") &&
      threadRequired.includes("sessionId") &&
      turnRequired.includes("id") &&
      startRequired.includes("thread") &&
      noIdVariants.length === 0,
    detail: `Thread requires id+sessionId, Turn requires id, all ${definitions.v2?.ThreadItem?.oneOf?.length ?? 0} ThreadItem variants require id`,
    itemVariantsWithoutId: noIdVariants,
  });

  const itemStarted = requiredOf(definitions.v2?.ItemStartedNotification).sort();
  const itemCompleted = requiredOf(definitions.v2?.ItemCompletedNotification).sort();
  const turnStarted = requiredOf(definitions.v2?.TurnStartedNotification).sort();
  const turnCompleted = requiredOf(definitions.v2?.TurnCompletedNotification).sort();
  checks.push({
    id: "contract.event-identifiers",
    ok:
      ["item", "threadId", "turnId"].every((key) => itemStarted.includes(key)) &&
      ["item", "threadId", "turnId"].every((key) => itemCompleted.includes(key)) &&
      ["threadId", "turn"].every((key) => turnStarted.includes(key)) &&
      ["threadId", "turn"].every((key) => turnCompleted.includes(key)),
    detail: "item events carry threadId+turnId+item; turn events carry threadId+turn",
    observed: { itemStarted, itemCompleted, turnStarted, turnCompleted },
  });

  const execDecision = collectStrings(definitions.CommandExecutionApprovalDecision);
  const fileDecision = collectStrings(definitions.FileChangeApprovalDecision);
  const approvalFields = requiredOf(definitions.CommandExecutionRequestApprovalParams).sort();
  checks.push({
    id: "contract.approval-decisions",
    ok:
      ["accept", "acceptForSession", "decline", "cancel"].every(
        (value) => execDecision.has(value) && fileDecision.has(value),
      ) && ["itemId", "threadId", "turnId"].every((key) => approvalFields.includes(key)),
    detail:
      "command and file-change approvals expose accept/acceptForSession/decline/cancel and correlate by itemId+threadId+turnId",
    observed: {
      commandExecution: [...execDecision].sort(),
      fileChange: [...fileDecision].sort(),
    },
  });

  const questionParams = definitions.ToolRequestUserInputParams;
  const questionSchema = definitions.ToolRequestUserInputQuestion;
  const questionResponse = definitions.ToolRequestUserInputResponse;
  const questionFields = requiredOf(questionParams).sort();
  const questionRequired = requiredOf(questionSchema).sort();
  const answersSchema = questionResponse?.properties?.answers;
  checks.push({
    id: "contract.user-input-question",
    ok:
      questionFields.includes("questions") &&
      questionFields.includes("threadId") &&
      questionFields.includes("turnId") &&
      ["header", "id", "question"].every((key) => questionRequired.includes(key)) &&
      answersSchema?.type === "object",
    detail:
      "item/tool/requestUserInput requires correlated questions with header/id/question and answers by question id",
    experimentalMarker: /EXPERIMENTAL/i.test(questionResponse?.description ?? "")
      ? "response schema description still says EXPERIMENTAL"
      : null,
  });

  const interruptParams = requiredOf(definitions.v2?.TurnInterruptParams).sort();
  checks.push({
    id: "contract.turn-cancel",
    ok: ["threadId", "turnId"].every((key) => interruptParams.includes(key)),
    detail: "turn/interrupt addresses an exact threadId+turnId",
    observed: interruptParams,
  });

  return {
    checks,
    bundles: {
      stable: { path: SCHEMA_BUNDLE, definitions: Object.keys(definitions).length },
      v2: {
        path: SCHEMA_V2_BUNDLE,
        definitions: Object.keys(v2.definitions ?? {}).length,
      },
    },
    methods: {
      clientMethods,
      clientNotifications,
      serverRequests,
      serverNotifications,
    },
  };
}
