import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { AcpRuntimeOptions } from "@remote-agent-console/acp-client";
import { createAcpRuntimeAdapter } from "@remote-agent-console/acp-client";
import type { RuntimeAdapter } from "@remote-agent-console/runtime-core";

export interface CommandCodeDiscoveryOptions {
  /** Exact executable path supplied by local host configuration. */
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type AcpAdapterFactory = (options: AcpRuntimeOptions) => RuntimeAdapter;

/** Finds the configured executable first, otherwise searches PATH without a shell. */
export function discoverCommandCodeExecutable(
  options: CommandCodeDiscoveryOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (options.executablePath !== undefined) {
    const explicitPath = resolve(options.executablePath);
    return isShellShim(explicitPath, platform) || !isExecutableFile(explicitPath, platform)
      ? null
      : explicitPath;
  }

  const pathValue = (options.env ?? process.env).PATH ?? "";
  // npm's .cmd launchers require a shell. Prefer the full native executable name,
  // then the documented native Windows short name, cmdc.exe.
  const executableNames =
    platform === "win32" ? ["command-code.exe", "cmdc.exe"] : ["command-code"];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of executableNames) {
      const candidate = resolve(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Reads a one-line version with a short timeout; stderr is always discarded. */
export function readCommandCodeVersion(
  executablePath: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string | undefined {
  const result = spawnSync(executablePath, ["--version"], {
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 8_192,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  const version = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  return version || undefined;
}

export class CommandCodeExecutableNotFoundError extends Error {
  constructor() {
    super("Command Code executable was not found or is not executable");
    this.name = "CommandCodeExecutableNotFoundError";
  }
}

/** Wraps the discovered Command Code CLI in the shared ACP v1 process adapter. */
export function createCommandCodeAdapter(
  options: CommandCodeDiscoveryOptions & {
    projects: Readonly<Record<string, string>>;
    env?: NodeJS.ProcessEnv;
  },
  adapterFactory: AcpAdapterFactory = createAcpRuntimeAdapter,
): RuntimeAdapter {
  const executablePath = discoverCommandCodeExecutable(options);
  if (!executablePath) throw new CommandCodeExecutableNotFoundError();
  return adapterFactory({
    id: "command-code",
    displayName: "Command Code",
    command: executablePath,
    args: ["acp"],
    projects: options.projects,
    ...(options.env ? { env: options.env } : {}),
  });
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isShellShim(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(?:bat|cmd|ps1)$/i.test(path);
}
