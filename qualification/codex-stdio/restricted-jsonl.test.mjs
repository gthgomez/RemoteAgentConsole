#!/usr/bin/env node

/**
 * Offline, source-bound qualification of the restricted JSONL byte reader added
 * by `patches/happier/0009-codex-restricted-jsonl.patch`.
 *
 * Labels: offline, source-bound, not-integrated, not-physical.
 *
 * The test reads the pinned Happier commit/tree and the already-applied
 * five-patch candidate tree from pinned Git objects, proves that the patch
 * applies to the candidate source and only appends code to the maintained
 * `codexAppServerJsonLineReader.ts`, then imports the patched module with the
 * pinned Node type stripper and executes the byte reader against synthetic
 * chunks. The original string reader is executed from both the unpatched and
 * patched module and must behave identically.
 *
 * It never starts a prompt, model, provider, auth, database, relay, listener,
 * installed app, real Codex executable or network request. JSON-RPC validation,
 * provider decisions and owned process settlement are explicitly out of scope.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const SOURCE_PATH = "apps/cli/src/backends/codex/appServer/client/codexAppServerJsonLineReader.ts";

const EXPECTED = {
  commit: "e992e049ffa7a98ab60740ac60f94918f022ff24",
  tree: "911bdc3c673608490b932bd939166d88f198066a",
  candidateTree: "c62fcb80464a0b7161efb4c09bdcbd8d9506bea4",
  patchCount: 5,
  sourcePath: SOURCE_PATH,
  sourceBlob: "d29c56f888a11e1e7c131ee42ff3bbe27aaea7ec",
  patchPath: "patches/happier/0009-codex-restricted-jsonl.patch",
  patchSha256: "173b465fc186fc0d1071c2357071253c9bad348cf28789a1226b7a10b2d29703",
  patchedBlob: "26e11d56c3a65558a1b1c0b587bfbc49d7557999",
};

const PINNED_NODE_VERSION = "24.22.1";

const TYPESCRIPT_FLAGS = [
  "--target",
  "ESNext",
  "--module",
  "ESNext",
  "--moduleResolution",
  "bundler",
  "--lib",
  "ES2020,ES2022",
  "--strict",
  "--noImplicitReturns",
  "--skipLibCheck",
  "--noEmit",
  "--types",
  "node",
];

const LABELS = ["offline", "source-bound", "not-integrated", "not-physical"];

function usage() {
  return [
    "Usage: node qualification/codex-stdio/restricted-jsonl.test.mjs [options]",
    "",
    "Required:",
    "  --happier-git-dir <dir>        Pinned Happier .git directory (read-only)",
    "  --happier-patch-objects <dir>  Object store containing the five-patch candidate tree",
    "  --git <absolute file>          Owner-trusted absolute Git executable",
    "",
    "Optional:",
    "  --patch <file>                 Maintained 0009 patch (default: repo path)",
    "  --tsc <absolute file>          Absolute TypeScript tsc.js for the one-file compile",
    "  --type-roots <dir>             Directory containing node (default: apps/host/node_modules/@types)",
    "  --temp-root <dir>              Parent for the owned disposable workspace",
    "  --keep-temp                    Keep the workspace and print its path",
    "  --json                         Print a JSON summary line as well",
    "  --help                         Print this help",
    "",
    "Requires pinned Node 24.22.1.",
    "Git runs with an isolated empty config and no ambient GIT_* variables.",
    "No dependency install, real Codex process or network request is performed.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    happierGitDir: null,
    happierPatchObjects: null,
    git: null,
    patch: join(repoRoot, EXPECTED.patchPath),
    tsc: null,
    typeRoots: join(repoRoot, "apps", "host", "node_modules", "@types"),
    tempRoot: process.env.RAC_CODEX_STDIO_TEMP_ROOT ?? tmpdir(),
    keepTemp: false,
    json: false,
    help: false,
  };
  const takesValue = {
    "--happier-git-dir": "happierGitDir",
    "--happier-patch-objects": "happierPatchObjects",
    "--git": "git",
    "--patch": "patch",
    "--tsc": "tsc",
    "--type-roots": "typeRoots",
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

function isAbsoluteWindowsPath(value) {
  return (
    typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value))
  );
}

function gitBlobHash(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(gitPath, gitDir, args, env, encoding = "utf8") {
  const result = spawnSync(gitPath, ["--git-dir", gitDir, ...args], {
    env,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  return result;
}

function gitOrThrow(gitPath, gitDir, args, env, encoding = "utf8") {
  const result = runGit(gitPath, gitDir, args, env, encoding);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

async function buildToolEnvironment(workspaceRoot) {
  const home = join(workspaceRoot, "tool-home");
  const xdg = join(workspaceRoot, "tool-xdg");
  const temp = join(workspaceRoot, "tool-temp");
  for (const path of [home, xdg, temp]) await mkdir(path, { recursive: true });
  const gitConfig = join(workspaceRoot, "gitconfig-isolated");
  await writeFile(gitConfig, "[core]\n\tautocrlf = input\n", "utf8");
  const env = {
    TEMP: temp,
    TMP: temp,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
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

function createRecorder() {
  const results = [];
  const record = (ok, id, detail, skipped = false) => {
    results.push({ id, ok, skipped, detail });
    const label = skipped ? "NOT_RUN" : ok ? "PASS" : "FAIL";
    console.log(`${label} ${id} - ${detail ?? ""}`);
    return ok;
  };
  return {
    pass: (id, detail) => record(true, id, detail),
    fail: (id, detail) => record(false, id, detail),
    blocked: (id, detail) => record(false, id, detail),
    skip: (id, detail) => record(true, id, detail, true),
    results,
    summary() {
      const executed = results.filter((entry) => !entry.skipped);
      const failed = executed.filter((entry) => !entry.ok);
      return {
        passed: executed.length - failed.length,
        failed: failed.length,
        skipped: results.length - executed.length,
        total: executed.length,
        failedIds: failed.map((entry) => entry.id),
      };
    },
  };
}

const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text);
const bytes = (...values) => new Uint8Array(values);

function readStrings(module, cases) {
  return cases.map(({ id, chunks, options }) => {
    const lines = [];
    const oversized = [];
    const reader = module.createCodexAppServerJsonLineReader((line) => lines.push(line), {
      ...options,
      onOversizedLine: (sample, maxBufferedChars) => oversized.push([sample, maxBufferedChars]),
    });
    for (const chunk of chunks) reader.push(chunk);
    return { id, lines, oversized };
  });
}

function runRestricted(module, testCase) {
  const lines = [];
  const failures = [];
  const reader = module.createCodexAppServerRestrictedJsonLineReader((line) => lines.push(line), {
    maxFrameBytes: testCase.maxFrameBytes,
    onFailure: (failure) => failures.push(failure),
  });
  for (const chunk of testCase.chunks) reader.push(chunk);
  let finish = null;
  if (testCase.finish !== false) finish = reader.finish();
  for (const chunk of testCase.after ?? []) reader.push(chunk);
  return { lines, failures, finish };
}

function expectRestricted(module, testCase) {
  const actual = runRestricted(module, testCase);
  assert.deepEqual(actual.lines, testCase.expectedLines, `${testCase.id}: delivered lines`);
  assert.equal(
    actual.failures.length,
    testCase.expectedFailure === null ? 0 : 1,
    `${testCase.id}: failure count`,
  );
  if (testCase.expectedFailure !== null) {
    assert.deepEqual(actual.failures[0], { reason: testCase.expectedFailure });
  }
  if (testCase.expectedFinish !== undefined) {
    assert.equal(actual.finish, testCase.expectedFinish, `${testCase.id}: finish status`);
  }
  return testCase.id;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  for (const [name, value] of [
    ["--happier-git-dir", options.happierGitDir],
    ["--happier-patch-objects", options.happierPatchObjects],
  ]) {
    if (!value || !isAbsoluteWindowsPath(value)) {
      throw new Error(`${name} must be an absolute Windows path`);
    }
  }
  if (!options.git || !isAbsoluteWindowsPath(options.git)) {
    throw new Error("--git must be an absolute Windows path");
  }
  if (options.tsc !== null && !isAbsoluteWindowsPath(options.tsc)) {
    throw new Error("--tsc must be an absolute Windows path");
  }
  if (!isAbsoluteWindowsPath(options.typeRoots)) {
    throw new Error("--type-roots must be an absolute Windows path");
  }

  const recorder = createRecorder();
  if (process.versions.node !== PINNED_NODE_VERSION) {
    recorder.blocked(
      "bind.node",
      `pinned Node ${PINNED_NODE_VERSION} is required; this process is ${process.version}`,
    );
    return 1;
  }
  recorder.pass("bind.node", `pinned Node ${process.version}`);
  const gitPath = resolve(options.git);
  const happierGitDir = resolve(options.happierGitDir);
  const patchObjects = resolve(options.happierPatchObjects);
  const patchPath = resolve(options.patch);
  const tempRoot = resolve(options.tempRoot);
  const limitations = [
    {
      id: "framing-only",
      status: "SCOPE",
      reason:
        "The added reader performs byte framing only. JSON-RPC validation, provider decisions and owned process settlement are not implemented or claimed here.",
    },
    {
      id: "not-wired",
      status: "STATIC_ONLY",
      reason:
        "No consumer selects the restricted reader. The patch appends an exported factory to an existing maintained module; no host, relay, profile or Windows launch path is bound.",
    },
    {
      id: "patch-unregistered",
      status: "BY_DESIGN",
      reason:
        "0009 is not listed in patches/happier/series.json and is not part of the active five-patch candidate tree; it is qualified only as an unregistered additive patch.",
    },
    {
      id: "synthetic-bytes",
      status: "SYNTHETIC",
      reason:
        "All inputs are in-process Uint8Array/Buffer values, including a Proxy-instrumented Uint8Array for the scan bound. No real pipe, child process, stderr stream or Codex app-server is read.",
    },
    {
      id: "memory-bound",
      status: "BEHAVIORAL",
      reason:
        "The cap, single-buffer growth, copy-on-push behavior and bounded scan window are exercised behaviorally and pinned textually; no heap profiler or allocation measurement is run.",
    },
    {
      id: "callback-contract",
      status: "NOT_ENFORCED",
      reason:
        "The reader is non-reentrant. The owner must serialize push/finish calls, must not call back into the reader from onLine/onFailure, and must treat a callback throw as terminal before wiring. That contract is not enforced or qualified here.",
    },
    {
      id: "no-wipe-peak",
      status: "NOT_CLAIMED",
      reason:
        "The reusable frame buffer is not wiped or zeroized, so stale bytes may remain. No peak-allocation, throughput or OOM-classification claim is made; only per-frame retained bytes are bounded.",
    },
    {
      id: "platform",
      status: "WINDOWS_ONLY",
      reason:
        "This run was performed on Windows with the pinned Node 24.22.1; no other platform is claimed.",
    },
  ];
  if (options.tsc === null) {
    limitations.push({
      id: "typescript-single-module",
      status: "NOT_RUN",
      reason:
        "No --tsc was supplied; the exact one-file TypeScript compile was not executed and is not claimed.",
    });
  }

  const runId = `rac-codex-stdio-${Date.now().toString(36)}`;
  await mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await mkdtemp(join(tempRoot, `${runId}-`));
  const scratchTree = join(workspaceRoot, "tree");
  let exitCode = 1;

  try {
    const toolEnv = await buildToolEnvironment(workspaceRoot);
    const objectEnv = {
      ...toolEnv,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: patchObjects,
    };

    const commitType = runGit(
      gitPath,
      happierGitDir,
      ["cat-file", "-t", EXPECTED.commit],
      objectEnv,
    );
    const treeType = runGit(gitPath, happierGitDir, ["cat-file", "-t", EXPECTED.tree], objectEnv);
    const candidateType = runGit(
      gitPath,
      happierGitDir,
      ["cat-file", "-t", EXPECTED.candidateTree],
      objectEnv,
    );
    if (
      commitType.status === 0 &&
      treeType.status === 0 &&
      candidateType.status === 0 &&
      String(commitType.stdout).trim() === "commit" &&
      String(treeType.stdout).trim() === "tree" &&
      String(candidateType.stdout).trim() === "tree"
    ) {
      recorder.pass("bind.objects", "pinned commit, source tree and candidate tree are present");
    } else {
      recorder.blocked("bind.objects", "pinned Git objects are unavailable");
      return 1;
    }

    const commitTree = gitOrThrow(
      gitPath,
      happierGitDir,
      ["rev-parse", `${EXPECTED.commit}^{tree}`],
      objectEnv,
    ).trim();
    assert.equal(commitTree, EXPECTED.tree);
    recorder.pass("bind.commit-tree", `commit tree is ${EXPECTED.tree}`);

    const receiptPath = join(dirname(patchObjects), "receipt.json");
    let receipt = null;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      receipt = null;
    }
    assert.ok(receipt, "adjacent patch-index receipt.json is required");
    assert.equal(receipt.sourceCommit, EXPECTED.commit);
    assert.equal(receipt.sourceTree, EXPECTED.tree);
    assert.equal(receipt.candidateTree, EXPECTED.candidateTree);
    assert.equal(receipt.patchCount, EXPECTED.patchCount);
    recorder.pass(
      "bind.candidate-receipt",
      `candidate tree is bound to ${receipt.patchCount} ordered patches`,
    );

    const pinnedBlob = gitOrThrow(
      gitPath,
      happierGitDir,
      ["rev-parse", `${EXPECTED.commit}:${SOURCE_PATH}`],
      objectEnv,
    ).trim();
    const candidateBlob = gitOrThrow(
      gitPath,
      happierGitDir,
      ["rev-parse", `${EXPECTED.candidateTree}:${SOURCE_PATH}`],
      objectEnv,
    ).trim();
    assert.equal(pinnedBlob, EXPECTED.sourceBlob);
    assert.equal(candidateBlob, EXPECTED.sourceBlob);
    recorder.pass(
      "bind.source-blob",
      `pinned and candidate reader blobs are both ${EXPECTED.sourceBlob}`,
    );

    const pinnedSource = gitOrThrow(
      gitPath,
      happierGitDir,
      ["show", `${EXPECTED.commit}:${SOURCE_PATH}`],
      objectEnv,
    );
    const candidateSource = gitOrThrow(
      gitPath,
      happierGitDir,
      ["show", `${EXPECTED.candidateTree}:${SOURCE_PATH}`],
      objectEnv,
    );
    assert.equal(candidateSource, pinnedSource);
    const pinnedSize = Number(
      gitOrThrow(gitPath, happierGitDir, ["cat-file", "-s", EXPECTED.sourceBlob], objectEnv).trim(),
    );
    assert.equal(Buffer.byteLength(candidateSource, "utf8"), pinnedSize);
    recorder.pass(
      "bind.source-bytes",
      `candidate reader is byte-identical to the pin (${pinnedSize} bytes)`,
    );

    const patchBytes = await readFile(patchPath);
    const patchText = patchBytes.toString("utf8");
    const patchSha256 = sha256Bytes(patchBytes);
    assert.equal(patchSha256, EXPECTED.patchSha256);
    recorder.pass("patch.sha256", "0009 patch matches the qualified digest");

    const touched = patchText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice(6));
    assert.deepEqual(touched, [SOURCE_PATH]);
    const diffHeaders = patchText.split(/\r?\n/).filter((line) => line.startsWith("diff --git "));
    assert.equal(diffHeaders.length, 1);
    assert.ok(!patchText.includes("deleted file mode"));
    assert.ok(!patchText.includes("new file mode"));
    assert.ok(!patchText.includes("similarity index"));
    recorder.pass(
      "patch.touches-only",
      "patch is a single additive hunk for the maintained reader file",
    );

    const series = JSON.parse(
      await readFile(join(repoRoot, "patches", "happier", "series.json"), "utf8"),
    );
    const seriesPaths = series.patches.map((entry) => entry.path);
    assert.equal(seriesPaths.length, EXPECTED.patchCount);
    assert.ok(!seriesPaths.includes(EXPECTED.patchPath));
    recorder.pass(
      "patch.unregistered",
      "series.json still lists exactly the active five patches and not 0009",
    );

    const restrictedRefs = runGit(
      gitPath,
      happierGitDir,
      ["grep", "-l", "-F", "createCodexAppServerRestrictedJsonLineReader", EXPECTED.candidateTree],
      objectEnv,
    );
    assert.equal(
      restrictedRefs.status,
      1,
      "git grep must report a clean no-match (status 1), not an execution error",
    );
    assert.equal(String(restrictedRefs.stderr).trim(), "", "git grep no-match wrote stderr");
    assert.equal(String(restrictedRefs.stdout), "", "git grep no-match wrote stdout");
    recorder.pass(
      "patch.no-candidate-consumer",
      "git grep status 1 with empty stderr/stdout: no candidate-tree source references the restricted factory",
    );

    const importerPath =
      "apps/cli/src/backends/codex/appServer/client/createCodexAppServerClient.ts";
    const existingRefs = runGit(
      gitPath,
      happierGitDir,
      ["grep", "-l", "-F", "createCodexAppServerJsonLineReader", EXPECTED.candidateTree],
      objectEnv,
    );
    assert.equal(existingRefs.status, 0, "git grep for the maintained reader must match");
    const referencedFiles = String(existingRefs.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(`${EXPECTED.candidateTree}:`.length));
    assert.ok(referencedFiles.includes(SOURCE_PATH), "declaration file must appear");
    assert.ok(referencedFiles.includes(importerPath), "actual client importer must appear");
    const importerSource = gitOrThrow(
      gitPath,
      happierGitDir,
      ["show", `${EXPECTED.candidateTree}:${importerPath}`],
      objectEnv,
    );
    assert.ok(
      importerSource.includes(
        "import { createCodexAppServerJsonLineReader } from './codexAppServerJsonLineReader';",
      ),
      "client must import the maintained reader",
    );
    assert.ok(
      /createCodexAppServerJsonLineReader\s*\(/.test(importerSource),
      "client must call the maintained reader, not only declare it",
    );
    recorder.pass(
      "patch.existing-consumers-intact",
      "the maintained reader is imported and called by createCodexAppServerClient.ts",
    );

    await mkdir(join(scratchTree, dirname(SOURCE_PATH)), { recursive: true });
    await writeFile(join(scratchTree, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(join(scratchTree, SOURCE_PATH), candidateSource, "utf8");
    await writeFile(join(scratchTree, "baseline-reader.ts"), pinnedSource, "utf8");

    const init = spawnSync(gitPath, ["init", "-q", scratchTree], {
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);

    const applyCheck = spawnSync(gitPath, ["-C", scratchTree, "apply", "--check", patchPath], {
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(applyCheck.status, 0, `git apply --check failed: ${applyCheck.stderr}`);
    const apply = spawnSync(gitPath, ["-C", scratchTree, "apply", patchPath], {
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(apply.status, 0, `git apply failed: ${apply.stderr}`);
    recorder.pass(
      "patch.applies-to-candidate",
      "0009 applies cleanly to the extracted five-patch candidate source",
    );

    const patchedSource = await readFile(join(scratchTree, SOURCE_PATH), "utf8");
    assert.equal(gitBlobHash(patchedSource), EXPECTED.patchedBlob);
    const hashObject = spawnSync(gitPath, ["-C", scratchTree, "hash-object", SOURCE_PATH], {
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(hashObject.status, 0);
    assert.equal(hashObject.stdout.trim(), EXPECTED.patchedBlob);
    recorder.pass(
      "patch.result-blob",
      `patched reader blob is ${EXPECTED.patchedBlob} by independent hash computations`,
    );

    assert.ok(patchedSource.startsWith(candidateSource), "existing source must be preserved");
    assert.ok(patchedSource.length > candidateSource.length);
    assert.equal(patchedSource.slice(0, candidateSource.length), candidateSource);
    recorder.pass(
      "patch.prefix-preserving",
      "all maintained source bytes are preserved; the patch only appends a new exported block",
    );

    const restrictedBlock = patchedSource.slice(candidateSource.length);
    const restrictedCode = restrictedBlock.slice(
      restrictedBlock.indexOf("export type CodexAppServerRestrictedJsonLineFailureReason"),
    );
    for (const token of ["JSON.parse", "stderr", "sample", "process.", "requestApproval"]) {
      assert.ok(!restrictedCode.includes(token), `restricted code must not contain ${token}`);
    }
    assert.ok(
      !restrictedCode.includes("Buffer."),
      "added code must not depend on Node Buffer APIs",
    );
    assert.ok(restrictedBlock.includes("never a payload, sample or captured stderr"));
    assert.ok(
      restrictedBlock.includes("new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })"),
    );
    assert.ok(!restrictedCode.includes("chunk.slice"), "must not use Buffer#slice view semantics");
    assert.ok(!restrictedCode.includes("chunks"));
    assert.ok(restrictedCode.includes("buffer.set(chunk.subarray(start, end), bufferedBytes);"));
    assert.ok(restrictedCode.includes("const frameCeiling = maxFrameBytes + 1;"));
    assert.ok(
      restrictedCode.includes(
        "let capacity = Math.min(frameCeiling, restrictedInitialBufferBytes);",
      ),
    );
    assert.ok(
      restrictedCode.includes(
        "if (nextBytes === frameCeiling && chunk[end - 1] !== restrictedCarriageReturnByte) {",
      ),
    );
    assert.ok(
      restrictedCode.includes("const windowEnd = Math.min(chunk.length, startIndex + allowance);"),
      "newline scanning must be bounded by the remaining per-frame allowance",
    );
    recorder.pass(
      "patch.framing-separation",
      "added block uses one reusable copy-on-push buffer with bounded scanning and no JSON-RPC/provider/process/stderr handling",
    );
    assert.ok(
      restrictedCode.includes("fail('truncated_frame');\n                return 'truncated';"),
      "finish must return the truncated literal after fail()",
    );
    assert.ok(
      restrictedCode.includes("terminalStatus = 'clean';\n            return 'clean';"),
      "finish must return the clean literal after assignment",
    );
    recorder.pass(
      "patch.finish-literal-returns",
      "finish returns literal 'truncated'/'clean' after the narrowing-sensitive branches",
    );

    const module = await import(pathToFileURL(join(scratchTree, SOURCE_PATH)).href);
    const baseline = await import(pathToFileURL(join(scratchTree, "baseline-reader.ts")).href);
    assert.equal(typeof module.createCodexAppServerRestrictedJsonLineReader, "function");
    assert.equal(typeof module.createCodexAppServerJsonLineReader, "function");
    assert.equal(
      module.createCodexAppServerJsonLineReader.toString(),
      baseline.createCodexAppServerJsonLineReader.toString(),
    );
    recorder.pass(
      "executed.import",
      "patched module imports under the pinned type stripper; original function source is identical",
    );

    if (options.tsc === null) {
      recorder.skip(
        "executed.typescript-single-module",
        "no --tsc supplied; exact one-file TypeScript compile NOT_RUN and not claimed",
      );
    } else {
      const tscPath = resolve(options.tsc);
      const typeRoots = resolve(options.typeRoots);
      const tscSha256 = sha256Bytes(await readFile(tscPath));
      const tscVersion = spawnSync(process.execPath, [tscPath, "--version"], {
        cwd: scratchTree,
        env: toolEnv,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(tscVersion.status, 0, `tsc --version failed: ${tscVersion.stderr}`);
      let nodeTypesVersion = "unknown";
      try {
        nodeTypesVersion = JSON.parse(
          await readFile(join(typeRoots, "node", "package.json"), "utf8"),
        ).version;
      } catch {
        nodeTypesVersion = "unknown";
      }
      const compile = spawnSync(
        process.execPath,
        [tscPath, ...TYPESCRIPT_FLAGS, "--typeRoots", typeRoots, join(scratchTree, SOURCE_PATH)],
        { cwd: scratchTree, env: toolEnv, encoding: "utf8", windowsHide: true },
      );
      const compileStdout = String(compile.stdout ?? "").trim();
      const compileStderr = String(compile.stderr ?? "").trim();
      if (compile.status === 0 && compileStdout === "" && compileStderr === "") {
        recorder.pass(
          "executed.typescript-single-module",
          `${String(tscVersion.stdout).trim()} compiled the exact patched module with @types/node ${nodeTypesVersion} (tsc sha256 ${tscSha256.slice(0, 16)}...)`,
        );
      } else {
        recorder.fail("executed.typescript-single-module", "exact one-file compile failed", {
          status: compile.status,
          stdout: compileStdout.slice(0, 500),
          stderr: compileStderr.slice(0, 500),
        });
        throw new Error("typescript single-module compile failed");
      }
    }

    const stringCases = [
      {
        id: "lf-multi-frame",
        chunks: ['{"a":1}\n{"b":2}\n'],
        options: {},
        expected: [{ id: "lf-multi-frame", lines: ['{"a":1}', '{"b":2}'], oversized: [] }],
      },
      {
        id: "crlf-raw-parity",
        chunks: ['{"a":1}\r\n'],
        options: {},
        expected: [{ id: "crlf-raw-parity", lines: ['{"a":1}\r'], oversized: [] }],
      },
      {
        id: "split-frame",
        chunks: ['{"a":', "1}\n"],
        options: {},
        expected: [{ id: "split-frame", lines: ['{"a":1}'], oversized: [] }],
      },
      {
        id: "char-cap-splits-surrogate",
        chunks: ["\u{1F600}a\n", "ok\n"],
        options: { maxBufferedChars: 2 },
        expected: [
          {
            id: "char-cap-splits-surrogate",
            lines: ["ok"],
            oversized: [["\u{1F600}a", 2]],
          },
        ],
      },
      {
        id: "whitespace-and-empty-skip",
        chunks: ["\n   \n\t\n", '{"a":1}\n'],
        options: {},
        expected: [{ id: "whitespace-and-empty-skip", lines: ['{"a":1}'], oversized: [] }],
      },
    ];
    const baselineActual = readStrings(baseline, stringCases);
    const patchedActual = readStrings(module, stringCases);
    assert.deepEqual(patchedActual, baselineActual);
    for (const testCase of stringCases) {
      assert.deepEqual(
        baselineActual.find((entry) => entry.id === testCase.id),
        testCase.expected[0],
      );
    }
    recorder.pass(
      "executed.string-reader-unchanged",
      `maintained string reader behaves identically in unpatched and patched module for ${stringCases.length} cases`,
    );

    const restrictedCases = [
      {
        id: "exact-cap-lf",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":12}\n')],
        expectedLines: ['{"a":12}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "exact-cap-crlf",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":12}\r\n')],
        expectedLines: ['{"a":12}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "exact-cap-crlf-split",
        maxFrameBytes: 4,
        chunks: [utf8("abcd\r"), utf8("\n")],
        expectedLines: ["abcd"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "cap-plus-one-cr-pending",
        maxFrameBytes: 4,
        chunks: [utf8("abcd\r"), utf8("x")],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "cap-plus-one-lf",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":123}\n')],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "cap-plus-one-streaming",
        maxFrameBytes: 4,
        chunks: [utf8("abcde")],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "cap-plus-two-streaming",
        maxFrameBytes: 4,
        chunks: [utf8("abcde"), utf8("f")],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "byte-vs-char-two-byte",
        maxFrameBytes: 4,
        chunks: [utf8("\u00e9\u00e9\n")],
        expectedLines: ["\u00e9\u00e9"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "byte-vs-char-over-cap",
        maxFrameBytes: 3,
        chunks: [utf8("\u00e9\u00e9\n")],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "byte-vs-char-four-byte",
        maxFrameBytes: 4,
        chunks: [utf8("\u{1F600}\n")],
        expectedLines: ["\u{1F600}"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "split-multibyte",
        maxFrameBytes: 4,
        chunks: [bytes(0xf0), bytes(0x9f, 0x98, 0x80), bytes(0x0a)],
        expectedLines: ["\u{1F600}"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "split-frame-across-chunks",
        maxFrameBytes: 16,
        chunks: [utf8('{"a":'), utf8("1}"), utf8("\n")],
        expectedLines: ['{"a":1}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "multi-frame-per-chunk",
        maxFrameBytes: 16,
        chunks: [utf8('{"a":1}\n{"b":2}\n{"c":3}\n')],
        expectedLines: ['{"a":1}', '{"b":2}', '{"c":3}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "split-crlf",
        maxFrameBytes: 8,
        chunks: [utf8("abc\r"), utf8("\n")],
        expectedLines: ["abc"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "isolated-cr-retained",
        maxFrameBytes: 8,
        chunks: [utf8("a\rb\n")],
        expectedLines: ["a\rb"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "double-cr-one-stripped",
        maxFrameBytes: 8,
        chunks: [utf8("a\r\r\n")],
        expectedLines: ["a\r"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "empty-lf-frames-skipped",
        maxFrameBytes: 8,
        chunks: [utf8("\n\n")],
        expectedLines: [],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "empty-crlf-frame-skipped",
        maxFrameBytes: 8,
        chunks: [utf8("\r\n")],
        expectedLines: [],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "mixed-crlf-lf",
        maxFrameBytes: 16,
        chunks: [utf8('{"a":1}\r\n{"b":2}\n')],
        expectedLines: ['{"a":1}', '{"b":2}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "invalid-continuation",
        maxFrameBytes: 8,
        chunks: [bytes(0x80, 0x0a)],
        expectedLines: [],
        expectedFailure: "invalid_utf8",
        expectedFinish: "failed",
      },
      {
        id: "invalid-truncated-multibyte",
        maxFrameBytes: 8,
        chunks: [bytes(0xe2, 0x82, 0x0a)],
        expectedLines: [],
        expectedFailure: "invalid_utf8",
        expectedFinish: "failed",
      },
      {
        id: "invalid-surrogate",
        maxFrameBytes: 8,
        chunks: [bytes(0xed, 0xa0, 0x80, 0x0a)],
        expectedLines: [],
        expectedFailure: "invalid_utf8",
        expectedFinish: "failed",
      },
      {
        id: "invalid-overlong",
        maxFrameBytes: 8,
        chunks: [bytes(0xc0, 0xaf, 0x0a)],
        expectedLines: [],
        expectedFailure: "invalid_utf8",
        expectedFinish: "failed",
      },
      {
        id: "no-delivery-after-oversize",
        maxFrameBytes: 5,
        chunks: [utf8('{"a"}\n'), utf8("abcdef\n"), utf8('{"c"}\n')],
        expectedLines: ['{"a"}'],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "same-chunk-oversize-after-valid",
        maxFrameBytes: 3,
        chunks: [utf8("ok\nTOOLONG\nnext\n")],
        expectedLines: ["ok"],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
      {
        id: "partial-after-valid-at-eof",
        maxFrameBytes: 8,
        chunks: [utf8("ok\npartial")],
        expectedLines: ["ok"],
        expectedFailure: "truncated_frame",
        expectedFinish: "truncated",
      },
      {
        id: "bom-retained-not-stripped",
        maxFrameBytes: 8,
        chunks: [utf8("\uFEFF{}\n")],
        expectedLines: ["\uFEFF{}"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "whitespace-frame-delivered",
        maxFrameBytes: 8,
        chunks: [utf8("   \n")],
        expectedLines: ["   "],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "no-delivery-after-invalid",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":1}\n'), bytes(0xff, 0x0a), utf8('{"b":2}\n')],
        expectedLines: ['{"a":1}'],
        expectedFailure: "invalid_utf8",
        expectedFinish: "failed",
      },
      {
        id: "truncated-at-eof",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":1}')],
        expectedLines: [],
        expectedFailure: "truncated_frame",
        expectedFinish: "truncated",
      },
      {
        id: "trailing-cr-at-eof",
        maxFrameBytes: 8,
        chunks: [utf8("abc\r")],
        expectedLines: [],
        expectedFailure: "truncated_frame",
        expectedFinish: "truncated",
      },
      {
        id: "clean-eof",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":1}\n')],
        expectedLines: ['{"a":1}'],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "empty-eof",
        maxFrameBytes: 8,
        chunks: [],
        expectedLines: [],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "truncation-before-utf8-validation",
        maxFrameBytes: 8,
        chunks: [bytes(0xff)],
        expectedLines: [],
        expectedFailure: "truncated_frame",
        expectedFinish: "truncated",
      },
      {
        id: "no-delivery-after-finish",
        maxFrameBytes: 8,
        chunks: [utf8('{"a":1}\n')],
        expectedLines: ['{"a":1}'],
        expectedFailure: null,
        expectedFinish: "clean",
        after: [utf8('{"b":2}\n'), utf8('{"c":3}')],
      },
      {
        id: "one-byte-chunks-buffer-reuse",
        maxFrameBytes: 8,
        chunks: [
          ...Array.from(utf8("abcdefgh\n"), (byte) => bytes(byte)),
          ...Array.from(utf8("ij\n"), (byte) => bytes(byte)),
        ],
        expectedLines: ["abcdefgh", "ij"],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "amortized-buffer-growth",
        maxFrameBytes: 5000,
        chunks: [utf8(`${"a".repeat(5000)}\n`)],
        expectedLines: ["a".repeat(5000)],
        expectedFailure: null,
        expectedFinish: "clean",
      },
      {
        id: "adversarial-oversized-chunk",
        maxFrameBytes: 8,
        chunks: [new Uint8Array(1024 * 1024).fill(0x78)],
        expectedLines: [],
        expectedFailure: "frame_too_large",
        expectedFinish: "failed",
      },
    ];

    for (const testCase of restrictedCases) expectRestricted(module, testCase);
    recorder.pass(
      "executed.restricted-framing",
      `${restrictedCases.length} framing cases (cap, UTF-8, CRLF/LF, split, terminal, truncation) passed`,
    );

    const failureDiagnostics = [];
    const diagnosticReader = module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
      maxFrameBytes: 4,
      onFailure: (failure) => failureDiagnostics.push(failure),
    });
    diagnosticReader.push(utf8("SECRET-PAYLOAD\n"));
    diagnosticReader.push(utf8("SECRET-PAYLOAD\n"));
    diagnosticReader.finish();
    assert.equal(failureDiagnostics.length, 1);
    assert.deepEqual(Object.keys(failureDiagnostics[0]), ["reason"]);
    assert.deepEqual(failureDiagnostics[0], { reason: "frame_too_large" });
    const diagnosticText = JSON.stringify(failureDiagnostics);
    assert.ok(!diagnosticText.includes("SECRET"));
    assert.ok(!diagnosticText.includes("PAYLOAD"));
    recorder.pass(
      "executed.bounded-diagnostic",
      "only the first failure is reported, with a fixed reason and no payload/SECRET text",
    );

    const terminalReader = module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
      maxFrameBytes: 4,
    });
    terminalReader.push(utf8("abcdef\n"));
    const firstFinish = terminalReader.finish();
    const secondFinish = terminalReader.finish();
    assert.equal(firstFinish, "failed");
    assert.equal(secondFinish, "failed");
    terminalReader.push(utf8('{"a":1}\n'));
    assert.equal(terminalReader.finish(), "failed");
    recorder.pass(
      "executed.terminal-idempotent",
      "finish() is idempotent after a failure and later pushes deliver nothing",
    );

    const cleanReader = module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
      maxFrameBytes: 4,
    });
    const cleanFirst = cleanReader.finish();
    const cleanSecond = cleanReader.finish();
    assert.equal(cleanFirst, "clean");
    assert.equal(cleanSecond, "clean");
    cleanReader.push(new Uint8Array([0xff, 0x0a]));
    assert.equal(cleanReader.finish(), "clean");
    recorder.pass(
      "executed.clean-terminal",
      "clean EOF is idempotent and later malformed bytes are not processed",
    );

    const configCases = [
      [undefined, "missing"],
      [null, "null"],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [Number.NEGATIVE_INFINITY, "-Infinity"],
      [0, "zero"],
      [-1, "negative"],
      [1.5, "fractional"],
      [Number.MAX_SAFE_INTEGER + 1, "unsafe"],
      ["8", "string"],
    ];
    for (const [value, id] of configCases) {
      assert.throws(
        () =>
          module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
            maxFrameBytes: value,
          }),
        (error) => error instanceof RangeError,
        `maxFrameBytes ${id} must be rejected`,
      );
    }
    assert.throws(
      () => module.createCodexAppServerRestrictedJsonLineReader(() => {}, null),
      (error) => error instanceof TypeError,
    );
    assert.throws(
      () =>
        module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
          maxFrameBytes: 8,
          onFailure: "nope",
        }),
      (error) => error instanceof TypeError,
    );
    const boundaryReader = module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
      maxFrameBytes: 1,
    });
    assert.throws(
      () => boundaryReader.push("not-bytes"),
      (error) => error instanceof TypeError,
    );
    assert.throws(
      () => boundaryReader.push([0x61, 0x0a]),
      (error) => error instanceof TypeError,
    );
    boundaryReader.push(Buffer.from("a\n", "utf8"));
    assert.equal(boundaryReader.finish(), "clean");
    const maxConfiguredFrameBytes = module.codexAppServerRestrictedJsonLineMaxFrameBytes;
    assert.equal(maxConfiguredFrameBytes, 64 * 1024 * 1024);
    assert.throws(
      () =>
        module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
          maxFrameBytes: maxConfiguredFrameBytes + 1,
        }),
      (error) => error instanceof RangeError,
    );
    const ceilingReader = module.createCodexAppServerRestrictedJsonLineReader(() => {}, {
      maxFrameBytes: maxConfiguredFrameBytes,
    });
    assert.equal(ceilingReader.finish(), "clean");
    recorder.pass(
      "executed.config-and-input-validation",
      "invalid caps, the defined ceiling, options, callbacks and non-Uint8Array chunks are rejected; Buffer is accepted",
    );

    const bufferBacking = Buffer.alloc(32, 0x41);
    bufferBacking.write("abcdefgh", 4, "utf8");
    const bufferView = bufferBacking.subarray(4, 12);
    assert.equal(bufferView.buffer, bufferBacking.buffer);
    assert.equal(
      bufferBacking.slice(4, 12).buffer,
      bufferBacking.buffer,
      "Buffer#slice shares the backing allocation",
    );
    const bufferLines = [];
    const bufferFailures = [];
    const bufferReader = module.createCodexAppServerRestrictedJsonLineReader(
      (line) => bufferLines.push(line),
      { maxFrameBytes: 8, onFailure: (failure) => bufferFailures.push(failure) },
    );
    bufferReader.push(bufferView);
    bufferBacking.fill(0x5a, 4, 12);
    bufferReader.push(Buffer.from("\n", "utf8"));
    assert.deepEqual(bufferLines, ["abcdefgh"]);
    assert.deepEqual(bufferFailures, []);
    assert.equal(bufferReader.finish(), "clean");
    recorder.pass(
      "executed.buffer-subview-copied",
      "a small Buffer subview of a larger allocation is copied on push; mutating the caller after push cannot change the frame",
    );

    const scanTarget = new Uint8Array(65536).fill(0x78);
    let scanMaxIndex = -1;
    let scanReads = 0;
    const scanProxy = new Proxy(scanTarget, {
      get(target, property) {
        if (property === "length") return target.length;
        if (property === "subarray") {
          return (start, end) => target.subarray(start, end);
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          const index = Number(property);
          if (index > scanMaxIndex) scanMaxIndex = index;
          scanReads += 1;
          return target[index];
        }
        return Reflect.get(target, property, target);
      },
    });
    const scanLines = [];
    const scanFailures = [];
    const scanReader = module.createCodexAppServerRestrictedJsonLineReader(
      (line) => scanLines.push(line),
      { maxFrameBytes: 8, onFailure: (failure) => scanFailures.push(failure) },
    );
    scanReader.push(scanProxy);
    assert.deepEqual(scanLines, []);
    assert.deepEqual(scanFailures, [{ reason: "frame_too_large" }]);
    assert.equal(scanReader.finish(), "failed");
    assert.ok(scanMaxIndex <= 8, `scan stopped at index ${scanMaxIndex}, expected <= 8`);
    assert.ok(scanReads < 32, `scan performed ${scanReads} indexed reads`);
    recorder.pass(
      "executed.oversized-scan-bounded",
      `instrumented 64 KiB input: oversized detection read only up to index ${scanMaxIndex} (${scanReads} reads), not the whole allocation`,
    );

    const summary = recorder.summary();
    assert.equal(summary.failed, 0, `failed checks: ${summary.failedIds.join(", ")}`);
    const listedChecks = summary.total + 1 + summary.skipped;
    recorder.pass(
      "suite.result",
      `${summary.passed + 1} checks passed, 0 failed${
        summary.skipped > 0 ? `, ${summary.skipped} not run` : ""
      } (${listedChecks} listed)`,
    );

    if (options.json) {
      console.log(
        JSON.stringify({
          suite: "codex-restricted-stdio-jsonl",
          labels: LABELS,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          preparedOnRacBase: {
            commit: "c9151245933a1522d08bb3d8eeea65c23d595226",
            tree: "1e0f1331bc70496edbc66547076ac4cfda5f5d5d",
          },
          happy: {
            commit: EXPECTED.commit,
            tree: EXPECTED.tree,
            candidateTree: EXPECTED.candidateTree,
            sourcePath: SOURCE_PATH,
            sourceBlob: EXPECTED.sourceBlob,
            patchPath: EXPECTED.patchPath,
            patchSha256: EXPECTED.patchSha256,
            patchedBlob: EXPECTED.patchedBlob,
          },
          summary: recorder.summary(),
          limitations,
        }),
      );
    }

    console.log(
      `RESULT PASS ${recorder.summary().passed}/${recorder.summary().total} executed checks${
        recorder.summary().skipped > 0 ? `, ${recorder.summary().skipped} not run` : ""
      } ` + `(node ${process.version}, ${process.platform}/${process.arch})`,
    );
    exitCode = 0;
  } catch (error) {
    recorder.fail("suite.error", String(error?.message ?? error).slice(0, 500));
    exitCode = 1;
  } finally {
    if (options.keepTemp) {
      console.log(`SCRATCH ${workspaceRoot}`);
    } else {
      try {
        const owned = resolve(workspaceRoot);
        const prefix = `${tempRoot}${sep}`;
        if (owned.startsWith(prefix) && basename(owned).startsWith("rac-codex-stdio-")) {
          await rm(owned, { recursive: true, force: true });
        } else {
          console.error(`[codex-stdio] temp cleanup refused: ${owned}`);
        }
      } catch (error) {
        console.error(`[codex-stdio] temp cleanup refused: ${String(error?.message ?? error)}`);
      }
    }
  }
  return exitCode;
}

process.exitCode = await main();
