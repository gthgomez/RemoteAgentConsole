#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_RELATIVE = "distribution/composition-lock.json";
const SERIES_RELATIVE = "patches/happier/series.json";
const LOCK_PATH = join(REPO_ROOT, LOCK_RELATIVE);
const SERIES_PATH = join(REPO_ROOT, SERIES_RELATIVE);
const DEFAULT_HAPPIER = resolve(REPO_ROOT, "..", "Happier");
const DEFAULT_BABEL = resolve(REPO_ROOT, "..", "Babel");
// Exact-candidate qualification is split into three independent claims: source
// identity (RAC, Babel and the patched Happier stage), source-built evidence,
// and installer/install proof. Only the first is produced here; the other two
// stay closed unless a caller supplies their own receipt.
const EVIDENCE_FILE = "rac-composition-evidence.json";
const SCAFFOLD_DISPOSITION = "scaffold-only-not-a-production-or-qualified-package";
const REQUIRED_PATCH_COUNT = 5;
const BUILD_OUTPUT_PATHS = [
  ".rac-build-state",
  "node_modules",
  "apps/ui/dist",
  "apps/server/dist",
  ".yarn",
];

export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function fail(message) {
  throw new Error(message);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left, right) {
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

function assertFullCommit(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(String(value ?? ""))) {
    fail(`${label} must be an explicit 40-character commit, not a moving ref`);
  }
  return String(value).toLowerCase();
}

function assertTreeHash(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(String(value ?? ""))) {
    fail(`${label} must be an explicit 40-character Git tree`);
  }
  return String(value).toLowerCase();
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) {
    fail(`${label} must be a 64-character SHA-256 digest`);
  }
  return String(value);
}

function assertSafeRepoPath(path, label) {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    fail(`${label} contains an unsafe repository path: ${path}`);
  }
}

const BLOCKED_PARENT_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_REPLACE_REF_BASE",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
]);

function sanitizedGitEnv({ indexFile = null } = {}) {
  const env = { ...process.env };
  for (const key of BLOCKED_PARENT_GIT_ENV) delete env[key];
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

function git(repo, args, { indexFile = null } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnv({ indexFile }),
    windowsHide: true,
  });
  if (result.error && result.status !== 0)
    fail(`git ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitProbe(repo, args, { indexFile = null } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnv({ indexFile }),
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitBlobBytes(repo, commit, path) {
  const revision =
    commit === "HEAD" ? "HEAD" : assertFullCommit(commit, "Git blob revision");
  assertSafeRepoPath(path, "Git blob path");
  const result = spawnSync(
    "git",
    ["--no-replace-objects", "-C", repo, "show", `${revision}:${path}`],
    { encoding: "buffer", env: sanitizedGitEnv() },
  );
  if (result.error && result.status !== 0) {
    fail(`git show could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Git blob is missing from ${revision}: ${path}`);
  }
  return result.stdout;
}

function gitFileBytes(repo, path, revision = "HEAD") {
  return gitBlobBytes(repo, revision, path);
}

function gitWithInput(repo, args, input) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    input,
    encoding: "utf8",
    env: sanitizedGitEnv(),
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function canonicalRepoUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Cannot parse ${label}: ${error.message}`);
  }
}

async function writeJsonExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function verifyLockfilesAtHead({ repo, lockfiles, label }) {
  const files = [];
  for (const [path, expected] of Object.entries(lockfiles ?? {})) {
    const actual = sha256Bytes(gitFileBytes(repo, path));
    if (actual !== expected) {
      fail(`${label} ${path} SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }
    files.push({ path, sha256: actual });
  }
  return files;
}

function verifyCleanRepository(repo, label) {
  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail(`${label} checkout is dirty; refusing to qualify it:\n${status}`);
}

function closedInstallation() {
  return {
    status: "not-qualified",
    installedProduct: false,
    installer: "not-provided",
    activation: "closed",
    profiles: [],
    reason:
      "This receipt does not install, activate, or prove a downstream product on Windows or Android.",
  };
}

function validateCompositionLock(lock) {
  if (lock?.schemaVersion !== 1) fail("composition lock must use schemaVersion 1");
  for (const name of ["rac", "babel", "happier"]) {
    const repository = lock.repositories?.[name];
    if (!repository?.url || !repository.commit || !repository.tree) {
      fail(`composition lock is missing the ${name} repository identity`);
    }
    assertFullCommit(repository.commit, `${name} baseline commit`);
    assertTreeHash(repository.tree, `${name} baseline tree`);
  }
  const happier = lock.repositories.happier;
  if (!happier.license?.path) fail("composition lock is missing the Happier license notice");
  assertSha256(happier.license.sha256, "Happier license SHA-256");
  if (happier.patchedTree) {
    assertTreeHash(happier.patchedTree, "Locked Happier patched tree");
  }
}

function validateReferenceArtifactRecords(lock) {
  const requiredArtifactIds = new Set([
    "happier-cli-windows-x64",
    "happier-server-windows-x64",
    "happier-standalone-web-reference",
  ]);
  if (
    !Array.isArray(lock.referenceArtifacts) ||
    lock.referenceArtifacts.length !== requiredArtifactIds.size
  ) {
    fail(
      "composition lock must contain the CLI, server-with-web, and standalone web reference artifacts",
    );
  }
  const seenIds = new Set();
  const records = [];
  for (const item of lock.referenceArtifacts ?? []) {
    if (!item || typeof item !== "object" || !item.id) {
      fail("Malformed reference artifact record without an id");
    }
    assertSha256(item.sha256, `Reference artifact ${item.id} SHA-256`);
    if (!item.fileName || !Number.isSafeInteger(item.bytes)) {
      fail(`Malformed reference artifact record: ${item.id ?? "(missing id)"}`);
    }
    if (
      !item.sourceCommit ||
      !item.url?.startsWith("https://github.com/happier-dev/happier/releases/download/")
    ) {
      fail(`Reference artifact ${item.id} has no immutable upstream provenance`);
    }
    if (!requiredArtifactIds.has(item.id) || seenIds.has(item.id)) {
      fail(`Unexpected or duplicate reference artifact: ${item.id}`);
    }
    seenIds.add(item.id);
    if (
      basename(item.fileName) !== item.fileName ||
      item.fileName === "." ||
      item.fileName === ".."
    ) {
      fail(`Reference artifact ${item.id} must use a plain file name`);
    }
    if (!item.url.endsWith(`/${encodeURIComponent(item.fileName)}`)) {
      fail(`Reference artifact ${item.id} URL does not resolve to ${item.fileName}`);
    }
    if (
      item.id !== "happier-standalone-web-reference" &&
      item.sourceCommit !== lock.repositories?.happier?.commit
    ) {
      fail(`Reference artifact ${item.id} source commit does not match the pinned Happier tree`);
    }
    records.push({
      id: item.id,
      component: item.component ?? null,
      platform: item.platform ?? null,
      sourceCommit: item.sourceCommit,
      url: item.url,
      fileName: item.fileName,
      sha256: item.sha256.toLowerCase(),
      bytes: item.bytes,
    });
  }
  return records;
}

export async function verifyArtifacts({ lock, artifactDir }) {
  const records = validateReferenceArtifactRecords(lock);
  const results = [];
  for (const item of records) {
    const filePath = resolve(artifactDir, item.fileName);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      fail(`Missing required cached upstream artifact ${item.id}: ${filePath}`);
    }
    if (!info.isFile() || info.size !== item.bytes) {
      fail(`Reference artifact ${item.id} size mismatch: expected ${item.bytes}, got ${info.size}`);
    }
    const actual = await sha256File(filePath);
    if (actual !== item.sha256) {
      fail(
        `Reference artifact ${item.id} SHA-256 mismatch: expected ${item.sha256}, got ${actual}`,
      );
    }
    results.push({ id: item.id, path: filePath, bytes: info.size, sha256: actual, verified: true });
  }
  return results;
}

export async function verifyUpstream({ happierRepo, lock, artifactDir }) {
  validateCompositionLock(lock);
  const selected = lock.repositories?.happier;
  if (!selected?.url || !selected.commit || !selected.tree || !selected.license?.path) {
    fail(
      "composition-lock.json is missing the exact Happier source, tree, lockfile, or license pin",
    );
  }
  const head = git(happierRepo, ["rev-parse", "HEAD"]);
  if (head !== selected.commit)
    fail(`Happier HEAD mismatch: expected ${selected.commit}, got ${head}`);
  const tree = git(happierRepo, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== selected.tree) fail(`Happier tree mismatch: expected ${selected.tree}, got ${tree}`);
  const origin = git(happierRepo, ["remote", "get-url", "origin"]);
  if (canonicalRepoUrl(origin) !== canonicalRepoUrl(selected.url)) {
    fail(`Happier origin does not match the pinned public repository ${selected.url}`);
  }
  verifyCleanRepository(happierRepo, "Happier");

  const lockfiles = verifyLockfilesAtHead({
    repo: happierRepo,
    lockfiles: selected.lockfiles,
    label: "Happier",
  });
  const licenseBytes = gitFileBytes(happierRepo, selected.license.path);
  const licenseHash = sha256Bytes(licenseBytes);
  if (licenseHash !== selected.license.sha256) {
    fail(
      `Happier license digest mismatch: expected ${selected.license.sha256}, got ${licenseHash}`,
    );
  }
  const licenseText = licenseBytes.toString("utf8");
  if (!/^MIT License\s/m.test(licenseText))
    fail("Pinned Happier license file is not the expected MIT notice");
  const artifacts = await verifyArtifacts({ lock, artifactDir });
  return {
    repository: selected.url,
    commit: head,
    tree,
    origin: selected.url,
    worktreeClean: true,
    lockfiles,
    license: { path: selected.license.path, sha256: licenseHash },
    artifacts,
  };
}

function assertInside(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    fail(`${label} must be inside ${root}`);
  }
}

function assertOutside(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel === "." || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    fail(`${label} must be outside ${root}`);
  }
}

function validatePatchSeriesBase({ series, lock }) {
  const selected = lock.repositories?.happier;
  if (
    series.schemaVersion !== 1 ||
    series.base?.repository !== selected?.url ||
    series.base?.commit !== selected?.commit ||
    series.base?.tree !== selected?.tree
  ) {
    fail("Patch series base does not exactly match the pinned Happier commit and tree");
  }
  if (!Array.isArray(series.patches)) fail("Patch series must declare an ordered patches array");
}

export async function verifyPatchSeries({ series, artifactRoot = REPO_ROOT, lock }) {
  const selectedLock = lock ?? (await readJson(LOCK_PATH, "composition lock"));
  validatePatchSeriesBase({ series, lock: selectedLock });
  const seen = new Set();
  const patches = [];
  for (const [index, item] of series.patches.entries()) {
    if (!item.path || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ""))
      fail(`Patch ${index + 1} needs a path and SHA-256`);
    if (seen.has(item.path)) fail(`Patch series contains a duplicate path: ${item.path}`);
    seen.add(item.path);
    const path = resolve(artifactRoot, item.path);
    assertInside(artifactRoot, path, `Patch ${item.path}`);
    const bytes = await readFile(path);
    const actual = sha256Bytes(bytes);
    if (actual !== item.sha256)
      fail(`Patch ${item.path} SHA-256 mismatch: expected ${item.sha256}, got ${actual}`);
    patches.push({
      order: index + 1,
      path,
      relativePath: relative(artifactRoot, path).split(sep).join("/"),
      sha256: actual,
      bytes,
      description: item.description ?? "",
    });
  }
  return patches;
}

function verifyPatchSeriesFromGit({ series, lock, racRepo, racCommit }) {
  validatePatchSeriesBase({ series, lock });
  const seen = new Set();
  const patches = [];
  for (const [index, item] of series.patches.entries()) {
    if (!item.path || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ""))
      fail(`Patch ${index + 1} needs a path and SHA-256`);
    if (seen.has(item.path)) fail(`Patch series contains a duplicate path: ${item.path}`);
    seen.add(item.path);
    const bytes = gitBlobBytes(racRepo, racCommit, item.path);
    const actual = sha256Bytes(bytes);
    if (actual !== item.sha256) {
      fail(
        `Patch ${item.path} SHA-256 mismatch against selected RAC blob: expected ${item.sha256}, got ${actual}`,
      );
    }
    patches.push({
      order: index + 1,
      path: item.path,
      relativePath: item.path,
      sha256: actual,
      bytes,
      description: item.description ?? "",
    });
  }
  return patches;
}

function assertGitInput(result, label) {
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
}

function patchFilePathsFromBytes(repo, bytes, label) {
  const result = gitWithInput(repo, ["apply", "--numstat"], bytes);
  assertGitInput(result, `Patch ${label} numstat`);
  const paths = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(2).join("\t"));
  if (
    !paths.length ||
    paths.some((path) => !path || path.startsWith("/") || path.includes("\\"))
  ) {
    fail(`Patch ${label} has no safe, reportable file paths`);
  }
  for (const path of paths) {
    assertSafeRepoPath(path, `Patch ${label}`);
  }
  return [...new Set(paths)];
}

async function applyPatchSeries({ candidateRepo, patches, lock }) {
  if (!patches.length) return [];
  const selected = lock.repositories?.happier;
  if (git(candidateRepo, ["rev-parse", "HEAD"]) !== selected.commit)
    fail("Candidate is not at the pinned Happier commit");
  const applied = [];
  for (const patch of patches) {
    const relativePatch = (
      patch.relativePath ?? relative(REPO_ROOT, patch.path)
    ).split(sep).join("/");
    const patchBytes = patch.bytes ?? (await readFile(patch.path));
    const paths = patchFilePathsFromBytes(candidateRepo, patchBytes, relativePatch);
    assertGitInput(
      gitWithInput(candidateRepo, ["apply", "--check"], patchBytes),
      `Patch ${relativePatch} check`,
    );
    assertGitInput(
      gitWithInput(candidateRepo, ["apply", "--whitespace=error"], patchBytes),
      `Patch ${relativePatch} apply`,
    );
    const fileChecks = [];
    for (const path of paths) {
      const target = resolve(candidateRepo, path);
      const targetRel = relative(candidateRepo, target);
      if (!targetRel || targetRel === ".." || targetRel.startsWith(`..${sep}`)) {
        fail(`Patch ${relativePatch} escaped the candidate checkout at ${path}`);
      }
      const info = await stat(target).catch(() => null);
      fileChecks.push(
        info?.isFile()
          ? { path, bytes: info.size, sha256: await sha256File(target) }
          : { path, deleted: true },
      );
    }
    applied.push({
      order: patch.order,
      path: relativePatch,
      sha256: patch.sha256,
      fileChecks,
    });
  }
  return applied;
}

async function computeWorktreeTree(repo, { includePaths = [] } = {}) {
  if (!includePaths.length) fail("A patched tree needs at least one declared patch path");
  const temp = await mkdtemp(join(tmpdir(), "rac-composition-index-"));
  const indexPath = join(temp, "index");
  try {
    git(repo, ["read-tree", "HEAD"], { indexFile: indexPath });
    const paths = includePaths.map((path) => {
      assertSafeRepoPath(path, "Patched candidate path");
      return path;
    });
    // Only the declared patch paths are staged into the temporary index. This
    // keeps tree verification independent of build output, receipt files and
    // unrelated worktree content, which the status check rejects separately.
    git(repo, ["add", "-A", "--", ...paths], { indexFile: indexPath });
    return git(repo, ["write-tree"], { indexFile: indexPath });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function parseStatusZ(raw) {
  const tokens = raw.split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code.includes("R") || code.includes("C")) {
      entries.push({ code, path, oldPath: tokens[++index] ?? "" });
    } else {
      entries.push({ code, path });
    }
  }
  return entries;
}

function verifyRacCandidate({ racRepo, expectedCommit, lock }) {
  const expected = assertFullCommit(expectedCommit, "RAC expected commit");
  const root = git(racRepo, ["rev-parse", "--show-toplevel"]);
  if (!samePath(root, racRepo)) fail(`RAC repository root is not the selected source: ${root}`);
  const head = git(racRepo, ["rev-parse", "HEAD"]);
  const commitObject = git(racRepo, ["cat-file", "-p", head]);
  const parents = commitObject
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length).trim());
  if (head !== expected) {
    fail(`RAC HEAD ${head} does not equal the explicit expected commit ${expected}`);
  }
  const tree = git(racRepo, ["rev-parse", "HEAD^{tree}"]);
  const origin = git(racRepo, ["remote", "get-url", "origin"]);
  const baseline = lock.repositories?.rac;
  if (!baseline?.url || !baseline.commit || !baseline.tree) {
    fail("composition lock is missing the audited RAC baseline");
  }
  if (canonicalRepoUrl(origin) !== canonicalRepoUrl(baseline.url)) {
    fail(`RAC origin does not match the audited repository ${baseline.url}`);
  }
  verifyCleanRepository(racRepo, "RAC");
  const baselineTreeProbe = gitProbe(racRepo, [
    "rev-parse",
    `${baseline.commit}^{tree}`,
  ]);
  if (baselineTreeProbe.error) {
    fail(`git rev-parse could not start: ${baselineTreeProbe.error.message}`);
  }
  if (baselineTreeProbe.status === 128) {
    fail(
      `Cannot resolve the audited RAC baseline ${baseline.commit}; fetch full history instead of a shallow checkout`,
    );
  }
  if (baselineTreeProbe.status !== 0) {
    fail(`Cannot resolve the audited RAC baseline tree ${baseline.commit}`);
  }
  if (baselineTreeProbe.stdout.trim() !== baseline.tree) {
    fail(
      `Audited RAC baseline tree mismatch: expected ${baseline.tree}, got ${baselineTreeProbe.stdout.trim()}`,
    );
  }
  const containment = gitProbe(racRepo, [
    "merge-base",
    "--is-ancestor",
    baseline.commit,
    head,
  ]);
  if (containment.error) fail(`git merge-base could not start: ${containment.error.message}`);
  if (containment.status === 128) {
    fail(
      `Cannot resolve the audited RAC baseline ${baseline.commit}; fetch full history instead of a shallow checkout`,
    );
  }
  if (containment.status !== 0) {
    fail(
      `RAC selected commit ${head} does not contain the audited baseline ${baseline.commit}`,
    );
  }
  const lockfiles = verifyLockfilesAtHead({
    repo: racRepo,
    lockfiles: baseline.lockfiles,
    label: "RAC",
  });
  return {
    role: "distribution-controller",
    baseline: {
      source: "composition-lock.json",
      commit: baseline.commit,
      tree: baseline.tree,
      classification: "audited-baseline-provenance",
    },
    selected: {
      root,
      commit: head,
      tree,
      origin,
      checkoutKind: "exact",
      parents,
      headIsMerge: parents.length > 1,
      clean: true,
      baselineContained: true,
      lockfiles,
    },
    identityBound: true,
  };
}

function verifyBabelCandidate({ babelRepo, expectedCommit, expectedTree, lock }) {
  const commit = assertFullCommit(expectedCommit, "Babel expected commit");
  const treePin = assertTreeHash(expectedTree, "Babel expected tree");
  const baseline = lock.repositories?.babel;
  if (!baseline?.url || !baseline.commit || !baseline.tree) {
    fail("composition lock is missing the reviewed Babel baseline");
  }
  if (commit !== baseline.commit || treePin !== baseline.tree) {
    fail(
      "Babel expected commit/tree must equal the reviewed composition lock; moving or unreviewed refs are not accepted",
    );
  }
  const root = git(babelRepo, ["rev-parse", "--show-toplevel"]);
  if (!samePath(root, babelRepo)) fail(`Babel repository root is not the selected source: ${root}`);
  const symbolic = gitProbe(babelRepo, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.error) fail(`git symbolic-ref could not start: ${symbolic.error.message}`);
  if (symbolic.status === 0) {
    fail(
      `Babel checkout is attached to the moving ref ${symbolic.stdout.trim()}; check out the reviewed commit detached`,
    );
  }
  const head = git(babelRepo, ["rev-parse", "HEAD"]);
  if (head !== commit) fail(`Babel HEAD mismatch: expected ${commit}, got ${head}`);
  const tree = git(babelRepo, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== treePin) fail(`Babel tree mismatch: expected ${treePin}, got ${tree}`);
  const origin = git(babelRepo, ["remote", "get-url", "origin"]);
  if (canonicalRepoUrl(origin) !== canonicalRepoUrl(baseline.url)) {
    fail(`Babel origin does not match the reviewed repository ${baseline.url}`);
  }
  verifyCleanRepository(babelRepo, "Babel");
  const lockfiles = verifyLockfilesAtHead({
    repo: babelRepo,
    lockfiles: baseline.lockfiles,
    label: "Babel",
  });
  return {
    role: "scoped-native-agent",
    baseline: {
      source: "composition-lock.json",
      commit: baseline.commit,
      tree: baseline.tree,
      classification: "reviewed-baseline-provenance",
    },
    selected: {
      root,
      commit: head,
      tree,
      origin,
      checkoutKind: "detached-exact",
      clean: true,
      lockfiles,
    },
    identityBound: true,
    coverage: "source-identity-only",
  };
}

function verifyReceiptPatches({ receipt, patches, candidateRepo }) {
  if (!Array.isArray(receipt.patches)) fail("Candidate receipt has no applied patch receipt");
  if (receipt.patches.length !== REQUIRED_PATCH_COUNT || patches.length !== REQUIRED_PATCH_COUNT) {
    fail(
      `Candidate qualification requires exactly ${REQUIRED_PATCH_COUNT} ordered Happier patches`,
    );
  }
  if (receipt.patchSeriesCount !== undefined && receipt.patchSeriesCount !== patches.length) {
    fail("Candidate receipt patch count does not match the verified patch series");
  }
  for (const [index, patch] of patches.entries()) {
    const recorded = receipt.patches[index];
    if (!recorded) fail(`Candidate receipt is missing patch ${index + 1}`);
    if (recorded.order !== index + 1) {
      fail(`Candidate receipt patch ${index + 1} has the wrong order`);
    }
    if (recorded.path !== patch.relativePath) {
      fail(
        `Candidate receipt patch ${index + 1} path mismatch: expected ${patch.relativePath}, got ${recorded.path}`,
      );
    }
    if (recorded.sha256 !== patch.sha256) {
      fail(`Candidate receipt patch ${recorded.path} SHA-256 does not match the patch series`);
    }
    const expectedPaths = new Set(
      patchFilePathsFromBytes(candidateRepo, patch.bytes, patch.relativePath),
    );
    if (!Array.isArray(recorded.fileChecks) || recorded.fileChecks.length !== expectedPaths.size) {
      fail(`Candidate receipt patch ${recorded.path} file checks are incomplete`);
    }
    for (const check of recorded.fileChecks) {
      if (!expectedPaths.has(check.path)) {
        fail(`Candidate receipt patch ${recorded.path} claims an undeclared path ${check.path}`);
      }
    }
  }
}

async function verifyStagedHappierCandidate({
  candidateRepo,
  lock,
  patches,
  expectedPatchedTree,
  expectedLockSha256,
  expectedSeriesSha256,
}) {
  const base = lock.repositories?.happier;
  if (!base?.commit || !base.tree || !base.url) {
    fail("composition lock is missing the pinned Happier source identity");
  }
  const root = git(candidateRepo, ["rev-parse", "--show-toplevel"]);
  if (!samePath(root, candidateRepo)) {
    fail(`Staged candidate root is not the selected source: ${root}`);
  }
  const head = git(candidateRepo, ["rev-parse", "HEAD"]);
  if (head !== base.commit) {
    fail(`Staged candidate HEAD mismatch: expected ${base.commit}, got ${head}`);
  }
  const tree = git(candidateRepo, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== base.tree) {
    fail(`Staged candidate tree mismatch: expected ${base.tree}, got ${tree}`);
  }
  const origin = git(candidateRepo, ["remote", "get-url", "origin"]);

  for (const path of BUILD_OUTPUT_PATHS) {
    if (existsSync(join(candidateRepo, path))) {
      fail(
        `Staged structural candidate contains build or install output at ${path}; use a separate built-evidence receipt`,
      );
    }
  }
  const ignored = gitProbe(candidateRepo, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (ignored.error) fail(`git ls-files could not start: ${ignored.error.message}`);
  if (ignored.status !== 0) fail("Cannot enumerate ignored candidate files");
  if (ignored.stdout.trim()) {
    fail(`Staged structural candidate contains ignored files:\n${ignored.stdout.trim()}`);
  }

  const allowedPaths = new Set();
  for (const patch of patches) {
    for (const path of patchFilePathsFromBytes(candidateRepo, patch.bytes, patch.relativePath)) {
      allowedPaths.add(path);
    }
  }
  const status = gitProbe(candidateRepo, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.error) fail(`git status could not start: ${status.error.message}`);
  if (status.status !== 0) fail("Cannot read staged candidate status");
  for (const entry of parseStatusZ(status.stdout)) {
    if (!entry.path || entry.path === EVIDENCE_FILE) continue;
    if (!allowedPaths.has(entry.path)) {
      fail(`Staged candidate contains content outside the declared patch series: ${entry.path}`);
    }
  }

  const receiptPath = join(candidateRepo, EVIDENCE_FILE);
  let receiptBytes;
  try {
    receiptBytes = await readFile(receiptPath);
  } catch {
    fail(`Staged candidate has no ${EVIDENCE_FILE} receipt`);
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    fail(`Staged candidate receipt is not valid JSON: ${error.message}`);
  }
  const receiptSha256 = sha256Bytes(receiptBytes);
  if (receipt.receiptType !== "happier-patched-source-stage") {
    fail("Candidate receipt is not a pristine Happier source-stage receipt");
  }
  if (receipt.disposition !== SCAFFOLD_DISPOSITION) {
    fail("Candidate receipt does not identify itself as scaffold-only");
  }
  if (
    canonicalRepoUrl(receipt.source?.repository) !== canonicalRepoUrl(base.url) ||
    receipt.source?.commit !== base.commit ||
    receipt.source?.tree !== base.tree
  ) {
    fail("Candidate receipt source does not match the pinned Happier identity");
  }
  if (receipt.inputs?.lockSha256 !== expectedLockSha256) {
    fail("Candidate receipt is not bound to the composition lock blob of the selected RAC commit");
  }
  if (receipt.inputs?.patchSeriesSha256 !== expectedSeriesSha256) {
    fail(
      "Candidate receipt is not bound to the Happier patch series blob of the selected RAC commit",
    );
  }
  if (receipt.productionPackaging !== "disabled") {
    fail("Candidate receipt claims production packaging; qualification refuses it");
  }
  if (!Array.isArray(receipt.productionProfiles) || receipt.productionProfiles.length !== 0) {
    fail("Candidate receipt enables a production profile; qualification refuses it");
  }
  if (receipt.qualification !== "not-run") {
    fail("Candidate receipt improperly claims qualification");
  }
  if (
    receipt.installation?.status !== "not-qualified" ||
    receipt.installation?.installedProduct !== false
  ) {
    fail("Candidate receipt improperly claims an installed downstream product");
  }
  if (
    receipt.builtEvidence?.status !== "not-run" ||
    receipt.builtEvidence?.installedProduct === true
  ) {
    fail("Structural candidate receipt must not carry built-product evidence");
  }

  verifyReceiptPatches({ receipt, patches, candidateRepo });

  // A path can be touched by more than one ordered patch. Only the last
  // recorded check corresponds to the final staged worktree; earlier checks are
  // intermediate states that are covered by the final patched-tree pin.
  const finalRecordedChecks = new Map();
  for (const patch of receipt.patches) {
    for (const check of patch.fileChecks ?? []) {
      finalRecordedChecks.set(check.path, check);
    }
  }
  const actualPaths = new Set();
  for (const patch of patches) {
    for (const path of patchFilePathsFromBytes(candidateRepo, patch.bytes, patch.relativePath)) {
      actualPaths.add(path);
    }
  }
  for (const path of actualPaths) {
    const target = resolve(candidateRepo, path);
    const info = await stat(target).catch(() => null);
    const recorded = finalRecordedChecks.get(path);
    if (!recorded) fail(`Candidate receipt is missing a file check for ${path}`);
    if (!info?.isFile()) {
      if (recorded.deleted !== true) {
        fail(`Candidate receipt does not record ${path} deletion`);
      }
      continue;
    }
    if (
      recorded.deleted === true ||
      recorded.bytes !== info.size ||
      recorded.sha256 !== (await sha256File(target))
    ) {
      fail(`Candidate receipt file check does not match the applied patch content at ${path}`);
    }
  }

  const actualPatchedTree = await computeWorktreeTree(candidateRepo, {
    includePaths: [...allowedPaths],
  });
  if (receipt.patchedTree !== actualPatchedTree) {
    fail(
      `Candidate receipt patched tree mismatch: expected ${actualPatchedTree}, got ${receipt.patchedTree}`,
    );
  }
  if (expectedPatchedTree && receipt.patchedTree !== expectedPatchedTree) {
    fail(
      `Candidate patched tree does not match the explicit expected tree: expected ${expectedPatchedTree}, got ${receipt.patchedTree}`,
    );
  }

  const licenseBytes = await readFile(join(candidateRepo, base.license.path)).catch(() => null);
  if (!licenseBytes) fail(`Staged candidate is missing ${base.license.path}`);
  const licenseHash = sha256Bytes(licenseBytes);
  if (licenseHash !== base.license.sha256) {
    fail(
      `Staged candidate license digest mismatch: expected ${base.license.sha256}, got ${licenseHash}`,
    );
  }
  if (!/^MIT License\s/m.test(licenseBytes.toString("utf8"))) {
    fail("Staged candidate license is not the expected MIT notice");
  }
  const finalHead = git(candidateRepo, ["rev-parse", "HEAD"]);
  const finalTree = git(candidateRepo, ["rev-parse", "HEAD^{tree}"]);
  if (finalHead !== head || finalTree !== tree) {
    fail("Staged candidate identity changed during qualification");
  }

  return {
    role: "patched-relay-controller",
    baseline: {
      source: "composition-lock.json",
      commit: base.commit,
      tree: base.tree,
      classification: "pinned-source-provenance",
    },
    selected: {
      root,
      origin,
      commit: head,
      tree,
      checkoutKind: "pinned-base-plus-ordered-patches",
      patchedTree: actualPatchedTree,
      patchCount: patches.length,
      receiptSha256,
      cleanExceptPatchSeries: true,
      lockfiles: verifyLockfilesAtHead({
        repo: candidateRepo,
        lockfiles: base.lockfiles,
        label: "Staged Happier",
      }),
    },
    license: { path: base.license.path, sha256: licenseHash, spdx: "MIT" },
    identityBound: true,
  };
}

function probeVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function observeToolchain({ yarnBin = "yarn", bunBin = "bun" } = {}) {
  const observed = {
    node: process.versions.node,
    bun: probeVersion(bunBin, ["--version"]),
    yarn: null,
    pnpm:
      probeVersion("pnpm", ["--version"]) ??
      (process.platform === "win32" ? probeVersion("pnpm.cmd", ["--version"]) : null),
    platform: process.platform,
    arch: process.arch,
  };
  try {
    const yarnJs = resolveYarnJs(yarnBin);
    const metadata = JSON.parse(
      readFileSync(join(dirname(dirname(yarnJs)), "package.json"), "utf8"),
    );
    if (metadata.name === "yarn") observed.yarn = metadata.version;
  } catch {
    observed.yarn = null;
  }
  return observed;
}

function buildReadiness(lock, options) {
  const pinned = lock.toolchain ?? {};
  const observed = observeToolchain(options);
  const reasons = [];
  // pnpm pins the RAC workspace. The selected Happier reference build needs Node,
  // Yarn and Bun only, so keep the build-critical comparison explicit.
  for (const name of ["node", "yarn", "bun"]) {
    const expected = pinned[name];
    if (expected && observed[name] !== expected) {
      reasons.push(`${name}: pinned ${expected}, observed ${observed[name] ?? "unavailable"}`);
    }
  }
  return {
    pinned,
    observed,
    matchesPin: reasons.length === 0,
    reasons,
    buildsAttempted: false,
  };
}

async function verifyBuildEvidence({
  buildEvidencePath,
  lock,
  series,
  expectedPatchedTree,
  expectedLockSha256,
  expectedSeriesSha256,
}) {
  const bytes = await readFile(buildEvidencePath).catch(() => null);
  if (!bytes) fail(`Missing build evidence receipt: ${buildEvidencePath}`);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Build evidence receipt is not valid JSON: ${error.message}`);
  }
  const base = lock.repositories?.happier;
  if (receipt.receiptType !== "happier-reference-build") {
    fail("Build evidence receipt is not a Happier source-reference build");
  }
  if (receipt.disposition !== SCAFFOLD_DISPOSITION) {
    fail("Build evidence receipt does not identify itself as scaffold-only");
  }
  if (
    canonicalRepoUrl(receipt.source?.repository) !== canonicalRepoUrl(base?.url) ||
    receipt.source?.commit !== base?.commit ||
    receipt.source?.tree !== base?.tree
  ) {
    fail("Build evidence receipt source does not match the pinned Happier identity");
  }
  if (receipt.patchedTree !== expectedPatchedTree) {
    fail("Build evidence receipt patched tree does not match the staged candidate");
  }
  if (receipt.inputs?.lockSha256 !== expectedLockSha256) {
    fail("Build evidence receipt is not bound to the selected RAC composition lock blob");
  }
  if (receipt.inputs?.patchSeriesSha256 !== expectedSeriesSha256) {
    fail("Build evidence receipt is not bound to the selected RAC patch series blob");
  }
  if (!Array.isArray(receipt.patches) || receipt.patches.length !== REQUIRED_PATCH_COUNT) {
    fail("Build evidence receipt does not carry the five ordered Happier patches");
  }
  for (const [index, patch] of series.patches.entries()) {
    if (
      receipt.patches[index]?.order !== index + 1 ||
      receipt.patches[index]?.path !== patch.path ||
      receipt.patches[index]?.sha256 !== patch.sha256
    ) {
      fail(`Build evidence receipt patch ${index + 1} does not match the patch series`);
    }
  }
  if (
    receipt.productionPackaging !== "disabled" ||
    !Array.isArray(receipt.productionProfiles) ||
    receipt.productionProfiles.length !== 0
  ) {
    fail("Build evidence receipt claims production packaging or profiles");
  }
  if (
    receipt.installation?.status !== "not-qualified" ||
    receipt.installation?.installedProduct !== false
  ) {
    fail("Build evidence receipt improperly claims an installed downstream product");
  }
  if (
    receipt.builtEvidence?.status !== "source-built-reference-only" ||
    receipt.builtEvidence?.classification !== "not-an-installed-product" ||
    receipt.builtEvidence?.installedProduct === true
  ) {
    fail("Build evidence is not labeled as a source-only upstream reference build");
  }
  if (receipt.buildReadiness?.matchesPin !== true) {
    fail("Build evidence was not produced with the exact pinned toolchain");
  }
  if (receipt.builtEvidence?.outputs?.buildType !== "upstream-reference-only") {
    fail("Build evidence does not identify an upstream-reference-only build");
  }
  return {
    status: "source-built-reference-only",
    receiptSha256: sha256Bytes(bytes),
    receiptOnly: true,
    binariesVerified: false,
    installedProduct: false,
    installProof: false,
    activationProof: false,
    classification: "not-an-installed-product",
  };
}

export async function stageCandidate({
  happierRepo = DEFAULT_HAPPIER,
  lock,
  series,
  lockPath = LOCK_PATH,
  seriesPath = SERIES_PATH,
  artifactRoot = REPO_ROOT,
  artifactDir,
  output,
  build = false,
  yarnBin = "yarn",
  bunBin = "bun",
}) {
  const evidence = await verifyUpstream({ happierRepo, lock, artifactDir });
  const patches = await verifyPatchSeries({ series, lock, artifactRoot });
  if (patches.length !== REQUIRED_PATCH_COUNT) {
    fail(`Staged candidate must contain exactly ${REQUIRED_PATCH_COUNT} ordered Happier patches`);
  }
  const candidateRepo = resolve(output);
  assertOutside(happierRepo, candidateRepo, "Candidate output");
  if (await stat(candidateRepo).catch(() => null)) {
    fail(`Refusing to overwrite existing candidate directory: ${candidateRepo}`);
  }
  await mkdir(dirname(candidateRepo), { recursive: true });
  try {
    await mkdir(candidateRepo);
  } catch {
    fail(`Refusing to reserve existing candidate directory: ${candidateRepo}`);
  }
  run(
    "git",
    [
      "--no-replace-objects",
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      happierRepo,
      candidateRepo,
    ],
    { env: sanitizedGitEnv() },
  );
  // Keep the staged bytes deterministic across Windows and Linux checkouts.
  git(candidateRepo, ["config", "core.autocrlf", "false"]);
  git(candidateRepo, ["config", "core.eol", "lf"]);
  git(candidateRepo, ["checkout", "--detach", lock.repositories.happier.commit]);
  const applied = await applyPatchSeries({ candidateRepo, patches, lock });
  const patchedTree = await computeWorktreeTree(candidateRepo, {
    includePaths: applied.flatMap((patch) => patch.fileChecks.map((check) => check.path)),
  });
  const pinnedPatchedTree = lock.repositories?.happier?.patchedTree;
  if (pinnedPatchedTree) {
    const pin = assertTreeHash(pinnedPatchedTree, "Locked Happier patched tree");
    if (patchedTree !== pin) {
      fail(`Staged patched tree ${patchedTree} does not match the composition lock pin ${pin}`);
    }
  }
  const lockSha256 = await sha256File(lockPath);
  const seriesSha256 = await sha256File(seriesPath);
  let referenceBuild = null;
  if (build) {
    referenceBuild = await buildReferenceComponents({
      candidateRepo,
      lock,
      yarnBin,
      bunBin,
    });
  }
  const readiness = buildReadiness(lock, { yarnBin, bunBin });
  const manifest = {
    schemaVersion: 1,
    receiptType: build ? "happier-reference-build" : "happier-patched-source-stage",
    disposition: SCAFFOLD_DISPOSITION,
    source: { repository: evidence.repository, commit: evidence.commit, tree: evidence.tree },
    patchedTree,
    patchedTreeBinding: pinnedPatchedTree
      ? { value: patchedTree, source: "composition-lock" }
      : { value: patchedTree, source: "recomputed-from-pinned-inputs" },
    inputs: {
      lock: { path: lockPath, sha256: lockSha256 },
      patchSeries: { path: seriesPath, sha256: seriesSha256 },
      lockSha256,
      patchSeriesSha256: seriesSha256,
    },
    patches: applied,
    verifiedReferenceArtifacts: evidence.artifacts.map(({ id, bytes, sha256 }) => ({
      id,
      bytes,
      sha256,
    })),
    productionProfiles: [],
    productionPackaging: "disabled",
    qualification: "not-run",
    builtEvidence: referenceBuild
      ? {
          status: "source-built-reference-only",
          classification: "not-an-installed-product",
          installedProduct: false,
          receiptOnly: true,
          binariesVerified: false,
          installProof: false,
          activationProof: false,
          outputs: referenceBuild,
        }
      : {
          status: "not-run",
          classification: "not-an-installed-product",
          installedProduct: false,
          receiptOnly: true,
          binariesVerified: false,
          installProof: false,
          activationProof: false,
          reason: "No selected-component build was requested for this stage.",
        },
    installation: closedInstallation(),
    buildReadiness: build ? { ...readiness, buildsAttempted: true } : readiness,
    referenceBuild,
  };
  await writeJsonExclusive(join(candidateRepo, EVIDENCE_FILE), manifest);
  return { candidateRepo, manifest };
}

export async function qualifyCandidate({
  scope,
  racRepo = REPO_ROOT,
  racCommit,
  babelRepo = DEFAULT_BABEL,
  babelCommit,
  babelTree,
  candidateRepo,
  expectedPatchedTree,
  artifactDir = "",
  buildEvidencePath = "",
  yarnBin = "yarn",
  bunBin = "bun",
}) {
  if (!["codex-only", "composition"].includes(scope)) {
    fail("Candidate qualification scope must be codex-only or composition");
  }
  if (!racCommit) fail("Candidate qualification requires an explicit --rac-commit");
  if (!candidateRepo) fail("Candidate qualification requires --candidate");

  const selectedCommit = assertFullCommit(racCommit, "RAC expected commit");
  const lockBytes = gitBlobBytes(racRepo, selectedCommit, LOCK_RELATIVE);
  const lock = parseJsonBytes(lockBytes, `composition lock at ${LOCK_RELATIVE}`);
  validateCompositionLock(lock);
  const lockSha256 = sha256Bytes(lockBytes);

  const rac = verifyRacCandidate({ racRepo, expectedCommit: selectedCommit, lock });
  const seriesBytes = gitBlobBytes(racRepo, rac.selected.commit, SERIES_RELATIVE);
  const series = parseJsonBytes(seriesBytes, `Happier patch series at ${SERIES_RELATIVE}`);
  const seriesSha256 = sha256Bytes(seriesBytes);
  const artifactRecords = validateReferenceArtifactRecords(lock);
  const patches = verifyPatchSeriesFromGit({
    series,
    lock,
    racRepo,
    racCommit: rac.selected.commit,
  });
  if (patches.length !== REQUIRED_PATCH_COUNT) {
    fail(
      `Candidate qualification requires exactly ${REQUIRED_PATCH_COUNT} ordered Happier patches`,
    );
  }
  const headAfterBlobs = git(racRepo, ["rev-parse", "HEAD"]);
  const treeAfterBlobs = git(racRepo, ["rev-parse", "HEAD^{tree}"]);
  if (headAfterBlobs !== rac.selected.commit || treeAfterBlobs !== rac.selected.tree) {
    fail("Selected RAC identity changed while reading immutable qualification blobs");
  }
  const babel =
    scope === "composition"
      ? verifyBabelCandidate({
          babelRepo,
          expectedCommit: babelCommit,
          expectedTree: babelTree,
          lock,
        })
      : {
          role: "scoped-native-agent",
          scope: "excluded",
          baseline: {
            source: "composition-lock.json",
            commit: lock.repositories?.babel?.commit ?? null,
            tree: lock.repositories?.babel?.tree ?? null,
            classification: "reviewed-baseline-provenance",
          },
          selected: null,
          identityBound: false,
          coverage: "not-covered",
          reason:
            "Codex-only candidate scope does not bind or claim coverage for the Babel candidate.",
        };

  let expectedTree = null;
  let expectedTreeSource = "recomputed-from-pinned-inputs";
  if (expectedPatchedTree) {
    expectedTree = assertTreeHash(expectedPatchedTree, "Expected patched tree");
    expectedTreeSource = "cli-argument";
  }
  const lockTreePin = lock.repositories?.happier?.patchedTree;
  if (lockTreePin) {
    const pinned = assertTreeHash(lockTreePin, "Locked Happier patched tree");
    if (expectedTree && expectedTree !== pinned) {
      fail("Explicit expected patched tree does not match the composition lock pin");
    }
    expectedTree = pinned;
    expectedTreeSource = "composition-lock";
  }

  const happier = await verifyStagedHappierCandidate({
    candidateRepo: resolve(candidateRepo),
    lock,
    patches,
    expectedPatchedTree: expectedTree,
    expectedLockSha256: lockSha256,
    expectedSeriesSha256: seriesSha256,
  });
  happier.receiptBinding = "selected-rac-commit-blobs";
  happier.patchedTreeBinding = expectedTree
    ? { value: expectedTree, source: expectedTreeSource }
    : { value: happier.selected.patchedTree, source: expectedTreeSource };

  const artifacts = artifactDir
    ? {
        status: "files-verified",
        classification: "compatibility-reference-only",
        items: await verifyArtifacts({ lock, artifactDir }),
      }
    : {
        status: "records-verified",
        classification: "compatibility-reference-only",
        items: artifactRecords,
      };

  const readiness = buildReadiness(lock, { yarnBin, bunBin });
  let builtEvidence = {
    status: "not-run",
    classification: "not-an-installed-product",
    installedProduct: false,
    receiptOnly: true,
    binariesVerified: false,
    installProof: false,
    activationProof: false,
    reason:
      "No selected-component build receipt was supplied. This structural receipt does not establish an installed product.",
  };
  if (buildEvidencePath) {
    builtEvidence = await verifyBuildEvidence({
      buildEvidencePath,
      lock,
      series,
      expectedPatchedTree: happier.selected.patchedTree,
      expectedLockSha256: lockSha256,
      expectedSeriesSha256: seriesSha256,
    });
  }

  return {
    schemaVersion: 1,
    receiptType: "rac-composition-candidate-qualification",
    disposition: "structural-qualified-source-only-not-an-installed-product",
    scope,
    observedAt: new Date().toISOString(),
    inputs: {
      binding: "selected-rac-commit-blobs",
      racCommit: rac.selected.commit,
      racTree: rac.selected.tree,
      lock: { path: LOCK_RELATIVE, sha256: lockSha256 },
      patchSeries: { path: SERIES_RELATIVE, sha256: seriesSha256 },
    },
    candidateIsolation: {
      structuralCandidate: "disposable staged checkout",
      sourceWorktreeClean: "not-claimed",
      note:
        "The receipt binds the selected commits, trees and recomputed patched tree. It does not certify the originating source worktree as clean.",
    },
    components: { rac, babel, happier },
    structuralChecks: {
      status: "pass",
      checks: [
        "rac-exact-explicit-head",
        "rac-clean-and-contains-audited-baseline",
        "rac-lockfile-matches-baseline-pin",
        "lock-series-and-patch-bytes-from-selected-rac-commit",
        scope === "composition"
          ? "babel-detached-reviewed-commit-and-tree"
          : "babel-scope-excluded-no-coverage-claim",
        "happier-pinned-base-commit-and-tree",
        "happier-five-ordered-patch-series",
        "happier-source-stage-receipt-recomputed",
        "happier-patched-tree-recomputed",
        "happier-mit-notice-preserved",
        "reference-artifacts-are-compatibility-inputs-only",
      ],
    },
    referenceArtifacts: artifacts,
    buildReadiness: readiness,
    builtEvidence,
    installation: closedInstallation(),
    productClaims: {
      installedProduct: false,
      downstreamProduct: "not-established",
      referenceArtifactsAreCompatibilityInputsOnly: true,
      gateScriptsAreNotProduct: true,
      fakeAgentsAreNotProduct: true,
    },
    coverage: {
      scope,
      agentProfiles: "not-run",
      babel: scope === "composition" ? "source-identity-only" : "not-covered",
      sourceIdentity: "structurally-bound",
      sourceWorktree: "not-covered",
      builtArtifacts: builtEvidence.status === "not-run" ? "not-covered" : "receipt-only",
      installer: "not-covered",
      nativeRuntime: "not-covered",
      windowsProcess: "not-covered",
      android: "not-covered",
    },
  };
}

function parseArgs(argv) {
  const [mode = "verify", ...args] = argv;
  if (!["verify", "stage", "build-reference", "qualify"].includes(mode)) {
    fail(
      "Usage: node distribution/build-composition.mjs [verify|stage|build-reference|qualify] [options]",
    );
  }
  const options = {
    mode,
    happierRepo: DEFAULT_HAPPIER,
    babelRepo: DEFAULT_BABEL,
    racRepo: REPO_ROOT,
    artifactDir: "",
    output: "",
    candidate: "",
    buildEvidence: "",
    yarnBin: "yarn",
    bunBin: "bun",
    scope: "",
    racCommit: "",
    babelCommit: "",
    babelTree: "",
    expectedPatchedTree: "",
  };
  const pathKeys = new Set([
    "--happier-repo",
    "--babel-repo",
    "--rac-repo",
    "--artifact-dir",
    "--output",
    "--candidate",
    "--build-evidence",
  ]);
  const valueKeys = new Set([
    "--yarn-bin",
    "--bun-bin",
    "--scope",
    "--rac-commit",
    "--babel-commit",
    "--babel-tree",
    "--expected-patched-tree",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if ((!pathKeys.has(key) && !valueKeys.has(key)) || !args[index + 1]) {
      fail(`Unknown or incomplete option: ${key}`);
    }
    const rawValue = args[++index];
    const value = pathKeys.has(key) ? resolve(rawValue) : rawValue;
    if (key === "--happier-repo") options.happierRepo = value;
    if (key === "--babel-repo") options.babelRepo = value;
    if (key === "--rac-repo") options.racRepo = value;
    if (key === "--artifact-dir") options.artifactDir = value;
    if (key === "--output") options.output = value;
    if (key === "--candidate") options.candidate = value;
    if (key === "--build-evidence") options.buildEvidence = value;
    if (key === "--yarn-bin") options.yarnBin = value;
    if (key === "--bun-bin") options.bunBin = value;
    if (key === "--scope") options.scope = value;
    if (key === "--rac-commit") options.racCommit = value;
    if (key === "--babel-commit") options.babelCommit = value;
    if (key === "--babel-tree") options.babelTree = value;
    if (key === "--expected-patched-tree") options.expectedPatchedTree = value;
  }
  if (["verify", "stage", "build-reference"].includes(mode) && !options.artifactDir) {
    fail(`${mode} requires --artifact-dir pointing to the verified upstream artifact cache`);
  }
  if (["stage", "build-reference", "qualify"].includes(mode) && !options.output) {
    fail(`${mode} requires --output`);
  }
  if (mode === "qualify") {
    if (!options.candidate) fail("qualify requires --candidate pointing to a staged candidate");
    if (!["codex-only", "composition"].includes(options.scope)) {
      fail("qualify requires --scope codex-only or --scope composition");
    }
    if (!options.racCommit) fail("qualify requires an explicit --rac-commit");
    if (
      options.scope === "composition" &&
      (!options.babelCommit || !options.babelTree)
    ) {
      fail("composition scope requires --babel-commit and --babel-tree");
    }
  }
  return options;
}

function run(command, args, { cwd, env = process.env } = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error && result.status !== 0)
    fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

function resolveYarnJs(binary) {
  const candidates = [];
  if (binary.includes(sep) || isAbsolute(binary)) candidates.push(resolve(binary));
  else {
    for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      candidates.push(join(directory, binary));
      if (process.platform === "win32") candidates.push(join(directory, `${binary}.cmd`));
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (basename(real).toLowerCase() !== "yarn.js") continue;
    return real;
  }
  fail(
    "Cannot resolve the pinned Yarn JavaScript entrypoint; pass --yarn-bin pointing to yarn/bin/yarn.js",
  );
}

async function verifyYarn(yarnBin, expectedVersion) {
  const yarnJs = resolveYarnJs(yarnBin);
  const packagePath = join(dirname(dirname(yarnJs)), "package.json");
  const metadata = await readJson(packagePath, "Yarn package metadata");
  if (metadata.name !== "yarn" || metadata.version !== expectedVersion) {
    fail(
      `Build requires Yarn ${expectedVersion}; selected package is ${metadata.name}@${metadata.version}`,
    );
  }
  return { command: process.execPath, prefixArgs: [yarnJs], version: metadata.version };
}

async function buildReferenceComponents({ candidateRepo, lock, yarnBin, bunBin }) {
  const toolchain = lock.toolchain ?? {};
  const requiredNode = toolchain.node;
  const actualNode = process.versions.node;
  if (actualNode !== requiredNode) fail(`Build requires Node ${requiredNode}; found ${actualNode}`);
  const yarn = await verifyYarn(yarnBin, toolchain.yarn);
  const bunResult = spawnSync(bunBin, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if ((bunResult.error && bunResult.status !== 0) || bunResult.status !== 0)
    fail(`Reference binary build requires Bun ${toolchain.bun}; Bun is unavailable`);
  const bunVersion = bunResult.stdout.trim();
  if (bunVersion !== toolchain.bun)
    fail(`Build requires Bun ${toolchain.bun}; found ${bunVersion}`);
  const stateRoot = join(candidateRepo, ".rac-build-state");
  const buildEnv = {
    ...process.env,
    EXPO_OFFLINE: "1",
    HAPPIER_HOME_DIR: join(stateRoot, "happier-home"),
    HAPPIER_STACK_HOME_DIR: join(stateRoot, "stack-home"),
    HAPPIER_STACK_CLI_HOME_DIR: join(stateRoot, "stack-cli-home"),
    HAPPIER_STACK_STORAGE_DIR: join(stateRoot, "stack-storage"),
    HAPPIER_STACK_WORKSPACE_DIR: join(stateRoot, "stack-workspace"),
    HAPPIER_STACK_STACK: "rac-c01-reference",
    HAPPIER_STACK_REPO_DIR: candidateRepo,
    HAPPIER_STACK_ENV_FILE: join(stateRoot, "stack.env"),
    HAPPIER_STACK_RUNTIME_STATE_PATH: join(stateRoot, "runtime-state.json"),
  };
  const yarnRun = (args) =>
    run(yarn.command, [...yarn.prefixArgs, ...args], { cwd: candidateRepo, env: buildEnv });
  yarnRun(["install", "--frozen-lockfile", "--non-interactive"]);

  // These are deliberately upstream reference builds. They do not create a RAC
  // product, enable a provider profile, or establish qualification.
  yarnRun(["-s", "build:packages"]);
  yarnRun(["workspace", "@happier-dev/cli", "build"]);
  yarnRun(["workspace", "@happier-dev/stack", "build"]);
  yarnRun(["workspace", "@happier-dev/app", "ensure:workspace:built"]);
  run(
    yarn.command,
    [
      ...yarn.prefixArgs,
      "--cwd",
      "apps/ui",
      "-s",
      "expo",
      "export",
      "--platform",
      "web",
      "--output-dir",
      "dist",
    ],
    {
      cwd: candidateRepo,
      env: { ...buildEnv, EXPO_UNSTABLE_WEB_MODAL: "1" },
    },
  );
  yarnRun(["--cwd", "apps/server", "-s", "build"]);

  // Do not invoke upstream release packaging here: its native binaries are stock
  // controller outputs and cannot be mistaken for a restricted RAC distribution.
  return {
    buildType: "upstream-reference-only",
    cli: "yarn workspace @happier-dev/cli build",
    relay: "yarn workspace @happier-dev/stack build",
    web: "yarn --cwd apps/ui -s expo export --platform web --output-dir dist",
    serverTypecheck: "yarn --cwd apps/server -s build",
    serverBinary: "not run (stock release packaging is intentionally excluded)",
    bridge: "not built; no pinned RAC-to-Babel integration patch exists yet",
    isolatedStateRoot: stateRoot,
    profilesEnabled: [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === "qualify") {
    const receipt = await qualifyCandidate({
      scope: options.scope,
      racRepo: options.racRepo,
      racCommit: options.racCommit,
      babelRepo: options.babelRepo,
      babelCommit: options.babelCommit,
      babelTree: options.babelTree,
      candidateRepo: options.candidate,
      expectedPatchedTree: options.expectedPatchedTree,
      artifactDir: options.artifactDir,
      buildEvidencePath: options.buildEvidence,
      yarnBin: options.yarnBin,
      bunBin: options.bunBin,
    });
    await writeJsonExclusive(options.output, receipt);
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  const lock = await readJson(LOCK_PATH, "composition lock");
  const series = await readJson(SERIES_PATH, "Happier patch series");

  if (options.mode === "verify") {
    const evidence = await verifyUpstream({
      happierRepo: options.happierRepo,
      lock,
      artifactDir: options.artifactDir,
    });
    const patches = await verifyPatchSeries({ series, lock });
    evidence.patchSeries = {
      baseCommit: series.base.commit,
      baseTree: series.base.tree,
      count: patches.length,
      patches: patches.map(({ order, path, sha256, description }) => ({
        order,
        path,
        sha256,
        description,
      })),
    };
    evidence.disposition = "verified-upstream-reference-only";
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  const staged = await stageCandidate({
    happierRepo: options.happierRepo,
    lock,
    series,
    lockPath: LOCK_PATH,
    seriesPath: SERIES_PATH,
    artifactRoot: REPO_ROOT,
    artifactDir: options.artifactDir,
    output: options.output,
    build: options.mode === "build-reference",
    yarnBin: options.yarnBin,
    bunBin: options.bunBin,
  });
  console.log(JSON.stringify(staged, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[composition] ${error.message}`);
    process.exitCode = 1;
  });
}
