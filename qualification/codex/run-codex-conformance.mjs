#!/usr/bin/env node

/**
 * ROG-14 Codex native/offline conformance harness.
 *
 * Labels: native, offline. Not integrated, not physical.
 *
 * Fail-closed order:
 *   1. metadata-only launcher resolution (absolute paths, containment, no reparse)
 *   2. binary digest against a pinned or owner-supplied SHA-256, before any launch
 *   3. version identity (first launch)
 *   4. stable schema identity and contract (second launch)
 *   5. real stdio initialize gate, then thread start/read/resume in a disposable home
 *
 * Any failed gate stops the later stages. No turn is sent, no model or provider
 * is contacted, and no listener or shared app-server is started.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerSession, DEFAULT_LIMITS } from "./lib/app-server-client.mjs";
import { createByteBoundedBuffer, scalarError, versionLabel } from "./lib/bounds.mjs";
import {
  buildChildEnv,
  CONTAINMENT_NOTE,
  classifyUsages,
  describeExit,
  ISOLATED_ENV_NAMES,
  parseMethodLiteral,
} from "./lib/harness-policy.mjs";
import {
  classifyMagic,
  fileMagic,
  resolveCodexBinary,
  sha256File,
  verifyBinaryIdentity,
} from "./lib/native-identity.mjs";
import {
  assertEvidenceTarget,
  assertOwnedTempDirectory,
  isPathInside,
  pathExists,
} from "./lib/paths.mjs";
import { maskId, redactString, redactValue } from "./lib/redact.mjs";
import {
  buildSchemaManifest,
  compareManifests,
  generateStableSchema,
  hashManifest,
  SCHEMA_BUNDLE,
  SCHEMA_V2_BUNDLE,
  verifyStableContract,
} from "./lib/schema-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LABELS = ["native", "offline", "not-integrated", "not-physical"];

const OFFLINE_CONCERN =
  /(responses_websocket|failed to connect|api\.openai\.com|econn|enotfound|network error|proxy)/i;
const SHELL_SNAPSHOT = /shell_snapshot/i;

function usage() {
  return [
    "Usage: node qualification/codex/run-codex-conformance.mjs [options]",
    "",
    "Options:",
    "  --codex <absolute path>    Codex launcher or native binary (default: codex on absolute PATH)",
    "  --expected-sha256 <hex>    Owner-supplied digest; overrides the platform-pinned digest",
    "  --schema-snapshot <dir>    Compare generated stable schema bytes with a captured bundle",
    "  --write-schema-snapshot    Write a NEW candidate manifest; never overwrites the baseline",
    "  --snapshot-out <file>      Candidate path for --write-schema-snapshot",
    "  --happier-source <dir>     Pinned Happier checkout; comparison is then required to pass",
    "  --evidence <file>          Write the structured JSON receipt (existing file refused)",
    "  --temp-root <dir>          Parent for the owned disposable workspace",
    "  --keep-temp                Keep the disposable workspace (console-only path)",
    "  --json                     Print the full receipt instead of a summary",
    "  --self-test                Run pure trust and negative-control assertions, no launches",
    "  --help                     Print this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    codex: null,
    expectedSha256: null,
    schemaSnapshot: null,
    writeSchemaSnapshot: false,
    snapshotOut: null,
    happierSource: null,
    evidence: null,
    tempRoot: process.env.RAC_CODEX_TEMP_ROOT ?? tmpdir(),
    keepTemp: false,
    json: false,
    selfTest: false,
    help: false,
  };
  const takesValue = {
    "--codex": "codex",
    "--expected-sha256": "expectedSha256",
    "--schema-snapshot": "schemaSnapshot",
    "--snapshot-out": "snapshotOut",
    "--happier-source": "happierSource",
    "--evidence": "evidence",
    "--temp-root": "tempRoot",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--write-schema-snapshot") {
      options.writeSchemaSnapshot = true;
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
    if (argument === "--self-test") {
      options.selfTest = true;
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

function runProcessBounded(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 15000,
    maxStdoutBytes = 16 * 1024,
    maxStderrBytes = 16 * 1024,
  } = options;
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ...value, durationMs: Date.now() - startedAt });
    };
    const child = spawn(command, args, {
      cwd,
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
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      finish({
        ok: false,
        spawnError: true,
        code: null,
        timedOut,
        stdoutText: stdout.text,
        stderrText: stderr.text,
        stdout: stdout.summary(),
        stderr: stderr.summary(),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !timedOut,
        spawnError: false,
        code,
        timedOut,
        stdoutText: stdout.text,
        stderrText: stderr.text,
        stdout: stdout.summary(),
        stderr: stderr.summary(),
      });
    });
  });
}
function summarizeStderr(text, { bytes, truncated }) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let offlineConcern = 0;
  let shellSnapshot = 0;
  for (const line of lines) {
    if (OFFLINE_CONCERN.test(line)) offlineConcern += 1;
    else if (SHELL_SNAPSHOT.test(line)) shellSnapshot += 1;
  }
  return {
    lineCount: lines.length,
    bytes,
    truncated,
    sha256: createHash("sha256")
      .update(String(text ?? ""), "utf8")
      .digest("hex"),
    categories: {
      offlineConcern,
      shellSnapshot,
      other: lines.length - offlineConcern - shellSnapshot,
    },
  };
}

function summarizeFaults(faults) {
  const kinds = { limit: 0, timeout: 0, serverRequest: 0, other: 0 };
  for (const fault of faults) {
    if (/exceeded|cap/i.test(fault)) kinds.limit += 1;
    else if (/timeout|exceeded .*ms/i.test(fault)) kinds.timeout += 1;
    else if (/unexpected server request/i.test(fault)) kinds.serverRequest += 1;
    else kinds.other += 1;
  }
  return { count: faults.length, kinds };
}

function createRecorder() {
  const checks = [];
  const observations = [];
  const mismatches = [];
  const push = (id, status, detail, extra = {}) => {
    checks.push({ id, status, detail, ...extra });
    if (status === "fail") mismatches.push({ check: id, detail });
    return status;
  };
  return {
    checks,
    observations,
    mismatches,
    pass: (id, detail, extra) => push(id, "pass", detail, extra),
    fail: (id, detail, extra) => push(id, "fail", detail, extra),
    skip: (id, detail, extra) => push(id, "skip", detail, extra),
    blocked: (id, detail, extra) => push(id, "blocked", detail, extra),
    notQualified: (id, detail, extra) => push(id, "not-qualified", detail, extra),
    observe: (note, extra = {}) => observations.push({ note, ...extra }),
  };
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function createWorkspace(tempRoot) {
  const parent = resolve(tempRoot);
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "rac-codex-conformance-"));
  assertOwnedTempDirectory(root, parent);
  const workspace = {
    root,
    codexHome: join(root, "codex-home"),
    schemaHome: join(root, "schema-home"),
    schemaOut: join(root, "schema"),
    project: join(root, "project"),
    home: join(root, "home"),
    userprofile: join(root, "userprofile"),
    appdata: join(root, "appdata-roaming"),
    localAppdata: join(root, "appdata-local"),
    temp: join(root, "temp"),
  };
  for (const path of Object.values(workspace)) {
    if (path !== root) await mkdir(path, { recursive: true });
  }
  await writeFile(
    join(workspace.project, "QUALIFICATION.md"),
    "# Disposable qualification project\n\nCreated by the Codex native/offline conformance harness. Contains no source and is removed after the run.\n",
    "utf8",
  );
  return workspace;
}

function isolatedEnv(codexHome, workspace) {
  return buildChildEnv({
    baseEnv: process.env,
    platform: process.platform,
    isolated: {
      CODEX_HOME: codexHome,
      HOME: workspace.home,
      USERPROFILE: workspace.userprofile,
      APPDATA: workspace.appdata,
      LOCALAPPDATA: workspace.localAppdata,
      TEMP: workspace.temp,
      TMP: workspace.temp,
    },
  });
}

async function runSelfTest(options) {
  const assertions = [];
  const check = (id, condition, detail) => assertions.push({ id, ok: Boolean(condition), detail });
  const parent = resolve(options.tempRoot);
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "rac-codex-conformance-"));
  try {
    assertOwnedTempDirectory(root, parent);
    const pePath = join(root, "pe.bin");
    await writeFile(pePath, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]));
    check("magic.pe", (await fileMagic(pePath)) === "pe", "MZ prefix classifies as pe");
    const elfPath = join(root, "elf.bin");
    await writeFile(elfPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    check("magic.elf", (await fileMagic(elfPath)) === "elf", "ELF prefix classifies as elf");
    check(
      "magic.unknown",
      classifyMagic(Buffer.from("plain text")) === "unknown",
      "text is unknown",
    );
    check(
      "magic.bounded-prefix",
      classifyMagic(Buffer.from([0x4d, 0x5a, 1, 2, 3, 4, 5, 6])) === "pe",
      "classification needs only the leading bytes",
    );

    const expected = { "a.json": { sha256: "aa", bytes: 1 } };
    check("manifest.identical", compareManifests(expected, { ...expected }).identical === true);
    check("manifest.missing", compareManifests(expected, {}).missing[0] === "a.json");
    check(
      "manifest.changed",
      compareManifests(expected, { "a.json": { sha256: "bb", bytes: 1 } }).changed.length === 1,
    );

    check("paths.inside", isPathInside("C:/root/x", "C:/root/x/y"));
    check("paths.sibling-prefix", !isPathInside("C:/root/x", "C:/root/xy"));
    check("paths.escape", !isPathInside("C:/root/x", "C:/root/x/../y"));

    const built = buildChildEnv({
      baseEnv: {
        PATH: "relative\\bin;C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows",
        SECRET_TOKEN: "do-not-forward",
      },
      platform: "win32",
      isolated: {
        CODEX_HOME: "C:\\isolated\\codex",
        HOME: "C:\\isolated\\home",
        USERPROFILE: "C:\\isolated\\home",
        APPDATA: "C:\\isolated\\appdata",
        LOCALAPPDATA: "C:\\isolated\\local",
        TEMP: "C:\\isolated\\temp",
        TMP: "C:\\isolated\\temp",
      },
    });
    check(
      "env.secret-dropped",
      !("SECRET_TOKEN" in built.env),
      "arbitrary ambient variables are not forwarded",
    );
    check(
      "env.relative-path-dropped",
      built.rejectedPathEntries.length === 1 && !built.env.PATH.includes("relative\\bin"),
      "relative PATH entries are rejected",
    );

    const classified = classifyUsages(
      [
        { method: "thread/ok", location: "src/a.ts" },
        { method: "thread/bad", location: "src/b.ts" },
        { method: "thread/bad", location: "src/b.test.ts" },
        { method: "thread/bad", location: "tests/c.ts" },
      ],
      new Set(["thread/ok"]),
    );
    const bad = classified.absent.find((entry) => entry.method === "thread/bad");
    check(
      "usage.all-occurrences",
      bad.occurrences === 3 && bad.testOccurrences === 2 && bad.testOnly === false,
      "classification counts every occurrence, not just the retained sample",
    );
    check(
      "usage.locations-bounded",
      bad.productionLocations.length === 1 && bad.testLocations.length === 2,
      "production and test locations are retained separately and bounded",
    );
    check(
      "usage.double-quoted-literal",
      parseMethodLiteral('emit("thread/start", {})') === "thread/start",
      "double-quoted method literals are recognised",
    );
    check(
      "usage.single-quoted-literal",
      parseMethodLiteral("emit('turn/interrupt', {})") === "turn/interrupt",
      "single-quoted method literals are recognised",
    );

    const graceful = describeExit({
      observed: true,
      code: 0,
      signal: null,
      timedOut: false,
      forcedKill: false,
      exitAfterKill: false,
    });
    const forced = describeExit({
      observed: true,
      code: 0,
      signal: null,
      timedOut: false,
      forcedKill: true,
      exitAfterKill: true,
    });
    const unconfirmed = describeExit({
      observed: false,
      code: null,
      signal: null,
      timedOut: true,
      forcedKill: true,
      exitAfterKill: false,
    });
    check("exit.graceful", graceful.graceful && graceful.confirmedExit && !graceful.forcedKill);
    check(
      "exit.forced-not-graceful",
      forced.confirmedExit &&
        forced.forcedKill &&
        !forced.graceful &&
        forced.exitAfterKill &&
        forced.gracefulTimedOut,
    );
    check("exit.unconfirmed", !unconfirmed.confirmedExit && unconfirmed.timedOut);

    check(
      "redact.user",
      !redactString("C:\\Users\\alice\\project").includes("alice") &&
        !redactString("D:\\AgentData\\evidence").includes("AgentData"),
    );

    const fakeNative = join(root, "fake-native.exe");
    await writeFile(fakeNative, Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]));
    const mismatch = await verifyBinaryIdentity(fakeNative, "0".repeat(64));
    check(
      "identity.digest-mismatch",
      mismatch.matchesExpected === false && mismatch.magic === "pe",
      "a wrong digest is detected before any launch",
    );
    const malformed = await verifyBinaryIdentity(fakeNative, "not-a-digest");
    check("identity.malformed-digest", malformed.expectedDigestWellFormed === false);

    const receiptPath = join(root, "receipt.json");
    await writeFile(receiptPath, "{}", "utf8");
    let refused = false;
    try {
      await assertEvidenceTarget(receiptPath);
    } catch {
      refused = true;
    }
    check("evidence.refuses-existing", refused, "an existing evidence receipt is never replaced");
    const freshReceipt = join(root, "fresh-receipt.json");
    check(
      "evidence.accepts-new-path",
      (await assertEvidenceTarget(freshReceipt)) === resolve(freshReceipt),
      "a new receipt path is accepted",
    );
  } finally {
    try {
      const owned = assertOwnedTempDirectory(root, parent);
      await rm(owned, { recursive: true, force: true });
    } catch {
      // Self-test cleanup is best-effort; nothing outside the owned prefix is removed.
    }
  }

  const failed = assertions.filter((assertion) => !assertion.ok);
  const status = failed.length === 0 ? "PASS" : "FAIL";
  console.log(
    JSON.stringify(
      {
        suite: "codex-native-app-server-offline-conformance",
        mode: "self-test",
        status,
        labels: LABELS,
        launches: 0,
        assertions,
        summary: {
          total: assertions.length,
          passed: assertions.length - failed.length,
          failed: failed.length,
        },
      },
      null,
      2,
    ),
  );
  return status === "PASS" ? 0 : 1;
}

async function inspectHappierSource({ directory, lock, schemaMethodSet, limits }) {
  const scanScope = {
    mode: "git-object-literal-scan",
    revision: "HEAD",
    quoteForms: ["double-quoted", "single-quoted"],
    checkoutEvaluated: false,
    runtimeEvaluated: false,
    completeness: "not claimed",
  };
  const base = {
    requested: Boolean(directory),
    directory: directory ? redactString(resolve(directory)) : null,
    scan: scanScope,
    pinnedCommit: lock.repositories?.happier?.commit ?? null,
    pinnedTree: lock.repositories?.happier?.tree ?? null,
  };
  if (!directory) {
    return { ...base, status: "not-run", adapterComparison: "NOT_RUN", reason: null };
  }
  const head = await runProcessBounded("git", ["-C", directory, "rev-parse", "HEAD"], {
    timeoutMs: 15000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 4096,
  });
  if (!head.ok) {
    return {
      ...base,
      status: "blocked",
      adapterComparison: "BLOCKED",
      reason: "checkout HEAD unreadable",
    };
  }
  const tree = await runProcessBounded("git", ["-C", directory, "rev-parse", "HEAD^{tree}"], {
    timeoutMs: 15000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 4096,
  });
  if (!tree.ok) {
    return {
      ...base,
      status: "blocked",
      adapterComparison: "BLOCKED",
      reason: "checkout tree unreadable",
    };
  }
  const observedCommit = head.stdoutText.trim();
  const observedTree = tree.stdoutText.trim();
  const commitMatchesLock = observedCommit === base.pinnedCommit;
  const treeMatchesLock = observedTree === base.pinnedTree;

  const grep = await runProcessBounded(
    "git",
    [
      "-C",
      directory,
      "grep",
      "-n",
      "-o",
      "-E",
      "-e",
      '"(thread|turn|item)/[A-Za-z0-9/_.-]+"',
      "-e",
      "'(thread|turn|item)/[A-Za-z0-9/_.-]+'",
      "HEAD",
    ],
    {
      timeoutMs: 120000,
      maxStdoutBytes: limits.grepOutputBytes,
      maxStderrBytes: 32 * 1024,
    },
  );
  if (!grep.ok && grep.code !== 1) {
    return {
      ...base,
      status: "blocked",
      adapterComparison: "BLOCKED",
      observedCommit,
      observedTree,
      commitMatchesLock,
      treeMatchesLock,
      reason: `git grep unreadable (exit ${grep.code ?? "spawn error"})`,
    };
  }
  const entries = [];
  for (const line of grep.stdoutText.split(/\r?\n/)) {
    const parsed = /^HEAD:(.+?):(\d+):(.*)$/.exec(line);
    if (!parsed) continue;
    const [, path, lineNumber, payload] = parsed;
    const method = parseMethodLiteral(payload);
    if (method) entries.push({ method, location: `${path}:${lineNumber}` });
  }
  if (entries.length === 0) {
    return {
      ...base,
      status: "blocked",
      adapterComparison: "BLOCKED",
      observedCommit,
      observedTree,
      commitMatchesLock,
      treeMatchesLock,
      reason: "no thread/turn/item method strings were found at the pinned commit",
    };
  }
  const classification = classifyUsages(entries, schemaMethodSet);
  const productionGaps = classification.absent.filter((entry) => !entry.testOnly);
  const testOnlyGaps = classification.absent.filter((entry) => entry.testOnly);
  return {
    ...base,
    status: "checked",
    adapterComparison:
      commitMatchesLock && treeMatchesLock && productionGaps.length === 0 ? "PASS" : "FAIL",
    observedCommit,
    observedTree,
    commitMatchesLock,
    treeMatchesLock,
    scannedMethods: classification.totalMethods,
    scannedOccurrences: entries.length,
    absentFromStableSchema: classification.absent,
    productionGapCount: productionGaps.length,
    testOnlyGapCount: testOnlyGaps.length,
    reason: null,
  };
}

async function initializeSession(session, workspace, expectations) {
  const result = await session.request("initialize", {
    clientInfo: {
      name: "rac-codex-conformance",
      title: "RAC Codex native/offline conformance",
      version: "0.0.0",
    },
    capabilities: {},
  });
  if (result.error) {
    return { ok: false, error: scalarError(result.error) };
  }
  session.notify("initialized");
  const payload = result.result ?? {};
  const reportedHome = typeof payload.codexHome === "string" ? payload.codexHome : "";
  const userAgent = typeof payload.userAgent === "string" ? payload.userAgent : "";
  const codexHomeInsideWorkspace = isPathInside(workspace.root, reportedHome);
  const codexHomeIsIsolated = isPathInside(workspace.codexHome, reportedHome);
  const platformFamilyMatches = payload.platformFamily === expectations.expectedPlatformFamily;
  const platformOsMatches = payload.platformOs === expectations.expectedPlatformOs;
  const userAgentClientMatch = userAgent.includes("rac-codex-conformance");
  const versionTokenMatches = userAgent.includes(expectations.expectedVersionToken);
  return {
    ok:
      codexHomeInsideWorkspace &&
      codexHomeIsIsolated &&
      platformFamilyMatches &&
      platformOsMatches &&
      userAgentClientMatch &&
      versionTokenMatches,
    codexHomeInsideWorkspace,
    codexHomeIsIsolated,
    platformFamilyMatches,
    platformOsMatches,
    userAgentClientMatch,
    versionTokenMatches,
    userAgentSha256: createHash("sha256").update(userAgent, "utf8").digest("hex"),
    platformFamily: typeof payload.platformFamily === "string" ? payload.platformFamily : null,
    platformOs: typeof payload.platformOs === "string" ? payload.platformOs : null,
  };
}

function validateThreadStart(result, workspace, expectations) {
  const thread = result?.thread ?? {};
  const sandbox = result?.sandbox ?? {};
  const requiredSandbox = expectations.requiredSandbox;
  const startOk =
    typeof thread.id === "string" &&
    typeof thread.sessionId === "string" &&
    resolve(thread.cwd ?? "") === resolve(workspace.project) &&
    thread.cliVersion === expectations.expectedVersionToken &&
    thread.ephemeral === false &&
    thread.status?.type === "idle" &&
    Array.isArray(thread.turns) &&
    thread.turns.length === 0;
  const sandboxOk =
    sandbox.type === requiredSandbox.type &&
    sandbox.networkAccess === requiredSandbox.networkAccess;
  const approvalOk = result?.approvalPolicy === expectations.requiredApprovalPolicy;
  return {
    startOk,
    sandboxOk,
    approvalOk,
    thread: {
      threadIdMasked: maskId(thread.id),
      threadIdSha256:
        typeof thread.id === "string" ? createHash("sha256").update(thread.id).digest("hex") : null,
      sessionIdMasked: maskId(thread.sessionId),
      cliVersion: typeof thread.cliVersion === "string" ? thread.cliVersion : null,
      status: thread.status?.type ?? null,
      ephemeral: thread.ephemeral ?? null,
      turns: Array.isArray(thread.turns) ? thread.turns.length : null,
      cwdInsideWorkspace: isPathInside(workspace.project, thread.cwd ?? ""),
    },
    policy: {
      sandboxType: typeof sandbox.type === "string" ? sandbox.type : null,
      sandboxNetworkAccess: sandbox.networkAccess ?? null,
      approvalPolicy: typeof result?.approvalPolicy === "string" ? result.approvalPolicy : null,
    },
  };
}

async function runPhaseA({ exePath, env, workspace, expectations, recorder, threadState, limits }) {
  const phase = {
    name: "first-process",
    initialize: null,
    threadStart: null,
    threadGates: null,
    inject: null,
    read: null,
    list: null,
    close: null,
    notifications: [],
    faults: [],
  };
  let session;
  try {
    session = await AppServerSession.open({
      exePath,
      args: expectations.appServerArgs,
      cwd: workspace.project,
      env,
      limits,
    });
    phase.initialize = await initializeSession(session, workspace, expectations);
    if (!phase.initialize.ok) {
      recorder.fail("stdio.initialize", "initialize did not prove the expected isolated peer", {
        error: phase.initialize.error ?? null,
        codexHomeInsideWorkspace: phase.initialize.codexHomeInsideWorkspace ?? false,
        codexHomeIsIsolated: phase.initialize.codexHomeIsIsolated ?? false,
        platformFamilyMatches: phase.initialize.platformFamilyMatches ?? false,
        platformOsMatches: phase.initialize.platformOsMatches ?? false,
        userAgentClientMatch: phase.initialize.userAgentClientMatch ?? false,
        versionTokenMatches: phase.initialize.versionTokenMatches ?? false,
      });
      threadState.stoppedAt = "initialize";
      return phase;
    }
    recorder.pass("stdio.initialize", "initialize/initialized completed inside the isolated home");

    const startStartedAt = Date.now();
    const start = await session.request("thread/start", {
      cwd: workspace.project,
      ...expectations.threadStartParams,
    });
    const durationMs = Date.now() - startStartedAt;
    if (start.error) {
      recorder.fail("stdio.thread.start", "thread/start was rejected", {
        error: scalarError(start.error),
        durationMs,
      });
      threadState.stoppedAt = "thread-start";
      return phase;
    }
    const validation = validateThreadStart(start.result, workspace, expectations);
    phase.threadStart = { ...validation.thread, durationMs };
    phase.threadGates = {
      startOk: validation.startOk,
      sandboxOk: validation.sandboxOk,
      approvalOk: validation.approvalOk,
      policy: validation.policy,
    };
    threadState.threadId = start.result?.thread?.id ?? null;

    if (!validation.startOk) {
      recorder.fail(
        "stdio.thread.start",
        "thread/start response did not match the disposable project",
        {
          gates: phase.threadGates,
        },
      );
      threadState.stoppedAt = "thread-start";
      return phase;
    }
    recorder.pass(
      "stdio.thread.start",
      `thread created (${phase.threadStart.threadIdMasked}) with cliVersion ${phase.threadStart.cliVersion}`,
      { durationMs },
    );
    if (!validation.sandboxOk) {
      recorder.fail(
        "stdio.thread.sandbox",
        "returned sandbox is not read-only with network disabled",
        {
          policy: validation.policy,
          required: expectations.requiredSandbox,
        },
      );
      threadState.stoppedAt = "thread-policy";
      return phase;
    }
    recorder.pass("stdio.thread.sandbox", "returned sandbox is read-only with network disabled");
    if (!validation.approvalOk) {
      recorder.fail(
        "stdio.thread.approval-policy",
        "returned approval policy does not match the request",
        {
          policy: validation.policy,
          required: expectations.requiredApprovalPolicy,
        },
      );
      threadState.stoppedAt = "thread-policy";
      return phase;
    }
    recorder.pass("stdio.thread.approval-policy", "returned approval policy matches the request");

    if (!threadState.threadId) {
      threadState.stoppedAt = "thread-start";
      return phase;
    }

    const injected = await session.request("thread/inject_items", {
      threadId: threadState.threadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "synthetic qualification item; persisted by the offline conformance harness; not a model request",
            },
          ],
        },
      ],
    });
    phase.inject = { ok: !injected.error, error: scalarError(injected.error) };
    if (injected.error) {
      recorder.fail("stdio.thread.synthetic-item", "thread/inject_items was rejected", {
        error: phase.inject.error,
      });
    } else {
      recorder.pass(
        "stdio.thread.synthetic-item",
        "synthetic item appended without a turn or model call",
      );
    }

    const read = await session.request("thread/read", {
      threadId: threadState.threadId,
      includeTurns: false,
    });
    phase.read = {
      ok: !read.error,
      threadIdMatches: read.result?.thread?.id === threadState.threadId,
      error: scalarError(read.error),
    };
    if (phase.read.threadIdMatches) {
      recorder.pass("stdio.thread.read", "thread/read returned the created thread");
    } else {
      recorder.fail("stdio.thread.read", "thread/read did not return the created thread", {
        error: phase.read.error,
      });
    }

    const list = await session.request("thread/list", { limit: 20 });
    const listed = Array.isArray(list.result?.data) ? list.result.data : [];
    phase.list = {
      ok: !list.error,
      count: listed.length,
      containsCreatedThread: listed.some((entry) => entry.id === threadState.threadId),
      qualification: "NOT_QUALIFIED",
      error: scalarError(list.error),
    };
    recorder.notQualified(
      "stdio.thread.list",
      "local thread/list is not qualified for the controller; unauthenticated isolated home",
      { count: phase.list.count, containsCreatedThread: phase.list.containsCreatedThread },
    );
    if (list.error) {
      recorder.fail("stdio.thread.list-call", "thread/list was rejected", {
        error: phase.list.error,
      });
    }

    const notifications = session.notifications;
    const turnMethods = notifications.filter(
      ({ method }) => method.startsWith("turn/") || method.startsWith("item/"),
    );
    phase.notifications = [...new Set(notifications.map(({ method }) => method))]
      .sort()
      .map((method) => ({
        method,
        count: notifications.filter((entry) => entry.method === method).length,
      }));
    if (turnMethods.length === 0 && !session.diagnostics.methodsSent.includes("turn/start")) {
      recorder.pass(
        "stdio.no-turn",
        "no turn, item or model activity occurred during the lifecycle check",
      );
    } else {
      recorder.fail(
        "stdio.no-turn",
        "unexpected turn or item activity during the lifecycle check",
        {
          count: turnMethods.length,
        },
      );
    }
    return phase;
  } catch (error) {
    recorder.fail(
      "stdio.phase-first-process",
      "first process failed before completing the lifecycle",
      {
        error: scalarError(error),
      },
    );
    phase.error = scalarError(error);
    threadState.stoppedAt = "stdout-first-process";
    return phase;
  } finally {
    if (session) {
      phase.close = await session.close();
      const diagnostics = session.diagnostics;
      phase.faults = summarizeFaults(diagnostics.faults);
      phase.methodsSent = [...diagnostics.methodsSent];
      phase.stderr = summarizeStderr(diagnostics.stderrText, {
        bytes: diagnostics.stderrBytes,
        truncated: diagnostics.stderrTruncated,
      });
      phase.frames = diagnostics.frames;
      phase.unexpectedServerRequests = diagnostics.unexpectedServerRequests;
      if (phase.close.graceful) {
        recorder.pass(
          "stdio.close-first-process",
          "closing stdin ended the owned app-server with exit code 0",
        );
      } else {
        recorder.fail(
          "stdio.close-first-process",
          "owned app-server did not exit cleanly after stdin close",
          {
            close: phase.close,
          },
        );
      }
      if (diagnostics.faults.length > 0) {
        recorder.fail("stdio.session-integrity", "transport fault during the first process", {
          faultCount: diagnostics.faults.length,
        });
      }
      if (diagnostics.stderrBytes > 0 && phase.stderr.categories.offlineConcern > 0) {
        recorder.fail("stdio.offline-activity", "stderr mentioned outbound connection activity", {
          categories: phase.stderr.categories,
        });
      }
    }
  }
}

async function runPhaseB({ exePath, env, workspace, expectations, recorder, threadState, limits }) {
  const phase = {
    name: "second-process",
    initialize: null,
    resume: null,
    read: null,
    delete: null,
    close: null,
    faults: [],
  };
  if (!threadState.threadId) {
    recorder.skip(
      "stdio.thread.resume",
      `no thread was created (${threadState.stoppedAt ?? "unknown stage"})`,
    );
    return phase;
  }
  let session;
  try {
    session = await AppServerSession.open({
      exePath,
      args: expectations.appServerArgs,
      cwd: workspace.project,
      env,
      limits,
    });
    phase.initialize = await initializeSession(session, workspace, expectations);
    if (!phase.initialize.ok) {
      recorder.fail(
        "stdio.resume-initialize",
        "second process did not prove the expected isolated peer",
        {
          error: phase.initialize.error ?? null,
        },
      );
      return phase;
    }

    const resume = await session.request("thread/resume", {
      threadId: threadState.threadId,
      excludeTurns: true,
    });
    phase.resume = {
      ok: !resume.error,
      threadIdMatches: resume.result?.thread?.id === threadState.threadId,
      turns: Array.isArray(resume.result?.thread?.turns) ? resume.result.thread.turns.length : null,
      error: scalarError(resume.error),
    };
    if (phase.resume.threadIdMatches) {
      recorder.pass("stdio.thread.resume", "a second owned process resumed the persisted thread");
    } else {
      recorder.fail("stdio.thread.resume", "thread/resume did not reattach the persisted thread", {
        error: phase.resume.error,
      });
    }

    const read = await session.request("thread/read", {
      threadId: threadState.threadId,
      includeTurns: false,
    });
    phase.read = {
      ok: !read.error,
      threadIdMatches: read.result?.thread?.id === threadState.threadId,
    };
    if (phase.read.threadIdMatches) {
      recorder.pass(
        "stdio.thread.read-after-resume",
        "thread/read still resolves the resumed thread",
      );
    } else {
      recorder.fail("stdio.thread.read-after-resume", "thread/read failed after resume", {
        error: scalarError(read.error),
      });
    }

    phase.rolloutFilesBeforeDelete = await countFiles(
      join(workspace.codexHome, "sessions"),
      ".jsonl",
    );
    const deleted = await session.request("thread/delete", { threadId: threadState.threadId });
    phase.delete = { ok: !deleted.error, error: scalarError(deleted.error) };
    if (phase.delete.ok) {
      recorder.pass("stdio.thread.delete", "thread/delete removed the disposable thread");
    } else {
      recorder.fail("stdio.thread.delete", "thread/delete rejected the disposable thread", {
        error: phase.delete.error,
      });
    }
    return phase;
  } catch (error) {
    recorder.fail(
      "stdio.phase-second-process",
      "second process failed before completing the lifecycle",
      {
        error: scalarError(error),
      },
    );
    phase.error = scalarError(error);
    return phase;
  } finally {
    if (session) {
      phase.close = await session.close();
      const diagnostics = session.diagnostics;
      phase.faults = summarizeFaults(diagnostics.faults);
      phase.methodsSent = [...diagnostics.methodsSent];
      phase.stderr = summarizeStderr(diagnostics.stderrText, {
        bytes: diagnostics.stderrBytes,
        truncated: diagnostics.stderrTruncated,
      });
      if (phase.close.graceful) {
        recorder.pass(
          "stdio.close-second-process",
          "second owned app-server exited cleanly after stdin close",
        );
      } else {
        recorder.fail(
          "stdio.close-second-process",
          "second owned app-server did not exit cleanly",
          {
            close: phase.close,
          },
        );
      }
      if (diagnostics.faults.length > 0) {
        recorder.fail(
          "stdio.session-integrity-second",
          "transport fault during the second process",
          {
            faultCount: diagnostics.faults.length,
          },
        );
      }
      if (diagnostics.stderrBytes > 0 && phase.stderr.categories.offlineConcern > 0) {
        recorder.fail(
          "stdio.offline-activity-second",
          "stderr mentioned outbound connection activity",
          {
            categories: phase.stderr.categories,
          },
        );
      }
    }
  }
}

function snapshotName(prefix = "schema-snapshot") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  return `${prefix}.${stamp}.sha256.json`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.selfTest) return runSelfTest(options);

  const expectations = await readJsonFile(join(here, "expectations.json"));
  let lock = null;
  let lockError = null;
  try {
    lock = await readJsonFile(join(repoRoot, "distribution", "composition-lock.json"));
  } catch {
    lockError = "composition lock missing or unreadable";
  }
  const expectedNode = lock?.toolchain?.node ? `v${lock.toolchain.node}` : null;
  const limits = {
    ...DEFAULT_LIMITS,
    requestTimeoutMs: expectations.limits.requestTimeoutMs,
    processTimeoutMs: expectations.limits.processTimeoutMs,
    exitTimeoutMs: expectations.limits.exitTimeoutMs,
    killGraceMs: expectations.limits.killGraceMs,
    frameLimitBytes: expectations.limits.frameLimitBytes,
    maxFrames: expectations.limits.maxFrames,
    maxNotifications: expectations.limits.maxNotifications,
    stderrByteLimit: expectations.limits.stderrByteLimit,
  };

  if (options.evidence) {
    try {
      await assertEvidenceTarget(options.evidence);
    } catch (error) {
      console.error(`[codex-conformance] ${error.message}`);
      return 1;
    }
  }
  if (options.snapshotOut && !options.writeSchemaSnapshot) {
    console.error("[codex-conformance] --snapshot-out requires --write-schema-snapshot");
    return 1;
  }
  let candidateTarget = null;
  if (options.writeSchemaSnapshot) {
    candidateTarget = options.snapshotOut
      ? resolve(options.snapshotOut)
      : join(here, snapshotName());
    const baselineResolved = resolve(join(here, expectations.baselineManifest));
    if (candidateTarget === baselineResolved) {
      console.error("[codex-conformance] refusing to overwrite the tracked schema baseline");
      return 1;
    }
    if (await pathExists(candidateTarget)) {
      console.error(
        "[codex-conformance] candidate manifest already exists; choose a new --snapshot-out path",
      );
      return 1;
    }
  }

  const recorder = createRecorder();
  const gates = [];
  const startedAt = new Date();
  const report = {
    schemaVersion: 2,
    suite: expectations.suite,
    target: expectations.target,
    status: "BLOCKED",
    labels: LABELS,
    scope: expectations.scope,
    generatedAt: startedAt.toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      nodeExpected: expectedNode,
      nodePinned: expectedNode ? process.version === expectedNode : null,
    },
    expected: {
      cliVersion: expectations.expectedCliVersion,
      platformTarget: expectations.platformTargets[`${process.platform}-${process.arch}`] ?? null,
      binarySha256: null,
      sandbox: expectations.requiredSandbox,
      approvalPolicy: expectations.requiredApprovalPolicy,
    },
    identity: null,
    version: null,
    schema: null,
    gates,
    stdio: null,
    isolation: null,
    happier: null,
    qualification: {
      native: "NOT_RUN",
      adapterComparison: "NOT_RUN",
      threadList: "NOT_QUALIFIED",
    },
    stoppedAt: null,
    checks: recorder.checks,
    observations: recorder.observations,
    mismatches: recorder.mismatches,
  };
  if (report.environment.nodePinned === false) {
    recorder.observe(
      "This run used a Node version other than the pinned composition toolchain; the receipt records the deviation.",
      { used: process.version, expected: report.environment.nodeExpected },
    );
  }

  const workspace = await createWorkspace(options.tempRoot);
  const environment = isolatedEnv(workspace.codexHome, workspace);
  report.isolation = {
    codexHome: redactString(workspace.codexHome, [
      { root: workspace.root, placeholder: "%CONFORMANCE_TMP%" },
    ]),
    project: redactString(workspace.project, [
      { root: workspace.root, placeholder: "%CONFORMANCE_TMP%" },
    ]),
    childEnvironment: {
      allowlist: environment.allowlist,
      isolatedVariables: [...ISOLATED_ENV_NAMES],
      excludedAmbientCount: environment.excludedAmbientCount,
      rejectedPathEntryCount: environment.rejectedPathEntries.length,
    },
    containment: CONTAINMENT_NOTE,
  };

  try {
    if (lockError) {
      gates.push({ gate: "composition-lock", outcome: "stopped", stage: "lock" });
      recorder.blocked("lock.composition", lockError);
      report.stoppedAt = "composition-lock";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    const resolution = await resolveCodexBinary({
      explicitPath: options.codex,
      env: process.env,
      platform: process.platform,
      arch: process.arch,
    });
    const pinnedDigest = expectations.pinnedBinaryDigests?.[resolution.targetTriple ?? ""] ?? null;
    const expectedDigest = options.expectedSha256 ?? pinnedDigest;
    report.expected.binarySha256 = expectedDigest ? expectedDigest.toLowerCase() : null;
    report.identity = {
      status: resolution.status,
      resolution: resolution.resolution,
      shimPath: resolution.shimPath ? redactString(resolution.shimPath) : null,
      nativePath: resolution.nativePath ? redactString(resolution.nativePath) : null,
      packageVersion: resolution.packageVersion,
      targetTriple: resolution.targetTriple,
      rejectedPathEntries: resolution.rejectedPathEntries ?? 0,
      containment: resolution.containment ?? null,
      digestSource: options.expectedSha256
        ? "owner-supplied"
        : pinnedDigest
          ? "platform-pinned"
          : "missing",
      reason: resolution.reason,
    };
    if (resolution.status !== "resolved") {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "resolution" });
      recorder.blocked("identity.resolve", resolution.reason ?? "native binary not resolved");
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    if (!resolution.containment) {
      recorder.observe(
        "Launcher resolved to a native binary directly; vendor metadata containment was not applicable.",
      );
    } else if (
      !resolution.containment.metadataInsideTarget ||
      !resolution.containment.entrypointInsideTarget ||
      !resolution.containment.entrypointIsFile ||
      resolution.containment.metadataIsReparsePoint ||
      resolution.containment.entrypointIsReparsePoint
    ) {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "containment" });
      recorder.fail(
        "identity.containment",
        "vendor metadata entrypoint failed containment or reparse checks",
        {
          containment: resolution.containment,
        },
      );
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    } else {
      recorder.pass(
        "identity.containment",
        "vendor metadata and entrypoint stay inside the target with no reparse points",
        { reparseChecks: resolution.containment.reparseChecks },
      );
    }

    if (!expectedDigest) {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "digest-source" });
      recorder.blocked(
        "identity.expected-digest",
        "no pinned digest for this platform target; pass --expected-sha256",
      );
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }

    const identity = await verifyBinaryIdentity(resolution.nativePath, expectedDigest);
    report.identity = {
      ...report.identity,
      sha256: identity.sha256,
      bytes: identity.bytes,
      magic: identity.magic,
      expectedSha256: identity.expectedSha256,
      expectedDigestWellFormed: identity.expectedDigestWellFormed,
      matchesExpected: identity.matchesExpected,
      checkedBeforeLaunch: true,
    };
    if (!identity.expectedDigestWellFormed) {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "digest-format" });
      recorder.fail("identity.expected-digest", "the expected digest is not a SHA-256 hex value");
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    if (!identity.matchesExpected) {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "digest-mismatch" });
      recorder.fail("identity.digest", "resolved binary does not match the expected SHA-256", {
        expected: identity.expectedSha256,
        actual: identity.sha256,
      });
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    if (identity.magic === "unknown") {
      gates.push({ gate: "binary-identity", outcome: "stopped", stage: "magic" });
      recorder.fail(
        "identity.native-magic",
        "resolved binary is not a recognised native executable",
      );
      report.stoppedAt = "binary-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    gates.push({ gate: "binary-identity", outcome: "pass", stage: "before-launch" });
    recorder.pass(
      "identity.digest",
      `sha256 ${identity.sha256} matched (${report.identity.digestSource})`,
      {
        bytes: identity.bytes,
        magic: identity.magic,
      },
    );

    const version = await runProcessBounded(resolution.nativePath, ["--version"], {
      env: isolatedEnv(workspace.schemaHome, workspace).env,
      timeoutMs: expectations.limits.versionTimeoutMs,
      maxStdoutBytes: expectations.limits.versionOutputBytes,
      maxStderrBytes: expectations.limits.versionOutputBytes,
    });
    const label = versionLabel(version.stdoutText);
    report.version = {
      reported: label,
      matches: label === expectations.expectedCliVersion,
      exitCode: version.code,
      timedOut: version.timedOut,
      durationMs: version.durationMs ?? null,
      stdout: version.stdout,
      stderr: version.stderr,
    };
    if (!version.ok || label !== expectations.expectedCliVersion) {
      gates.push({ gate: "version-identity", outcome: "stopped", stage: "version" });
      recorder.fail(
        "version.identity",
        `expected ${expectations.expectedCliVersion}; observed ${label ?? "unrecognised output"}`,
        { exitCode: version.code, timedOut: version.timedOut },
      );
      report.stoppedAt = "version-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    gates.push({ gate: "version-identity", outcome: "pass", stage: "version" });
    recorder.pass("version.identity", `reported ${label}`);

    const baselinePath = join(here, expectations.baselineManifest);
    const baselineExists = await pathExists(baselinePath);
    const generated = await generateStableSchema({
      exePath: resolution.nativePath,
      outDir: workspace.schemaOut,
      env: isolatedEnv(workspace.schemaHome, workspace).env,
      timeoutMs: expectations.limits.schemaTimeoutMs,
      maxStdoutBytes: expectations.limits.schemaOutputBytes,
      maxStderrBytes: expectations.limits.schemaOutputBytes,
    });
    if (!generated.ok) {
      gates.push({ gate: "schema-identity", outcome: "stopped", stage: "generate" });
      recorder.blocked("schema.generate", "stable schema generation failed", {
        exitCode: generated.exitCode ?? null,
        timedOut: generated.timedOut ?? false,
        stderr: generated.stderr,
      });
      report.stoppedAt = "schema-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    const actualManifest = await buildSchemaManifest(workspace.schemaOut);
    const actualHash = hashManifest(actualManifest.files);
    report.schema = {
      generation: {
        args: ["app-server", "generate-json-schema", "--out", "<owned temp dir>"],
        experimentalIncluded: false,
        durationMs: generated.durationMs,
        fileCount: actualManifest.fileCount,
        totalBytes: actualManifest.totalBytes,
        manifestSha256: actualHash,
        aggregateHashes: Object.fromEntries(
          [SCHEMA_BUNDLE, SCHEMA_V2_BUNDLE].map((bundle) => [
            bundle,
            actualManifest.files[bundle]?.sha256 ?? null,
          ]),
        ),
        stdout: generated.stdout,
        stderr: generated.stderr,
      },
      baseline: {
        path: expectations.baselineManifest,
        present: baselineExists,
        expectedManifestSha256: null,
        compared: false,
        identical: null,
        missing: [],
        extra: [],
        changed: [],
      },
      capturedBundle: null,
      candidate: null,
      contract: null,
    };
    recorder.pass("schema.generate", `stable schema generated in ${generated.durationMs}ms`, {
      durationMs: generated.durationMs,
    });

    if (options.writeSchemaSnapshot) {
      const document = {
        schemaVersion: 1,
        generatedBy: "node qualification/codex/run-codex-conformance.mjs --write-schema-snapshot",
        cliVersion: label,
        platformTarget: report.identity.targetTriple,
        experimentalIncluded: false,
        fileCount: actualManifest.fileCount,
        totalBytes: actualManifest.totalBytes,
        manifestSha256: actualHash,
        files: actualManifest.files,
      };
      await writeFile(candidateTarget, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      report.schema.candidate = {
        path: redactString(candidateTarget),
        fileCount: actualManifest.fileCount,
        manifestSha256: actualHash,
      };
      recorder.pass(
        "schema.candidate-written",
        "wrote a new candidate manifest; the tracked baseline was not modified",
        { fileCount: actualManifest.fileCount },
      );
    }

    if (!baselineExists) {
      gates.push({ gate: "schema-identity", outcome: "stopped", stage: "baseline-missing" });
      recorder.blocked(
        "schema.baseline",
        "the pinned schema baseline is missing; a run cannot pass without comparison",
      );
      report.stoppedAt = "schema-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }

    const baseline = await readJsonFile(baselinePath);
    const comparison = compareManifests(baseline.files, actualManifest.files);
    report.schema.baseline = {
      ...report.schema.baseline,
      expectedManifestSha256: baseline.manifestSha256 ?? hashManifest(baseline.files),
      compared: true,
      identical: comparison.identical,
      missing: comparison.missing,
      extra: comparison.extra,
      changed: comparison.changed,
    };

    if (!comparison.identical) {
      gates.push({ gate: "schema-identity", outcome: "stopped", stage: "baseline-drift" });
      recorder.fail(
        "schema.baseline-identity",
        `stable schema drifted: ${comparison.missing.length} missing, ${comparison.extra.length} extra, ${comparison.changed.length} changed`,
      );
      report.stoppedAt = "schema-identity";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    gates.push({ gate: "schema-identity", outcome: "pass", stage: "baseline" });
    recorder.pass(
      "schema.baseline-identity",
      `${actualManifest.fileCount} stable schema files match the pinned baseline`,
    );

    if (options.schemaSnapshot) {
      const capturedManifest = await buildSchemaManifest(resolve(options.schemaSnapshot));
      const capturedComparison = compareManifests(capturedManifest.files, actualManifest.files);
      report.schema.capturedBundle = {
        directory: redactString(resolve(options.schemaSnapshot)),
        fileCount: capturedManifest.fileCount,
        manifestSha256: hashManifest(capturedManifest.files),
        identical: capturedComparison.identical,
        missing: capturedComparison.missing,
        extra: capturedComparison.extra,
        changed: capturedComparison.changed,
      };
      if (!capturedComparison.identical) {
        gates.push({ gate: "schema-identity", outcome: "stopped", stage: "captured-drift" });
        recorder.fail("schema.captured-bytes", "generated schema differs from the captured bundle");
        report.stoppedAt = "schema-identity";
        return finalize(report, recorder, options, workspace, startedAt);
      }
      recorder.pass(
        "schema.captured-bytes",
        `byte-identical to the captured bundle (${capturedManifest.fileCount} files)`,
      );
    }

    const contract = await verifyStableContract({ schemaDir: workspace.schemaOut, expectations });
    report.schema.contract = contract.checks;
    let contractFailed = false;
    for (const check of contract.checks) {
      if (check.ok) {
        recorder.pass(check.id, check.detail, { observed: check.observed });
      } else {
        contractFailed = true;
        recorder.fail(check.id, check.detail, { missing: check.missing, observed: check.observed });
      }
    }
    const experimentalMarker = contract.checks.find((check) => check.experimentalMarker);
    if (experimentalMarker) {
      recorder.observe(
        "The stable bundle ships the user-input response schema with an EXPERIMENTAL description; presence is proven, stability labelling is not.",
      );
    }
    if (contractFailed) {
      gates.push({ gate: "schema-contract", outcome: "stopped", stage: "contract" });
      report.stoppedAt = "schema-contract";
      return finalize(report, recorder, options, workspace, startedAt);
    }
    gates.push({ gate: "schema-contract", outcome: "pass", stage: "contract" });

    const threadState = { threadId: null, stoppedAt: null };
    const phaseA = await runPhaseA({
      exePath: resolution.nativePath,
      env: environment.env,
      workspace,
      expectations,
      recorder,
      threadState,
      limits,
    });
    const phaseB = await runPhaseB({
      exePath: resolution.nativePath,
      env: environment.env,
      workspace,
      expectations,
      recorder,
      threadState,
      limits,
    });
    report.stdio = { phaseA, phaseB };
    const sentMethods = [
      ...new Set([...(phaseA.methodsSent ?? []), ...(phaseB.methodsSent ?? [])]),
    ].sort();
    const allowedMethods = new Set([
      ...expectations.requiredClientMethods,
      ...expectations.requiredClientNotifications,
    ]);
    const unexpectedMethods = sentMethods.filter((method) => !allowedMethods.has(method));
    report.stdio.sentMethods = sentMethods;
    if (unexpectedMethods.length === 0) {
      recorder.pass(
        "stdio.method-contract",
        `all ${sentMethods.length} sent methods belong to the required native contract`,
        { methods: sentMethods },
      );
    } else {
      recorder.fail(
        "stdio.method-contract",
        "a sent method is outside the required native contract",
        {
          unexpectedMethods,
        },
      );
    }
    report.qualification.threadList = phaseA.list?.qualification ?? "NOT_QUALIFIED";

    const homeSnapshot = {
      entries: (await readdir(workspace.codexHome)).sort(),
      forbiddenFiles: {},
      forbiddenDirectories: {},
      credentialFilesPresent: [],
      pluginMarketplacePresent: false,
      rolloutFileCount: 0,
    };
    for (const file of expectations.isolation.forbiddenHomeFiles) {
      const present = await pathExists(join(workspace.codexHome, file));
      homeSnapshot.forbiddenFiles[file] = present;
      if (present) homeSnapshot.credentialFilesPresent.push(file);
    }
    for (const directory of expectations.isolation.forbiddenHomeDirectories) {
      const present = await pathExists(join(workspace.codexHome, directory));
      homeSnapshot.forbiddenDirectories[directory] = present;
      if (directory.endsWith("plugins")) homeSnapshot.pluginMarketplacePresent = present;
    }
    homeSnapshot.rolloutFileCount = await countFiles(
      join(workspace.codexHome, "sessions"),
      ".jsonl",
    );
    report.isolation.home = homeSnapshot;
    if (homeSnapshot.credentialFilesPresent.length === 0) {
      recorder.pass(
        "isolation.no-credentials",
        "no auth.json or config.toml was created in the isolated home",
      );
    } else {
      recorder.fail(
        "isolation.no-credentials",
        `unexpected credential files: ${homeSnapshot.credentialFilesPresent.join(", ")}`,
      );
    }
    if (!homeSnapshot.pluginMarketplacePresent) {
      recorder.pass(
        "isolation.no-marketplace",
        "no plugin marketplace clone under the isolated home",
      );
    } else {
      recorder.fail(
        "isolation.no-marketplace",
        "the plugin marketplace was cloned despite disabled plugin features",
      );
    }
    const isolatedValues = ISOLATED_ENV_NAMES.map((name) => environment.env[name]);
    if (isolatedValues.every((value) => value && isPathInside(workspace.root, value))) {
      recorder.pass(
        "isolation.env",
        "HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP and CODEX_HOME point at owned directories",
      );
    } else {
      recorder.fail(
        "isolation.env",
        "an isolated environment variable points outside the owned workspace",
      );
    }

    const schemaMethodSet = new Set([
      ...contract.methods.clientMethods,
      ...contract.methods.clientNotifications,
      ...contract.methods.serverRequests,
      ...contract.methods.serverNotifications,
    ]);
    report.happier = await inspectHappierSource({
      directory: options.happierSource,
      lock,
      schemaMethodSet,
      limits: expectations.limits,
    });
    if (!report.happier.requested) {
      recorder.skip("happier.method-literals", "adapter comparison NOT_RUN (no --happier-source)");
    } else if (report.happier.status !== "checked") {
      recorder.blocked(
        "happier.method-literals",
        report.happier.reason ?? "Happier comparison could not be completed",
      );
    } else {
      if (!report.happier.commitMatchesLock || !report.happier.treeMatchesLock) {
        recorder.fail(
          "happier.pinned-source",
          "Happier checkout does not match the pinned commit and tree",
          {
            commitMatchesLock: report.happier.commitMatchesLock,
            treeMatchesLock: report.happier.treeMatchesLock,
          },
        );
      }
      const productionGaps = report.happier.absentFromStableSchema.filter(
        (entry) => !entry.testOnly,
      );
      const testOnlyGaps = report.happier.absentFromStableSchema.filter((entry) => entry.testOnly);
      if (productionGaps.length > 0) {
        recorder.fail("happier.method-literals", "methods absent from the stable schema", {
          productionGapCount: productionGaps.length,
        });
      } else if (report.happier.commitMatchesLock && report.happier.treeMatchesLock) {
        recorder.pass(
          "happier.method-literals",
          `pinned commit and tree verified; ${report.happier.scannedMethods} literal methods all present`,
        );
      }
      if (testOnlyGaps.length > 0) {
        recorder.observe(
          "Happier test doubles and harness fixtures reference method names that the 0.171.0 stable schema does not define. They are not production client calls and are recorded as a fixture-drift observation.",
          {
            methods: testOnlyGaps.map((entry) => ({
              method: entry.method,
              occurrences: entry.occurrences,
              testOccurrences: entry.testOccurrences,
            })),
          },
        );
      }
    }

    return finalize(report, recorder, options, workspace, startedAt);
  } catch (error) {
    recorder.fail("harness.error", "the harness stopped on an unexpected error", {
      error: scalarError(error),
    });
    report.stoppedAt = report.stoppedAt ?? "harness-error";
    return finalize(report, recorder, options, workspace, startedAt);
  } finally {
    if (!options.keepTemp) {
      try {
        const owned = assertOwnedTempDirectory(workspace.root, options.tempRoot);
        await rm(owned, { recursive: true, force: true });
      } catch (error) {
        console.error(`[codex-conformance] temp cleanup refused: ${error.message}`);
      }
    }
  }
}

async function countFiles(root, suffix) {
  let count = 0;
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith(suffix)) count += 1;
    }
  }
  await walk(root);
  return count;
}

async function finalize(report, recorder, options, workspace, startedAt) {
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
    notQualified: statuses.filter((status) => status === "not-qualified").length,
  };
  const nativeChecks = recorder.checks.filter(
    (check) => !check.id.startsWith("happier.") && check.id !== "stdio.thread.list",
  );
  const nativeBlocked = nativeChecks.some((check) => check.status === "blocked");
  const nativeFailed = nativeChecks.some((check) => check.status === "fail");
  report.qualification = {
    native: nativeBlocked ? "BLOCKED" : nativeFailed ? "FAIL" : "PASS",
    adapterComparison: report.happier ? report.happier.adapterComparison : "NOT_RUN",
    threadList: report.stdio?.phaseA?.list?.qualification ?? "NOT_QUALIFIED",
  };
  report.evidenceLabel = "native/offline only; not integrated; not physical";
  report.harness = { files: [] };
  for (const relativePath of [
    "run-codex-conformance.mjs",
    "expectations.json",
    "schema-snapshot.sha256.json",
    "lib/app-server-client.mjs",
    "lib/bounds.mjs",
    "lib/harness-policy.mjs",
    "lib/native-identity.mjs",
    "lib/paths.mjs",
    "lib/redact.mjs",
    "lib/schema-check.mjs",
  ]) {
    const path = join(here, relativePath);
    if (await pathExists(path)) {
      report.harness.files.push({ path: relativePath, sha256: await sha256File(path) });
    }
  }

  const redacted = redactValue(report, [
    { root: workspace.root, placeholder: "%CONFORMANCE_TMP%" },
  ]);
  if (options.evidence) {
    redacted.evidencePath = redactString(resolve(options.evidence));
  }
  const body = `${JSON.stringify(redacted, null, 2)}\n`;
  const finalDocument = `${JSON.stringify(
    { ...redacted, evidenceContentSha256: createHash("sha256").update(body).digest("hex") },
    null,
    2,
  )}\n`;
  if (options.evidence) {
    await writeFile(resolve(options.evidence), finalDocument, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  if (options.json) {
    console.log(finalDocument);
  } else {
    printSummary(redacted, options, workspace);
  }
  return redacted.status === "PASS" ? 0 : 1;
}

function printSummary(report, options, workspace) {
  const lines = [];
  lines.push(`${report.suite} — ${report.status}`);
  lines.push(`label: ${report.evidenceLabel}`);
  lines.push(
    `qualification: native=${report.qualification.native} adapter=${report.qualification.adapterComparison} thread-list=${report.qualification.threadList}`,
  );
  if (report.identity?.nativePath) {
    lines.push(`binary: ${report.identity.nativePath}`);
    lines.push(
      `  ${report.version?.reported ?? "unknown"} · ${report.identity.bytes ?? "?"} bytes · sha256 ${report.identity.sha256 ?? "unverified"}`,
    );
  }
  if (report.schema?.generation) {
    lines.push(
      `schema: ${report.schema.generation.fileCount} stable files · manifest ${report.schema.generation.manifestSha256.slice(0, 16)}… · baseline ${
        report.schema.baseline?.compared
          ? report.schema.baseline.identical
            ? "identical"
            : "DRIFTED"
          : "not compared"
      }`,
    );
  }
  for (const check of report.checks) {
    const marker =
      check.status === "pass"
        ? "ok  "
        : check.status === "fail"
          ? "FAIL"
          : check.status === "blocked"
            ? "BLOC"
            : check.status === "not-qualified"
              ? "NQ  "
              : "note";
    lines.push(`  [${marker}] ${check.id}: ${check.detail}`);
  }
  for (const observation of report.observations) {
    lines.push(`  [obs ] ${observation.note}`);
  }
  if (report.happier) {
    lines.push(
      `happier: ${report.happier.status}${report.happier.reason ? ` (${report.happier.reason})` : ""}`,
    );
  }
  if (report.stoppedAt) lines.push(`stopped at: ${report.stoppedAt}`);
  if (options.keepTemp) lines.push(`workspace: ${workspace.root}`);
  lines.push(
    `summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} noted, ${report.summary.blocked} blocked, ${report.summary.notQualified} not-qualified`,
  );
  if (options.evidence) lines.push(`evidence: ${report.evidencePath ?? resolve(options.evidence)}`);
  console.log(lines.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[codex-conformance] ${error.stack ?? error.message}`);
      process.exitCode = 1;
    });
}
