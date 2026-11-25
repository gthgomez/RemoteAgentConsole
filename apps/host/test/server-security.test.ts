import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const children: ChildProcess[] = [];
const tempDirectories: string[] = [];

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Subscribe before kill so the release of the SQLite handles is observed before cleanup.
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill();
  await exited;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("production host startup", () => {
  it("keeps device authentication enabled even when NODE_ENV is test", async () => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), "rac-host-security-"));
    tempDirectories.push(directory);
    const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
      cwd: hostRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        RAC_HOST_PORT: String(port),
        RAC_HOST_DATABASE_PATH: join(directory, "host.sqlite"),
        RAC_PROJECTS_JSON: "[]",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });

    const deadline = Date.now() + 10_000;
    let pairingCode: string | null = null;
    let ready = false;
    while (Date.now() < deadline && (!pairingCode || !ready)) {
      pairingCode = output.match(/pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/i)?.[1] ?? null;
      if (child.exitCode !== null) throw new Error(`Host exited during startup: ${output}`);
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok;
      } catch {
        ready = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pairingCode).not.toBeNull();
    expect(ready).toBe(true);

    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
    expect(denied.status).toBe(401);
    const paired = await fetch(`http://127.0.0.1:${port}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode, displayName: "Host security test" }),
    });
    expect(paired.status).toBe(201);
  }, 15_000);
});
