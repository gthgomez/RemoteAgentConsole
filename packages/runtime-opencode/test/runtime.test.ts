import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeRuntimeAdapter, discoverOpenCode } from "../src/index.js";

const fakeAgent = fileURLToPath(new URL("../../testkit/src/fake-agent.js", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // The fake CLI's child inherits the temp project directory as its cwd
      // and can outlive the killed CLI briefly on Windows, where that cwd
      // handle blocks removal. Bounded retries wait for release; a real
      // orphan still makes rm throw after the bound.
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

async function createFakeCli() {
  const directory = await mkdtemp(join(tmpdir(), "rac-opencode "));
  temporaryDirectories.push(directory);
  const projectPath = join(directory, "project folder");
  const cliPath = join(directory, "fake-opencode.mjs");
  const logPath = join(directory, "invocation.json");
  await mkdir(projectPath);
  await writeFile(
    cliPath,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("opencode v9.8.7"); process.exit(0); }
if (args[0] !== "acp") process.exit(64);
writeFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ args, cwd: process.cwd() }));
const agent = spawn(process.execPath, [process.env.FAKE_ACP_AGENT], { stdio: "inherit" });
agent.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  return { directory, projectPath, cliPath, logPath };
}

describe("OpenCode runtime", () => {
  it("discovers version and reports only capabilities exposed by the adapter", async () => {
    const fake = await createFakeCli();
    const runtime = await discoverOpenCode({
      command: process.execPath,
      versionArgs: [fake.cliPath, "--version"],
    });
    expect(runtime).toEqual({
      id: "opencode",
      displayName: "OpenCode",
      installed: true,
      version: "9.8.7",
      capabilities: {
        sessions: { create: true, resume: false, list: false },
        interaction: { cancel: true, permissions: true, questions: false },
        models: { selectable: false, effort: false },
        modes: false,
        plans: false,
        commands: false,
        images: false,
        files: false,
      },
    });
  });

  it("uses the ACP process with project cwd and normalizes its session events", async () => {
    const fake = await createFakeCli();
    const adapter = createOpenCodeRuntimeAdapter({
      command: process.execPath,
      args: [fake.cliPath, "acp"],
      env: { ...process.env, FAKE_OPENCODE_LOG: fake.logPath, FAKE_ACP_AGENT: fakeAgent },
      projects: { demo: fake.projectPath },
    });
    const connection = await adapter.connect({ projectId: "demo" });
    const session = await connection.createSession();
    const message = new Promise<string>((resolve) => {
      session.subscribe((event) => {
        if (event.type === "message.delta") resolve(event.text);
      });
    });
    await session.prompt("hello from OpenCode adapter");
    await expect(message).resolves.toContain("Fake response to: hello from OpenCode adapter");
    expect(JSON.parse(await readFile(fake.logPath, "utf8"))).toEqual({
      args: ["acp"],
      cwd: fake.projectPath,
    });
    await session.close();
    await connection.close();
  });

  it("reports an unavailable CLI without spawning a shell", async () => {
    const missing = await discoverOpenCode({ command: join(tmpdir(), "missing-opencode") });
    expect(missing).toEqual({
      id: "opencode",
      displayName: "OpenCode",
      installed: false,
      capabilities: null,
    });
  });
});
