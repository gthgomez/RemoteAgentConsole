import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openDiagnosticOwner } from "./diagnostic-owner.mjs";

const pin = "e992e049ffa7a98ab60740ac60f94918f022ff24";
const activeTree = "c62fcb80464a0b7161efb4c09bdcbd8d9506bea4";
const cli = "apps/cli/src/";
const client = "backends/codex/appServer/client/";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const fixed = [
  `${client}createCodexAppServerClient.ts`, `${client}codexAppServerJsonLineReader.ts`,
  `${client}codexAppServerRpcTimeout.ts`, `${client}codexAppServerRpcLogSanitizer.ts`,
  `${client}createCodexWebSocket.ts`,
  "backends/codex/appServer/appServerCompatibility.ts", "backends/codex/utils/resolveCodexCliInvocation.ts",
  "backends/codex/executionRuns/probeCodexAppServerExecutionRunAvailability.ts",
  "backends/codex/executionRuns/executionRunBackendFactory.ts", "security/restrictedDeployment/policy.ts",
  "utils/safeJson.ts",
];

// Imports outside the selected fragment are poison stubs: an attempt to use an
// upstream launch, WebSocket, process-kill, config or log lane fails this witness.
const tripwires = new Map([
  ["@happier-dev/cli-common/providers", [
    "expandHomeDirPath", "providerCliPathRequiresJavaScriptRuntime", "resolveHomeDirFromEnvironment",
  ]],
  ["@happier-dev/cli-common/process", ["resolveWindowsCommandInvocation", "resolveWindowsCommandPath"]],
  ["../../utils/withCodexNativeStartupLock", ["readCodexNativeStartupVersion", "withCodexNativeStartupLock"]],
  ["../../utils/appendCodexCliConfigOverridesArgs", ["appendCodexCliConfigOverridesArgs"]],
  ["../../utils/resolveConfiguredCodexHome", ["resolveConfiguredCodexConfigTomlPath"]],
  ["@/runtime/js/requireJavaScriptRuntimeExecutable", ["requireJavaScriptRuntimeExecutable"]],
  ["@/runtime/managedTools/requireProviderCliCommand", ["requireProviderCliCommand"]],
  ["@/runtime/managedTools/providerCliResolution", ["resolveProviderCliCommand"]],
  ["@/daemon/service/commandExistsInPath", ["commandExistsInPath"]],
  ["@/utils/runtime", ["isBun"]],
  ["@/agent/runtime/process/killProcessTree", ["killProcessTree"]],
  ["@/daemon/connectedServices/diagnostics/sanitizeConnectedServiceDiagnosticString", [
    "sanitizeConnectedServiceDiagnosticString",
  ]],
  ["@/daemon/connectedServices/diagnostics/sensitiveConnectedServiceDiagnosticFields", [
    "classifyConnectedServiceSensitiveDiagnosticKey", "CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER",
    "CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER", "resolveConnectedServiceSensitiveDiagnosticMarker",
  ]],
]);
const constants = {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY: "HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON",
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY: "HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON",
  HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR: "HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON",
};
const dataModule = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const poison = (names) => dataModule(names.map(
  (name) => `export function ${name}(){throw new Error('unexpected_unowned_codex_dependency')}`,
).join("\n"));
const literals = (names) => dataModule(names.map(
  (name) => `export const ${name}=${JSON.stringify(constants[name])};`,
).join("\n"));

function git(gitExe, args, options) {
  const result = spawnSync(gitExe, ["-c", "core.autocrlf=false", ...args], {
    ...options, timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error("diagnostic_git_input_failed");
  return result.stdout;
}

async function stage({ gitExe, gitDir, objects, source }) {
  const base = {
    env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects },
    cwd: source,
  };
  const show = (...args) => git(gitExe, ["--git-dir", gitDir, ...args], base);
  assert.equal(show("rev-parse", `${pin}^{tree}`).toString().trim(), "911bdc3c673608490b932bd939166d88f198066a");
  assert.equal(show("cat-file", "-t", activeTree).toString().trim(), "tree");
  for (const path of fixed) {
    const output = join(source, cli, path);
    await mkdir(fileURLToPath(new URL(".", pathToFileURL(output))), { recursive: true });
    await writeFile(output, show("show", `${activeTree}:${cli}${path}`), { flag: "wx" });
  }
  const patches = [
    ["0009-codex-restricted-jsonl.patch", "173b465fc186fc0d1071c2357071253c9bad348cf28789a1226b7a10b2d29703"],
    ["0010-codex-owned-stdio.patch", "bb8d74c0f8b7d2e7609ee54811f93efed3fe8fa55a4006e38903831dd7d72a61"],
    ["0011-codex-owned-client-diagnostic.patch"],
  ];
  let bindingPatch;
  for (const [name, digest] of patches) {
    const file = join(repo, "patches", "happier", name);
    const hash = createHash("sha256").update(await readFile(file)).digest("hex");
    if (digest) assert.equal(hash, digest);
    else bindingPatch = hash;
    git(gitExe, ["apply", "--check", file], { cwd: source });
    git(gitExe, ["apply", file], { cwd: source });
  }
  return bindingPatch;
}

// A deterministic peer exercises provider waits and stop races without confusing
// those cases with evidence from the real Codex process below.
async function witnessQueueAndLifetime(createClient) {
  const { Readable } = await import("node:stream");
  const stdout = new Readable({ read() {} });
  const sent = [];
  let releaseWrite;
  let firstQueued;
  const firstAdmitted = new Promise((resolve) => { firstQueued = resolve; });
  let onFailure;
  let disposed = 0;
  const pendingReply = (message, result) => stdout.push(Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`));
  const codex = await createClient({
    processEnv: { HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: "250" },
    transport: {
      kind: "ownedStdio",
      open: async () => ({
        stdin: { async write(bytes) {
          const message = JSON.parse(Buffer.from(bytes).toString("utf8"));
          sent.push(message);
          if (message.method === "initialize") pendingReply(message, {});
          if (message.method === "thread/start") {
            firstQueued();
            await new Promise((resolve) => { releaseWrite = resolve; });
          }
        } },
        stdout,
        stderr: (async function* () {})(),
        onFailure(handler) { onFailure = handler; return () => { onFailure = undefined; }; },
        async dispose() { disposed++; stdout.push(null); return { rootEmpty: true, jobEmpty: true }; },
      }),
    },
  });
  try {
    const started = codex.request("thread/start");
    const tracked = started.then((value) => ({ value }), (error) => ({ error }));
    await firstAdmitted;
    const abort = new AbortController();
    const queued = codex.request("turn/start", {}, { signal: abort.signal });
    const rejected = assert.rejects(queued, { name: "AbortError" });
    abort.abort();
    await rejected;
    const expired = codex.request("thread/read");
    await assert.rejects(expired, /timed out after 250ms/);
    assert.equal(await Promise.race([tracked.then(() => "settled"), delay(0, "pending")]), "pending");
    releaseWrite();
    pendingReply(sent.at(-1), { slow: true });
    assert.deepEqual(await started, { slow: true });
    await delay(0);
    assert.deepEqual(sent.map(({ method }) => method), ["initialize", "initialized", "thread/start"]);

    let exits = 0;
    codex.onExit(() => { throw new Error("observer test"); });
    codex.onExit(() => { exits++; });
    const reply = codex.request("turn/start", {}, { timeoutMs: null });
    const terminal = assert.rejects(reply, { name: "CodexOwnedStdioError" });
    await delay(0);
    onFailure(new Error("synthetic carrier loss"));
    await terminal;
    await assert.rejects(codex.request("turn/start"), { name: "CodexOwnedStdioError" });
    assert.equal(exits, 1);
    assert.equal(sent.filter(({ method }) => method === "turn/start").length, 1);
  } finally {
    releaseWrite?.();
    await codex.dispose();
  }
  assert.equal(disposed, 1);
}

async function main(args) {
  const [gitExe, gitDir, objects, zodEntry, ownerExe, codexExe, temp] = args;
  assert.equal(process.version, "v24.22.1");
  assert.equal(args.length, 7);
  assert.ok(args.every(isAbsolute), "all inputs must be owner-selected absolute paths");
  const scratch = await mkdtemp(join(await realpath(temp), "rac-codex-local-"));
  const source = join(scratch, "source");
  const project = join(scratch, "project");
  const home = join(scratch, "home");
  const steps = [];
  let settlement;
  let phase = "setup";
  try {
    await Promise.all([source, project, home, join(scratch, "temp")].map((dir) => mkdir(dir)));
    await writeFile(join(source, "package.json"), '{"type":"module"}\n', { flag: "wx" });
    git(gitExe, ["init", "--quiet", "--template=", project], { cwd: scratch });
    const bindingPatch = await stage({ gitExe, gitDir, objects, source });
    const ownerExeSha256 = createHash("sha256").update(await readFile(ownerExe)).digest("hex");
    const baseUrl = pathToFileURL(join(source, cli) + "/");
    registerHooks({
      resolve(specifier, context, next) {
        if (!context.parentURL?.startsWith(baseUrl.href)) return next(specifier, context);
        if (specifier === "zod") return next(pathToFileURL(zodEntry).href, context);
        if (specifier === "ws-node") {
          return { url: dataModule("export default class { constructor(){throw new Error('unexpected_websocket')} }"), shortCircuit: true };
        }
        if (tripwires.has(specifier)) return { url: poison(tripwires.get(specifier)), shortCircuit: true };
        if (specifier === "@/daemon/connectedServices/connectedServiceChildEnvironment") {
          return { url: literals(Object.keys(constants).slice(0, 2)), shortCircuit: true };
        }
        if (specifier === "@/daemon/spawn/spawnExplicitEnvKeysMarker") {
          return { url: literals(Object.keys(constants).slice(2)), shortCircuit: true };
        }
        if (specifier.startsWith("@/") || specifier.startsWith(".")) {
          const url = new URL(`${specifier.replace(/^@\//, "./")}.ts`, specifier.startsWith("@/") ? baseUrl : context.parentURL);
          if (existsSync(fileURLToPath(url))) return next(url.href, context);
        }
        return next(specifier, context);
      },
    });
    process.env.HAPPIER_RAC_RESTRICTED_DEPLOYMENT = "1";
    phase = "load-client";
    const { createCodexAppServerClient, bootstrapCodexNativeHome } = await import(new URL(`${client}createCodexAppServerClient.ts`, baseUrl).href);
    const { probeCodexAppServerExecutionRunAvailability } = await import(
      new URL("backends/codex/executionRuns/probeCodexAppServerExecutionRunAvailability.ts", baseUrl).href);
    phase = "deny-unowned";
    const options = { cwd: project, processEnv: {} };
    for (const transport of [undefined, { kind: "daemonProxy" }, { kind: "unixWebSocket", socketPath: "unused" }]) {
      await assert.rejects(() => createCodexAppServerClient({ ...options, transport }), { message: "restricted_codex_owner_required" });
    }
    await assert.rejects(() => bootstrapCodexNativeHome(options), { message: "restricted_codex_owner_required" });
    assert.equal(probeCodexAppServerExecutionRunAvailability({ cwd: project, env: {} }), false);
    await assert.rejects(() => createCodexAppServerClient({
      ...options, configOverrides: ["test.invalid=true"],
      transport: { kind: "ownedStdio", open: async () => assert.fail("owner was opened") },
    }), { message: "restricted_codex_owned_launch_options_unsupported" });
    steps.push("unowned-client-bootstrap-probe-refused");
    phase = "synthetic-queue-lifetime";
    await witnessQueueAndLifetime(createCodexAppServerClient);
    steps.push("synthetic-queued-abort-expiry-null-wait-terminal-no-replay");
    let owner;
    let codex;
    try {
      phase = "native-initialize";
      codex = await createCodexAppServerClient({
        ...options,
        transport: {
          kind: "ownedStdio",
          open: async (signal) => {
            owner = await openDiagnosticOwner({ ownerExe, codexExe, scratch, signal });
            return owner;
          },
        },
        initializeRequestOptions: { signal: AbortSignal.timeout(35000) },
      });
      steps.push("maintained-initialize-initialized");
      phase = "native-thread-start";
      const thread = await codex.request("thread/start", {
        cwd: project, sandbox: "read-only", approvalPolicy: "never",
      }, { signal: AbortSignal.timeout(25000) });
      assert.equal(typeof thread.thread.id, "string");
      assert.equal(await realpath(thread.thread.cwd), await realpath(project));
      assert.equal(thread.thread.cliVersion, "0.172.0");
      assert.equal(thread.thread.status.type, "idle");
      assert.equal(thread.thread.turns.length, 0);
      assert.equal(thread.sandbox.type, "readOnly");
      assert.equal(thread.sandbox.networkAccess, false);
      assert.equal(thread.approvalPolicy, "never");
      steps.push("native-idle-thread-start");
      phase = "native-thread-read";
      const read = await codex.request("thread/read", { threadId: thread.thread.id, includeTurns: false },
        { signal: AbortSignal.timeout(15000) });
      assert.equal(read.thread.id, thread.thread.id);
      assert.equal(read.thread.turns.length, 0);
      steps.push("native-correlated-thread-read");
      phase = "aborted-request";
      await assert.rejects(() => codex.request("thread/read", {}, { signal: AbortSignal.abort() }), { name: "AbortError" });
      steps.push("caller-abort-refused-before-dispatch");
    } finally {
      try { await codex?.dispose(); }
      finally { if (owner) settlement = await owner.dispose(); }
    }
    phase = "settlement";
    assert.deepEqual(settlement, {
      rootEmpty: true, jobEmpty: true, ioComplete: true, submittedWrites: 4, ownerExitCode: 0,
    });
    assert.ok(!existsSync(join(home, "auth.json")));
    steps.push("exact-root-job-native-io-settlement");
    phase = "native-carrier-loss";
    const faultRoot = join(scratch, "carrier-loss");
    await mkdir(faultRoot);
    await Promise.all(["project", "home", "temp"].map((dir) => mkdir(join(faultRoot, dir))));
    git(gitExe, ["init", "--quiet", "--template=", join(faultRoot, "project")], { cwd: scratch });
    let faultOwner;
    const faultClient = await createCodexAppServerClient({
      cwd: join(faultRoot, "project"), processEnv: {},
      transport: {
        kind: "ownedStdio",
        open: async (signal) => {
          faultOwner = await openDiagnosticOwner({ ownerExe, codexExe, scratch: faultRoot, signal });
          return faultOwner;
        },
      },
      initializeRequestOptions: { signal: AbortSignal.timeout(35000) },
    });
    let faultSettlement;
    try {
      const observedExit = new Promise((resolve) => faultClient.onExit(resolve));
      faultSettlement = await faultOwner.dispose();
      const deadline = new AbortController();
      try {
        const error = await Promise.race([observedExit, delay(2000, null, { signal: deadline.signal })]);
        assert.equal(error?.name, "CodexOwnedStdioError");
      } finally {
        deadline.abort();
      }
      await assert.rejects(faultClient.request("thread/read"), { name: "CodexOwnedStdioError" });
      assert.deepEqual(faultSettlement, {
        rootEmpty: true, jobEmpty: true, ioComplete: true, submittedWrites: 2, ownerExitCode: 0,
      });
    } finally {
      await faultClient.dispose();
    }
    steps.push("native-owner-eof-closed-client-no-later-dispatch");
    return { status: "PASS", scope: "local-maintained-client-no-turn", activeTree, bindingPatch, ownerExeSha256, steps, settlement, faultSettlement };
  } catch (error) {
    const errorKind = error instanceof Error ? error.name : null;
    const safeMessage = errorKind !== null && typeof error.message === "string"
      && /^(diagnostic_(?:owner|git)_[a-z_]+|unexpected_[a-z_]+|Codex owned stdio failed closed \([a-z]+\))$/.test(error.message)
      ? error.message : undefined;
    return { status: "FAIL", scope: "local-maintained-client-no-turn", phase, errorKind, safeMessage, steps, settlement };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

try {
  const result = await main(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.status !== "PASS") process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ status: "BLOCKED", scope: "local-maintained-client-no-turn", phase: "inputs-or-cleanup" }));
  process.exitCode = 1;
}
