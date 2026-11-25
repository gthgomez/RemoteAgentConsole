import { spawn } from "node:child_process";
import { describeExit } from "./harness-policy.mjs";

/**
 * Minimal JSON-RPC 2.0 client for `codex app-server` over stdio.
 *
 * Deliberately narrow: newline-delimited frames with a hard byte cap (checked
 * even when the newline already arrived), bounded total frames, notifications
 * and pending requests, bounded stderr, and shutdown of exactly the child this
 * session created. No socket, listener, daemon or shared server is involved.
 */

export const DEFAULT_LIMITS = Object.freeze({
  requestTimeoutMs: 60000,
  frameLimitBytes: 1024 * 1024,
  maxFrames: 2000,
  maxNotifications: 500,
  maxPendingRequests: 8,
  stderrByteLimit: 64 * 1024,
  processTimeoutMs: 300000,
  exitTimeoutMs: 10000,
  killGraceMs: 3000,
});

class SessionFault extends Error {}

export class AppServerSession {
  #child;
  #limits;
  #pending = new Map();
  #buffer = "";
  #nextId = 1;
  #closed = false;
  #closeResult = null;
  #faults = [];
  #unparsed = 0;
  #frames = 0;
  #notificationsSeen = 0;
  #unexpectedServerRequests = 0;
  #methodsSent = [];
  #notifications = [];
  #stderr = "";
  #stderrBytes = 0;
  #stderrTruncated = false;
  #exitPromise;
  #processTimer;

  constructor({ child, limits }) {
    this.#child = child;
    this.#limits = limits;
    this.#exitPromise = new Promise((resolvePromise) => {
      child.on("close", (code, signal) => resolvePromise({ code, signal }));
    });
    this.#processTimer = setTimeout(() => {
      this.#faults.push(`process lifetime exceeded ${limits.processTimeoutMs}ms`);
      this.#killChild();
    }, limits.processTimeoutMs);
    this.#processTimer.unref?.();
  }

  static async open({ exePath, args, cwd, env, limits = DEFAULT_LIMITS }) {
    const resolvedLimits = { ...DEFAULT_LIMITS, ...limits };
    const child = spawn(exePath, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = new AppServerSession({ child, limits: resolvedLimits });
    session.#attach();
    await new Promise((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    return session;
  }

  #attach() {
    const child = this.#child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      this.#buffer += chunk;
      if (this.#buffer.length > this.#limits.frameLimitBytes && !this.#buffer.includes("\n")) {
        this.#fail(
          `stdout buffer exceeded ${this.#limits.frameLimitBytes} bytes without a newline`,
        );
        return;
      }
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        this.#frames += 1;
        if (this.#frames > this.#limits.maxFrames) {
          this.#fail(`frame count exceeded ${this.#limits.maxFrames}`);
          return;
        }
        if (Buffer.byteLength(line, "utf8") > this.#limits.frameLimitBytes) {
          this.#fail(`single frame exceeded ${this.#limits.frameLimitBytes} bytes`);
          return;
        }
        if (line) this.#handleLine(line);
        if (this.#closed) return;
        index = this.#buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      const bytes = Buffer.byteLength(text, "utf8");
      if (this.#stderrBytes >= this.#limits.stderrByteLimit) {
        this.#stderrTruncated = true;
        return;
      }
      const remaining = this.#limits.stderrByteLimit - this.#stderrBytes;
      if (bytes <= remaining) {
        this.#stderr += text;
        this.#stderrBytes += bytes;
        return;
      }
      const slice = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
      this.#stderr += slice;
      this.#stderrBytes += Buffer.byteLength(slice, "utf8");
      this.#stderrTruncated = true;
    });

    child.on("error", (error) => {
      this.#fail(`process error: ${error.message}`);
      this.#rejectPending(new SessionFault("process error"));
    });

    child.on("close", (code, signal) => {
      clearTimeout(this.#processTimer);
      if (code !== 0 && !this.#closed) {
        this.#faults.push(`process exited before close with code ${code}`);
      }
      this.#rejectPending(
        new SessionFault(`app-server exited (code ${code}, signal ${signal ?? "none"})`),
      );
    });
  }

  #fail(reason) {
    this.#faults.push(reason);
    this.#killChild();
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#unparsed += 1;
      return;
    }
    const hasId = typeof message.id !== "undefined";
    const hasResultOrError = message.result !== undefined || message.error !== undefined;
    if (hasId && hasResultOrError) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#unparsed += 1;
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    if (hasId && typeof message.method === "string") {
      // A server-initiated request (for example an approval). The harness never
      // answers these and must never auto-approve; treat it as an unexpected
      // peer request and stop the session.
      this.#unexpectedServerRequests += 1;
      this.#fail(`unexpected server request: ${message.method}`);
      return;
    }
    if (typeof message.method === "string") {
      this.#notificationsSeen += 1;
      if (this.#notificationsSeen > this.#limits.maxNotifications) {
        this.#fail(`notification count exceeded ${this.#limits.maxNotifications}`);
        return;
      }
      this.#notifications.push({ method: message.method });
    }
  }

  #rejectPending(error) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #send(payload) {
    if (this.#closed) throw new SessionFault("session already closed");
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params = {}, timeoutMs = this.#limits.requestTimeoutMs) {
    if (this.#pending.size >= this.#limits.maxPendingRequests) {
      return Promise.reject(new SessionFault("pending request cap reached"));
    }
    const id = this.#nextId++;
    this.#methodsSent.push(method);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#faults.push(`request ${method} exceeded ${timeoutMs}ms`);
        reject(new SessionFault(`request timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#methodsSent.push(method);
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.#send(payload);
  }

  #killChild() {
    try {
      this.#child.kill();
    } catch {
      // The close handler records the observed exit, if any.
    }
  }

  async #waitExit(timeoutMs) {
    return Promise.race([
      this.#exitPromise,
      new Promise((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  async close() {
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    let forcedKill = false;
    try {
      this.#child.stdin.end();
    } catch {
      // stdin may already be destroyed.
    }
    let exit = await this.#waitExit(this.#limits.exitTimeoutMs);
    const timedOut = exit === null;
    if (timedOut) {
      forcedKill = true;
      this.#faults.push(`graceful close exceeded ${this.#limits.exitTimeoutMs}ms`);
      this.#killChild();
      exit = await this.#waitExit(this.#limits.killGraceMs);
    }
    clearTimeout(this.#processTimer);
    this.#rejectPending(new SessionFault("session closed"));
    this.#closeResult = describeExit({
      observed: exit !== null,
      code: exit?.code,
      signal: exit?.signal,
      timedOut: exit === null,
      forcedKill,
      exitAfterKill: forcedKill && exit !== null,
    });
    return this.#closeResult;
  }

  get diagnostics() {
    return {
      pid: this.#child.pid ?? null,
      methodsSent: [...this.#methodsSent],
      notificationMethods: [...new Set(this.#notifications.map(({ method }) => method))],
      notificationCount: this.#notificationsSeen,
      frames: this.#frames,
      unparsedFrames: this.#unparsed,
      unexpectedServerRequests: this.#unexpectedServerRequests,
      stderrText: this.#stderr,
      stderrBytes: this.#stderrBytes,
      stderrTruncated: this.#stderrTruncated,
      faults: [...this.#faults],
      pending: this.#pending.size,
    };
  }

  get notifications() {
    return [...this.#notifications];
  }
}
