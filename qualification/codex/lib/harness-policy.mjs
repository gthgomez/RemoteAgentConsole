import { isAbsolutePath } from "./paths.mjs";

/**
 * Explicit child-environment policy.
 *
 * The app-server child receives a fixed allowlist plus isolated home variables.
 * No arbitrary ambient variable is forwarded, so the run cannot inherit an
 * interactive identity, credential or unrelated tool setting by accident.
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
]);

export const ISOLATED_ENV_NAMES = Object.freeze([
  "CODEX_HOME",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
]);

/**
 * Best-effort egress containment only. A closed loopback port is not an OS
 * firewall and this does not enforce network isolation.
 */
export const CONTAINMENT_ENV = Object.freeze({
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  ALL_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "",
});

export const CONTAINMENT_NOTE =
  "Closed-port proxy variables plus the absence of observed attempts are containment evidence, not OS-enforced network isolation.";

const PATH_SEPARATOR = process.platform === "win32" ? ";" : ":";

/** Keeps only absolute, existing-shape PATH entries; relative entries are rejected. */
export function sanitizePathList(value, platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  const kept = [];
  const rejected = [];
  for (const part of String(value ?? "").split(separator)) {
    const trimmed = part.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    if (!isAbsolutePath(trimmed, platform)) {
      rejected.push(trimmed);
      continue;
    }
    if (!kept.includes(trimmed)) kept.push(trimmed);
  }
  return { kept, rejected, value: kept.join(separator) };
}

export function buildChildEnv({ baseEnv, platform = process.platform, isolated }) {
  const env = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  const pathResult = sanitizePathList(baseEnv.PATH ?? baseEnv.Path ?? "", platform);
  const systemRoot = baseEnv.SYSTEMROOT ?? baseEnv.SystemRoot ?? "";
  const safeDefaults =
    platform === "win32" && systemRoot
      ? [`${systemRoot}\\System32`, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`, systemRoot]
      : [];
  const pathEntries = [...new Set([...safeDefaults, ...pathResult.kept])];
  env.PATH = pathEntries.join(platform === "win32" ? ";" : ":");
  if (platform === "win32" && !env.PATHEXT) env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  Object.assign(env, isolated, CONTAINMENT_ENV, { RUST_LOG: "warn", NO_COLOR: "1" });
  const ambientNames = Object.keys(baseEnv).filter(Boolean);
  const excludedAmbientCount = ambientNames.filter(
    (name) => !CHILD_ENV_ALLOWLIST.includes(name),
  ).length;
  return {
    env,
    allowlist: [
      ...CHILD_ENV_ALLOWLIST,
      ...ISOLATED_ENV_NAMES,
      ...Object.keys(CONTAINMENT_ENV),
      "RUST_LOG",
      "NO_COLOR",
    ],
    rejectedPathEntries: pathResult.rejected,
    excludedAmbientCount,
  };
}

/** Consistent exit description: `forcedKill` never implies a confirmed exit. */
export function describeExit({ observed, code, signal, timedOut, forcedKill, exitAfterKill }) {
  const confirmedExit = Boolean(observed) && !timedOut;
  const gracefulTimedOut = Boolean(forcedKill);
  return {
    confirmedExit,
    exitCode: confirmedExit ? (code ?? null) : null,
    signal: confirmedExit ? (signal ?? null) : null,
    timedOut: Boolean(timedOut),
    gracefulTimedOut,
    forcedKill: Boolean(forcedKill),
    exitAfterKill: Boolean(exitAfterKill),
    graceful: confirmedExit && code === 0 && !forcedKill,
  };
}

const TEST_PATH_PATTERN = /(\.test\.|\.spec\.|(^|\/)(tests?|testkit|__tests__|fixtures?)\/)/i;

export function isTestPath(location) {
  return TEST_PATH_PATTERN.test(location);
}

const DOUBLE_QUOTED_METHOD = /"((?:thread|turn|item)\/[A-Za-z0-9/_.-]+)"/;
const SINGLE_QUOTED_METHOD = /'((?:thread|turn|item)\/[A-Za-z0-9/_.-]+)'/;

/** Extracts a literal thread/turn/item method name in either quote form. */
export function parseMethodLiteral(payload) {
  return DOUBLE_QUOTED_METHOD.exec(payload)?.[1] ?? SINGLE_QUOTED_METHOD.exec(payload)?.[1] ?? null;
}

/**
 * Classifies method-name usages over ALL occurrences. The retained `locations`
 * sample is deliberately shorter than the classification window.
 */
export function classifyUsages(entries, schemaMethods) {
  const records = new Map();
  for (const { method, location } of entries) {
    if (typeof method !== "string") continue;
    const record = records.get(method) ?? {
      method,
      occurrences: 0,
      testOccurrences: 0,
      testLocations: [],
      productionLocations: [],
    };
    record.occurrences += 1;
    if (isTestPath(location)) {
      record.testOccurrences += 1;
      if (record.testLocations.length < 3) record.testLocations.push(location);
    } else if (record.productionLocations.length < 3) {
      record.productionLocations.push(location);
    }
    records.set(method, record);
  }
  const absent = [...records.values()]
    .filter((record) => !schemaMethods.has(record.method))
    .map((record) => ({
      method: record.method,
      occurrences: record.occurrences,
      testOccurrences: record.testOccurrences,
      testOnly: record.testOccurrences === record.occurrences,
      productionLocations: record.productionLocations,
      testLocations: record.testLocations,
    }))
    .sort((left, right) => left.method.localeCompare(right.method));
  return { totalMethods: records.size, absent };
}

export { PATH_SEPARATOR };
