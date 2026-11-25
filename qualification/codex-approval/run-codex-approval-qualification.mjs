#!/usr/bin/env node

/**
 * Offline, source-bound qualification of the restricted-profile approval
 * hardening for the pinned Happier Codex app-server route.
 *
 * Labels: offline, source-bound, not-integrated, not-physical.
 *
 * It binds the pinned Happier commit/tree and the existing five-patch candidate
 * tree, applies the additive 0008 patch to an extracted fragment, verifies the
 * resulting blobs, executes the new production approvalDecisionPolicy module
 * with synthetic decisions, and records static source facts for the route.
 *
 * It never starts a prompt, model, provider, auth, database, relay, listener,
 * installed app or live Happier process. Full-runtime and physical are NOT_RUN.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  archiveTo,
  blobHashAt,
  createScratchRepository,
  git,
  gitBlobHash,
  gitOrThrow,
  objectType,
  readBlob,
  sha256Bytes,
} from "../codex-adapter/lib/git.mjs";
import { redactString, redactValue } from "../codex-adapter/lib/redact.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LABELS = ["offline", "source-bound", "not-integrated", "not-physical"];

function usage() {
  return [
    "Usage: node qualification/codex-approval/run-codex-approval-qualification.mjs [options]",
    "",
    "Required:",
    "  --happier-git-dir <dir>        Pinned Happier .git object directory (read-only)",
    "  --happier-patch-objects <dir>  Object store containing the five-patch candidate tree",
    "  --git <absolute Windows file>  Owner-trusted Git executable (recorded and rechecked)",
    "  --tar <absolute Windows file>  Owner-trusted tar executable (recorded and rechecked)",
    "",
    "Optional:",
    "  --patch <file>                 Maintained patch (default: patches/happier/0008-restrict-codex-approval-occurrences.patch)",
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
    git: null,
    tar: null,
    patch: join(repoRoot, "patches", "happier", "0008-restrict-codex-approval-occurrences.patch"),
    evidence: null,
    tempRoot: process.env.RAC_CODEX_APPROVAL_TEMP_ROOT ?? tmpdir(),
    keepTemp: false,
    json: false,
    help: false,
  };
  const takesValue = {
    "--happier-git-dir": "happierGitDir",
    "--happier-patch-objects": "happierPatchObjects",
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
  if (!basename(resolvedRoot).startsWith("rac-codex-approval-")) {
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
  if (!isAbsoluteToolPath(path))
    return { label, ok: false, reason: "must be an absolute Windows path" };
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
  const toolGitConfig = join(workspaceRoot, "gitconfig-isolated");
  // Pin the archive/apply line-ending behaviour explicitly. Without this, the
  // isolated (ambient-free) configuration makes `git archive` emit CRLF on
  // Windows, so the extracted text would not match the pinned blob bytes.
  await writeFile(toolGitConfig, "[core]\n\tautocrlf = input\n", "utf8");
  const env = {
    TEMP: temp,
    TMP: temp,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: toolGitConfig,
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

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findSnippet(source, snippet) {
  const index = source.indexOf(snippet);
  return index < 0 ? null : { index, line: lineOf(source, index) };
}

function balancedBlock(source, from) {
  const brace = source.indexOf("{", from);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace, index + 1);
    }
  }
  return null;
}

function findAllSnippets(source, snippet) {
  const matches = [];
  let index = source.indexOf(snippet);
  while (index >= 0) {
    matches.push({ index, line: lineOf(source, index) });
    index = source.indexOf(snippet, index + snippet.length);
  }
  return matches;
}

function analyzeRouteFacts({
  runCodexSource,
  codexHandlerSource,
  codexLikeSource,
  runtimeSource,
  coordinatorSource,
  baseSource,
  historySource,
  clientSource,
}) {
  const factory = findSnippet(runCodexSource, "permissionHandler = createCodexPermissionHandler({");
  const runtimeCreation = findSnippet(
    runCodexSource,
    "codexAppServerRuntime = createCodexAppServerRuntime({",
  );
  const runtimeCreationBlock = runtimeCreation
    ? balancedBlock(runCodexSource, runtimeCreation.index)
    : null;
  const handlerClass = findSnippet(
    codexHandlerSource,
    "class CodexPermissionHandler extends CodexLikePermissionHandler",
  );
  const restrictedFlag = findSnippet(
    codexHandlerSource,
    "requireExplicitOwnerDecision: isRestrictedDeploymentConfigured()",
  );
  const autoApproveGuard = findSnippet(
    codexLikeSource,
    "if (this.requireExplicitOwnerDecision) return false;",
  );
  const sessionAllowlistOverride = findSnippet(
    codexLikeSource,
    "protected override isAllowedForSession(toolName: string, input: unknown): boolean {",
  );
  const cacheFlagPassed = findSnippet(
    codexLikeSource,
    "allowCachedDecisions: params.requireExplicitOwnerDecision !== true",
  );
  const baseCacheFlag = findSnippet(
    baseSource,
    "allowCachedDecisions: opts?.allowCachedDecisions !== false",
  );
  const coordinatorCacheRead = findSnippet(coordinatorSource, "this.allowCachedDecisions");
  const coordinatorCacheWrite = findSnippet(coordinatorSource, "if (this.allowCachedDecisions) {");
  const runtimeRestrictedFlag = findSnippet(
    runtimeSource,
    "const requireExplicitOwnerDecision = isRestrictedDeploymentConfigured();",
  );
  const approvalGuard = findSnippet(
    runtimeSource,
    "restrictedApprovalDecision(requireExplicitOwnerDecision, result.decision)",
  );
  const permissionsGuard = findSnippet(
    runtimeSource,
    "restrictedPermissionsDecision(requireExplicitOwnerDecision)",
  );
  const elicitationGuard = findSnippet(
    runtimeSource,
    "restrictedElicitationAction(requireExplicitOwnerDecision, result.decision)",
  );
  const userInputPrepareGuard = findSnippet(runtimeSource, "isRestrictedApprovalShapedUserInput({");
  const userInputThrows = findAllSnippets(
    runtimeSource,
    "throw createRestrictedApprovalShapedUserInputError();",
  );
  const answersBuild = findSnippet(
    runtimeSource,
    "const answers = buildCodexRequestUserInputAnswers({",
  );
  const requestMatchesActiveTurn = findSnippet(
    runtimeSource,
    "const requestMatchesActiveTurn = options?.allowProviderEffects === false",
  );
  const stockAcceptSession = findSnippet(
    runtimeSource,
    "case 'approved_for_session':\n                return { decision: 'acceptForSession' };",
  );
  const stockAmendment = findSnippet(runtimeSource, "acceptWithExecpolicyAmendment");
  const stockPermissions = findSnippet(runtimeSource, "permissions: update.permissions,");
  const stockElicitationSwitch = findSnippet(
    runtimeSource,
    "const action: CodexAppServerMcpElicitationAction = (() => {",
  );
  const stockUserInput = findSnippet(runtimeSource, "const choice = (() => {");
  const unpatchedAutoApprove = findSnippet(codexLikeSource, "case 'yolo':");
  const unpatchedAllowlist = findSnippet(codexLikeSource, "Auto-approving (allowed for session)");
  const handlerUsesPolicyHelper = findSnippet(
    codexLikeSource,
    "restrictPermissionResultForExplicitOwner({",
  );
  const completedGuard = findSnippet(codexLikeSource, "hasCompletedPermissionRequest(toolCallId)");
  const occurrenceCatch = findSnippet(
    codexLikeSource,
    "error instanceof RestrictedApprovalOccurrenceError",
  );
  const restrictedRequestHelper = findSnippet(
    codexLikeSource,
    "requestPermissionDecisionForRestrictedProfile(",
  );
  const seenClaimsCreated = findSnippet(
    coordinatorSource,
    "createBoundedSeenOccurrenceClaims(RESTRICTED_APPROVAL_OCCURRENCE_LIMIT)",
  );
  const seenClaimCall = findSnippet(
    coordinatorSource,
    "this.seenOccurrenceClaims.claim(request.requestId)",
  );
  const publishCall = findSnippet(coordinatorSource, "this.store.publishRequest({");
  const noCompletedReplacement = !coordinatorSource.includes(
    "invalidatedDecision || !!cached || !this.allowCachedDecisions",
  );
  const occurrenceErrorThrown = findSnippet(
    coordinatorSource,
    "new RestrictedApprovalOccurrenceError(",
  );
  const runBridgeWorkBlock = (() => {
    const index = runtimeSource.indexOf("const runBridgeWork = async <T>(");
    return index < 0 ? null : balancedBlock(runtimeSource, index);
  })();
  const handleServerRequestBlock = (() => {
    const index = runtimeSource.indexOf("const handleServerRequest = async (");
    if (index < 0) return null;
    const arrow = runtimeSource.indexOf("=> {", index);
    return arrow < 0 ? null : balancedBlock(runtimeSource, arrow + 3);
  })();
  const historyOnRequestBlock = (() => {
    const index = historySource.indexOf("async onRequest<T>(");
    return index < 0 ? null : balancedBlock(historySource, index);
  })();
  const clientHandlerStart = clientSource.indexOf(
    "const result = await handler(message.params, message)",
  );
  const clientHandlerCatchBlock =
    clientHandlerStart < 0
      ? null
      : clientSource.slice(
          clientHandlerStart,
          clientSource.indexOf("const reportExit =", clientHandlerStart),
        );
  const restrictedBuildGuard = findSnippet(
    runtimeSource,
    "requireExplicitOwnerDecision && options?.allowDecisionFallback === true",
  );
  const updatesLoop = findSnippet(runtimeSource, "for (const update of updates)");
  const prepareHandlerCall = findSnippet(runtimeSource, "handleToolCall(update.callId");
  const firstUserInputThrow = userInputThrows[0] ?? null;
  const stockApprovalChoiceResolver = findSnippet(runtimeSource, "resolveApprovalChoiceLabel(");
  const orderByPath = {
    buildGuardConditionBeforeThrow: Boolean(
      restrictedBuildGuard &&
        firstUserInputThrow &&
        restrictedBuildGuard.index < firstUserInputThrow.index,
    ),
    buildGuardBeforeAnswers: Boolean(
      firstUserInputThrow && answersBuild && firstUserInputThrow.index < answersBuild.index,
    ),
    prepareGuardBeforeLoop: Boolean(
      userInputPrepareGuard && updatesLoop && userInputPrepareGuard.index < updatesLoop.index,
    ),
    prepareGuardBeforeHandler: Boolean(
      userInputPrepareGuard &&
        prepareHandlerCall &&
        userInputPrepareGuard.index < prepareHandlerCall.index,
    ),
    stockResolverAfterRestrictedGuard: Boolean(
      firstUserInputThrow &&
        stockUserInput &&
        stockUserInput.index > firstUserInputThrow.index &&
        stockApprovalChoiceResolver &&
        stockApprovalChoiceResolver.index > firstUserInputThrow.index,
    ),
  };

  return {
    factory,
    runtimeCreation: {
      ...runtimeCreation,
      passesPermissionHandler: Boolean(runtimeCreationBlock?.includes("permissionHandler,")),
    },
    handlerClass,
    restrictedFlag,
    autoApproveGuard,
    sessionAllowlistOverride,
    cacheFlagPassed,
    baseCacheFlag,
    coordinatorCacheRead,
    coordinatorCacheWrite,
    coordinatorCacheReadGated: coordinatorSource.includes("? this.cachedDecisions.get"),
    coordinatorRepublishesRemoved: noCompletedReplacement,
    coordinatorFactoryFlag: coordinatorSource.includes("allowCachedDecisions?: boolean"),
    seenClaimsCreated,
    seenClaimCall,
    publishCall,
    occurrenceErrorThrown,
    handlerUsesPolicyHelper,
    completedGuard,
    occurrenceCatch,
    restrictedRequestHelper,
    runtimeImportsPolicy: runtimeSource.includes("@/agent/permissions/approvalDecisionPolicy"),
    codexHandlerImportsPolicy: codexHandlerSource.includes(
      "@/security/restrictedDeployment/policy",
    ),
    runtimeRestrictedFlag,
    approvalGuard,
    permissionsGuard,
    elicitationGuard,
    userInputPrepareGuard,
    userInputThrows,
    answersBuild,
    requestMatchesActiveTurn,
    restrictedBuildGuard,
    orderByPath,
    stockAcceptSession,
    stockAmendment,
    stockPermissions,
    stockElicitationSwitch,
    stockUserInput,
    unpatchedAutoApprove,
    unpatchedAllowlist,
    providerEnforcedInRoute:
      runCodexSource.includes("ProviderEnforcedPermissionHandler") ||
      codexHandlerSource.includes("ProviderEnforcedPermissionHandler"),
    providerFencing: {
      ensureActiveTurn: findSnippet(
        runtimeSource,
        "const ensureActiveTurnForProviderRequest = async",
      ),
      matchesPendingTurn: findSnippet(runtimeSource, "const notificationMatchesPendingTurn = ("),
      terminatedGuard: findSnippet(
        runtimeSource,
        "hasProviderTurnAlreadyTerminated(requestParams, requestTurnId)",
      ),
      resolvedHandler: findSnippet(
        runtimeSource,
        "client.registerNotificationHandler('serverRequest/resolved'",
      ),
      cancelsPending: findSnippet(runtimeSource, "'Resolved in another Codex client'"),
    },
    errorSurfacing: {
      runBridgeWorkFound: Boolean(runBridgeWorkBlock),
      runBridgeWorkHasCatch: Boolean(runBridgeWorkBlock && /\bcatch\b/.test(runBridgeWorkBlock)),
      handleServerRequestFound: Boolean(handleServerRequestBlock),
      handleServerRequestHasCatch: Boolean(
        handleServerRequestBlock && /\bcatch\b/.test(handleServerRequestBlock),
      ),
      historyOnRequestFound: Boolean(historyOnRequestBlock),
      historyOnRequestHasCatch: Boolean(
        historyOnRequestBlock && /\bcatch\b/.test(historyOnRequestBlock),
      ),
      clientSendsErrorResponse: clientSource.includes("error: createJsonRpcError(failure.message)"),
      clientHandlerCatchHasFailWith: Boolean(
        clientHandlerCatchBlock && /\bfailWith\s*\(/.test(clientHandlerCatchBlock),
      ),
    },
    guardOrder: {
      approvalBeforeStock: Boolean(
        approvalGuard && stockAcceptSession && approvalGuard.index < stockAcceptSession.index,
      ),
      permissionsBeforeStock: Boolean(
        permissionsGuard && stockPermissions && permissionsGuard.index < stockPermissions.index,
      ),
      elicitationBeforeStock: Boolean(
        elicitationGuard &&
          stockElicitationSwitch &&
          elicitationGuard.index < stockElicitationSwitch.index,
      ),
      userInputBuildThrowBeforeAnswers: Boolean(
        userInputThrows.some((entry) => answersBuild && entry.index < answersBuild.index),
      ),
      userInputPrepareGuardBeforeActivity: Boolean(
        userInputPrepareGuard &&
          requestMatchesActiveTurn &&
          userInputPrepareGuard.index < requestMatchesActiveTurn.index,
      ),
    },
  };
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runPolicyCases(module, expectations) {
  const results = [];
  const record = (group, entry, actual, expected, stock, stockValue) => {
    const ok = stock ? deepEqual(actual, stockValue) : deepEqual(actual, expected);
    results.push({
      group,
      id: entry.id,
      expected: stock ? { stock: stockValue ?? null } : expected,
      actual,
      ok,
    });
    return ok;
  };

  for (const entry of expectations.cases.approval) {
    const actual = module.restrictedApprovalDecision(entry.flag, entry.decision);
    record("approval", entry, actual, entry.expected, entry.expectStock === true, null);
  }
  for (const entry of expectations.cases.permissions) {
    const actual = module.restrictedPermissionsDecision(entry.flag);
    record("permissions", entry, actual, entry.expected, entry.expectStock === true, null);
  }
  for (const entry of expectations.cases.elicitation) {
    const actual = module.restrictedElicitationAction(entry.flag, entry.decision);
    record("elicitation", entry, actual, entry.expected, entry.expectStock === true, null);
  }
  for (const entry of expectations.cases.handler) {
    const actual = module.restrictPermissionResultForExplicitOwner({
      requireExplicitOwnerDecision: entry.flag,
      requestKind: entry.requestKind,
      result: { decision: entry.decision },
    });
    record("handler", entry, actual.decision, entry.expected, false);
  }
  for (const entry of expectations.cases.fixedMapping) {
    const actual = module.isRestrictedApprovalShapedUserInput({
      requireExplicitOwnerDecision: entry.flag,
      method: entry.method,
      approvalShaped: entry.approvalShaped,
    });
    record("fixed-mapping", entry, actual, entry.expected, false);
  }
  {
    const error = module.createRestrictedApprovalShapedUserInputError();
    const second = module.createRestrictedApprovalShapedUserInputError();
    const expectedMessage = expectations.cases.fixedError[0].expectedMessage;
    const expectedName = expectations.cases.fixedError[1].expectedName;
    const actual = {
      message: error.message,
      name: error.name,
      fixedAcrossCalls: error.message === second.message && error.name === second.name,
      isError: error instanceof Error,
    };
    record(
      "fixed-error",
      { id: "approval-shaped-error" },
      actual,
      { message: expectedMessage, name: expectedName, fixedAcrossCalls: true, isError: true },
      false,
    );
  }
  for (const entry of expectations.cases.claims) {
    const tracker = module.createBoundedSeenOccurrenceClaims(entry.capacity);
    const claims = entry.sequence.map((requestId) => tracker.claim(requestId));
    const has = Object.fromEntries(
      Object.keys(entry.expectedHas).map((requestId) => [requestId, tracker.has(requestId)]),
    );
    const actual = { claims, size: tracker.size, has };
    record(
      "claims",
      entry,
      actual,
      { claims: entry.expectedClaims, size: entry.expectedSize, has: entry.expectedHas },
      false,
    );
  }
  for (const capacity of expectations.cases.invalidClaimCapacity) {
    let actual;
    try {
      module.createBoundedSeenOccurrenceClaims(capacity);
      actual = "created";
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    record(
      "claims-invalid",
      { id: `capacity-${capacity}` },
      actual,
      "restricted_approval_occurrence_limit_invalid",
      false,
    );
  }
  for (const entry of expectations.cases.claimErrors) {
    const error = new module.RestrictedApprovalOccurrenceError(entry.reason);
    const actual = {
      message: error.message,
      name: error.name,
      reason: error.reason,
      isError: error instanceof Error,
    };
    record(
      "claims-error",
      entry,
      actual,
      {
        message: entry.expectedMessage,
        name: "RestrictedApprovalOccurrenceError",
        reason: entry.reason,
        isError: true,
      },
      false,
    );
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const required = ["happierGitDir", "happierPatchObjects", "git", "tar"];
  const missing = required.filter((name) => !options[name]);
  if (missing.length > 0) {
    console.error(
      `[codex-approval] missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
    );
    console.error(usage());
    return 1;
  }
  if (options.evidence && (await pathExists(options.evidence))) {
    console.error("[codex-approval] evidence file already exists; write the receipt to a new path");
    return 1;
  }

  const expectations = JSON.parse(await readFile(join(here, "expectations.json"), "utf8"));
  const patchPath = resolve(options.patch);
  if (!(await pathExists(patchPath))) {
    console.error(`[codex-approval] patch not found: ${patchPath}`);
    return 1;
  }

  const parent = resolve(options.tempRoot);
  await mkdir(parent, { recursive: true });
  const workspaceRoot = await mkdtemp(join(parent, "rac-codex-approval-"));
  assertOwnedWorkspace(workspaceRoot, parent);
  const workspace = {
    root: workspaceRoot,
    scratch: join(workspaceRoot, "scratch"),
    tree: join(workspaceRoot, "tree"),
  };
  for (const path of Object.values(workspace)) {
    if (path !== workspaceRoot) await mkdir(path, { recursive: true });
  }
  const redactionRoots = [
    { root: resolve(options.happierGitDir), placeholder: "%HAPPIER_GIT%" },
    { root: resolve(options.happierPatchObjects), placeholder: "%PATCH_OBJECTS%" },
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
    evidenceClasses: {
      executed: [
        "the patched production approvalDecisionPolicy module, imported and called with synthetic decisions and parameters",
        "pure fixed approval-shaped mapping, fixed unsupported error identity, and bounded seen-occurrence claim fresh/duplicate/full/no-eviction semantics",
      ],
      static: [
        "route and source-fact assertions over pinned/patched text",
        "fixed error propagation through prepareServerRequest, runBridgeWork, historyBoundary.onRequest and the app-server client",
        "coordinator cache-disable and seen-claim wiring",
        "handler completed-request and reused-occurrence guards",
      ],
      source: [
        "pinned commit/tree and candidate-tree object bindings",
        "patch sha256, touched-path set, application and resulting blob identities",
      ],
      runtime:
        "NOT_RUN: no Happier runtime, Codex app-server, model turn, provider, turn-failure behavior or physical install was started",
    },
    supersedes: "codex-approval-20261124/run-20261124-v5.json",
    retiredClaims: [
      "coordinator.reprompt replaced a completed request under the same provider id; this is withdrawn",
      "restricted approval-shaped requestUserInput used keyword/positional label selection; this is withdrawn",
      "transport duplicate delivery was described as re-prompting; the retained contract is deny/unsupported, not a fresh grant",
    ],
    bindings: null,
    tools: null,
    route: null,
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
        "Owner-supplied absolute Windows Git/tar are trusted inputs. They run with an isolated Git config pinned to core.autocrlf=input, no ambient GIT_* variables and no dependency installation. A replaced tool invalidates this binding. No Linux execution is claimed.",
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

    const patchText = await readFile(patchPath, "utf8");
    const patchSha256 = sha256Bytes(Buffer.from(patchText, "utf8"));
    const touched = patchTouchedFiles(patchText);
    report.bindings = {
      patch: {
        path: redactString(resolve(options.patch), redactionRoots),
        maintainedPath: expectations.patch.path,
        sha256: patchSha256,
        touches: touched,
      },
    };
    if (patchSha256 === expectations.patch.sha256) {
      recorder.pass("patch.sha256", "0008 patch matches the pinned digest");
    } else {
      recorder.fail(
        "patch.sha256",
        "0008 patch digest differs from the pinned expectation; refusing a non-maintained override",
        {
          expected: expectations.patch.sha256,
          actual: patchSha256,
        },
      );
      report.stoppedAt = "patch-sha256";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    if (JSON.stringify(touched) === JSON.stringify(expectations.patch.touchesOnly)) {
      recorder.pass("patch.touches-only", `patch touches ${touched.length} expected paths`);
    } else {
      recorder.fail("patch.touches-only", "patch touches unexpected paths", { touched });
    }

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
        "pinned commit, source tree and five-patch candidate tree are present",
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
    report.bindings.happier = { ...(report.bindings.happier ?? {}), sourceBlobs: sourceHashes };
    if (sourceMismatch) {
      report.stoppedAt = "source-binding";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    recorder.pass(
      "source.blobs",
      "pinned route, handler, coordinator and policy dependency blobs match",
    );

    const patchReceiptPath = join(dirname(resolve(options.happierPatchObjects)), "receipt.json");
    if (!(await pathExists(patchReceiptPath))) {
      recorder.blocked(
        "happier.patch-receipt",
        "no adjacent patch-index receipt.json; pinned objects and source hashes were still checked",
      );
      report.stoppedAt = "patch-receipt-missing";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    let patchReceipt = null;
    try {
      patchReceipt = JSON.parse(await readFile(patchReceiptPath, "utf8"));
    } catch {
      recorder.fail("happier.patch-receipt", "adjacent patch-index receipt.json is not valid JSON");
      report.stoppedAt = "patch-receipt-invalid";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const patchReceiptValid = Boolean(patchReceipt) && typeof patchReceipt === "object";
    const matches =
      patchReceiptValid &&
      patchReceipt.sourceCommit === expectations.happier.commit &&
      patchReceipt.sourceTree === expectations.happier.tree &&
      patchReceipt.candidateTree === expectations.happier.candidateTree;
    report.bindings.happier = {
      ...report.bindings.happier,
      patchReceipt: {
        patchCount: patchReceiptValid ? (patchReceipt.patchCount ?? null) : null,
        changedPathCount: patchReceiptValid ? (patchReceipt.changedPathCount ?? null) : null,
        matches,
      },
    };
    if (matches) {
      recorder.pass(
        "happier.patch-receipt",
        `candidate tree is bound to ${patchReceipt.patchCount ?? "?"} ordered patches`,
      );
    } else {
      recorder.fail(
        "happier.patch-receipt",
        "adjacent patch-index receipt.json is invalid or does not bind the expected trees",
      );
      report.stoppedAt = "patch-receipt-invalid";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }

    const createdFile = expectations.patch.createdFiles[0];
    const createdBefore =
      git({
        ...gitOptions,
        args: ["cat-file", "-e", `${expectations.happier.candidateTree}:${createdFile}`],
      }).status === 0;
    if (!createdBefore) {
      recorder.pass(
        "source.created-file-absent",
        "policy module is absent from the five-patch candidate tree",
      );
    } else {
      recorder.fail(
        "source.created-file-absent",
        "policy module unexpectedly exists before the patch",
      );
      report.stoppedAt = "created-file-present";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }

    const sourcePaths = Object.keys(expectations.happier.sourceFiles);
    await archiveTo({
      ...gitOptions,
      tarPath: resolve(options.tar),
      tarEnv: toolEnv,
      revision: expectations.happier.candidateTree,
      paths: sourcePaths,
      destination: workspace.tree,
      maxBytes: expectations.limits.maxSourceBytes,
    });
    await writeFile(join(workspace.tree, "package.json"), '{"type":"module"}\n', "utf8");

    const applyCheck = spawnSync(resolve(options.git), ["apply", "--check", patchPath], {
      cwd: workspace.tree,
      env: toolEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    if (applyCheck.status !== 0) {
      recorder.fail("patch.applies", "patch does not apply to the extracted candidate fragment", {
        stderr: String(applyCheck.stderr).slice(0, 300),
      });
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }
    const apply = spawnSync(resolve(options.git), ["apply", patchPath], {
      cwd: workspace.tree,
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
    recorder.pass(
      "patch.applies",
      "patch applies cleanly to the pinned five-patch candidate fragment",
    );

    const readTree = (path) => readFile(join(workspace.tree, path), "utf8");
    const patchedBlobs = {};
    let patchedMismatch = false;
    for (const [path, expected] of Object.entries(expectations.patch.patchedBlobs)) {
      const content = await readTree(path);
      const actual = gitBlobHash(content);
      patchedBlobs[path] = actual;
      if (actual !== expected) {
        patchedMismatch = true;
        recorder.fail("patch.result", `patched blob differs for ${path}`, { expected, actual });
      }
    }
    report.bindings.patch.patchedBlobs = patchedBlobs;
    if (!patchedMismatch) {
      recorder.pass("patch.result", "all patched blobs match the pinned expected identities");
    } else {
      report.stoppedAt = "patch-result";
      return finalize(report, recorder, options, workspace, redactionRoots, startedAt);
    }

    const runCodexSource = readBlob({
      ...gitOptions,
      revision: expectations.happier.candidateTree,
      path: "apps/cli/src/backends/codex/runCodex.ts",
      maxBytes: expectations.limits.maxSourceBytes,
    });
    const codexHandlerSource = await readTree(
      "apps/cli/src/backends/codex/utils/permissionHandler.ts",
    );
    const codexLikeSource = await readTree(
      "apps/cli/src/agent/permissions/CodexLikePermissionHandler.ts",
    );
    const runtimeSource = await readTree("apps/cli/src/backends/codex/appServer/runtime.ts");
    const coordinatorSource = await readTree(
      "apps/cli/src/agent/permissions/permissionRequestCoordinator.ts",
    );
    const baseSource = await readTree("apps/cli/src/agent/permissions/BasePermissionHandler.ts");
    const historySource = await readTree(
      "apps/cli/src/backends/codex/appServer/codexAppServerHistoryBoundary.ts",
    );
    const clientSource = await readTree(
      "apps/cli/src/backends/codex/appServer/client/createCodexAppServerClient.ts",
    );

    const facts = analyzeRouteFacts({
      runCodexSource,
      codexHandlerSource,
      codexLikeSource,
      runtimeSource,
      coordinatorSource,
      baseSource,
      historySource,
      clientSource,
    });
    report.route = facts;

    const unpatchedLike = readBlob({
      ...gitOptions,
      revision: expectations.happier.candidateTree,
      path: "apps/cli/src/agent/permissions/CodexLikePermissionHandler.ts",
      maxBytes: expectations.limits.maxSourceBytes,
    });
    const unpatchedRuntime = readBlob({
      ...gitOptions,
      revision: expectations.happier.candidateTree,
      path: "apps/cli/src/backends/codex/appServer/runtime.ts",
      maxBytes: expectations.limits.maxSourceBytes,
    });
    const defect = {
      codexLikeAutoApprovesYolo: unpatchedLike.includes("case 'yolo':"),
      codexLikeAllowsSessionAllowlist: unpatchedLike.includes(
        "Auto-approving (allowed for session)",
      ),
      codexLikeHasNoRestrictedGuard: !unpatchedLike.includes("requireExplicitOwnerDecision"),
      runtimeMapsSessionToAcceptForSession: unpatchedRuntime.includes(
        "return { decision: 'acceptForSession' };",
      ),
      runtimeMapsExecpolicyAmendment: unpatchedRuntime.includes("acceptWithExecpolicyAmendment"),
      runtimeHasNoRestrictedGuard: !unpatchedRuntime.includes("requireExplicitOwnerDecision"),
    };
    report.source = { defect, facts };

    const routeOk = recordRouteChecks(recorder, facts);
    const defectOk = recordDefectChecks(recorder, defect);

    const policyPath = join(
      workspace.tree,
      "apps/cli/src/agent/permissions/approvalDecisionPolicy.ts",
    );
    let policyResults = [];
    let policyImportError = null;
    try {
      const module = await import(pathToFileURL(policyPath).href);
      policyResults = await runPolicyCases(module, expectations);
    } catch (error) {
      policyImportError = String(error?.message ?? error).slice(0, 300);
    }
    report.executed = {
      module: "apps/cli/src/agent/permissions/approvalDecisionPolicy.ts",
      source: "patched production source from the pinned five-patch candidate fragment",
      importError: policyImportError,
      cases: policyResults,
    };
    const executedOk =
      policyImportError === null &&
      policyResults.length > 0 &&
      policyResults.every((entry) => entry.ok);
    if (executedOk) {
      recorder.pass(
        "executed.approval-policy",
        `production policy module returns the expected restricted/stock decision for ${policyResults.length} synthetic cases`,
      );
    } else {
      recorder.fail("executed.approval-policy", "production policy module diverged", {
        policyImportError,
        failed: policyResults.filter((entry) => !entry.ok),
      });
    }

    report.patchJustified =
      routeOk &&
      defectOk &&
      Boolean(facts.restrictedFlag) &&
      executedOk &&
      facts.guardOrder.approvalBeforeStock &&
      facts.guardOrder.permissionsBeforeStock &&
      facts.guardOrder.elicitationBeforeStock &&
      facts.guardOrder.userInputBuildThrowBeforeAnswers &&
      facts.guardOrder.userInputPrepareGuardBeforeActivity &&
      facts.orderByPath.buildGuardConditionBeforeThrow &&
      facts.orderByPath.buildGuardBeforeAnswers &&
      facts.orderByPath.prepareGuardBeforeLoop &&
      facts.orderByPath.prepareGuardBeforeHandler &&
      facts.orderByPath.stockResolverAfterRestrictedGuard;
    if (report.patchJustified) {
      recorder.pass(
        "patch.justified",
        "the maintained Codex app-server route uses the gated handler; approval-shaped userInput is rejected with a fixed error before answers, and reused/settled request ids are denied without replacing completed records",
      );
    } else {
      recorder.fail("patch.justified", "the patch cannot be justified from the actual call route");
    }

    report.limitations = [
      {
        id: "full-happier-runtime",
        status: "NOT_RUN",
        reason:
          "The Happier workspace dependency install/build and full runtime were not executed offline; no package install was attempted.",
      },
      {
        id: "live-codex-app-server",
        status: "NOT_RUN",
        reason:
          "Starting the Codex app-server requires a provider process and auth; prohibited by this lane.",
      },
      {
        id: "upstream-vitest",
        status: "NOT_RUN",
        reason:
          "Happier vitest suites are not available offline; this lane executes the new runtime-free policy module instead.",
      },
      {
        id: "physical-install",
        status: "NOT_RUN",
        reason: "No device, installed artifact or physical RAC journey is exercised.",
      },
      {
        id: "relay-grant-revocation",
        status: "NOT_PROVEN",
        reason:
          "This lane does not prove that an owner grant is revoked when a relay await is interrupted or retried. The patch fences decisions at the native app-server/handler boundary only; relay revocation remains a separate gap and is not claimed.",
      },
      {
        id: "restricted-flag-delivery",
        status: "NOT_PROVEN",
        reason:
          "This lane proves that the same in-process HAPPIER_RAC_RESTRICTED_DEPLOYMENT predicate used by 0001 gates the patched code; it does not prove that every restricted launch profile exports that signal into the session process. Profiles are unchanged and not exercised.",
      },
      {
        id: "execution-run-approval-path",
        status: "NOT_QUALIFIED",
        reason:
          "Codex execution-run backends accept a separately supplied permissionHandler. That path is not the foreground app-server route and is not qualified here.",
      },
      {
        id: "transport-duplicate-request-id",
        status: "NOT_EXERCISED",
        reason:
          "No live JSON-RPC transport is started. Under the restricted profile a completed or reused provider request id is denied; a duplicate while the same request is pending attaches to one pending decision and is not a second grant. Concurrent same-id transport is not qualified.",
      },
      {
        id: "approval-shaped-user-input-error",
        status: "UNQUALIFIED",
        reason:
          "Restricted approval-shaped requestUserInput is rejected with a fixed JSON-RPC error surfaced by the app-server client. The provider may fail the turn or behave otherwise; this is not a denial and is not qualified. No label, prebuilt answer or empty map is used.",
      },
      {
        id: "occurrence-generation-binding",
        status: "NOT_PROVEN",
        reason:
          "The bounded seen-occurrence claim denies a reused id for the coordinator lifetime and the handler denies ids already present in completedRequests. The pinned approval schemas expose no provider generation token, foreground RPC payloads omit occurrenceId, and the completed-record/claim memory is not a provider edge. No generation binding is claimed; a pruned completed record or a new handler can lose the memory.",
      },
      {
        id: "seen-claim-capacity",
        status: "BOUNDED",
        reason:
          "The restricted seen-occurrence claim holds at most 4096 ids. New permission request ids are denied when full; there is no eviction that would permit reuse. In-flight duplicates still attach to their existing pending request.",
      },
      {
        id: "source-wiring",
        status: "STATIC_ONLY",
        reason:
          "Route, guard ordering, fixed-error propagation and claim wiring are pinned-text assertions over the patched source, not an execution of runtime.ts.",
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
        console.error(`[codex-approval] temp cleanup refused: ${String(error.message)}`);
      }
    }
  }
}

function recordRouteChecks(recorder, facts) {
  let ok = true;
  const requireSnippet = (id, detail, snippet) => {
    if (snippet) {
      recorder.pass(id, detail, { line: snippet.line });
    } else {
      recorder.fail(id, detail);
      ok = false;
    }
  };

  requireSnippet(
    "route.handler-factory",
    "runCodex constructs the Codex handler via createCodexPermissionHandler",
    facts.factory,
  );
  if (facts.runtimeCreation?.passesPermissionHandler) {
    recorder.pass(
      "route.appserver-handler",
      "createCodexAppServerRuntime receives that handler as permissionHandler",
      { line: facts.runtimeCreation.line },
    );
  } else {
    recorder.fail(
      "route.appserver-handler",
      "app-server runtime creation does not pass permissionHandler",
    );
    ok = false;
  }
  requireSnippet(
    "route.handler-class",
    "CodexPermissionHandler extends CodexLikePermissionHandler",
    facts.handlerClass,
  );
  if (!facts.providerEnforcedInRoute) {
    recorder.pass(
      "route.not-provider-enforced",
      "the Codex route does not use the 0001 ProviderEnforcedPermissionHandler guard",
    );
  } else {
    recorder.fail(
      "route.not-provider-enforced",
      "ProviderEnforcedPermissionHandler appears in the route",
    );
    ok = false;
  }

  requireSnippet(
    "handler.restricted-flag",
    "Codex handler derives requireExplicitOwnerDecision from the restricted deployment policy",
    facts.restrictedFlag,
  );
  requireSnippet(
    "handler.no-autoapprove",
    "restricted mode returns before every auto-approval branch",
    facts.autoApproveGuard,
  );
  requireSnippet(
    "handler.no-session-allowlist",
    "restricted mode overrides the session allowlist acceptance",
    facts.sessionAllowlistOverride,
  );
  requireSnippet(
    "handler.cache-disabled",
    "restricted handler disables the coordinator decision cache",
    facts.cacheFlagPassed,
  );
  requireSnippet(
    "handler.policy-helper",
    "handler normalises broader permission results through the policy helper",
    facts.handlerUsesPolicyHelper,
  );

  requireSnippet(
    "base.cache-flag",
    "BasePermissionHandler forwards the cache-disable option",
    facts.baseCacheFlag,
  );
  requireSnippet(
    "coordinator.cache-flag",
    "coordinator accepts the cache-disable option",
    facts.coordinatorFactoryFlag,
  );
  if (facts.coordinatorCacheReadGated && facts.coordinatorCacheWrite) {
    recorder.pass(
      "coordinator.cache-gated",
      "coordinator neither reads nor records cached decisions when disabled",
      {
        readLine: facts.coordinatorCacheRead?.line ?? null,
        writeLine: facts.coordinatorCacheWrite.line,
      },
    );
  } else {
    recorder.fail("coordinator.cache-gated", "coordinator cache gating is incomplete");
    ok = false;
  }
  if (facts.coordinatorRepublishesRemoved) {
    recorder.pass(
      "coordinator.no-completed-replacement",
      "restricted mode never replaces or deletes a completed request under the same id",
    );
  } else {
    recorder.fail(
      "coordinator.no-completed-replacement",
      "a completed-request replacement remains",
    );
    ok = false;
  }
  if (
    facts.seenClaimsCreated &&
    facts.seenClaimCall &&
    facts.publishCall &&
    facts.seenClaimCall.index < facts.publishCall.index &&
    facts.occurrenceErrorThrown
  ) {
    recorder.pass(
      "coordinator.seen-claim-before-prompt",
      "the bounded seen-occurrence claim is recorded before the owner prompt and rejects settled/full ids",
      { claimLine: facts.seenClaimCall.line, publishLine: facts.publishCall.line },
    );
  } else {
    recorder.fail(
      "coordinator.seen-claim-before-prompt",
      "seen-occurrence claim wiring is missing or ordered after publication",
    );
    ok = false;
  }
  requireSnippet(
    "handler.completed-request-guard",
    "restricted permission requests deny ids already present in completedRequests",
    facts.completedGuard,
  );
  requireSnippet(
    "handler.reused-occurrence-catch",
    "the handler turns a settled/full occurrence rejection into a typed denial",
    facts.occurrenceCatch,
  );
  requireSnippet(
    "handler.restricted-request-helper",
    "the restricted request path is wrapped for the occurrence rejection",
    facts.restrictedRequestHelper,
  );

  requireSnippet(
    "runtime.restricted-flag",
    "app-server runtime derives the restricted flag from the same policy",
    facts.runtimeRestrictedFlag,
  );
  requireSnippet(
    "runtime.approval-guard",
    "approval mapping consults the restricted policy",
    facts.approvalGuard,
  );
  requireSnippet(
    "runtime.permissions-guard",
    "permissions mapping declines escalation in restricted mode",
    facts.permissionsGuard,
  );
  requireSnippet(
    "runtime.elicitation-guard",
    "MCP elicitation mapping consults the restricted policy",
    facts.elicitationGuard,
  );
  requireSnippet(
    "runtime.user-input-prepare-guard",
    "approval-shaped user input is rejected before asking or returning answers",
    facts.userInputPrepareGuard,
  );
  if (facts.userInputThrows.length >= 2) {
    recorder.pass(
      "runtime.user-input-fixed-error",
      "the fixed unsupported error is thrown in both the prepare and answer-building branches",
      { lines: facts.userInputThrows.map((entry) => entry.line) },
    );
  } else {
    recorder.fail("runtime.user-input-fixed-error", "fixed unsupported error throw is missing");
    ok = false;
  }
  const byPath = facts.orderByPath;
  if (
    facts.restrictedBuildGuard &&
    byPath.buildGuardConditionBeforeThrow &&
    byPath.buildGuardBeforeAnswers &&
    byPath.prepareGuardBeforeLoop &&
    byPath.prepareGuardBeforeHandler &&
    byPath.stockResolverAfterRestrictedGuard
  ) {
    recorder.pass(
      "runtime.restricted-approval-shaped-order",
      "the fixed guard precedes answer construction in prepareServerRequest and buildUserInputResponse; the stock label resolver remains reachable only when the restricted guard is false",
    );
  } else {
    recorder.fail(
      "runtime.restricted-approval-shaped-order",
      "a restricted approval-shaped path can prepare or return answers before the fixed guard",
      byPath,
    );
    ok = false;
  }
  requireSnippet(
    "runtime.stock-accept-session",
    "unrestricted session acceptance remains in the stock switch",
    facts.stockAcceptSession,
  );
  requireSnippet(
    "runtime.stock-amendment",
    "unrestricted execpolicy amendment remains in the stock mapping",
    facts.stockAmendment,
  );
  requireSnippet(
    "runtime.stock-permissions",
    "unrestricted permissions grant remains in the stock mapping",
    facts.stockPermissions,
  );
  requireSnippet(
    "handler.unrestricted-mode",
    "unrestricted yolo auto-approval remains in the handler",
    facts.unpatchedAutoApprove,
  );
  requireSnippet(
    "handler.unrestricted-allowlist",
    "unrestricted session allowlist auto-approval remains in the handler",
    facts.unpatchedAllowlist,
  );

  const order = facts.guardOrder;
  if (
    order.approvalBeforeStock &&
    order.permissionsBeforeStock &&
    order.elicitationBeforeStock &&
    order.userInputBuildThrowBeforeAnswers &&
    order.userInputPrepareGuardBeforeActivity
  ) {
    recorder.pass(
      "runtime.guard-order",
      "every restricted guard is evaluated before its stock affirmative mapping and before asking/answers",
    );
  } else {
    recorder.fail("runtime.guard-order", "a restricted guard follows its stock mapping", order);
    ok = false;
  }

  if (facts.runtimeImportsPolicy && facts.codexHandlerImportsPolicy) {
    recorder.pass(
      "source.policy-imports",
      "runtime and Codex handler import the maintained policy",
    );
  } else {
    recorder.fail("source.policy-imports", "a required policy import is missing");
    ok = false;
  }

  const fencing = facts.providerFencing;
  if (
    fencing?.ensureActiveTurn &&
    fencing.matchesPendingTurn &&
    fencing.terminatedGuard &&
    fencing.resolvedHandler &&
    fencing.cancelsPending
  ) {
    recorder.pass(
      "source.provider-fencing",
      "pinned runtime gates provider requests on the active turn/thread and cancels locally pending requests resolved elsewhere (static fact, not a live claim)",
    );
  } else {
    recorder.fail("source.provider-fencing", "provider turn/request fencing was not found", {
      fencing,
    });
    ok = false;
  }

  const surfacing = facts.errorSurfacing;
  if (
    surfacing?.runBridgeWorkFound &&
    !surfacing.runBridgeWorkHasCatch &&
    surfacing.handleServerRequestFound &&
    !surfacing.handleServerRequestHasCatch &&
    surfacing.historyOnRequestFound &&
    !surfacing.historyOnRequestHasCatch &&
    surfacing.clientSendsErrorResponse &&
    !surfacing.clientHandlerCatchHasFailWith
  ) {
    recorder.pass(
      "runtime.fixed-error-surfaces",
      "no route layer catches the fixed error into a success; the app-server client sends a bounded JSON-RPC error response without failing the transport",
    );
  } else {
    recorder.fail(
      "runtime.fixed-error-surfaces",
      "a route layer can catch the fixed error or the client does not send an error response",
      surfacing,
    );
    ok = false;
  }
  return ok;
}

function recordDefectChecks(recorder, defect) {
  const entries = Object.entries(defect);
  const missing = entries.filter(([, value]) => value !== true).map(([key]) => key);
  if (missing.length === 0) {
    recorder.pass(
      "source.defect-observed",
      "the unpatched route auto-approves and maps session/execpolicy acceptance, and the handler has no restricted guard",
      defect,
    );
    return true;
  }
  recorder.fail("source.defect-observed", "the expected pre-patch behaviour was not observed", {
    missing,
  });
  return false;
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
    "run-codex-approval-qualification.mjs",
    "expectations.json",
    "../codex-adapter/lib/git.mjs",
    "../codex-adapter/lib/redact.mjs",
  ]) {
    const path = join(here, relativePath);
    if (await pathExists(path)) {
      report.harness.files.push({
        path: relativePath.replaceAll("\\", "/").replace(/^\.\.\//, "qualification/codex-adapter/"),
        sha256: await sha256File(path),
      });
    }
  }
  report.harness.patch = {
    path: redactString(resolve(options.patch), redactionRoots),
    maintainedPath: "patches/happier/0008-restrict-codex-approval-occurrences.patch",
    sha256: await sha256File(resolve(options.patch)),
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
  for (const limitation of report.limitations) {
    lines.push(`  [limit] ${limitation.id}: ${limitation.status} — ${limitation.reason}`);
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
      console.error(`[codex-approval] ${error.stack ?? error.message}`);
      process.exitCode = 1;
    });
}
