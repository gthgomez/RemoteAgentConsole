import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const children: ChildProcess[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
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

describe("production host static app", () => {
  it("serves the PWA shell and assets while keeping authenticated API routes available", async () => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), "rac-host-static-"));
    tempDirectories.push(directory);
    const webRoot = join(directory, "web-dist");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<!doctype html><main>app shell</main>");
    await writeFile(join(webRoot, "assets", "app.js"), "globalThis.appLoaded = true;");

    const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
      cwd: hostRoot,
      env: {
        ...process.env,
        RAC_HOST_PORT: String(port),
        RAC_HOST_DATABASE_PATH: join(directory, "host.sqlite"),
        RAC_PROJECTS_JSON: "[]",
        RAC_WEB_DIST_PATH: webRoot,
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

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    let pairingCode: string | null = null;
    let ready = false;
    while (Date.now() < deadline && (!pairingCode || !ready)) {
      pairingCode = output.match(/pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/i)?.[1] ?? null;
      if (child.exitCode !== null) throw new Error(`Host exited during startup: ${output}`);
      try {
        ready = (await fetch(`${baseUrl}/api/v1/health`)).ok;
      } catch {
        ready = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pairingCode).not.toBeNull();
    expect(ready).toBe(true);

    const shell = await fetch(`${baseUrl}/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(await shell.text()).toContain("app shell");

    const nestedRoute = await fetch(`${baseUrl}/sessions/example`, {
      headers: { Accept: "text/html" },
    });
    expect(nestedRoute.status).toBe(200);
    expect(await nestedRoute.text()).toContain("app shell");

    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("appLoaded");

    const paired = await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode, displayName: "Static serving test" }),
    });
    expect(paired.status).toBe(201);
    const { credential } = (await paired.json()) as { credential: string };
    const projects = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ projects: [] });

    const apiNotFound = await fetch(`${baseUrl}/api/v1/missing`, {
      headers: { Accept: "text/html", Authorization: `Bearer ${credential}` },
    });
    expect(apiNotFound.status).toBe(404);
    expect(apiNotFound.headers.get("content-type")).not.toContain("text/html");
  }, 15_000);
});
