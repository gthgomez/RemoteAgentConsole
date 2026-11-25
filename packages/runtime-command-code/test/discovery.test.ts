import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntimeOptions } from "@remote-agent-console/acp-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommandCodeAdapter,
  discoverCommandCodeExecutable,
  readCommandCodeVersion,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const executableName = process.platform === "win32" ? "command-code.exe" : "command-code";

async function makeFakeExecutable(directory: string, name = executableName): Promise<string> {
  const path = join(directory, name);
  await copyFile(process.execPath, path);
  await chmod(path, 0o755);
  return path;
}

async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "command-code-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Command Code discovery and ACP wrapper", () => {
  it("prefers an explicitly configured executable over PATH", async () => {
    const explicitDirectory = await makeDirectory();
    const pathDirectory = await makeDirectory();
    const explicit = await makeFakeExecutable(explicitDirectory);
    await makeFakeExecutable(pathDirectory);

    expect(
      discoverCommandCodeExecutable({
        executablePath: explicit,
        env: { PATH: pathDirectory },
      }),
    ).toBe(explicit);
  });

  it("discovers the executable from PATH and skips non-executable files", async () => {
    const directory = await makeDirectory();
    const candidate = join(directory, executableName);
    // A directory at the candidate path is not a file on any platform.
    await mkdir(candidate);
    expect(discoverCommandCodeExecutable({ env: { PATH: directory } })).toBeNull();
    await rm(candidate, { recursive: true });

    // Windows has no POSIX execute bit, so check this only on POSIX hosts.
    if (process.platform !== "win32") {
      await writeFile(candidate, "not executable");
      await chmod(candidate, 0o644);
      expect(discoverCommandCodeExecutable({ env: { PATH: directory } })).toBeNull();
    }

    await makeFakeExecutable(directory);
    expect(discoverCommandCodeExecutable({ env: { PATH: directory } })).toBe(candidate);
  });

  it("does not fall back to PATH when an explicit executable is missing", async () => {
    const pathDirectory = await makeDirectory();
    await makeFakeExecutable(pathDirectory);
    expect(
      discoverCommandCodeExecutable({
        executablePath: join(pathDirectory, "missing-command-code"),
        env: { PATH: pathDirectory },
      }),
    ).toBeNull();
  });

  it("prefers the full native Windows executable, then discovers cmdc.exe", async () => {
    const directory = await makeDirectory();
    const shortName = await makeFakeExecutable(directory, "cmdc.exe");
    const fullName = await makeFakeExecutable(directory, "command-code.exe");

    expect(discoverCommandCodeExecutable({ env: { PATH: directory }, platform: "win32" })).toBe(
      fullName,
    );
    await rm(fullName);
    expect(discoverCommandCodeExecutable({ env: { PATH: directory }, platform: "win32" })).toBe(
      shortName,
    );
  });

  it("does not select Windows command shims that require a shell", async () => {
    const directory = await makeDirectory();
    const shim = join(directory, "command-code.cmd");
    await writeFile(shim, "@echo off\r\n");

    expect(
      discoverCommandCodeExecutable({ env: { PATH: directory }, platform: "win32" }),
    ).toBeNull();
    expect(discoverCommandCodeExecutable({ executablePath: shim, platform: "win32" })).toBeNull();
  });

  it("reads a bounded version string without exposing stderr", async () => {
    const directory = await makeDirectory();
    const executable = await makeFakeExecutable(directory);
    expect(readCommandCodeVersion(executable)).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("wraps the discovered executable with the ACP subcommand and allowlisted projects", async () => {
    const directory = await makeDirectory();
    const executable = await makeFakeExecutable(directory);
    const projects = { demo: "/tmp/demo" };
    let received: AcpRuntimeOptions | undefined;
    const adapter = createCommandCodeAdapter(
      { executablePath: executable, projects },
      (options) => {
        received = options;
        return {
          id: options.id,
          displayName: options.displayName,
          async connect() {
            throw new Error("test adapter is not connected");
          },
        };
      },
    );

    expect(adapter.id).toBe("command-code");
    expect(received).toMatchObject({
      id: "command-code",
      displayName: "Command Code",
      command: executable,
      args: ["acp"],
      projects,
    });
  });
});
