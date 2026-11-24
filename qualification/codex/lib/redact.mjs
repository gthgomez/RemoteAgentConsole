const ROOT_PLACEHOLDERS = [
  { pattern: /\\Users\\[^\\]+/gi, replacement: "\\Users\\%USER%" },
  { pattern: /\bD:\\AgentData\b/gi, replacement: "%AGENT_DATA%" },
  { pattern: /\bD:\\Workspace\b/gi, replacement: "%WORKSPACE%" },
];

/**
 * Redacts machine-specific absolute paths from evidence strings.
 *
 * Evidence must stay attributable without publishing the operator's home
 * directory, workspace layout or clone locations.
 */
export function redactString(value, extraRoots = []) {
  if (typeof value !== "string") return value;
  let output = value;
  for (const { root, placeholder } of extraRoots) {
    if (!root) continue;
    output = output.split(root).join(placeholder);
    output = output.split(root.replaceAll("\\", "/")).join(placeholder);
  }
  for (const { pattern, replacement } of ROOT_PLACEHOLDERS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactValue(value, extraRoots = []) {
  if (typeof value === "string") return redactString(value, extraRoots);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, extraRoots));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactValue(entry, extraRoots);
    }
    return output;
  }
  return value;
}

export function maskId(value) {
  if (typeof value !== "string" || value.length < 12) return value ?? null;
  return `${value.slice(0, 8)}…`;
}
