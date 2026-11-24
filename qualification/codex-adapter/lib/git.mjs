import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read-only access to pinned Git objects through a scratch repository.
 *
 * The caller supplies owner-trusted absolute `git`/`tar` executables and a
 * sanitized environment. No executable is resolved from PATH here.
 */
export function git({
  gitPath,
  env,
  gitDir,
  args,
  encoding = "utf8",
  maxBuffer = 256 * 1024 * 1024,
}) {
  const result = spawnSync(gitPath, ["--git-dir", gitDir, ...args], {
    env,
    encoding,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function gitOrThrow(options) {
  const result = git(options);
  if (result.status !== 0) {
    throw new Error(`git ${options.args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

/** Creates a scratch bare repo whose alternates are the pinned object stores. */
export async function createScratchRepository({ gitPath, env, parent, objectDirs }) {
  const gitDir = join(parent, "scratch.git");
  await mkdir(gitDir, { recursive: true });
  const init = spawnSync(gitPath, ["init", "--bare", gitDir], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const alternates = objectDirs.map((dir) => join(dir)).join("\n");
  await writeFile(join(gitDir, "objects", "info", "alternates"), `${alternates}\n`, "utf8");
  return gitDir;
}

export function objectType(options) {
  const result = git({ ...options, args: ["cat-file", "-t", options.objectId] });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function blobHashAt(options) {
  return gitOrThrow({
    ...options,
    args: ["rev-parse", `${options.revision}:${options.path}`],
  }).trim();
}

export function readBlob(options) {
  const result = git({
    ...options,
    args: ["show", `${options.revision}:${options.path}`],
    maxBuffer: options.maxBytes ?? 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git show ${options.revision}:${options.path} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

/** Extracts selected paths from a tree without touching any checkout. */
export async function archiveTo({
  tarPath,
  tarEnv,
  revision,
  paths,
  destination,
  maxBytes,
  ...gitOptions
}) {
  await mkdir(destination, { recursive: true });
  const result = git({
    ...gitOptions,
    args: ["archive", revision, ...paths],
    encoding: "buffer",
    maxBuffer: maxBytes ?? 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git archive failed: ${String(result.stderr).trim()}`);
  }
  const tarFile = join(destination, "archive.tar");
  await writeFile(tarFile, result.stdout);
  const extract = spawnSync(tarPath, ["-xf", tarFile, "-C", destination], {
    env: tarEnv,
    encoding: "utf8",
    windowsHide: true,
  });
  await rm(tarFile, { force: true });
  if (extract.status !== 0) throw new Error(`tar extraction failed: ${extract.stderr}`);
  return destination;
}

/** Git blob id for an in-memory file, used to prove the patched file identity. */
export function gitBlobHash(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256Bytes(content) {
  return createHash("sha256").update(content).digest("hex");
}
