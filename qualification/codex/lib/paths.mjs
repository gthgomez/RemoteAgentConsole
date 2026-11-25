import { access } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

/** Absolute-path predicate that rejects drive-relative and cwd-relative forms. */
export function isAbsolutePath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value);
  }
  return value.startsWith("/");
}

function comparable(value, platform) {
  const resolved = resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` or below it, after resolution. */
export function isPathInside(root, candidate, platform = process.platform) {
  if (!root || !candidate) return false;
  const rootPath = comparable(root, platform);
  const candidatePath = comparable(candidate, platform);
  if (rootPath === candidatePath) return true;
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath.startsWith(prefix);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guards disposal so only the directory this run created, directly under the
 * requested temp parent, can be removed.
 */
export function assertOwnedTempDirectory(created, parent) {
  const resolvedParent = resolve(parent);
  const resolvedCreated = resolve(created);
  if (dirname(resolvedCreated) !== resolvedParent) {
    throw new Error("refusing to manage a temp directory outside the requested temp root");
  }
  if (!basename(resolvedCreated).startsWith("rac-codex-conformance-")) {
    throw new Error("refusing to manage a temp directory without the harness prefix");
  }
  return resolvedCreated;
}

/**
 * Evidence files are receipts: an existing path is never replaced. There is no
 * override flag; publish to a new path instead.
 */
export async function assertEvidenceTarget(path) {
  const resolved = resolve(path);
  if (await exists(resolved)) {
    throw new Error("evidence file already exists; write the receipt to a new path");
  }
  return resolved;
}

export async function pathExists(path) {
  return exists(path);
}
