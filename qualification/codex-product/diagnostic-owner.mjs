import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function latch() {
  let resolve;
  const result = new Promise((take) => { resolve = take; });
  return { result, resolve };
}

// Diagnostic harness only. This module is not imported by the controller or relay.
export async function openDiagnosticOwner({ ownerExe, codexExe, scratch, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== "win32" || process.arch !== "x64"
    || ![ownerExe, codexExe, scratch, process.env.SystemRoot].every((path) => typeof path === "string" && isAbsolute(path))) {
    throw new Error("diagnostic_owner_requires_absolute_windows_x64_inputs");
  }
  const system = process.env.SystemRoot;
  const child = spawn(ownerExe, [codexExe, scratch], {
    shell: false, windowsHide: true, cwd: win32.dirname(ownerExe), stdio: ["pipe", "pipe", "pipe"],
    env: {
      SystemRoot: system, WINDIR: system, PATH: win32.join(system, "System32"),
      TEMP: win32.join(scratch, "temp"), TMP: win32.join(scratch, "temp"),
    },
  });
  const ready = latch();
  const closed = latch();
  const observers = new Set();
  let failure;
  let pending;
  let settleRecord;
  let stopping = false;
  let started = false;
  let closeWork;
  let control = "";

  const fail = (reason) => {
    if (failure) return;
    failure = new Error(`diagnostic_owner_${reason}`);
    pending?.reject(failure);
    pending = undefined;
    ready.resolve(false);
    for (const handler of observers) {
      try { handler(failure); } catch { /* Do not stop other observers. */ }
    }
  };
  child.stdin.on("error", () => fail("carrier_input"));
  child.stdout.on("error", () => fail("carrier_output"));
  child.stderr.on("error", () => fail("carrier_control"));
  child.on("error", () => fail("carrier_start"));
  child.once("close", (code, signalName) => {
    if (!stopping) fail("carrier_closed");
    closed.resolve({ code, signal: signalName !== null });
  });
  child.stderr.setEncoding("ascii");
  child.stderr.on("data", (chunk) => {
    control += chunk;
    while (control.includes("\n")) {
      const index = control.indexOf("\n");
      const line = control.slice(0, index).replace(/\r$/, "");
      control = control.slice(index + 1);
      if (!started && line === "R") {
        started = true;
        ready.resolve(true);
      } else if (line === "W" && pending) {
        const write = pending;
        pending = undefined;
        write.resolve();
      } else if (line === "N" || line === "U") {
        fail(line === "N" ? "native_refused" : "native_delivery_unknown");
      } else {
        const result = /^S ([01]) ([01]) ([01]) (0|[1-9][0-9]{0,8})$/.exec(line);
        if (!result || settleRecord) {
          fail("protocol");
        } else {
          settleRecord = Object.freeze({
            rootEmpty: result[1] === "1", jobEmpty: result[2] === "1",
            ioComplete: result[3] === "1", submittedWrites: Number(result[4]),
          });
          // A terminal from the owner while serving is not intentional user disposal.
          if (!stopping) fail("native_ended");
        }
      }
    }
    if (control.length > 128) {
      control = "";
      fail("protocol");
    }
  });

  const dispose = () => {
    if (closeWork) return closeWork;
    stopping = true;
    pending?.reject(new Error("diagnostic_owner_delivery_unknown_on_stop"));
    pending = undefined;
    // Let a blocked carrier write finish/EOF; never resubmit. Keep its output draining
    // while the exact native job and I/O settlement is measured.
    child.stdin.end();
    child.stdout.resume();
    closeWork = (async () => {
      const stop = new AbortController();
      try {
        const exit = await Promise.race([
          closed.result,
          delay(9000, null, { signal: stop.signal }),
        ]);
        if (exit === null) {
          // Last resort: exact owned helper only. Its private job has kill-on-close;
          // forced reclamation does not provide root/job/stdio settlement evidence.
          child.kill();
          throw new Error("diagnostic_owner_close_unobserved");
        }
        if (control !== "" || !settleRecord || exit.signal) throw new Error("diagnostic_owner_settlement_unobserved");
        return { ...settleRecord, ownerExitCode: exit.code };
      } finally {
        stop.abort();
      }
    })();
    return closeWork;
  };

  const stop = new AbortController();
  const admission = latch();
  const onAbort = () => admission.resolve(false);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    if (!await Promise.race([ready.result, admission.result, delay(20000, false, { signal: stop.signal })]) || failure) {
      await dispose().catch(() => undefined);
      signal?.throwIfAborted();
      throw new Error("diagnostic_owner_not_ready");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop.abort();
  }
  return {
    stdin: {
      write(bytes) {
        if (stopping || failure || pending || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) {
          return Promise.reject(new Error("diagnostic_owner_write_refused"));
        }
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
          const message = Buffer.allocUnsafe(4 + bytes.byteLength);
          message.writeUInt32LE(bytes.byteLength);
          message.set(bytes, 4);
          child.stdin.write(message, (error) => {
            if (error) fail("carrier_write_delivery_unknown");
          });
        });
      },
    },
    stdout: child.stdout.iterator({ destroyOnReturn: false }),
    // Native child stderr never crosses the owner boundary.
    stderr: (async function* () {})(),
    onFailure(handler) {
      if (failure) handler(failure);
      else observers.add(handler);
      return () => observers.delete(handler);
    },
    dispose,
  };
}
