import { createHash } from "node:crypto";

/** Byte-bounded capture used for every child stdout/stderr receipt. */
export function createByteBoundedBuffer(limitBytes) {
  let text = "";
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const value = typeof chunk === "string" ? chunk : String(chunk);
      if (!value) return;
      const valueBytes = Buffer.byteLength(value, "utf8");
      if (bytes >= limitBytes) {
        truncated = true;
        return;
      }
      if (bytes + valueBytes <= limitBytes) {
        text += value;
        bytes += valueBytes;
        return;
      }
      const remaining = limitBytes - bytes;
      const slice = Buffer.from(value, "utf8").subarray(0, remaining).toString("utf8");
      text += slice;
      bytes += Buffer.byteLength(slice, "utf8");
      truncated = true;
    },
    get text() {
      return text;
    },
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    summary() {
      return { bytes, truncated, sha256: sha256Text(text) };
    },
  };
}

export function sha256Text(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

/**
 * Converts a caught error or JSON-RPC error into fixed scalar receipt fields.
 * The message itself is never retained, only its digest and byte length.
 */
export function scalarError(error) {
  if (!error) return null;
  const message = typeof error.message === "string" ? error.message : "";
  return {
    code: typeof error.code === "number" ? error.code : null,
    messageSha256: sha256Text(message),
    messageBytes: Buffer.byteLength(message, "utf8"),
  };
}

/** Only a strict CLI version label is retained; anything else is hashed only. */
export function versionLabel(stdout) {
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(String(stdout ?? "").trim());
  return match ? match[0] : null;
}
