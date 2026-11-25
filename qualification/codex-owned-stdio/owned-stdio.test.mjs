#!/usr/bin/env node

/**
 * Offline, source-bound qualification of the inactive owner-backed stdio
 * transport helper added by `patches/happier/0010-codex-owned-stdio.patch`.
 *
 * Labels: offline, source-bound, not-integrated, not-physical, not-wired.
 *
 * The test binds the pinned Happier commit/tree, the active five-patch candidate
 * tree, the reviewed inactive 0009 reader and the helper-only 0010 patch. It
 * applies 0009 then 0010 to a disposable extracted fragment, verifies the
 * maintained client is unchanged, imports the helper with the pinned Node type
 * stripper, and runs synthetic owner/stream fixtures. No maintained client wiring,
 * RPC policy, real process, socket, install or network is exercised.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const CLIENT_PATH = "apps/cli/src/backends/codex/appServer/client/createCodexAppServerClient.ts";
const HELPER_PATH = "apps/cli/src/backends/codex/appServer/client/codexOwnedStdioTransport.ts";
const READER_PATH = "apps/cli/src/backends/codex/appServer/client/codexAppServerJsonLineReader.ts";

const EXPECTED = {
  commit: "e992e049ffa7a98ab60740ac60f94918f022ff24",
  tree: "911bdc3c673608490b932bd939166d88f198066a",
  candidateTree: "c62fcb80464a0b7161efb4c09bdcbd8d9506bea4",
  patchCount: 5,
  patch0009: "patches/happier/0009-codex-restricted-jsonl.patch",
  patch0009Sha256: "173b465fc186fc0d1071c2357071253c9bad348cf28789a1226b7a10b2d29703",
  patch0010: "patches/happier/0010-codex-owned-stdio.patch",
  patch0010Sha256: "bb8d74c0f8b7d2e7609ee54811f93efed3fe8fa55a4006e38903831dd7d72a61",
  candidateClientBlob: "e74b4e4920f0f8f16f5de98205dce57084ecd4dc",
  candidateReaderBlob: "d29c56f888a11e1e7c131ee42ff3bbe27aaea7ec",
  after0009ReaderBlob: "26e11d56c3a65558a1b1c0b587bfbc49d7557999",
  helperBlob: "55e87573934851388750fa6b68fe4177f77dc507",
};

const PINNED_NODE_VERSION = "24.22.1";
const LABELS = ["offline", "source-bound", "not-integrated", "not-physical", "not-wired"];
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

function usage() {
  return [
    "Usage: node qualification/codex-owned-stdio/owned-stdio.test.mjs [options]",
    "",
    "Required:",
    "  --happier-git-dir <dir>        Pinned Happier .git directory (read-only)",
    "  --happier-patch-objects <dir>  Object store containing the five-patch candidate tree",
    "  --git <absolute file>          Owner-trusted absolute Git executable",
    "",
    "Optional:",
    "  --patch-0009 <file>            Reviewed inactive 0009 patch (default: repo path)",
    "  --patch-0010 <file>            Helper-only 0010 patch (default: repo path)",
    "  --tsc <absolute file>          Absolute TypeScript tsc.js for the helper+reader compile",
    "  --type-roots <dir>             Directory containing node (default: apps/host/node_modules/@types)",
    "  --temp-root <dir>              Parent for the owned disposable workspace",
    "  --keep-temp                    Keep the workspace and print its path",
    "  --json                         Print a JSON summary line as well",
    "  --help                         Print this help",
    "",
    "Requires pinned Node 24.22.1.",
    "No dependency install, real Codex process, stream, socket or network request is used.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    happierGitDir: null,
    happierPatchObjects: null,
    git: null,
    patch0009: join(repoRoot, EXPECTED.patch0009),
    patch0010: join(repoRoot, EXPECTED.patch0010),
    tsc: null,
    typeRoots: join(repoRoot, "apps", "host", "node_modules", "@types"),
    tempRoot: process.env.RAC_CODEX_OWNED_STDIO_TEMP_ROOT ?? tmpdir(),
    keepTemp: false,
    json: false,
    help: false,
  };
  const takesValue = {
    "--happier-git-dir": "happierGitDir",
    "--happier-patch-objects": "happierPatchObjects",
    "--git": "git",
    "--patch-0009": "patch0009",
    "--patch-0010": "patch0010",
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

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function runGitWorktree(gitPath, cwd, args, env) {
  const result = spawnSync(gitPath, ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  return result;
}

function gitOrThrow(gitPath, gitDir, args, env) {
  const result = runGit(gitPath, gitDir, args, env);
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

const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text);
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

function createFeed() {
  const queue = [];
  const waiters = [];
  let ended = false;
  let failure = null;
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (failure !== null) throw failure;
        if (ended) return;
        await new Promise((resolveWaiter) => waiters.push(resolveWaiter));
      }
    },
    push(chunk) {
      queue.push(chunk);
      waiters.shift()?.();
    },
    end() {
      ended = true;
      for (const wake of waiters.splice(0)) wake();
    },
    fail(error) {
      failure = error;
      for (const wake of waiters.splice(0)) wake();
    },
  };
}

function createOpeningAsyncIterable(counts) {
  return {
    [Symbol.asyncIterator]() {
      counts.opens += 1;
      return {
        async next() {
          await new Promise(() => {});
          return { done: true, value: undefined };
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createOwner(options = {}) {
  const stdout = options.stdout ?? createFeed();
  const stderr = options.stderr ?? createFeed();
  const writes = [];
  let failureHandler = null;
  let disposeCalls = 0;
  const owner = {
    stdin: {
      write: async (bytes) => {
        writes.push(Buffer.from(bytes));
        if (options.write) await options.write(bytes);
      },
    },
    stdout,
    stderr,
    onFailure(handler) {
      failureHandler = handler;
      return () => {
        if (failureHandler === handler) failureHandler = null;
      };
    },
    async dispose() {
      disposeCalls += 1;
      if (options.dispose) return await options.dispose();
      return options.settlement ?? { rootEmpty: true, jobEmpty: true };
    },
  };
  return {
    owner,
    stdout,
    stderr,
    writes,
    fail: (error) => failureHandler?.(error),
    getDisposeCalls: () => disposeCalls,
  };
}

const baseLimits = {
  maxFrameBytes: 16,
  maxQueueItems: 4,
  maxQueueBytes: 128,
  writeDeadlineMs: 200,
  disposeDeadlineMs: 200,
  maxStderrDiscardBytes: 8,
};
const limits = (overrides = {}) => ({ ...baseLimits, ...overrides });

function startCase(module, fixture, onLine, caseLimits = {}) {
  const lines = [];
  let terminal = null;
  let resolveTerminal;
  const terminalPromise = new Promise((resolveTerminalPromise) => {
    resolveTerminal = resolveTerminalPromise;
  });
  const transport = module.createCodexOwnedStdioTransport(fixture.owner, limits(caseLimits));
  transport.start(
    (line) => {
      lines.push(line);
      onLine?.(line, lines);
    },
    (error) => {
      terminal = error;
      resolveTerminal(error);
    },
  );
  return { transport, lines, terminalPromise, getTerminal: () => terminal };
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
  const patch0009Path = resolve(options.patch0009);
  const patch0010Path = resolve(options.patch0010);
  const tempRoot = resolve(options.tempRoot);
  const limitations = [
    {
      id: "helper-only",
      status: "INACTIVE",
      reason:
        "0010 adds only the owner-backed transport helper. The maintained client, RPC policy and all selectors are unchanged; no current caller, barrel export or activation path exists.",
    },
    {
      id: "no-rpc-policy",
      status: "SCOPE",
      reason:
        "No request deadline, pending-request, envelope, callback-budget or client abort policy is implemented here. The future maintained binding must configure provider-lifetime and protocol policy separately.",
    },
    {
      id: "synthetic-owner",
      status: "SYNTHETIC",
      reason:
        "All stdin/stdout/stderr and disposal outcomes are synthetic in-process fixtures. No real pipe, job, process, socket, device or Codex app-server is touched.",
    },
    {
      id: "blocked-os-calls",
      status: "NOT_INTERRUPTED",
      reason:
        "A blocked owner write/read promise is not cancellable here. Terminal state and settlement reject pending seam work promptly, but no claim is made that disposal interrupts a blocked OS call.",
    },
    {
      id: "callback-lifetime",
      status: "BEST_EFFORT",
      reason:
        "Once closure is observed no new iterator next is submitted and the failure subscription is detached best-effort. An already-invoked next/write/iterator return remains owner responsibility.",
    },
    {
      id: "request-ambiguity",
      status: "OUT_OF_SCOPE",
      reason:
        "No JSON-RPC request is sent by this helper. Future binding must keep side-effecting request ambiguity, quarantine without retry, and explicit AbortError compatibility.",
    },
    {
      id: "windows-only",
      status: "PLATFORM",
      reason: "Executed on Windows with pinned Node 24.22.1; no other platform is claimed.",
    },
    {
      id: "no-full-build",
      status: "NOT_RUN",
      reason:
        "No Happier install, build, full typecheck, vitest suite or production launch was attempted.",
    },
  ];
  if (options.tsc === null) {
    limitations.push({
      id: "typescript-helper-compile",
      status: "NOT_RUN",
      reason:
        "No --tsc was supplied; the focused helper+reader TypeScript compile was not executed and is not claimed.",
    });
  }

  const runId = `rac-codex-owned-stdio-${Date.now().toString(36)}`;
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
    assert.equal(commitType.status, 0);
    assert.equal(treeType.status, 0);
    assert.equal(candidateType.status, 0);
    assert.equal(String(commitType.stdout).trim(), "commit");
    assert.equal(String(treeType.stdout).trim(), "tree");
    assert.equal(String(candidateType.stdout).trim(), "tree");
    const commitTree = gitOrThrow(
      gitPath,
      happierGitDir,
      ["rev-parse", `${EXPECTED.commit}^{tree}`],
      objectEnv,
    ).trim();
    assert.equal(commitTree, EXPECTED.tree);
    recorder.pass("bind.objects", "pinned commit/tree and five-patch candidate tree are present");

    const receiptPath = join(dirname(patchObjects), "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.sourceCommit, EXPECTED.commit);
    assert.equal(receipt.sourceTree, EXPECTED.tree);
    assert.equal(receipt.candidateTree, EXPECTED.candidateTree);
    assert.equal(receipt.patchCount, EXPECTED.patchCount);
    recorder.pass(
      "bind.receipt",
      `candidate tree is bound to ${receipt.patchCount} ordered patches`,
    );

    const series = JSON.parse(
      await readFile(join(repoRoot, "patches", "happier", "series.json"), "utf8"),
    );
    const seriesPaths = series.patches.map((entry) => entry.path);
    assert.equal(seriesPaths.length, EXPECTED.patchCount);
    assert.ok(!seriesPaths.includes(EXPECTED.patch0009));
    assert.ok(!seriesPaths.includes(EXPECTED.patch0010));
    recorder.pass(
      "series.unchanged",
      "series.json still lists exactly the active five patches and neither inactive patch",
    );

    const patch0009Bytes = await readFile(patch0009Path);
    const patch0010Bytes = await readFile(patch0010Path);
    assert.equal(sha256Bytes(patch0009Bytes), EXPECTED.patch0009Sha256);
    assert.equal(sha256Bytes(patch0010Bytes), EXPECTED.patch0010Sha256);
    recorder.pass("patch.digests", "0009 and helper-only 0010 match the qualified digests");

    const candidateClient = gitOrThrow(
      gitPath,
      happierGitDir,
      ["show", `${EXPECTED.candidateTree}:${CLIENT_PATH}`],
      objectEnv,
    );
    const candidateReader = gitOrThrow(
      gitPath,
      happierGitDir,
      ["show", `${EXPECTED.candidateTree}:${READER_PATH}`],
      objectEnv,
    );
    assert.ok(!candidateReader.includes("createCodexAppServerRestrictedJsonLineReader"));
    recorder.pass(
      "bind.0009-dependency",
      "the candidate reader lacks the restricted factory; the helper imports the reviewed 0009 API",
    );

    await mkdir(join(scratchTree, dirname(CLIENT_PATH)), { recursive: true });
    await writeFile(join(scratchTree, CLIENT_PATH), candidateClient, "utf8");
    await writeFile(join(scratchTree, READER_PATH), candidateReader, "utf8");
    assert.equal(runGitWorktree(gitPath, scratchTree, ["init", "-q"], toolEnv).status, 0);

    const apply0009 = runGitWorktree(gitPath, scratchTree, ["apply", patch0009Path], toolEnv);
    assert.equal(apply0009.status, 0, `0009 apply failed: ${apply0009.stderr}`);
    const readerAfter0009 = runGitWorktree(
      gitPath,
      scratchTree,
      ["hash-object", READER_PATH],
      toolEnv,
    );
    assert.equal(String(readerAfter0009.stdout).trim(), EXPECTED.after0009ReaderBlob);
    recorder.pass(
      "apply.0009",
      `reviewed 0009 yields the expected byte reader blob ${EXPECTED.after0009ReaderBlob}`,
    );

    const patch0010Text = patch0010Bytes.toString("utf8");
    const touched = patch0010Text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice(6))
      .sort();
    assert.deepEqual(touched, [HELPER_PATH]);
    assert.equal(
      patch0010Text.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length,
      1,
    );
    assert.ok(patch0010Text.includes("new file mode 100644"));
    assert.ok(!patch0010Text.includes("createCodexAppServerClient.ts"));
    recorder.pass("patch.helper-only", "0010 adds only the sibling helper path");

    const applyCheck = runGitWorktree(
      gitPath,
      scratchTree,
      ["apply", "--check", patch0010Path],
      toolEnv,
    );
    assert.equal(applyCheck.status, 0, `0010 check failed: ${applyCheck.stderr}`);
    const apply0010 = runGitWorktree(gitPath, scratchTree, ["apply", patch0010Path], toolEnv);
    assert.equal(apply0010.status, 0, `0010 apply failed: ${apply0010.stderr}`);
    const helperHash = runGitWorktree(gitPath, scratchTree, ["hash-object", HELPER_PATH], toolEnv);
    const clientHash = runGitWorktree(gitPath, scratchTree, ["hash-object", CLIENT_PATH], toolEnv);
    const readerHash = runGitWorktree(gitPath, scratchTree, ["hash-object", READER_PATH], toolEnv);
    assert.equal(String(helperHash.stdout).trim(), EXPECTED.helperBlob);
    assert.equal(String(clientHash.stdout).trim(), EXPECTED.candidateClientBlob);
    assert.equal(String(readerHash.stdout).trim(), EXPECTED.after0009ReaderBlob);
    recorder.pass(
      "patch.applies-inactive",
      `helper blob ${EXPECTED.helperBlob}; maintained client and 0009 reader are unchanged`,
    );

    const helperSource = await readFile(join(scratchTree, HELPER_PATH), "utf8");
    assert.ok(helperSource.includes("from './codexAppServerJsonLineReader'"));
    assert.ok(helperSource.includes("createCodexAppServerRestrictedJsonLineReader("));
    for (const token of [
      "from 'node:child_process'",
      "from 'node:net'",
      "from 'node:fs'",
      "spawn(",
      "createConnection(",
      "resolveCodexCliInvocation",
      "readCodexNativeStartupVersion",
      "process.env",
      "console.",
      "JSON.parse",
      "Buffer",
      "stderrBuffer",
      "resolveOwnedStdioRequestTimeoutMs",
      "isOwnedStdioPendingCapacityAvailable",
      "canAdmitOwnedStdioInboundCallback",
      "validateOwnedStdioJsonRpcEnvelope",
      "'aborted'",
    ]) {
      assert.ok(!helperSource.includes(token), `helper must not contain ${token}`);
    }
    const ownerTypeBlock = helperSource.slice(
      helperSource.indexOf("export type CodexOwnedStdioOwner"),
      helperSource.indexOf("export type CodexOwnedStdioLimits"),
    );
    for (const token of ["command", "args", "cwd"]) {
      assert.ok(!ownerTypeBlock.includes(token), `owner contract must not accept ${token}`);
    }
    recorder.pass(
      "helper.inactive-contract",
      "no spawn/socket/fs/env/console/Buffer/JSON-RPC policy or speculative owner-RPC helpers; no command surface",
    );

    for (const token of ["ownedStdio", "createCodexOwnedStdioTransport"]) {
      const refs = runGit(
        gitPath,
        happierGitDir,
        ["grep", "-l", "-F", token, EXPECTED.candidateTree],
        objectEnv,
      );
      assert.equal(refs.status, 1, `git grep ${token} must be a clean no-match`);
      assert.equal(String(refs.stderr).trim(), "");
      assert.equal(String(refs.stdout), "");
    }
    recorder.pass(
      "no-current-selector",
      "no candidate-tree source references the helper before 0010",
    );

    const loaderPath = join(workspaceRoot, "ts-relative-loader.mjs");
    await writeFile(join(scratchTree, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(
      loaderPath,
      [
        "export async function resolve(specifier, context, nextResolve) {",
        "  try {",
        "    return await nextResolve(specifier, context);",
        "  } catch (error) {",
        "    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && error?.code === 'ERR_MODULE_NOT_FOUND') {",
        "      return await nextResolve(specifier + '.ts', context);",
        "    }",
        "    throw error;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    register(pathToFileURL(loaderPath).href, import.meta.url);
    const helper = await import(pathToFileURL(join(scratchTree, HELPER_PATH)).href);
    assert.equal(typeof helper.createCodexOwnedStdioTransport, "function");
    assert.equal(typeof helper.CodexOwnedStdioError, "function");
    assert.equal(typeof helper.ownedStdioUtf8ByteLength, "function");
    assert.equal(helper.CODEX_OWNED_STDIO_LIMITS.maxFrameBytes > 0, true);
    recorder.pass(
      "helper.import",
      "helper and reviewed 0009 reader import under pinned Node with a relative-.ts resolution harness",
    );

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture);
      const frame = utf8('{"a":1}\r\n{"b":"é"}\n');
      const accentStart = frame.indexOf(0xc3);
      feed.push(frame.subarray(0, accentStart + 1));
      feed.push(frame.subarray(accentStart + 1, accentStart + 2));
      feed.push(frame.subarray(accentStart + 2));
      await tick();
      assert.deepEqual(testCase.lines, ['{"a":1}', '{"b":"é"}']);
      await testCase.transport.send('{"id":1}\n');
      assert.equal(fixture.writes.length, 1);
      assert.equal(fixture.writes[0].toString("utf8"), '{"id":1}\n');
      feed.end();
      const terminal = await testCase.terminalPromise;
      assert.equal(terminal.reason, "eof");
      await testCase.transport.dispose();
      recorder.pass(
        "run.framing",
        "split CRLF/multibyte frames deliver in order; outbound payload is serialized UTF-8 with LF; EOF is terminal",
      );
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture, () => {
        throw new Error("callback boom");
      });
      feed.push(utf8("a\nb\n"));
      await tick();
      assert.deepEqual(testCase.lines, ["a"]);
      assert.equal(testCase.getTerminal()?.reason, "callback");
      assert.equal(testCase.getTerminal()?.message, "Codex owned stdio failed closed (callback)");
      await testCase.transport.dispose();

      const subtypeFeed = createFeed();
      const subtypeFixture = createOwner({ stdout: subtypeFeed });
      const subtypeCase = startCase(helper, subtypeFixture, () => {
        throw new helper.CodexOwnedStdioError("frame");
      });
      subtypeFeed.push(utf8("c\n"));
      await tick();
      assert.equal(subtypeCase.getTerminal()?.reason, "callback");
      assert.equal(
        subtypeCase.getTerminal()?.message,
        "Codex owned stdio failed closed (callback)",
      );
      await subtypeCase.transport.dispose();
      recorder.pass(
        "run.callback-terminal",
        "a throwing frame callback, even with a transport error subtype, maps to the fixed sanitized callback state",
      );
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture, null, { maxFrameBytes: 4 });
      feed.push(Uint8Array.of(0xff, 0x0a));
      await tick();
      assert.deepEqual(testCase.lines, []);
      assert.equal(testCase.getTerminal()?.reason, "frame");
      await testCase.transport.dispose();
      recorder.pass("run.malformed", "invalid UTF-8 maps to the fixed frame state");
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture, null, { maxFrameBytes: 4 });
      feed.push(utf8("12345\n"));
      await tick();
      assert.deepEqual(testCase.lines, []);
      assert.equal(testCase.getTerminal()?.reason, "frame");
      await testCase.transport.dispose();
      recorder.pass("run.oversized-frame", "an over-cap frame fails closed without delivery");
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture);
      feed.push(utf8('{"a":1}'));
      feed.end();
      await tick();
      assert.deepEqual(testCase.lines, []);
      assert.equal(testCase.getTerminal()?.reason, "eof");
      await testCase.transport.dispose();
      recorder.pass("run.truncated", "a partial frame at EOF is truncation, not a frame");
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture);
      feed.end();
      await tick();
      assert.equal(testCase.getTerminal()?.reason, "eof");
      await testCase.transport.dispose();
      recorder.pass("run.early-eof", "clean EOF before disposal is terminal");
    }

    {
      const feed = createFeed();
      const fixture = createOwner({ stdout: feed });
      const testCase = startCase(helper, fixture);
      feed.push("not-bytes");
      await tick();
      assert.equal(testCase.getTerminal()?.reason, "frame");
      await testCase.transport.dispose();
      recorder.pass("run.invalid-chunk", "a non-Uint8Array stdout chunk fails closed");
    }

    {
      const fixture = createOwner();
      const testCase = startCase(helper, fixture);
      await testCase.transport.send("a\n");
      await testCase.transport.send("b\n");
      assert.deepEqual(
        fixture.writes.map((entry) => entry.toString("utf8")),
        ["a\n", "b\n"],
      );
      await testCase.transport.dispose();
      recorder.pass("run.write-serialized", "outbound writes are serialized in order");
    }

    {
      const fixture = createOwner({
        write: async () => {
          throw new Error("broken write");
        },
      });
      const testCase = startCase(helper, fixture);
      await assert.rejects(testCase.transport.send("a\n"), (error) => error.reason === "write");
      assert.equal(testCase.getTerminal()?.reason, "write");
      await assert.rejects(testCase.transport.send("b\n"), (error) => error.reason === "write");
      assert.equal(fixture.writes.length, 1);
      await testCase.transport.dispose();
      recorder.pass(
        "run.write-broken",
        "a broken stream write is a fixed write fault and later sends do not touch the stream",
      );
    }

    {
      const fixture = createOwner({ write: () => new Promise(() => {}) });
      const testCase = startCase(helper, fixture, null, { maxQueueItems: 1 });
      const first = testCase.transport.send("a\n");
      first.catch(() => undefined);
      await tick();
      await assert.rejects(testCase.transport.send("b\n"), (error) => error.reason === "capacity");
      const firstError = await first.then(
        () => null,
        (error) => error,
      );
      assert.equal(firstError?.reason, "capacity");
      assert.equal(testCase.getTerminal()?.reason, "capacity");
      assert.equal(fixture.writes.length, 1);
      await testCase.transport.dispose();
      recorder.pass(
        "run.queue-items-capacity",
        "item queue overflow latches capacity before an additional write and settles the blocked send",
      );
    }

    {
      const fixture = createOwner();
      const testCase = startCase(helper, fixture, null, { maxQueueBytes: 4 });
      await assert.rejects(
        testCase.transport.send("12345\n"),
        (error) => error.reason === "capacity",
      );
      assert.equal(testCase.getTerminal()?.reason, "capacity");
      assert.equal(fixture.writes.length, 0);
      await testCase.transport.dispose();
      recorder.pass(
        "run.queue-bytes-capacity",
        "byte queue overflow latches capacity before stream touch",
      );
    }

    {
      const hugeFixture = createOwner();
      const hugeCase = startCase(helper, hugeFixture, null, { maxQueueBytes: 8 });
      await assert.rejects(
        hugeCase.transport.send(`${"a".repeat(1024 * 1024)}\n`),
        (error) => error.reason === "capacity",
      );
      assert.equal(hugeFixture.writes.length, 0);
      assert.equal(hugeCase.getTerminal()?.reason, "capacity");
      await hugeCase.transport.dispose();

      const multibyteFixture = createOwner();
      const multibyteCase = startCase(helper, multibyteFixture, null, { maxQueueBytes: 8 });
      await assert.rejects(
        multibyteCase.transport.send(`${"é".repeat(5)}\n`),
        (error) => error.reason === "capacity",
      );
      assert.equal(multibyteFixture.writes.length, 0);
      await multibyteCase.transport.dispose();
      recorder.pass(
        "run.oversized-before-encode-capacity",
        "oversized ASCII and multibyte payloads latch capacity before encoding or stream touch",
      );
    }

    {
      const fixture = createOwner();
      const testCase = startCase(helper, fixture);
      await assert.rejects(
        testCase.transport.send("no-newline"),
        (error) => error.reason === "write",
      );
      assert.equal(fixture.writes.length, 0);
      await testCase.transport.dispose();
      recorder.pass(
        "run.non-lf-contract",
        "a non-LF payload is an independent write contract fault",
      );
    }

    {
      const fixture = createOwner({ write: () => new Promise(() => {}) });
      const testCase = startCase(helper, fixture, null, {
        maxQueueItems: 2,
        writeDeadlineMs: 20,
      });
      const first = testCase.transport.send("a\n");
      first.catch(() => undefined);
      await tick();
      const second = testCase.transport.send("b\n");
      second.catch(() => undefined);
      await assert.rejects(first, (error) => error.reason === "timeout");
      await assert.rejects(second, (error) => error.reason === "timeout");
      assert.equal(testCase.getTerminal()?.reason, "timeout");
      assert.equal(fixture.writes.length, 1);
      await testCase.transport.dispose();
      recorder.pass(
        "run.write-deadline",
        "the 10s-style write deadline is enqueue-to-settlement and fails queued/in-flight waits once",
      );
    }

    {
      const fixture = createOwner({ write: () => new Promise(() => {}) });
      const testCase = startCase(helper, fixture);
      const pending = testCase.transport.send("a\n");
      const outcome = pending.then(
        () => null,
        (error) => error,
      );
      await tick();
      fixture.fail(new Error("owner failed"));
      const result = await outcome;
      assert.equal(result?.reason, "owner");
      assert.equal(testCase.getTerminal()?.reason, "owner");
      await testCase.transport.dispose();
      recorder.pass(
        "run.pending-prompt-settle",
        "owner failure settles the blocked send immediately, not after the write returns",
      );
    }

    {
      const fixture = createOwner();
      const testCase = startCase(helper, fixture);
      testCase.transport.closeAdmission();
      await assert.rejects(testCase.transport.send("a\n"), (error) => error.reason === "closed");
      assert.equal(fixture.writes.length, 0);
      fixture.fail(new Error("late owner failure"));
      await tick();
      assert.equal(testCase.getTerminal(), null);
      await testCase.transport.dispose();
      recorder.pass(
        "run.close-admission",
        "disposal admission reject happens before streams and a late owner failure is ignored",
      );
    }

    {
      const stderr = createFeed();
      const stdout = createFeed();
      const fixture = createOwner({ stdout, stderr });
      const testCase = startCase(helper, fixture, null, { maxStderrDiscardBytes: 4 });
      stderr.push(utf8("SECRET-STDERR-PAYLOAD"));
      stderr.push(utf8('{"jsonrpc":"2.0"}'));
      await tick();
      assert.equal(testCase.transport.stderrBytesDiscarded(), 4);
      stdout.end();
      await tick();
      const terminal = testCase.getTerminal();
      assert.equal(terminal?.reason, "eof");
      assert.ok(!terminal.message.includes("SECRET"));
      await testCase.transport.dispose();
      recorder.pass(
        "run.stderr-discarded",
        "stderr is counted to a fixed cap, never retained/parsed/leaked, and does not become a frame",
      );
    }

    {
      const fixture = createOwner({ settlement: { rootEmpty: true, jobEmpty: false } });
      const testCase = startCase(helper, fixture);
      const first = await testCase.transport.dispose();
      const second = await testCase.transport.dispose();
      assert.deepEqual(first, { rootEmpty: true, jobEmpty: false });
      assert.deepEqual(second, { rootEmpty: true, jobEmpty: false });
      assert.equal(fixture.getDisposeCalls(), 1);
      recorder.pass(
        "run.dispose-settlement",
        "one shared settlement preserves owner root/job claims and is idempotent",
      );
    }

    {
      const fixture = createOwner({
        dispose: async () => {
          throw new Error("dispose failed");
        },
      });
      const testCase = startCase(helper, fixture);
      assert.deepEqual(await testCase.transport.dispose(), { rootEmpty: null, jobEmpty: null });
      recorder.pass(
        "run.dispose-unknown",
        "owner dispose failure is unknown, not a fake empty state",
      );
    }

    {
      const fixture = createOwner({ dispose: () => new Promise(() => {}) });
      const testCase = startCase(helper, fixture, null, { disposeDeadlineMs: 20 });
      const startedAt = Date.now();
      assert.deepEqual(await testCase.transport.dispose(), { rootEmpty: null, jobEmpty: null });
      assert.ok(Date.now() - startedAt < 500);
      recorder.pass(
        "run.dispose-deadline",
        "a blocked owner disposal returns unknown within the finite settlement deadline",
      );
    }

    {
      const fixture = createOwner({ settlement: { rootEmpty: "yes", jobEmpty: 1 } });
      const testCase = startCase(helper, fixture);
      assert.deepEqual(await testCase.transport.dispose(), { rootEmpty: null, jobEmpty: null });
      recorder.pass("run.settlement-invalid", "non-boolean settlement claims normalize to unknown");
    }

    {
      const fixture = createOwner();
      assert.throws(
        () =>
          helper.createCodexOwnedStdioTransport(fixture.owner, {
            ...baseLimits,
            maxFrameBytes: 0,
          }),
        (error) => error instanceof RangeError,
      );
      assert.throws(
        () =>
          helper.createCodexOwnedStdioTransport({
            ...fixture.owner,
            stdout: [],
          }),
        (error) => error instanceof TypeError,
      );
      for (const deadline of ["writeDeadlineMs", "disposeDeadlineMs"]) {
        assert.throws(
          () =>
            helper.createCodexOwnedStdioTransport(fixture.owner, {
              ...baseLimits,
              [deadline]: 2_147_483_648,
            }),
          (error) => error instanceof RangeError,
        );
      }
      recorder.pass(
        "run.contract-validation",
        "invalid finite limits, over-timer deadlines and a non-async stdout contract are rejected at construction",
      );
    }

    {
      const mutableLimits = limits({ maxQueueBytes: 8 });
      const fixture = createOwner();
      const transport = helper.createCodexOwnedStdioTransport(fixture.owner, mutableLimits);
      mutableLimits.maxQueueBytes = 1;
      await transport.send("abcd\n");
      assert.equal(fixture.writes.length, 1);
      assert.deepEqual(await transport.dispose(), { rootEmpty: true, jobEmpty: true });
      recorder.pass(
        "run.limits-snapshot",
        "optional limits are snapshotted/frozen at construction; later caller mutation does not change policy",
      );
    }

    {
      const stdoutCounts = { opens: 0 };
      const stderrCounts = { opens: 0 };
      let listenerRegistered = 0;
      let detachCalls = 0;
      let disposeCalls = 0;
      const owner = {
        stdin: { write: async () => {} },
        stdout: createOpeningAsyncIterable(stdoutCounts),
        stderr: createOpeningAsyncIterable(stderrCounts),
        onFailure(handler) {
          listenerRegistered += 1;
          handler(new Error("already failed"));
          return () => {
            detachCalls += 1;
          };
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      const transport = helper.createCodexOwnedStdioTransport(owner);
      let terminalCount = 0;
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(listenerRegistered, 1);
      assert.equal(detachCalls, 1);
      assert.equal(disposeCalls, 1);
      assert.equal(stdoutCounts.opens, 0);
      assert.equal(stderrCounts.opens, 0);
      await transport.dispose();
      assert.equal(detachCalls, 1);
      assert.equal(disposeCalls, 1);
      recorder.pass(
        "run.start-replayed-failure-detach",
        "replayed failure during registration detaches the returned subscription once, disposes once and never opens stdout/stderr",
      );
    }

    {
      const stdoutCounts = { opens: 0 };
      const stderrCounts = { opens: 0 };
      let failureHandler = null;
      let detachCalls = 0;
      let disposeCalls = 0;
      const owner = {
        stdin: { write: async () => {} },
        stdout: createOpeningAsyncIterable(stdoutCounts),
        stderr: createOpeningAsyncIterable(stderrCounts),
        onFailure(handler) {
          failureHandler = handler;
          return () => {
            detachCalls += 1;
          };
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      const transport = helper.createCodexOwnedStdioTransport(owner);
      let terminalCount = 0;
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      assert.equal(terminalCount, 0);
      assert.equal(stdoutCounts.opens, 1);
      assert.equal(stderrCounts.opens, 1);
      failureHandler(new Error("normal failure"));
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(detachCalls, 1);
      assert.equal(disposeCalls, 1);
      await transport.dispose();
      assert.equal(disposeCalls, 1);
      recorder.pass(
        "run.start-normal",
        "normal start opens stdout/stderr once; later failure detaches once and disposes once",
      );
    }

    {
      let failureHandler = null;
      let detachCalls = 0;
      let disposeCalls = 0;
      const owner = {
        stdin: { write: async () => {} },
        stdout: createFeed(),
        stderr: createFeed(),
        onFailure(handler) {
          failureHandler = handler;
          return () => {
            detachCalls += 1;
            void transport.dispose();
          };
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      const transport = helper.createCodexOwnedStdioTransport(owner);
      let terminalCount = 0;
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      failureHandler(new Error("failure before reentrant unsubscribe"));
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(detachCalls, 1);
      assert.equal(disposeCalls, 1);
      await transport.dispose();
      assert.equal(disposeCalls, 1);
      recorder.pass(
        "run.dispose-reentrant-unsubscribe",
        "settlement promise is published before synchronous unsubscribe, so reentrant dispose still calls owner.dispose once",
      );
    }

    {
      const stdoutCounts = { opens: 0 };
      const stderrCounts = { opens: 0 };
      const fixture = createOwner({
        stdout: createOpeningAsyncIterable(stdoutCounts),
        stderr: createOpeningAsyncIterable(stderrCounts),
      });
      const transport = helper.createCodexOwnedStdioTransport(fixture.owner);
      transport.failClosed("owner");
      assert.doesNotThrow(() =>
        transport.start(
          () => {},
          () => {
            throw new Error("early terminal observer throw");
          },
        ),
      );
      assert.equal(stdoutCounts.opens, 0);
      assert.equal(stderrCounts.opens, 0);
      await transport.dispose();
      recorder.pass(
        "run.early-terminal-callback-contained",
        "a synchronous early terminal observer throw is contained and no stream is acquired",
      );
    }

    {
      let nextCalls = 0;
      let stderrOpens = 0;
      let terminalCount = 0;
      let disposeCalls = 0;
      let transport = null;
      const stdout = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1;
              transport.failClosed("owner");
              await new Promise(() => {});
              return { done: true, value: undefined };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
      const stderr = {
        [Symbol.asyncIterator]() {
          stderrOpens += 1;
          return {
            async next() {
              await new Promise(() => {});
              return { done: true, value: undefined };
            },
          };
        },
      };
      const owner = {
        stdin: { write: async () => {} },
        stdout,
        stderr,
        onFailure() {
          return () => {};
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      transport = helper.createCodexOwnedStdioTransport(owner);
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(nextCalls, 1);
      assert.equal(stderrOpens, 0);
      assert.equal(disposeCalls, 1);
      await transport.dispose();
      recorder.pass(
        "run.stdout-terminal-no-stderr",
        "a terminal during synchronous stdout next prevents the stderr read and submits no further next",
      );
    }

    {
      let stdoutOpens = 0;
      let stdoutNextCalls = 0;
      let stderrOpens = 0;
      let terminalCount = 0;
      let disposeCalls = 0;
      let transport = null;
      const stdout = {
        [Symbol.asyncIterator]() {
          stdoutOpens += 1;
          // Acquisition itself replays owner failure, then still returns a valid
          // iterator. No next() may be submitted afterwards.
          transport.failClosed("owner");
          return {
            async next() {
              stdoutNextCalls += 1;
              return { done: true, value: undefined };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
      const stderr = {
        [Symbol.asyncIterator]() {
          stderrOpens += 1;
          return {
            async next() {
              await new Promise(() => {});
              return { done: true, value: undefined };
            },
          };
        },
      };
      const owner = {
        stdin: { write: async () => {} },
        stdout,
        stderr,
        onFailure() {
          return () => {};
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      transport = helper.createCodexOwnedStdioTransport(owner);
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(stdoutOpens, 1);
      assert.equal(stdoutNextCalls, 0);
      assert.equal(stderrOpens, 0);
      assert.equal(disposeCalls, 1);
      await transport.dispose();
      recorder.pass(
        "run.stdout-acquisition-terminal",
        "owner failure replayed during stdout iterator acquisition submits no next and no stderr read",
      );
    }

    {
      let stdoutOpens = 0;
      let stdoutNextCalls = 0;
      let stderrOpens = 0;
      let stderrNextCalls = 0;
      let terminalCount = 0;
      let disposeCalls = 0;
      let transport = null;
      const stdout = {
        [Symbol.asyncIterator]() {
          stdoutOpens += 1;
          return {
            async next() {
              stdoutNextCalls += 1;
              await new Promise(() => {});
              return { done: true, value: undefined };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
      const stderr = {
        [Symbol.asyncIterator]() {
          stderrOpens += 1;
          // The stderr iterator acquisition itself replays owner failure.
          transport.failClosed("owner");
          return {
            async next() {
              stderrNextCalls += 1;
              return { done: true, value: undefined };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
      const owner = {
        stdin: { write: async () => {} },
        stdout,
        stderr,
        onFailure() {
          return () => {};
        },
        async dispose() {
          disposeCalls += 1;
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      transport = helper.createCodexOwnedStdioTransport(owner);
      transport.start(
        () => {},
        () => {
          terminalCount += 1;
          void transport.dispose();
        },
      );
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(stdoutOpens, 1);
      assert.equal(stdoutNextCalls, 1);
      assert.equal(stderrOpens, 1);
      assert.equal(stderrNextCalls, 0);
      assert.equal(disposeCalls, 1);
      await transport.dispose();
      recorder.pass(
        "run.stderr-acquisition-terminal",
        "owner failure replayed during stderr iterator acquisition submits no stderr next and keeps one disposal",
      );
    }

    {
      let nextCalls = 0;
      let stderrOpens = 0;
      let terminalCount = 0;
      const chunks = [utf8('{"a":1}\n'), utf8('{"b":2}\n')];
      const stdout = {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              nextCalls += 1;
              if (index < chunks.length) {
                const value = chunks[index];
                index += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
      const stderr = {
        [Symbol.asyncIterator]() {
          stderrOpens += 1;
          return {
            async next() {
              await new Promise(() => {});
              return { done: true, value: undefined };
            },
          };
        },
      };
      const owner = {
        stdin: { write: async () => {} },
        stdout,
        stderr,
        onFailure() {
          return () => {};
        },
        async dispose() {
          return { rootEmpty: true, jobEmpty: true };
        },
      };
      const transport = helper.createCodexOwnedStdioTransport(owner);
      const lines = [];
      transport.start(
        (line) => {
          lines.push(line);
          transport.failClosed("callback");
        },
        () => {
          terminalCount += 1;
        },
      );
      await tick();
      assert.equal(terminalCount, 1);
      assert.equal(nextCalls, 1);
      assert.equal(stderrOpens, 1);
      assert.deepEqual(lines, ['{"a":1}']);
      await transport.dispose();
      recorder.pass(
        "run.no-next-after-terminal",
        "closure observed in a frame callback stops the next stdout next; a stderr read already admitted by async frame timing is allowed",
      );
    }

    if (options.tsc === null) {
      recorder.skip(
        "compile.helper-reader",
        "no --tsc supplied; focused helper+reader TypeScript compile NOT_RUN and not claimed",
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
        [tscPath, ...TYPESCRIPT_FLAGS, "--typeRoots", typeRoots, join(scratchTree, HELPER_PATH)],
        { cwd: scratchTree, env: toolEnv, encoding: "utf8", windowsHide: true },
      );
      const compileStdout = String(compile.stdout ?? "").trim();
      const compileStderr = String(compile.stderr ?? "").trim();
      if (compile.status === 0 && compileStdout === "" && compileStderr === "") {
        recorder.pass(
          "compile.helper-reader",
          `${String(tscVersion.stdout).trim()} compiled the helper+reader with @types/node ${nodeTypesVersion} (tsc sha256 ${tscSha256.slice(0, 16)}...)`,
        );
      } else {
        recorder.fail("compile.helper-reader", "focused helper+reader compile failed", {
          status: compile.status,
          stdout: compileStdout.slice(0, 500),
          stderr: compileStderr.slice(0, 500),
        });
        throw new Error("helper+reader TypeScript compile failed");
      }
    }

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
          suite: "codex-owned-stdio-transport-helper",
          labels: LABELS,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          preparedOnRacBase: {
            commit: "67fffdb08164a1f625b06693a7f935e27aac7387",
            tree: "8d117ab288f852cd2b65ed823e919a90b13ab65a",
          },
          happy: {
            commit: EXPECTED.commit,
            tree: EXPECTED.tree,
            candidateTree: EXPECTED.candidateTree,
            candidateClientBlob: EXPECTED.candidateClientBlob,
            candidateReaderBlob: EXPECTED.candidateReaderBlob,
            after0009ReaderBlob: EXPECTED.after0009ReaderBlob,
            patch0009: EXPECTED.patch0009,
            patch0009Sha256: EXPECTED.patch0009Sha256,
            patch0010: EXPECTED.patch0010,
            patch0010Sha256: EXPECTED.patch0010Sha256,
            helperBlob: EXPECTED.helperBlob,
          },
          summary: recorder.summary(),
          limitations,
        }),
      );
    }

    console.log(
      `RESULT PASS ${recorder.summary().passed}/${recorder.summary().total} executed checks${
        recorder.summary().skipped > 0 ? `, ${recorder.summary().skipped} not run` : ""
      } (node ${process.version}, ${process.platform}/${process.arch})`,
    );
    exitCode = 0;
  } catch (error) {
    recorder.fail("suite.error", String(error?.message ?? error).slice(0, 600));
    exitCode = 1;
  } finally {
    if (options.keepTemp) {
      console.log(`SCRATCH ${workspaceRoot}`);
    } else {
      try {
        const owned = resolve(workspaceRoot);
        const prefix = `${tempRoot}${sep}`;
        if (owned.startsWith(prefix) && basename(owned).startsWith("rac-codex-owned-stdio-")) {
          await rm(owned, { recursive: true, force: true });
        } else {
          console.error(`[codex-owned-stdio] temp cleanup refused: ${owned}`);
        }
      } catch (error) {
        console.error(
          `[codex-owned-stdio] temp cleanup refused: ${String(error?.message ?? error)}`,
        );
      }
    }
  }
  return exitCode;
}

process.exitCode = await main();
