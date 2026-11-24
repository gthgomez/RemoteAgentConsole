#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = join(REPO_ROOT, "distribution", "composition-lock.json");
const SERIES_PATH = join(REPO_ROOT, "patches", "happier", "series.json");
const DEFAULT_HAPPIER = resolve(REPO_ROOT, "..", "Happier");

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

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.error && result.status !== 0)
    fail(`git ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitFileBytes(repo, path) {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) {
    fail(`Pinned source path is unsafe: ${path}`);
  }
  const result = spawnSync("git", ["-C", repo, "show", `HEAD:${path}`], {
    encoding: "buffer",
  });
  if (result.error && result.status !== 0) {
    fail(`git show could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Pinned source file is missing from HEAD: ${path}`);
  }
  return result.stdout;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

export async function verifyArtifacts({ lock, artifactDir }) {
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
  const results = [];
  const seenIds = new Set();
  for (const item of lock.referenceArtifacts ?? []) {
    if (
      !item.id ||
      !item.fileName ||
      !/^[a-f0-9]{64}$/.test(item.sha256 ?? "") ||
      !Number.isSafeInteger(item.bytes)
    ) {
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
  const status = git(happierRepo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail(`Happier checkout is dirty; refusing to stage it:\n${status}`);

  const files = [];
  for (const [path, expected] of Object.entries(selected.lockfiles ?? {})) {
    const actual = sha256Bytes(gitFileBytes(happierRepo, path));
    if (actual !== expected)
      fail(`Happier ${path} SHA-256 mismatch: expected ${expected}, got ${actual}`);
    files.push({ path, sha256: actual });
  }
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
    lockfiles: files,
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

export async function verifyPatchSeries({ series, artifactRoot = REPO_ROOT }) {
  const selected = (await readJson(LOCK_PATH, "composition lock")).repositories?.happier;
  if (
    series.schemaVersion !== 1 ||
    series.base?.repository !== selected?.url ||
    series.base?.commit !== selected?.commit ||
    series.base?.tree !== selected?.tree
  ) {
    fail("Patch series base does not exactly match the pinned Happier commit and tree");
  }
  if (!Array.isArray(series.patches)) fail("Patch series must declare an ordered patches array");
  const seen = new Set();
  const patches = [];
  for (const [index, item] of series.patches.entries()) {
    if (!item.path || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ""))
      fail(`Patch ${index + 1} needs a path and SHA-256`);
    if (seen.has(item.path)) fail(`Patch series contains a duplicate path: ${item.path}`);
    seen.add(item.path);
    const path = resolve(artifactRoot, item.path);
    assertInside(artifactRoot, path, `Patch ${item.path}`);
    const actual = await sha256File(path);
    if (actual !== item.sha256)
      fail(`Patch ${item.path} SHA-256 mismatch: expected ${item.sha256}, got ${actual}`);
    patches.push({ order: index + 1, path, sha256: actual, description: item.description ?? "" });
  }
  return patches;
}

async function applyPatchSeries({ candidateRepo, patches }) {
  if (!patches.length) return [];
  const selected = (await readJson(LOCK_PATH, "composition lock")).repositories.happier;
  if (git(candidateRepo, ["rev-parse", "HEAD"]) !== selected.commit)
    fail("Candidate is not at the pinned Happier commit");
  const applied = [];
  for (const patch of patches) {
    const relativePatch = relative(REPO_ROOT, patch.path);
    const patchPath = resolve(REPO_ROOT, relativePatch);
    const numstat = git(candidateRepo, ["apply", "--numstat", patchPath]);
    const paths = numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").slice(2).join("\t"));
    if (
      !paths.length ||
      paths.some((path) => !path || path.startsWith("/") || path.includes("\\"))
    ) {
      fail(`Patch ${relativePatch} has no safe, reportable file paths`);
    }
    for (const path of paths) {
      if (path.split("/").some((part) => part === ".." || part === ".")) {
        fail(`Patch ${relativePatch} contains an unsafe path: ${path}`);
      }
    }
    git(candidateRepo, ["apply", "--check", patchPath]);
    git(candidateRepo, ["apply", "--whitespace=error", patchPath]);
    const fileChecks = [];
    for (const path of [...new Set(paths)]) {
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
    applied.push({ order: patch.order, path: relativePatch, sha256: patch.sha256, fileChecks });
  }
  return applied;
}

function parseArgs(argv) {
  const [mode = "verify", ...args] = argv;
  if (!["verify", "stage", "build-reference"].includes(mode)) {
    fail(
      "Usage: node distribution/build-composition.mjs [verify|stage|build-reference] --artifact-dir PATH [--happier-repo PATH] [--output PATH] [--yarn-bin PATH] [--bun-bin PATH]",
    );
  }
  const options = {
    mode,
    happierRepo: DEFAULT_HAPPIER,
    artifactDir: "",
    output: "",
    yarnBin: "yarn",
    bunBin: "bun",
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (
      !["--happier-repo", "--artifact-dir", "--output", "--yarn-bin", "--bun-bin"].includes(key) ||
      !args[index + 1]
    )
      fail(`Unknown or incomplete option: ${key}`);
    const rawValue = args[++index];
    const value = key.endsWith("-bin") ? rawValue : resolve(rawValue);
    if (key === "--happier-repo") options.happierRepo = value;
    if (key === "--artifact-dir") options.artifactDir = value;
    if (key === "--output") options.output = value;
    if (key === "--yarn-bin") options.yarnBin = value;
    if (key === "--bun-bin") options.bunBin = value;
  }
  if (!options.artifactDir)
    fail(`${mode} requires --artifact-dir pointing to the verified upstream artifact cache`);
  if (mode !== "verify" && !options.output)
    fail(`${mode} requires --output pointing to a new disposable directory`);
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
  const lock = await readJson(LOCK_PATH, "composition lock");
  const series = await readJson(SERIES_PATH, "Happier patch series");
  const evidence = await verifyUpstream({
    happierRepo: options.happierRepo,
    lock,
    artifactDir: options.artifactDir,
  });
  const patches = await verifyPatchSeries({ series });
  evidence.patchSeries = {
    baseCommit: series.base.commit,
    baseTree: series.base.tree,
    count: patches.length,
    patches,
  };
  if (options.mode === "verify") {
    evidence.disposition = "verified-upstream-reference-only";
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  const candidateRepo = options.output;
  assertOutside(options.happierRepo, candidateRepo, "Candidate output");
  if (await stat(candidateRepo).catch(() => null))
    fail(`Refusing to overwrite existing candidate directory: ${candidateRepo}`);
  await mkdir(dirname(candidateRepo), { recursive: true });
  try {
    await mkdir(candidateRepo);
  } catch {
    fail(`Refusing to reserve existing candidate directory: ${candidateRepo}`);
  }
  run("git", ["clone", "--no-hardlinks", "--no-checkout", options.happierRepo, candidateRepo]);
  git(candidateRepo, ["checkout", "--detach", lock.repositories.happier.commit]);
  const applied = await applyPatchSeries({ candidateRepo, patches });
  let referenceBuild = null;
  if (options.mode === "build-reference") {
    referenceBuild = await buildReferenceComponents({
      candidateRepo,
      lock,
      yarnBin: options.yarnBin,
      bunBin: options.bunBin,
    });
  }
  const manifest = {
    schemaVersion: 1,
    disposition: "scaffold-only-not-a-production-or-qualified-package",
    source: { repository: evidence.repository, commit: evidence.commit, tree: evidence.tree },
    patches: applied,
    verifiedReferenceArtifacts: evidence.artifacts.map(({ id, bytes, sha256 }) => ({
      id,
      bytes,
      sha256,
    })),
    productionProfiles: [],
    productionPackaging: "disabled",
    qualification: "not-run",
    referenceBuild,
  };
  await writeFile(
    join(candidateRepo, "rac-composition-evidence.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify({ candidateRepo, manifest }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[composition] ${error.message}`);
    process.exitCode = 1;
  });
}
