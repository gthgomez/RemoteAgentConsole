const GENERIC_RULES = [{ pattern: /\\Users\\[^\\]+/gi, replacement: "\\Users\\%USER%" }];

/**
 * Applies only caller-supplied exact roots plus generic user-home masking.
 * No machine-specific evidence or repository root is hardcoded here.
 */
export function redactString(value, roots = []) {
  if (typeof value !== "string") return value;
  let output = value;
  for (const { root, placeholder } of roots) {
    if (!root) continue;
    const normalized = root.replace(/[\\/]+$/, "");
    if (!normalized) continue;
    output = output.split(normalized).join(placeholder);
    output = output.split(normalized.replaceAll("\\", "/")).join(placeholder);
  }
  for (const { pattern, replacement } of GENERIC_RULES)
    output = output.replace(pattern, replacement);
  return output;
}

export function redactValue(value, roots = []) {
  if (typeof value === "string") return redactString(value, roots);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, roots));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactValue(entry, roots);
    }
    return output;
  }
  return value;
}
