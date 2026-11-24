import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { isAbsolutePath, isPathInside } from "./paths.mjs";

/**
 * Native Codex CLI identity resolution.
 *
 * Everything in this module is metadata-only until `verifyBinaryIdentity` runs;
 * no Codex process is launched. Resolution refuses relative launchers, relative
 * PATH entries, metadata that escapes the vendor target and reparse-point
 * entrypoints, so a wrong or redirected binary is rejected before execution.
 */

const TARGETS = {
  "win32-x64": { packageName: "@openai/codex-win32-x64", targetTriple: "x86_64-pc-windows-msvc" },
  "win32-arm64": {
    packageName: "@openai/codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
  },
  "linux-x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
  },
  "linux-arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "darwin-x64": { packageName: "@openai/codex-darwin-x64", targetTriple: "x86_64-apple-darwin" },
  "darwin-arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
};

const SHIM_EXTENSIONS = process.platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];

/** Magic classification reads at most this many bytes, never the whole binary. */
const MAGIC_BYTES = 16;

export function platformTarget(platform = process.platform, arch = process.arch) {
  return TARGETS[`${platform}-${arch}`] ?? null;
}

export function classifyMagic(buffer) {
  if (!buffer || buffer.length < 4) return "unknown";
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return "pe";
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    return "elf";
  }
  const bigEndian = buffer.readUInt32BE(0);
  if ([0xcffaedfe, 0xfeedface, 0xfeedfacf, 0xcefaedfe].includes(bigEndian)) return "macho";
  return "unknown";
}

export async function fileMagic(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAGIC_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return classifyMagic(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function findOnPath(command, env) {
  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue.split(delimiter).filter(Boolean);
  let rejectedCount = 0;
  for (const directory of directories) {
    if (!isAbsolutePath(directory)) {
      rejectedCount += 1;
      continue;
    }
    for (const extension of SHIM_EXTENSIONS) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return { shimPath: candidate, rejectedPathEntries: rejectedCount };
      }
    }
  }
  return { shimPath: null, rejectedPathEntries: rejectedCount };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function isReparse(stats) {
  return Boolean(stats?.isSymbolicLink?.());
}

async function readJson(path, maxBytes = 64 * 1024) {
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error("metadata path is not a regular file");
  if (stats.size > maxBytes) throw new Error("metadata file exceeds the bounded read size");
  return JSON.parse(await readFile(path, "utf8"));
}

async function locateCodexPackage(shimPath) {
  const shimDirectory = dirname(shimPath);
  const candidates = [
    join(shimDirectory, "node_modules", "@openai", "codex", "package.json"),
    join(dirname(shimDirectory), "node_modules", "@openai", "codex", "package.json"),
  ];
  for (const candidate of candidates) {
    const stats = await lstatOrNull(candidate);
    if (!stats) continue;
    if (!stats.isFile()) continue;
    if (isReparse(stats)) continue;
    return { packagePath: candidate, packageRoot: dirname(candidate) };
  }
  return null;
}

function safeRelativeEntrypoint(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isAbsolutePath(value)) return null;
  if (/^[A-Za-z]:/.test(value)) return null;
  if (value.split(/[\\/]/).includes("..")) return null;
  return value;
}

async function findVendoredEntrypoint(packageRoot, spec) {
  const nestedVendorRoot = join(packageRoot, "node_modules", spec.packageName);
  const hoistedVendorRoot = join(dirname(dirname(packageRoot)), spec.packageName);
  for (const vendorRoot of [nestedVendorRoot, hoistedVendorRoot]) {
    const targetDirectory = join(vendorRoot, "vendor", spec.targetTriple);
    const metadataPath = join(targetDirectory, "codex-package.json");
    const metadataStats = await lstatOrNull(metadataPath);
    if (!metadataStats) continue;
    const containment = {
      metadataInsideTarget: isPathInside(targetDirectory, metadataPath),
      metadataIsFile: metadataStats.isFile(),
      metadataIsReparsePoint: isReparse(metadataStats),
      entrypointRelative: null,
      entrypointInsideTarget: false,
      entrypointIsFile: false,
      entrypointIsReparsePoint: false,
      reparseChecks: 2,
    };
    if (!containment.metadataInsideTarget || !containment.metadataIsFile) continue;
    if (containment.metadataIsReparsePoint) {
      return { error: "codex-package.json is a reparse point", containment };
    }
    let metadata;
    try {
      metadata = await readJson(metadataPath);
    } catch {
      return { error: "codex-package.json unreadable", containment };
    }
    const relative = safeRelativeEntrypoint(metadata.entrypoint);
    if (!relative) {
      return { error: "codex-package.json entrypoint is not a safe relative path", containment };
    }
    const entrypoint = resolve(targetDirectory, relative);
    const entrypointStats = await lstatOrNull(entrypoint);
    containment.entrypointRelative = relative;
    containment.entrypointInsideTarget = isPathInside(targetDirectory, entrypoint);
    containment.entrypointIsFile = Boolean(entrypointStats?.isFile());
    containment.entrypointIsReparsePoint = isReparse(entrypointStats);
    containment.reparseChecks += 2;
    if (!containment.entrypointInsideTarget) {
      return { error: "codex-package.json entrypoint escapes the vendor target", containment };
    }
    if (!entrypointStats) {
      return { error: "vendored entrypoint does not exist", containment };
    }
    if (!containment.entrypointIsFile) {
      return { error: "vendored entrypoint is not a regular file", containment };
    }
    if (containment.entrypointIsReparsePoint) {
      return { error: "vendored entrypoint is a reparse point", containment };
    }
    return {
      vendorRoot,
      metadataPath,
      metadata,
      targetDirectory,
      entrypoint,
      containment,
    };
  }
  return null;
}

/**
 * Resolves the launcher to a native executable using metadata only.
 * Never executes the binary.
 */
export async function resolveCodexBinary({ explicitPath, env = process.env, platform, arch } = {}) {
  const record = {
    status: "unresolved",
    resolution: null,
    shimPath: null,
    nativePath: null,
    packageVersion: null,
    targetTriple: null,
    rejectedPathEntries: 0,
    reason: null,
  };
  const spec = platformTarget(platform, arch);
  if (!spec) {
    record.reason = `no pinned Codex platform package map for ${platform}/${arch}`;
    return record;
  }
  record.targetTriple = spec.targetTriple;

  let shimPath;
  if (explicitPath) {
    if (!isAbsolutePath(explicitPath)) {
      record.reason =
        "explicit launcher path must be absolute; relative paths are unsafe by default";
      return record;
    }
    shimPath = resolve(explicitPath);
    const stats = await lstatOrNull(shimPath);
    if (!stats) {
      record.shimPath = shimPath;
      record.reason = "the supplied launcher path does not exist";
      return record;
    }
    if (isReparse(stats)) {
      record.shimPath = shimPath;
      record.reason = "the supplied launcher is a reparse point";
      return record;
    }
  } else {
    const lookup = findOnPath("codex", env);
    record.rejectedPathEntries = lookup.rejectedPathEntries;
    shimPath = lookup.shimPath;
    if (!shimPath) {
      record.reason = "codex was not found on an absolute PATH entry";
      return record;
    }
  }
  record.shimPath = shimPath;

  let shimMagic;
  try {
    shimMagic = await fileMagic(shimPath);
  } catch {
    record.reason = "launcher unreadable";
    return record;
  }
  if (shimMagic !== "unknown") {
    record.status = "resolved";
    record.resolution = "native-direct";
    record.nativePath = shimPath;
    record.nativeMagic = shimMagic;
    return record;
  }

  const located = await locateCodexPackage(shimPath);
  if (!located) {
    record.reason = "launcher found but @openai/codex package metadata was not beside it";
    return record;
  }
  const packageRootStats = await lstatOrNull(located.packageRoot);
  if (!packageRootStats?.isDirectory()) {
    record.reason = "@openai/codex package root is not a directory";
    return record;
  }
  const packageJson = await readJson(located.packagePath);
  record.packageVersion = packageJson.version ?? null;
  record.packageMetadataPath = located.packagePath;

  const vendored = await findVendoredEntrypoint(located.packageRoot, spec);
  if (!vendored) {
    record.reason = `package ${spec.packageName} for ${spec.targetTriple} is not installed beside the launcher`;
    return record;
  }
  record.containment = vendored.containment ?? null;
  if (vendored.error) {
    record.reason = vendored.error;
    return record;
  }
  const entryMagic = await fileMagic(vendored.entrypoint).catch(() => "unknown");
  if (entryMagic === "unknown") {
    record.nativePath = vendored.entrypoint;
    record.reason = "vendored entrypoint is not a recognised native executable";
    return record;
  }
  if (vendored.metadata.version && packageJson.version !== vendored.metadata.version) {
    record.nativePath = vendored.entrypoint;
    record.reason = `launcher package ${packageJson.version} and vendored binary ${vendored.metadata.version} disagree`;
    return record;
  }
  record.status = "resolved";
  record.resolution = "npm-shim-to-vendored-native";
  record.nativePath = vendored.entrypoint;
  record.nativeMagic = entryMagic;
  return record;
}

/**
 * Hashes and classifies the resolved binary, then compares against the pinned
 * or owner-supplied digest. Callers must treat `matchesExpected !== true` as a
 * hard stop BEFORE any execution.
 */
export async function verifyBinaryIdentity(nativePath, expectedSha256) {
  const stats = await stat(nativePath);
  const sha256 = await sha256File(nativePath);
  const magic = await fileMagic(nativePath);
  const expected = typeof expectedSha256 === "string" ? expectedSha256.trim().toLowerCase() : null;
  let matchesExpected = null;
  if (expected) {
    matchesExpected = /^[0-9a-f]{64}$/.test(expected) ? sha256 === expected : false;
  }
  return {
    sha256,
    bytes: stats.size,
    magic,
    expectedSha256: expected,
    expectedDigestWellFormed: expected ? /^[0-9a-f]{64}$/.test(expected) : null,
    matchesExpected,
  };
}
