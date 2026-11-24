#!/usr/bin/env node

/**
 * Offline, source-bound qualification of the selected Happier Codex app-server
 * adapter surface against the pinned native Codex stable schema.
 *
 * Labels: offline, source-bound, not-integrated, not-physical.
 *
 * It executes the selected production capability module and extracted production
 * functions, verifies the pinned native schema bindings, and proves the effect of
 * the maintained adapter patch. It never starts a prompt, model, provider, auth,
 * database, listener or live Happier process.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFunctionModule, extractConst, extractFunction } from "./lib/extract-functions.mjs";
import {
  archiveTo,
  blobHashAt,
  createScratchRepository,
  gitBlobHash,
  gitOrThrow,
  objectType,
  readBlob,
  sha256Bytes,
} from "./lib/git.mjs";
import { classifyStableSchema, verifyNativeBinding } from "./lib/native-schema.mjs";
import { redactString, redactValue } from "./lib/redact.mjs";
import { analyzeHistoryBoundarySource, analyzeRuntimeSource } from "./lib/source-facts.mjs";
import { importCapabilityModule, installSourceHooks } from "./lib/ts-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LABELS = ["offline", "source-bound", "not-integrated", "not-physical"];

const RUNTIME_PATH = "apps/cli/src/backends/codex/appServer/runtime.ts";
const HISTORY_PATH = "apps/cli/src/backends/codex/appServer/codexAppServerHistoryBoundary.ts";

function usage() {
  return [
    "Usage: node qualification/codex-adapter/run-codex-adapter-qualification.mjs [options]",
    "",
    "Required:",
    "  --happier-git-dir <dir>        Pinned Happier .git object directory (read-only)",
    "  --happier-patch-objects <dir>  Object store containing the already-applied candidate tree",
    "  --native-schema-dir <dir>      Exact stable schema bundle directory",
    "  --native-receipt <file>        Native qualification receipt (JSON), explicitly hash-bound",
    "  --reference-archive <file>     Pinned Happier Windows CLI archive for zod/protocol deps",
    "  --git <absolute file>          Owner-trusted Git executable (recorded and rechecked)",
    "  --tar <absolute file>          Owner-trusted tar executable (recorded and rechecked)",
    "",
    "Optional:",
    "  --native-receipt-sha256 <hex>  Explicit owner-supplied receipt content hash",
    "  --patch <file>                 Maintained patch (default: patches/happier/0007-codex-stable-profile.patch)",
    "  --evidence <file>              Write the structured receipt (existing file refused)",
    "  --temp-root <dir>              Parent for the owned disposable workspace",
    "  --keep-temp                    Keep the workspace (console-only path)",
    "  --json                         Print the full receipt instead of a summary",
    "  --help                         Print this help",
    "",
    "Git/tar are not resolved from PATH. They run with an isolated empty Git config,",
    "no ambient GIT_* variables and no dependency installation.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    happierGitDir: null,
    happierPatchObjects: null,
    nativeSchemaDir: null,
    nativeReceipt: null,
    nativeReceiptSha256: null,
    referenceArchive: null,
    git: null,
    tar: null,
    patch: join(repoRoot, "patches", "happier", "0007-codex-stable-profile.patch"),
    evidence: null,
    tempRoot: process.env.RAC_CODEX_ADAPTER_TEMP_ROOT ?? tmpdir(),
    keepTemp: false,
    json: false,
    help: false,
  };
  const takesValue = {
    "--happier-git-dir": "happierGitDir",
    "--happier-patch-objects": "happierPatchObjects",
    "--native-schema-dir": "nativeSchemaDir",
    "--native-receipt": "nativeReceipt",
    "--native-receipt-sha256": "nativeReceiptSha256",
    "--reference-archive": "referenceArchive",
    "--git": "git",
    "--tar": "tar",
    "--patch": "patch",
    "--evidence": "evidence",
    "--temp-root": "tempRoot",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const key = takesValue[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

function createRecorder() {
  const checks = [];
  const push = (id, status, detail, extra = {}) => {
    checks.push({ id, status, detail, ...extra });
    return status;
  };
  return {
    checks,
    pass: (id, detail, extra) => push(id, "pass", detail, extra),
    fail: (id, detail, extra) => push(id, "fail", detail, extra),
    skip: (id, detail, extra) => push(id, "skip", detail, extra),
    blocked: (id, detail, extra) => push(id, "blocked", detail, extra),
  };
}

function assertOwnedWorkspace(root, parent) {
  const resolvedParent = resolve(parent);
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot) !== resolvedParent) {
    throw new Error("refusing to manage a workspace outside the requested temp root");
  }
  if (!basename(resolvedRoot).startsWith("rac-codex-adapter-")) {
    throw new Error("refusing to manage a workspace without the harness prefix");
  }
  return resolvedRoot;
}

function isAbsoluteToolPath(value) {
  return (
    typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value))
  );
}

async function inspectTrustedTool(path, label) {
  if (!isAbsoluteToolPath(path)) {
    return { label, ok: false, reason: "must be an absolute path" };
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { label, ok: false, reason: "does not exist" };
  }
  if (stats.isSymbolicLink()) return { label, ok: false, reason: "is a reparse point" };
  if (!stats.isFile()) return { label, ok: false, reason: "is not a regular file" };
  return {
    label,
    ok: true,
    name: basename(path),
    bytes: stats.size,
    sha256: await sha256File(path),
  };
}

async function createToolEnvironment(workspaceRoot) {
  const home = join(workspaceRoot, "tool-home");
  const xdg = join(workspaceRoot, "tool-xdg");
  const temp = join(workspaceRoot, "tool-temp");
  for (const path of [home, xdg, temp]) await mkdir(path, { recursive: true });
  const emptyGitConfig = join(workspaceRoot, "gitconfig-empty");
  await writeFile(emptyGitConfig, "", "utf8");
  const env = {
    TEMP: temp,
    TMP: temp,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return env;
}

function patchTouchedFiles(patchText) {
  const files = new Set();
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match) files.add(match[1]);
  }
  return [...files].sort();
}

function extractDependencies({ tarPath, env, archivePath, expected, depsDir }) {
  const members = expected.dependencyMembers.map((member) => `${expected.topDir}/${member}`);
  const result = spawnSync(
    tarPath,
    ["-xzf", archivePath, "-C", depsDir, "--strip-components=1", ...members],
    { env, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`dependency extraction failed: ${result.stderr}`);
}

async function runTerminalOutcomeChecks(runtimeSource, moduleDir) {
  const names = [
    "trimStringValue",
    "readRecord",
    "readCodexTurnStatus",
    "isCodexTurnInterruptedStatus",
    "readCodexTerminalOutcome",
  ];
  const built = await buildFunctionModule({
    directory: moduleDir,
    name: "terminal-outcome",
    parts: names.map((name) => extractFunction(runtimeSource, name)),
    exports: ["readCodexTerminalOutcome"],
  });
  const read = built.module.readCodexTerminalOutcome;
  const cases = [
    {
      id: "completed",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
      expected: "completed",
    },
    {
      id: "interrupted-status",
      method: "turn/completed",
      params: { turn: { status: "interrupted" } },
      expected: "interrupted",
    },
    {
      id: "failed-status",
      method: "turn/completed",
      params: { turn: { status: "failed" } },
      expected: "failed",
    },
    {
      id: "optional-notification",
      method: "turn/interrupted",
      params: { threadId: "thread", turn: { id: "turn" } },
      expected: "interrupted",
    },
  ];
  return cases.map((entry) => ({
    id: entry.id,
    method: entry.method,
    expected: entry.expected,
    actual: read(entry.method, entry.params),
  }));
}

async function runInterruptChecks(runtimeSource, moduleDir) {
  const parts = [
    extractFunction(runtimeSource, "isNoActiveTurnToInterruptError"),
    extractFunction(runtimeSource, "requestCodexTurnInterruptWithStartupRetry"),
    extractConst(runtimeSource, "CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_WINDOW_MS"),
    extractConst(runtimeSource, "CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS"),
  ];
  const built = await buildFunctionModule({
    directory: moduleDir,
    name: "turn-interrupt",
    parts,
    exports: ["requestCodexTurnInterruptWithStartupRetry"],
  });
  const request = built.module.requestCodexTurnInterruptWithStartupRetry;

  const calls = [];
  const requested = await request({
    client: {
      async request(method, params) {
        calls.push({ method, params });
        return {};
      },
    },
    threadId: "thread-1",
    turnId: "turn-1",
    waitForProviderTerminal: async () => false,
  });

  const gapCalls = [];
  let gapWaits = 0;
  const providerTerminal = await request({
    client: {
      async request(method, params) {
        gapCalls.push({ method, params });
        throw new Error("no active turn to interrupt");
      },
    },
    threadId: "thread-2",
    turnId: "turn-2",
    waitForProviderTerminal: async () => {
      gapWaits += 1;
      return true;
    },
  });

  let propagated = null;
  try {
    await request({
      client: {
        async request() {
          throw new Error("transport exploded");
        },
      },
      threadId: "thread-3",
      turnId: "turn-3",
      waitForProviderTerminal: async () => false,
    });
  } catch (error) {
    propagated = error.message;
  }

  return {
    requested: { result: requested, calls },
    providerTerminal: { result: providerTerminal, calls: gapCalls, waits: gapWaits },
    propagatedError: propagated,
  };
}

async function runRollbackUnsupportedChecks(runtimeSource, moduleDir) {
  const built = await buildFunctionModule({
    directory: moduleDir,
    name: "rollback-unsupported",
    parts: [extractFunction(runtimeSource, "readRollbackUnsupportedErrorMessage")],
    exports: ["readRollbackUnsupportedErrorMessage"],
  });
  const read = built.module.readRollbackUnsupportedErrorMessage;
  return {
    methodNotFoundClassified:
      typeof read(new Error("method not found: thread/rollback")) === "string",
    invalidParamsClassified:
      typeof read(new Error("invalid params for thread/rollback")) === "string",
    unrelatedErrorRejected: read(new Error("transport exploded")) === null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const required = [
    "happierGitDir",
    "happierPatchObjects",
    "nativeSchemaDir",
    "nativeReceipt",
    "referenceArchive",
    "git",
    "tar",
  ];
  const missing = required.filter((name) => !options[name]);
  if (missing.length > 0) {
    console.error(
      `[codex-adapter] missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
    );
    console.error(usage());
    return 1;
  }
  if (options.evidence) {
    if (await pathExists(options.evidence)) {
      console.error(
        "[codex-adapter] evidence file already exists; write the receipt to a new path",
      );
      return 1;
    }
  }

  const expectations = JSON.parse(await readFile(join(here, "expectations.json"), "utf8"));
  const patchPath = resolve(options.patch);
  if (!(await pathExists(patchPath))) {
    console.error(`[codex-adapter] patch not found: ${patchPath}`);
    return 1;
  }

  const parent = resolve(options.tempRoot);
  await mkdir(parent, { recursive: true });
  const workspaceRoot = await mkdtemp(join(parent, "rac-codex-adapter-"));
  assertOwnedWorkspace(workspaceRoot, parent);
  const workspace = {
    root: workspaceRoot,
    deps: join(workspaceRoot, "deps"),
    scratch: join(workspaceRoot, "scratch"),
    unpatched: join(workspaceRoot, "unpatched"),
    patched: join(workspaceRoot, "patched"),
    source: join(workspaceRoot, "source"),
    modules: join(workspaceRoot, "modules"),
  };
  for (const path of Object.values(workspace)) {
    if (path !== workspaceRoot) await mkdir(path, { recursive: true });
  }
  await writeFile(join(workspace.modules, "package.json"), '{"type":"module"}\n', "utf8");
  const redactionRoots = [
    { root: resolve(options.happierGitDir), placeholder: "%HAPPIER_GIT%" },
    { root: resolve(options.happierPatchObjects), placeholder: "%PATCH_OBJECTS%" },
    { root: resolve(options.nativeSchemaDir), placeholder: "%NATIVE_SCHEMA%" },
    { root: resolve(options.nativeReceipt), placeholder: "%NATIVE_RECEIPT%" },
    { root: dirname(resolve(options.nativeReceipt)), placeholder: "%NATIVE_EVIDENCE%" },
    { root: resolve(options.referenceArchive), placeholder: "%REFERENCE_ARCHIVE%" },
    { root: dirname(resolve(options.referenceArchive)), placeholder: "%REFERENCE_DIR%" },
    { root: resolve(options.patch), placeholder: "%PATCH%" },
    { root: dirname(resolve(options.patch)), placeholder: "%PATCH_DIR%" },
    { root: workspaceRoot, placeholder: "%WORKSPACE%" },
    { root: repoRoot, placeholder: "%REPO%" },
  ];
  if (options.evidence) {
    redactionRoots.push(
      { root: resolve(options.evidence), placeholder: "%EVIDENCE_FILE%" },
      { root: dirname(resolve(options.evidence)), placeholder: "%EVIDENCE_DIR%" },
    );
  }
  redactionRoots.sort((left, right) => right.root.length - left.root.length);

  const recorder = createRecorder();
  const startedAt = new Date();
  const report = {
    schemaVersion: 1,
    suite: expectations.suite,
    target: expectations.target,
    status: "BLOCKED",
    labels: LABELS,
    scope: expectations.scope,
    generatedAt: startedAt.toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    bindings: null,
    tools: null,
    nativeReceiptBinding: null,
    capability: null,
    nativeSchema: null,
    source: null,
    executed: null,
    patchJustified: null,
    limitations: [],
    checks: recorder.checks,
  };

  try {
    const gitTool = await inspectTrustedTool(resolve(options.git), "git");
    const tarTool = await inspectTrustedTool(resolve(options.tar), "tar");
    report.tools = {
      git: gitTool.ok
        ? { name: gitTool.name, sha256: gitTool.sha256, bytes: gitTool.bytes }
        : { rejected: gitTool.reason },
      tar: tarTool.ok
        ? { name: tarTool.name, sha256: tarTool.sha256, bytes: tarTool.bytes }
        : { rejected: tarTool.reason },
      boundary:
        "Owner-supplied absolute Git/tar are trusted inputs. They run with an isolated empty Git config, no ambient GIT_* variables and no dependency installation. A replaced tool invalidates this binding.",
    };
    if (!gitTool.ok || !tarTool.ok) {
      recorder.blocked("tools.trusted", "owner-trusted Git/tar inputs were not accepted", {
        git: gitTool.ok ? "accepted" : gitTool.reason,
        tar: tarTool.ok ? "accepted" : tarTool.reason,
      });
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    recorder.pass(
      "tools.trusted",
      "owner-trusted absolute Git and tar inputs are present and hashed",
    );
    const toolEnv = await createToolEnvironment(workspace.root);
    // Patch binding and shape.
    const patchText = await readFile(patchPath, "utf8");
    const patchSha256 = sha256Bytes(Buffer.from(patchText, "utf8"));
    const touched = patchTouchedFiles(patchText);
    if (patchSha256 === expectations.patch.sha256) {
      recorder.pass("patch.sha256", "maintained patch matches the pinned digest");
    } else {
      recorder.fail("patch.sha256", "maintained patch digest differs from the pinned expectation", {
        expected: expectations.patch.sha256,
        actual: patchSha256,
      });
    }
    if (JSON.stringify(touched) === JSON.stringify(expectations.patch.touchesOnly)) {
      recorder.pass("patch.touches-only", `patch touches ${touched.join(", ")}`);
    } else {
      recorder.fail("patch.touches-only", "patch touches unexpected files", { touched });
    }

    // Reference archive binding and minimal dependency extraction.
    const archiveSha256 = await sha256File(resolve(options.referenceArchive));
    if (archiveSha256 === expectations.happier.referenceArchive.sha256) {
      recorder.pass("archive.sha256", "reference CLI archive matches the pinned digest");
    } else {
      recorder.fail("archive.sha256", "reference CLI archive digest differs", {
        expected: expectations.happier.referenceArchive.sha256,
        actual: archiveSha256,
      });
    }
    extractDependencies({
      tarPath: resolve(options.tar),
      env: toolEnv,
      archivePath: resolve(options.referenceArchive),
      expected: expectations.happier.referenceArchive,
      depsDir: workspace.deps,
    });
    const protocolIndex = join(
      workspace.deps,
      "node_modules",
      "@happier-dev",
      "protocol",
      "dist",
      "index.js",
    );
    if (await pathExists(protocolIndex)) {
      recorder.pass(
        "archive.dependencies",
        "minimal zod/protocol dependencies extracted from the pinned archive",
      );
    } else {
      recorder.blocked(
        "archive.dependencies",
        "protocol dependency was not present in the archive",
      );
    }

    // Object-store bindings.
    const scratchGit = await createScratchRepository({
      gitPath: resolve(options.git),
      env: toolEnv,
      parent: workspace.scratch,
      objectDirs: [resolve(options.happierGitDir, "objects"), resolve(options.happierPatchObjects)],
    });
    const gitOptions = { gitPath: resolve(options.git), env: toolEnv, gitDir: scratchGit };
    const commitType = objectType({ ...gitOptions, objectId: expectations.happier.commit });
    const treeType = objectType({ ...gitOptions, objectId: expectations.happier.tree });
    const candidateType = objectType({
      ...gitOptions,
      objectId: expectations.happier.candidateTree,
    });
    if (commitType === "commit" && treeType === "tree" && candidateType === "tree") {
      recorder.pass(
        "happier.objects",
        "pinned commit, source tree and applied candidate tree are present",
      );
    } else {
      recorder.blocked("happier.objects", "pinned Happier objects are unavailable", {
        commitType,
        treeType,
        candidateType,
      });
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const commitTree = gitOrThrow({
      ...gitOptions,
      args: ["rev-parse", `${expectations.happier.commit}^{tree}`],
    }).trim();
    if (commitTree === expectations.happier.tree) {
      recorder.pass("happier.commit-tree", "pinned commit resolves to the expected source tree");
    } else {
      recorder.fail("happier.commit-tree", "pinned commit resolves to a different tree", {
        expected: expectations.happier.tree,
        actual: commitTree,
      });
      report.stoppedAt = "happier-commit-tree";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }

    const sourceHashes = {};
    let sourceMismatch = false;
    for (const [path, expected] of Object.entries(expectations.happier.sourceFiles)) {
      const actual = blobHashAt({
        ...gitOptions,
        revision: expectations.happier.candidateTree,
        path,
      });
      sourceHashes[path] = actual;
      if (actual !== expected) {
        sourceMismatch = true;
        recorder.fail("source.blob", `source blob differs for ${path}`, { expected, actual });
      }
    }
    report.bindings = {
      happier: {
        commit: expectations.happier.commit,
        tree: expectations.happier.tree,
        candidateTree: expectations.happier.candidateTree,
        sourceBlobs: sourceHashes,
      },
      patch: { path: expectations.patch.path, sha256: patchSha256, touches: touched },
      archive: {
        sha256: archiveSha256,
        topDir: expectations.happier.referenceArchive.topDir,
      },
    };
    if (sourceMismatch) {
      report.stoppedAt = "source-binding";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    recorder.pass("source.blobs", "pinned adopter and adapter source blobs match");

    const patchReceiptPath = join(dirname(resolve(options.happierPatchObjects)), "receipt.json");
    if (await pathExists(patchReceiptPath)) {
      const patchReceipt = JSON.parse(await readFile(patchReceiptPath, "utf8"));
      const matches =
        patchReceipt.sourceCommit === expectations.happier.commit &&
        patchReceipt.sourceTree === expectations.happier.tree &&
        patchReceipt.candidateTree === expectations.happier.candidateTree;
      report.bindings.happier.patchReceipt = {
        path: "patch-index-verification/receipt.json",
        patchCount: patchReceipt.patchCount ?? null,
        changedPathCount: patchReceipt.changedPathCount ?? null,
        matches,
      };
      if (matches) {
        recorder.pass(
          "happier.patch-receipt",
          `candidate tree is bound to ${patchReceipt.patchCount ?? "?"} ordered patches`,
        );
      } else {
        recorder.fail(
          "happier.patch-receipt",
          "patch-index receipt does not bind the expected trees",
        );
      }
    } else {
      recorder.skip("happier.patch-receipt", "no patch-index receipt beside the object store");
    }

    // Extract the selected production source.
    await archiveTo({
      ...gitOptions,
      tarPath: resolve(options.tar),
      tarEnv: toolEnv,
      revision: expectations.happier.candidateTree,
      paths: ["packages/agents/src"],
      destination: workspace.unpatched,
      maxBytes: expectations.limits.maxArchiveBytes,
    });
    await writeFile(join(workspace.unpatched, "package.json"), '{"type":"module"}\n', "utf8");
    await cp(workspace.unpatched, workspace.patched, { recursive: true });
    const applyCheck = spawnSync(resolve(options.git), ["apply", "--check", patchPath], {
      cwd: workspace.patched,
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    if (applyCheck.status !== 0) {
      recorder.fail("patch.applies", "patch does not apply to the applied candidate tree", {
        stderr: String(applyCheck.stderr).slice(0, 300),
      });
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const apply = spawnSync(resolve(options.git), ["apply", patchPath], {
      cwd: workspace.patched,
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    if (apply.status !== 0) {
      recorder.fail("patch.applies", "patch application failed", {
        stderr: String(apply.stderr).slice(0, 300),
      });
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const patchedManifest = await readFile(
      join(workspace.patched, "packages", "agents", "src", "manifest.ts"),
      "utf8",
    );
    const patchedBlob = gitBlobHash(patchedManifest);
    if (report.bindings?.patch) report.bindings.patch.patchedManifestBlob = patchedBlob;
    if (patchedBlob === expectations.patch.expectedPatchedManifestBlob) {
      recorder.pass("patch.result", "patched manifest blob matches the expected result");
    } else {
      recorder.fail("patch.result", "patched manifest blob differs from the expected result", {
        expected: expectations.patch.expectedPatchedManifestBlob,
        actual: patchedBlob,
      });
      report.stoppedAt = "patch-result";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }

    const runtimeSource = readBlob({
      ...gitOptions,
      revision: expectations.happier.candidateTree,
      path: RUNTIME_PATH,
      maxBytes: expectations.limits.maxSourceBytes,
    });
    const historySource = readBlob({
      ...gitOptions,
      revision: expectations.happier.candidateTree,
      path: HISTORY_PATH,
      maxBytes: expectations.limits.maxSourceBytes,
    });
    await writeFile(join(workspace.source, "runtime.ts"), runtimeSource, "utf8");
    await writeFile(join(workspace.source, "history.ts"), historySource, "utf8");

    // Execute the actual selected capability module, unpatched and patched.
    installSourceHooks({ depsDir: workspace.deps });
    const unpatchedModule = await importCapabilityModule(workspace.unpatched);
    const patchedModule = await importCapabilityModule(workspace.patched);
    const modes = expectations.capability.modes;
    const capabilities = [
      expectations.capability.capability,
      ...expectations.capability.otherCapabilities,
    ];
    const evaluate = (module) => {
      const matrix = {};
      for (const mode of modes) {
        matrix[mode] = {};
        for (const capability of capabilities) {
          matrix[mode][capability] = module.evaluateAgentSessionCapabilitySupport({
            agentId: expectations.capability.agentId,
            capability,
            metadata: { codexBackendMode: mode },
          });
        }
      }
      return matrix;
    };
    const unpatched = evaluate(unpatchedModule);
    const patched = evaluate(patchedModule);
    report.capability = { unpatched, patched };

    if (
      unpatched.appServer[expectations.capability.capability] ===
      expectations.capability.unpatchedAppServer
    ) {
      recorder.pass(
        "capability.defect-observed",
        `selected source advertises ${expectations.capability.capability}=supported for appServer`,
      );
    } else {
      recorder.fail(
        "capability.defect-observed",
        "selected source does not advertise the rollback capability; the patch is not justified",
        { actual: unpatched.appServer[expectations.capability.capability] },
      );
    }
    if (
      patched.appServer[expectations.capability.capability] ===
      expectations.capability.patchedAppServer
    ) {
      recorder.pass("capability.patch-effect", "patched source withholds rollback for appServer");
    } else {
      recorder.fail(
        "capability.patch-effect",
        "patched source still advertises rollback for appServer",
        {
          actual: patched.appServer[expectations.capability.capability],
        },
      );
    }
    const collateral = [];
    for (const mode of modes) {
      for (const capability of capabilities) {
        const before = unpatched[mode][capability];
        const after = patched[mode][capability];
        if (before !== after) collateral.push({ mode, capability, before, after });
      }
    }
    if (
      collateral.length === 1 &&
      collateral[0].mode === "appServer" &&
      collateral[0].capability === expectations.capability.capability
    ) {
      recorder.pass(
        "capability.no-collateral-change",
        "only appServer rollback capability changed",
      );
    } else {
      recorder.fail("capability.no-collateral-change", "patch changed unrelated capabilities", {
        changed: collateral,
      });
    }

    // Native schema classification and binding.
    const receiptHashSource = options.nativeReceiptSha256 ? "owner-supplied" : "expectations";
    const expectedReceiptSha256 = String(
      options.nativeReceiptSha256 ?? expectations.native.receiptContentSha256 ?? "",
    ).toLowerCase();
    report.nativeReceiptBinding = {
      expectedSha256: expectedReceiptSha256,
      source: receiptHashSource,
      label: expectations.native.receiptLabel ?? null,
    };
    if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha256)) {
      recorder.fail(
        "native.receipt-binding",
        "no explicit 64-hex native receipt hash was supplied or pinned",
      );
      report.stoppedAt = "native-receipt-binding";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const nativeBinding = await verifyNativeBinding({
      schemaDir: resolve(options.nativeSchemaDir),
      receiptPath: resolve(options.nativeReceipt),
      expectations,
      expectedReceiptSha256,
    });
    report.nativeSchema = {
      binding: nativeBinding.receipt,
      problems: nativeBinding.problems,
    };
    report.bindings.native = nativeBinding.receipt;
    if (nativeBinding.ok) {
      recorder.pass(
        "native.receipt-binding",
        "native receipt, binary, version and schema bundle hashes match",
      );
    } else {
      recorder.fail("native.receipt-binding", "native receipt binding failed", {
        problems: nativeBinding.problems,
      });
    }
    const schema = await classifyStableSchema(resolve(options.nativeSchemaDir));
    report.nativeSchema.classification = schema;
    const _classifications = expectations.classifications;

    if (!schema.methods.hasThreadRollback) {
      recorder.pass(
        "native.rollback-absent",
        "thread/rollback is absent from the stable ClientRequest",
      );
    } else {
      recorder.fail(
        "native.rollback-absent",
        "thread/rollback unexpectedly exists in the stable ClientRequest",
      );
    }
    if (
      schema.methods.hasThreadRevert &&
      JSON.stringify(schema.shapes.revertRequired.sort()) ===
        JSON.stringify(["beforeTurnId", "threadId"])
    ) {
      recorder.pass(
        "native.revert-shape",
        "thread/revert exists with { threadId, beforeTurnId } and remains not qualified",
      );
    } else {
      recorder.fail(
        "native.revert-shape",
        "thread/revert shape differs from the pinned expectation",
      );
    }
    if (
      schema.methods.hasTurnInterrupt &&
      JSON.stringify(schema.shapes.interruptRequired.sort()) ===
        JSON.stringify(["threadId", "turnId"])
    ) {
      recorder.pass("native.interrupt-shape", "turn/interrupt requires threadId and turnId");
    } else {
      recorder.fail(
        "native.interrupt-shape",
        "turn/interrupt shape differs from the pinned expectation",
      );
    }
    if (
      schema.methods.hasTurnCompleted &&
      ["threadId", "turn"].every((key) => schema.shapes.completedRequired.includes(key)) &&
      ["id", "status"].every((key) => schema.shapes.turnRequired.includes(key)) &&
      ["completed", "interrupted", "failed", "inProgress"].every((value) =>
        schema.shapes.turnStatus.includes(value),
      )
    ) {
      recorder.pass(
        "native.completed-shape",
        "turn/completed carries threadId and a typed turn with status",
      );
    } else {
      recorder.fail(
        "native.completed-shape",
        "turn/completed shape differs from the pinned expectation",
      );
    }
    if (!schema.methods.hasTurnInterrupted) {
      recorder.pass(
        "native.interrupted-absent",
        "turn/interrupted is absent and remains optional compatibility",
      );
    } else {
      recorder.fail(
        "native.interrupted-absent",
        "turn/interrupted is stable in this schema; classification must be revisited",
      );
    }

    // Static source facts.
    const runtimeFacts = analyzeRuntimeSource(runtimeSource);
    const historyFacts = analyzeHistoryBoundarySource(historySource);
    report.source = { runtime: runtimeFacts, history: historyFacts };
    recordSourceChecks(recorder, runtimeFacts, historyFacts);

    // Executed production functions.
    const terminal = await runTerminalOutcomeChecks(runtimeSource, workspace.modules);
    const interrupt = await runInterruptChecks(runtimeSource, workspace.modules);
    const rollbackUnsupported = await runRollbackUnsupportedChecks(
      runtimeSource,
      workspace.modules,
    );
    report.executed = { terminal, interrupt, rollbackUnsupported };
    const terminalOk = terminal.every((entry) => entry.actual === entry.expected);
    if (terminalOk) {
      recorder.pass(
        "executed.terminal-outcome",
        "production terminal classifier matches all expected cases",
      );
    } else {
      recorder.fail("executed.terminal-outcome", "production terminal classifier diverged", {
        terminal,
      });
    }
    const requestedOk =
      interrupt.requested.result === "requested" &&
      interrupt.requested.calls.length === 1 &&
      interrupt.requested.calls[0].method === "turn/interrupt" &&
      interrupt.requested.calls[0].params.threadId === "thread-1" &&
      interrupt.requested.calls[0].params.turnId === "turn-1";
    const providerOk =
      interrupt.providerTerminal.result === "providerTerminal" &&
      interrupt.providerTerminal.waits === 1 &&
      interrupt.providerTerminal.calls.length === 1;
    const errorOk = interrupt.propagatedError === "transport exploded";
    if (requestedOk && providerOk && errorOk) {
      recorder.pass(
        "executed.interrupt-request",
        "production interrupt helper sends the exact typed request and propagates failures",
      );
    } else {
      recorder.fail("executed.interrupt-request", "production interrupt helper diverged", {
        interrupt,
      });
    }
    const rollbackUnsupportedOk =
      rollbackUnsupported.methodNotFoundClassified === true &&
      rollbackUnsupported.invalidParamsClassified === true &&
      rollbackUnsupported.unrelatedErrorRejected === true;
    if (rollbackUnsupportedOk) {
      recorder.pass(
        "executed.rollback-unsupported",
        "production rollback classifier maps unsupported errors only",
      );
    } else {
      recorder.fail("executed.rollback-unsupported", "production rollback classifier diverged", {
        rollbackUnsupported,
      });
    }

    report.patchJustified =
      unpatched.appServer[expectations.capability.capability] === "supported" &&
      patched.appServer[expectations.capability.capability] === "unsupported" &&
      !schema.methods.hasThreadRollback &&
      collateral.length === 1;

    // Explicitly record what cannot run in this lane.
    report.limitations = [
      {
        id: "happier-build",
        status: "not-run",
        reason:
          "The Happier workspace dependency install (yarn lane) is not available offline; no package install was attempted.",
      },
      {
        id: "happier-runtime-e2e",
        status: "not-run",
        reason:
          "Running the Happier daemon/session runtime would start a live service; prohibited by this lane.",
      },
      {
        id: "cancellation-live",
        status: "not-run",
        reason:
          "Live cancellation requires a prompt/model turn; prohibited. Only request shape and terminal-gated settlement are verified.",
      },
      {
        id: "history-rollback",
        status: "not-qualified",
        reason: "thread/revert is stable but history rollback is outside the first qualification.",
      },
      {
        id: "source-facts",
        status: "static-only",
        reason:
          "The request-shape and settlement assertions read the pinned source text; they are not a runtime execution of runtime.ts.",
      },
    ];
    for (const limitation of report.limitations) {
      recorder.skip(`limitation.${limitation.id}`, limitation.reason);
    }

    return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
  } catch (error) {
    recorder.fail("harness.error", "the harness stopped on an unexpected error", {
      message: String(error?.message ?? error).slice(0, 300),
    });
    return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
  } finally {
    if (!options.keepTemp) {
      try {
        const owned = assertOwnedWorkspace(workspace.root, parent);
        await rm(owned, { recursive: true, force: true });
      } catch (error) {
        console.error(`[codex-adapter] temp cleanup refused: ${String(error.message)}`);
      }
    }
  }
}

function recordSourceChecks(recorder, runtime, history) {
  const rollbackOk =
    runtime.rollback.count === 2 &&
    runtime.rollback.shapes.every((shape) => shape.hasThreadId && shape.hasNumTurns);
  if (rollbackOk) {
    recorder.pass(
      "source.rollback-shape",
      "exactly two thread/rollback calls, both { threadId, numTurns }",
    );
  } else {
    recorder.fail(
      "source.rollback-shape",
      "thread/rollback call shapes differ from the pinned expectation",
      {
        rollback: runtime.rollback,
      },
    );
  }
  if (
    runtime.revert.count === 1 &&
    runtime.revert.shapes.every((shape) => shape.hasThreadId && shape.hasBeforeTurnId)
  ) {
    recorder.pass(
      "source.revert-shape",
      "one thread/revert history path, classified not qualified",
    );
  } else {
    recorder.fail(
      "source.revert-shape",
      "thread/revert call shape differs from the pinned expectation",
      {
        revert: runtime.revert,
      },
    );
  }
  if (
    runtime.interrupt.count === 1 &&
    runtime.interrupt.shapes.every((shape) => shape.hasThreadId && shape.hasTurnId)
  ) {
    recorder.pass("source.interrupt-shape", "one turn/interrupt call with threadId and turnId");
  } else {
    recorder.fail(
      "source.interrupt-shape",
      "turn/interrupt call shape differs from the pinned expectation",
      {
        interrupt: runtime.interrupt,
      },
    );
  }
  if (
    runtime.cancel.found &&
    runtime.cancel.requestsInterrupt &&
    runtime.cancel.awaitsTerminalAfterInterrupt &&
    !runtime.cancel.settlesOptimistically
  ) {
    recorder.pass(
      "source.no-optimistic-settlement",
      "cancel awaits the terminal turn without settling on the interrupt request",
    );
  } else {
    recorder.fail(
      "source.no-optimistic-settlement",
      "cancel settlement pattern differs from the pinned expectation",
      {
        cancel: runtime.cancel,
      },
    );
  }
  const handlers = runtime.terminal.handlers.join(",");
  if (
    handlers.includes("'turn/completed'") &&
    handlers.includes("'turn/interrupted'") &&
    runtime.terminal.identityComparesTrackedTurnId &&
    runtime.terminal.outcomeClassifiesCompatibilityNotification &&
    runtime.terminal.outcomeClassifiesInterruptedStatus
  ) {
    recorder.pass(
      "source.terminal-typing",
      "terminal handlers accept completion and optional interruption with turn identity",
    );
  } else {
    recorder.fail("source.terminal-typing", "terminal handler or identity patterns differ", {
      terminal: runtime.terminal,
    });
  }
  if (history.includesCompleted && history.includesInterrupted) {
    recorder.pass(
      "source.history-terminal-boundary",
      "history boundary accepts both terminal methods",
    );
  } else {
    recorder.fail("source.history-terminal-boundary", "history boundary terminal methods differ", {
      history,
    });
  }
  if (
    runtime.rollbackUnsupportedHandling.mapsMethodNotFound &&
    runtime.rollbackUnsupportedHandling.returnsUnsupportedAction
  ) {
    recorder.pass(
      "source.rollback-unsupported",
      "rollback maps method-not-found/invalid-params to unsupported_action",
    );
  } else {
    recorder.fail("source.rollback-unsupported", "rollback unsupported handling differs");
  }
}

async function finalize(report, recorder, options, _workspace, redactionRoots, startedAt) {
  if (report.tools?.git?.sha256 && report.tools?.tar?.sha256) {
    const gitSha256 = await sha256File(resolve(options.git));
    const tarSha256 = await sha256File(resolve(options.tar));
    if (gitSha256 === report.tools.git.sha256 && tarSha256 === report.tools.tar.sha256) {
      recorder.pass("tools.stable", "owner-trusted Git and tar digests are unchanged for the run");
    } else {
      recorder.fail("tools.stable", "owner-trusted Git or tar changed during the run");
    }
  }
  const statuses = recorder.checks.map((check) => check.status);
  const hasBlocked = statuses.includes("blocked");
  const hasFailed = statuses.includes("fail");
  report.status = hasBlocked ? "BLOCKED" : hasFailed ? "FAIL" : "PASS";
  report.completedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.summary = {
    checks: recorder.checks.length,
    passed: statuses.filter((status) => status === "pass").length,
    failed: statuses.filter((status) => status === "fail").length,
    skipped: statuses.filter((status) => status === "skip").length,
    blocked: statuses.filter((status) => status === "blocked").length,
  };
  report.harness = { files: [] };
  for (const relativePath of [
    "run-codex-adapter-qualification.mjs",
    "expectations.json",
    "lib/extract-functions.mjs",
    "lib/git.mjs",
    "lib/native-schema.mjs",
    "lib/redact.mjs",
    "lib/source-facts.mjs",
    "lib/ts-modules.mjs",
  ]) {
    const path = join(here, relativePath);
    if (await pathExists(path)) {
      report.harness.files.push({ path: relativePath, sha256: await sha256File(path) });
    }
  }
  report.harness.patch = {
    path: "patches/happier/0007-codex-stable-profile.patch",
    sha256: await sha256File(
      join(repoRoot, "patches", "happier", "0007-codex-stable-profile.patch"),
    ),
  };

  const redacted = redactValue(report, redactionRoots);
  if (options.evidence)
    redacted.evidencePath = redactString(resolve(options.evidence), redactionRoots);
  const body = `${JSON.stringify(redacted, null, 2)}\n`;
  const finalDocument = `${JSON.stringify(
    { ...redacted, evidenceContentSha256: createHash("sha256").update(body).digest("hex") },
    null,
    2,
  )}\n`;
  if (options.evidence) {
    await mkdir(dirname(resolve(options.evidence)), { recursive: true });
    await writeFile(resolve(options.evidence), finalDocument, { encoding: "utf8", flag: "wx" });
  }
  if (options.json) console.log(finalDocument);
  else printSummary(redacted, options);
  return redacted.status === "PASS" ? 0 : 1;
}

function printSummary(report, options) {
  const lines = [];
  lines.push(`${report.suite} — ${report.status}`);
  lines.push(`label: ${report.labels.join(", ")}`);
  lines.push(
    `capability: ${report.capability ? `unpatched=${report.capability.unpatched.appServer["sessionRollback.conversation"]} patched=${report.capability.patched.appServer["sessionRollback.conversation"]}` : "not evaluated"}`,
  );
  lines.push(`patch justified: ${report.patchJustified}`);
  for (const check of report.checks) {
    const marker =
      check.status === "pass"
        ? "ok  "
        : check.status === "fail"
          ? "FAIL"
          : check.status === "blocked"
            ? "BLOC"
            : "note";
    lines.push(`  [${marker}] ${check.id}: ${check.detail}`);
  }
  if (report.limitations.length > 0) {
    for (const limitation of report.limitations) {
      lines.push(`  [limit] ${limitation.id}: ${limitation.status} — ${limitation.reason}`);
    }
  }
  lines.push(
    `summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} noted, ${report.summary.blocked} blocked`,
  );
  if (options.evidence) lines.push(`evidence: ${report.evidencePath}`);
  console.log(lines.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[codex-adapter] ${error.stack ?? error.message}`);
      process.exitCode = 1;
    });
}
